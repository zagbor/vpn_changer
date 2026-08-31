package telegram

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"

	"github.com/zagbor/vpn_changer/internal/config"
	"github.com/zagbor/vpn_changer/internal/keenetic"
	"github.com/zagbor/vpn_changer/internal/store"
)

// Bot is the Telegram front-end.
type Bot struct {
	api   *tgbotapi.BotAPI
	store *store.Store
	cfg   *config.Config

	// pendingBind maps chatID -> bind state machine for multi-step /bind input.
	bindStates map[int64]*bindState
}

type bindState struct {
	url      string
	login    string
	password string
	name     string
	interfaceID string
	step     int // 0=url,1=login,2=password,3=name,4=interface
}

// New creates a bot handler.
func New(cfg *config.Config, st *store.Store) (*Bot, error) {
	api, err := tgbotapi.NewBotAPI(cfg.TelegramToken)
	if err != nil {
		return nil, err
	}
	api.Debug = false
	return &Bot{
		api:        api,
		store:      st,
		cfg:        cfg,
		bindStates: map[int64]*bindState{},
	}, nil
}

// isAdmin reports whether a chat_id has admin privileges.
func (b *Bot) isAdmin(chatID int64) bool {
	return len(b.cfg.AdminIDs) == 0 || b.cfg.AdminIDs[chatID]
}

// Run starts the long-polling loop.
func (b *Bot) Run() error {
	log.Printf("telegram bot authorized as %s", b.api.Self.UserName)
	u := tgbotapi.NewUpdate(0)
	u.Timeout = 60
	updates := b.api.GetUpdatesChan(u)
	for update := range updates {
		if update.Message == nil {
			continue
		}
		b.handle(update.Message)
	}
	return nil
}

func (b *Bot) send(chatID int64, text string) {
	msg := tgbotapi.NewMessage(chatID, text)
	if _, err := b.api.Send(msg); err != nil {
		log.Printf("send to %d failed: %v", chatID, err)
	}
}

func (b *Bot) handle(m *tgbotapi.Message) {
	// Optional allowlist: if configured, only listed chat_ids may interact.
	if len(b.cfg.AllowedIDs) > 0 && !b.cfg.AllowedIDs[m.Chat.ID] {
		if m.Text == "/start" {
			b.send(m.Chat.ID, "Извините, у вас нет доступа к этому боту.")
		}
		return
	}

	// Multi-step /bind conversation: answer intermediate steps with a message.
	if st, ok := b.bindStates[m.Chat.ID]; ok {
		b.handleBindStep(m, st)
		return
	}

	if m.Document != nil {
		b.handleDocument(m)
		return
	}
	if m.Text == "" {
		return
	}

	cmd, arg := splitCmd(m.Text)
	switch cmd {
	case "/start", "/help":
		b.send(m.Chat.ID, helpText())
	case "/bind":
		b.bindStates[m.Chat.ID] = &bindState{}
		b.send(m.Chat.ID, "🔗 Привязка роутера.\n\nШаг 1/4: введите адрес роутера.\nНапример: `https://ваш-ник.keenetic.link` или `https://192.168.1.1`")
	case "/routers":
		b.listRouters(m.Chat.ID)
	case "/status":
		b.status(m.Chat.ID, arg)
	case "/unbind":
		if arg == "" {
			b.send(m.Chat.ID, "Укажите имя: `/unbind <имя>`")
			return
		}
		if err := b.store.Remove(m.Chat.ID, arg); err != nil {
			b.send(m.Chat.ID, "Не удалось удалить: "+err.Error())
			return
		}
		b.send(m.Chat.ID, fmt.Sprintf("Роутер `%s` удалён.", arg))
	case "/setiface":
		b.setInterface(m.Chat.ID, arg)
	case "/admin_routers":
		b.adminRouters(m.Chat.ID)
	case "/admin_status":
		b.adminStatus(m.Chat.ID, arg)
	case "/admin_unbind":
		b.adminUnbind(m.Chat.ID, arg)
	case "/switch":
		// set active interface target is implicit by name; informational
		b.send(m.Chat.ID, "Отправьте WireGuard `.conf` файл — он будет применён к вашему роутеру.")
	default:
		b.send(m.Chat.ID, "Неизвестная команда. Наберите /help.")
	}
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9_\-]{1,32}$`)

func (b *Bot) handleBindStep(m *tgbotapi.Message, st *bindState) {
	text := strings.TrimSpace(m.Text)
	switch st.step {
	case 0: // url
		st.url = text
		st.step = 1
		b.send(m.Chat.ID, "Шаг 2/4: логин администратора роутера (обычно `admin`).")
	case 1: // login
		st.login = text
		st.step = 2
		b.send(m.Chat.ID, "Шаг 3/4: пароль администратора роутера.")
	case 2: // password
		st.password = text
		st.step = 3
		b.send(m.Chat.ID, "Шаг 4/4: задайте короткое имя роутера (латиницей). Например `home`, `dacha`.")
	case 3: // name
		if !nameRe.MatchString(text) {
			b.send(m.Chat.ID, "Имя должно быть 1-32 символа: латиница, цифры, `_` или `-`.")
			return
		}
		st.name = text
		st.step = 4
		// Query the router for available WireGuard interfaces to guide selection.
		c := keenetic.NewClient(st.url, st.login, st.password, b.cfg.TLSSkipVerify)
		ifaces, err := c.ShowWireGuardInterfaces()
		if err != nil {
			b.send(m.Chat.ID, "Не удалось получить список интерфейсов: "+err.Error()+"\nКакой интерфейс заменять? Введите ID или минус (`-`) для импорта нового файла.")
			return
		}
		if len(ifaces) == 0 {
			b.send(m.Chat.ID, "На роутере нет WireGuard-интерфейсов. Файл будет импортироваться как новый. Введите `-` для продолжения.")
			return
		}
		var sb strings.Builder
		sb.WriteString("Доступные WireGuard-интерфейсы:\n")
		for _, ifc := range ifaces {
			sb.WriteString(fmt.Sprintf(" • `%s`%s\n", ifc.ID, stateSuffix(ifc)))
		}
		sb.WriteString("\nВведите ID интерфейса для замены. Или `-`, если хотите каждый раз импортировать новый файл.")
		b.send(m.Chat.ID, sb.String())
	case 4: // interface
		if text == "-" || text == "" {
			st.interfaceID = ""
		} else {
			st.interfaceID = text
		}
		delete(b.bindStates, m.Chat.ID)
		b.finishBind(m.Chat.ID, st)
	}
}

func stateSuffix(ifc keenetic.WireGuardInterface) string {
	if ifc.State == "up" {
		return " (активен)"
	}
	return ""
}

// finishBind validates credentials against the router and saves the binding.
func (b *Bot) finishBind(chatID int64, st *bindState) {
	c := keenetic.NewClient(st.url, st.login, st.password, b.cfg.TLSSkipVerify)
	if err := c.Ping(); err != nil {
		b.send(chatID, "❌ Роутер недоступен: "+err.Error()+"\nПроверьте URL.")
		return
	}
	if err := c.Auth(); err != nil {
		b.send(chatID, "❌ Не удалось авторизоваться: "+err.Error())
		return
	}

	nb := &store.Binding{
		ChatID:      chatID,
		Name:        st.name,
		URL:         st.url,
		Login:       st.login,
		Password:    st.password,
		InterfaceID: st.interfaceID,
	}
	if err := b.store.Add(nb); err != nil {
		b.send(chatID, "❌ Ошибка сохранения: "+err.Error())
		return
	}
	target := st.interfaceID
	if target == "" {
		target = "импорт как новый файл"
	}
	b.send(chatID, fmt.Sprintf("✅ Роутер `%s` привязан! Цель: %s.\nТеперь отправьте WireGuard `.conf`, чтобы заменить VPN.", st.name, target))
}

// setInterface sets the target interface ID for an already-bound router.
// Usage: /setiface <имя> <interface-id>   (or "-" to import new)
func (b *Bot) setInterface(chatID int64, arg string) {
	fields := strings.Fields(arg)
	if len(fields) < 2 {
		b.send(chatID, "Использование: `/setiface <имя> <interface-id>`\nНапример: `/setiface home Wireguard0` или `/setiface home -`")
		return
	}
	name, iface := fields[0], fields[1]
	bd, err := b.store.Get(chatID, name)
	if err != nil {
		b.send(chatID, err.Error())
		return
	}
	if iface == "-" {
		iface = ""
	}
	bd.InterfaceID = iface
	if err := b.store.Update(bd); err != nil {
		b.send(chatID, "❌ Не удалось обновить: "+err.Error())
		return
	}
	target := iface
	if target == "" {
		target = "импорт как новый файл"
	}
	b.send(chatID, fmt.Sprintf("✅ Роутер `%s` теперь заменяет `%s`.", name, target))
}

// --- Admin cross-user management ---

func (b *Bot) requireAdmin(chatID int64) bool {
	if !b.isAdmin(chatID) {
		b.send(chatID, "⛔ Команда доступна только администраторам.")
		return false
	}
	return true
}

func (b *Bot) adminRouters(chatID int64) {
	if !b.requireAdmin(chatID) {
		return
	}
	all := b.store.All()
	if len(all) == 0 {
		b.send(chatID, "Пока нет ни одного привязанного роутера.")
		return
	}
	// Group by owner chat id.
	byOwner := map[int64][]*store.Binding{}
	for _, bd := range all {
		byOwner[bd.ChatID] = append(byOwner[bd.ChatID], bd)
	}
	var sb strings.Builder
	sb.WriteString("Все роутеры:\n")
	for owner, list := range byOwner {
		sb.WriteString(fmt.Sprintf("\n👤 chat `%d`:\n", owner))
		for _, r := range list {
			target := r.InterfaceID
			if target == "" {
				target = "новый импорт"
			}
			sb.WriteString(fmt.Sprintf("  • `%s` — %s (цель: %s)\n", r.Name, r.URL, target))
		}
	}
	sb.WriteString("\nАдмин-команды:\n`/admin_status <ownerId> <name>`\n`/admin_unbind <ownerId> <name>`")
	b.send(chatID, sb.String())
}

func (b *Bot) adminStatus(chatID int64, arg string) {
	if !b.requireAdmin(chatID) {
		return
	}
	owner, name, err := parseOwnerName(arg)
	if err != nil {
		b.send(chatID, err.Error()+"\nИспользование: `/admin_status <ownerId> <name>`")
		return
	}
	bd, err := b.store.GetAny(owner, name)
	if err != nil {
		b.send(chatID, err.Error())
		return
	}
	c := keenetic.NewClient(bd.URL, bd.Login, bd.Password, b.cfg.TLSSkipVerify)
	if err := c.Ping(); err != nil {
		b.send(chatID, "Роутер недоступен: "+err.Error())
		return
	}
	if err := c.Auth(); err != nil {
		b.send(chatID, "Авторизация не удалась: "+err.Error())
		return
	}
	b.send(chatID, fmt.Sprintf("✅ Роутер `%s` владельца `%d` на связи и авторизован.", bd.Name, owner))
}

func (b *Bot) adminUnbind(chatID int64, arg string) {
	if !b.requireAdmin(chatID) {
		return
	}
	owner, name, err := parseOwnerName(arg)
	if err != nil {
		b.send(chatID, err.Error()+"\nИспользование: `/admin_unbind <ownerId> <name>`")
		return
	}
	if err := b.store.RemoveByID(owner, name); err != nil {
		b.send(chatID, err.Error())
		return
	}
	b.send(chatID, fmt.Sprintf("Роутер `%s` владельца `%d` удалён.", name, owner))
}

func parseOwnerName(arg string) (int64, string, error) {
	fields := strings.Fields(arg)
	if len(fields) < 2 {
		return 0, "", fmt.Errorf("нужны ownerId и имя")
	}
	var owner int64
	if _, err := fmt.Sscan(fields[0], &owner); err != nil {
		return 0, "", fmt.Errorf("ownerId должен быть числом (chat id)")
	}
	return owner, fields[1], nil
}

func (b *Bot) listRouters(chatID int64) {
	list := b.store.List(chatID)
	if len(list) == 0 {
		b.send(chatID, "Роутеры не привязаны. Используйте /bind.")
		return
	}
	var sb strings.Builder
	sb.WriteString("Ваши роутеры:\n")
	for _, r := range list {
		target := r.InterfaceID
		if target == "" {
			target = "первый WireGuard интерфейс"
		}
		sb.WriteString(fmt.Sprintf(" • `%s` — %s (цель: %s)\n", r.Name, r.URL, target))
	}
	sb.WriteString("\nОтправьте `.conf`, чтобы заменить VPN. При нескольких роутерах прикрепите файл с подписью: `имя файл.conf`.")
	b.send(chatID, sb.String())
}

func (b *Bot) status(chatID int64, arg string) {
	name := strings.TrimSpace(arg)
	bd, err := b.store.Get(chatID, name)
	if err != nil {
		b.send(chatID, err.Error())
		return
	}
	c := keenetic.NewClient(bd.URL, bd.Login, bd.Password, b.cfg.TLSSkipVerify)
	if err := c.Ping(); err != nil {
		b.send(chatID, "Роутер недоступен: "+err.Error())
		return
	}
	if err := c.Auth(); err != nil {
		b.send(chatID, "Авторизация не удалась: "+err.Error())
		return
	}
	b.send(chatID, fmt.Sprintf("✅ Роутер `%s` на связи и авторизован.", bd.Name))
}

// handleDocument applies an uploaded .conf file to the target router.
func (b *Bot) handleDocument(m *tgbotapi.Message) {
	doc := m.Document
	if !strings.HasSuffix(strings.ToLower(doc.FileName), ".conf") &&
		!strings.HasSuffix(strings.ToLower(doc.FileName), ".wg") {
		b.send(m.Chat.ID, "Пожалуйста, прикрепите файл конфигурации WireGuard `.conf`.")
		return
	}

	// Optional caption "<имя> <файл.conf>" selects which of several routers to target.
	name := strings.TrimSpace(m.Caption)

	bd, err := b.store.Get(m.Chat.ID, name)
	if err != nil {
		b.send(m.Chat.ID, err.Error())
		return
	}

	// Download and apply the file to the target router.
	conf, err := b.downloadFile(doc.FileID)
	if err != nil {
		b.send(m.Chat.ID, "Не удалось скачать файл: "+err.Error())
		return
	}

	b.apply(m.Chat.ID, bd, doc.FileName, conf)
}

// apply replaces/imports the WireGuard config on the router and replies.
func (b *Bot) apply(chatID int64, bd *store.Binding, fileName string, conf []byte) {
	c := keenetic.NewClient(bd.URL, bd.Login, bd.Password, b.cfg.TLSSkipVerify)

	if err := c.Ping(); err != nil {
		b.send(chatID, "❌ Роутер недоступен: "+err.Error())
		return
	}
	if err := c.Auth(); err != nil {
		b.send(chatID, "❌ Авторизация не удалась: "+err.Error())
		return
	}

	// If a specific interface is configured, update it; otherwise import
	// the config as a new WireGuard interface (mimics "load from file").
	if bd.InterfaceID != "" {
		b.send(chatID, fmt.Sprintf("⏳ Обновляю `%s` на роутере `%s`...", bd.InterfaceID, bd.Name))
		if err := c.UpdateWireGuard(bd.InterfaceID, conf); err != nil {
			b.send(chatID, "❌ Ошибка обновления: "+err.Error())
			return
		}
		b.send(chatID, fmt.Sprintf("✅ VPN на `%s` обновлён (интерфейс `%s`).", bd.Name, bd.InterfaceID))
		return
	}

	b.send(chatID, fmt.Sprintf("⏳ Импортирую конфиг на роутер `%s`...", bd.Name))
	if err := c.ImportWireGuard(conf, fileName); err != nil {
		b.send(chatID, "❌ Ошибка импорта: "+err.Error())
		return
	}
	b.send(chatID, fmt.Sprintf("✅ Конфигурация WireGuard загружена на `%s` как `%s`.", bd.Name, fileName))
}

// downloadFile fetches a Telegram file by its file_id and returns bytes.
func (b *Bot) downloadFile(fileID string) ([]byte, error) {
	url, err := b.api.GetFileDirectURL(fileID)
	if err != nil {
		return nil, err
	}
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// splitCmd splits a message into command and the rest of the arguments.
func splitCmd(text string) (string, string) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return "", ""
	}
	cmd := fields[0]
	if i := strings.IndexByte(cmd, '@'); i >= 0 {
		cmd = cmd[:i]
	}
	return cmd, strings.Join(fields[1:], " ")
}

func helpText() string {
	return strings.Join([]string{
		"🦊 *VPN Changer* — замена WireGuard на роутере Keenetic через Telegram.",
		"",
		"Один бот — много роутеров; каждый пользователь управляет своим.",
		"",
		"*Команды:*",
		"`/bind` — привязать роутер (URL, логин, пароль, имя, интерфейс)",
		"`/routers` — список ваших роутеров",
		"`/setiface <имя> <id>` — сменить заменяемый интерфейс (`-` = импорт нового)",
		"`/status [имя]` — проверить связь с роутером",
		"`/unbind <имя>` — отвязать роутер",
		"",
		"*Смена VPN:* просто отправьте боту WireGuard `.conf` файл.",
		"Если привязано несколько роутеров — укажите имя в подписи к файлу: `дома wifi.conf`.",
		"",
		"*Для администраторов:*",
		"`/admin_routers` — все роутеры всех пользователей",
		"`/admin_status <ownerId> <имя>` — проверить чужой роутер",
		"`/admin_unbind <ownerId> <имя>` — отвязать чужой роутер",
	}, "\n")
}
