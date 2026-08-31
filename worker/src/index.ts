import { KeeneticClient } from "./keenetic.js";
import { sendMessage, sendInlineKeyboard, answerCallbackQuery, downloadTelegramFile, splitCmd, type TelegramMessage } from "./telegram.js";
import { Store } from "./store.js";
import type { Env, Binding } from "./types.js";

const NAME_RE = /^[A-Za-z0-9_\-]{1,32}$/;
const CRLF = "\n";

export default {
  // Scheduled (cron) handler: daily heartbeat to the bot operator.
  async scheduled(_event: any, env: Env, _ctx: any): Promise<void> {
    const adminChat = env.ADMIN_LOG_CHAT;
    if (!adminChat || !env.TG_BOT_TOKEN) return;
    const now = new Date();
    const ts = now.toISOString().replace("T", " ").slice(0, 16);
    try {
      await sendMessage(
        env.TG_BOT_TOKEN,
        adminChat,
        `✅ Бот жив и работает.\nВремя (UTC): ${ts}`
      );
    } catch (e: any) {
      console.error("heartbeat failed:", e?.message || e);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("VPN Changer bot is running", { status: 200 });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      console.log("webhook received:", body);
      let errMsg: TelegramMessage | undefined;
      try {
        const update = JSON.parse(body);
        const msg = update?.message;
        const cq = update?.callback_query;
        if (msg) {
          errMsg = msg;
          console.log("processing message from chat", msg.chat?.id);
          await handleMessage(msg, env);
          console.log("finished message", msg.chat?.id);
        } else if (cq && cq.message && cq.message.chat) {
          errMsg = cq.message;
          console.log("processing callback from chat", cq.message.chat.id);
          await handleCallback(cq, env);
          console.log("finished callback", cq.message.chat.id);
        }
      } catch (e: any) {
        console.error("webhook error:", e?.message || e);
        await notifyAdmin(env, errMsg, e);
      }
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      const key = url.searchParams.get("key");
      if (!env.SETUP_KEY || key !== env.SETUP_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const res = await fetch(
        `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            allowed_updates: ["message", "callback_query"],
          }),
        }
      );
      const out = await res.json();
      return new Response(JSON.stringify({ webhookUrl, telegram: out }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/diag") {
      const key = url.searchParams.get("key");
      if (!env.SETUP_KEY || key !== env.SETUP_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const webhookInfo = await fetch(
        `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getWebhookInfo`
      ).then((r) => r.json());
      const me = await fetch(
        `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getMe`
      ).then((r) => r.json());
      return new Response(
        JSON.stringify({ webhookInfo, me, origin: url.origin }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};

function isAdmin(env: Env, chatId: number): boolean {
  if (!env.TG_ADMIN_IDS) return true;
  return env.TG_ADMIN_IDS.split(",").map((s) => s.trim()).includes(String(chatId));
}

function isAllowed(env: Env, chatId: number): boolean {
  if (!env.TG_ALLOWED_IDS) return true;
  return env.TG_ALLOWED_IDS.split(",").map((s) => s.trim()).includes(String(chatId));
}

// notifyAdmin sends an error/event log to the bot operator's Telegram chat.
// msg identifies which user/chat triggered the event so the operator knows
// who the error came from.
async function notifyAdmin(env: Env, msg: TelegramMessage | undefined, err: unknown): Promise<void> {
  const adminChat = env.ADMIN_LOG_CHAT;
  if (!adminChat || !env.TG_BOT_TOKEN) return;

  const who = msg
    ? `пользователь: ${msg.chat?.id}${msg.chat?.type ? " (" + msg.chat.type + ")" : ""}`
    : "пользователь: неизвестен";
  const what =
    msg?.text != null
      ? `сообщение: ${msg.text.slice(0, 200)}`
      : msg?.document?.file_name
      ? `файл: ${msg.document.file_name}`
      : "";

  let errText = "";
  if (err instanceof Error) {
    errText = err.message;
  } else {
    try {
      errText = JSON.stringify(err);
    } catch {
      errText = String(err);
    }
  }

  const log = [
    "⚠️ Ошибка бота:",
    who,
    what,
    `ошибка: ${errText.slice(0, 600)}`,
  ].filter(Boolean).join(CRLF);

  try {
    await sendMessage(env.TG_BOT_TOKEN, adminChat, log);
  } catch {
    // never let logging break message handling
  }
}

function helpText(): string {
  return [
    "VPN Changer — замена WireGuard на роутере Keenetic через Telegram.",
    "",
    "Один бот — много роутеров; каждый пользователь управляет своим.",
    "",
    "Используйте /start, чтобы открыть меню с кнопками, или команды:",
    "/bind — привязать роутер",
    "/routers — список ваших роутеров",
    "/select — выбрать роутер для следующего .conf",
    "/status — проверить связь с роутером",
    "/unbind — отвязать роутер",
    "",
    "Смена VPN: выберите роутер (/select), затем отправьте WireGuard .conf файл.",
    "",
  ].join("\n");
}

async function handleMessage(msg: TelegramMessage, env: Env): Promise<void> {
  const chatId = msg.chat.id;

  if (!isAllowed(env, chatId)) {
    if (msg.text === "/start") {
      await sendMessage(env.TG_BOT_TOKEN, chatId, "У вас нет доступа к этому боту.");
    }
    return;
  }

  const store = new Store(env.STATE);

  // Multi-step bind
  const bindState = await store.getBindState(chatId);
  if (bindState && msg.text) {
    await handleBindStep(msg, bindState, store, env);
    return;
  }

  // Document
  if (msg.document) {
    await handleDocument(msg, store, env);
    return;
  }

  if (!msg.text) return;

  const [cmd, arg] = splitCmd(msg.text);
  switch (cmd) {
    case "/start":
    case "/help":
    case "/menu":
      await showMainMenu(chatId, env);
      break;

    case "/bind":
      await store.setBindState(chatId, { step: 0 });
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Привязка роутера.\n\nШаг 1/5: введите адрес роутера.\nНапример: https://ваш-ник.keenetic.link или https://192.168.1.1");
      break;

    case "/routers":
      await listRouters(chatId, store, env);
      break;

    case "/select":
      await selectRouter(chatId, store, env);
      break;

    case "/status":
      await status(chatId, arg, store, env);
      break;

    case "/unbind":
      if (!arg) {
        await sendMessage(env.TG_BOT_TOKEN, chatId, "Укажите имя: /unbind <имя>");
        return;
      }
      await unbind(chatId, arg, store, env);
      break;

    case "/setiface":
      await setInterface(chatId, arg, store, env);
      break;

    case "/admin_routers":
      await adminRouters(chatId, store, env);
      break;

    case "/admin_status":
      await adminStatus(chatId, arg, store, env);
      break;

    case "/admin_unbind":
      await adminUnbind(chatId, arg, store, env);
      break;

    case "/diagwire":
      await diagWire(chatId, arg, store, env);
      break;

    default:
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Неизвестная команда. Наберите /help.");
  }
}

// diagWire (admin) dumps raw RCI responses to inspect WireGuard structure.
async function diagWire(chatId: number, arg: string, store: Store, env: Env): Promise<void> {
  if (!isAdmin(env, chatId)) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Только для администраторов.");
    return;
  }
  const name = arg.trim();
  let bd: Binding;
  try {
    bd = await store.get(chatId, name);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, e.message);
    return;
  }
  const c = new KeeneticClient(bd.url, bd.login, bd.password);
  let out = `Диагностика ${bd.name}:\n`;

  // Show WireGuard interfaces and their global (internet) priority.
  try {
    const ifaces = await c.showWireGuardInterfaces();
    out += `WireGuard интерфейсы (${ifaces.length}): ${ifaces.map((i) => i.id).join(", ") || "—"}\n`;
  } catch (e: any) {
    out += `\nWireGuard интерфейсы → ERR ${e.message}\n`;
  }

  try {
    const body = await c.rawGet("/rci/interface");
    const parsed = JSON.parse(body) as Record<string, any>;
    for (const [id, obj] of Object.entries(parsed)) {
      if (!String(id).toLowerCase().startsWith("wireguard")) continue;
      const g = obj?.ip?.global;
      out += `\n${id}: up=${!!obj?.up} global-priority=${g?.priority ?? "не задан"} order=${g?.order ?? "—"}\n`;
    }
  } catch (e: any) {
    out += `\n(прочитать /rci/interface: ${e.message})\n`;
  }

  try {
    const data = await c.runCLI("show ip route");
    const route = JSON.stringify(data).slice(0, 1500);
    out += `\n### show ip route ###\n${route}\n`;
  } catch (e: any) {
    out += `\n### show ip route → ERR ${e.message}###\n`;
  }

  await sendMessage(env.TG_BOT_TOKEN, chatId, out);
  out = "";
}

async function handleBindStep(
  msg: TelegramMessage,
  state: any,
  store: Store,
  env: Env
): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  switch (state.step) {
    case 0: // URL
      state.url = text;
      state.step = 1;
      await store.setBindState(chatId, state);
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Шаг 2/5: логин администратора роутера (обычно admin).");
      break;

    case 1: // login
      state.login = text;
      state.step = 2;
      await store.setBindState(chatId, state);
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Шаг 3/5: пароль администратора роутера.");
      break;

    case 2: // password
      state.password = text;
      state.step = 3;
      await store.setBindState(chatId, state);
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Шаг 4/5: задайте короткое имя роутера (латиницей). Например home, dacha.");
      break;

    case 3: // name
      if (!NAME_RE.test(text)) {
        await sendMessage(env.TG_BOT_TOKEN, chatId, "Имя должно быть 1-32 символа: латиница, цифры, _ или -.");
        return;
      }
      state.name = text;
      state.step = 4;
      // Query interfaces
      try {
        const c = new KeeneticClient(state.url, state.login, state.password);
        const ifaces = await c.showWireGuardInterfaces();
        if (ifaces.length === 0) {
          state.interface_id = "";
          await store.deleteBindState(chatId);
          await finishBind(chatId, state, store, env);
          return;
        }
        let reply = "Доступные WireGuard-интерфейсы:\n";
        for (const iface of ifaces) {
          reply += ` - ${iface.id}${iface.state === "up" ? " (активен)" : ""}\n`;
        }
        reply += "\nВведите ID интерфейса для замены. Или -, если хотите каждый раз импортировать новый файл.";
        await store.setBindState(chatId, state);
        await sendMessage(env.TG_BOT_TOKEN, chatId, reply);
      } catch (e: any) {
        state.interface_id = "";
        await store.deleteBindState(chatId);
        await finishBind(chatId, state, store, env);
      }
      break;

    case 4: // interface
      state.interface_id = text === "-" || text === "" ? "" : text;
      await store.deleteBindState(chatId);
      await finishBind(chatId, state, store, env);
      break;
  }
}

async function finishBind(
  chatId: number,
  state: any,
  store: Store,
  env: Env
): Promise<void> {
  const c = new KeeneticClient(state.url, state.login, state.password);
  const alive = await c.ping();
  if (!alive) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Роутер недоступен. Проверьте URL.");
    return;
  }
  try {
    await c.auth();
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Ошибка авторизации: " + e.message);
    return;
  }

  const binding: Binding = {
    chat_id: chatId,
    name: state.name,
    url: state.url,
    login: state.login,
    password: state.password,
    interface_id: state.interface_id || "",
  };

  try {
    await store.add(binding);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Ошибка сохранения: " + e.message);
    return;
  }

  const target = state.interface_id || "импорт как новый файл";
  await sendMessage(env.TG_BOT_TOKEN, chatId, `Роутер ${state.name} привязан! Цель: ${target}.\nТеперь отправьте WireGuard .conf, чтобы заменить VPN.`);
}

async function listRouters(chatId: number, store: Store, env: Env): Promise<void> {
  const list = await store.list(chatId);
  if (list.length === 0) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Роутеры не привязаны. Используйте /bind.");
    return;
  }
  let reply = "Ваши роутеры:\n";
  for (const r of list) {
    const target = r.interface_id || "первый WireGuard интерфейс";
    reply += ` - ${r.name} — ${r.url} (цель: ${target})\n`;
  }
  reply += "\nВыберите роутер кнопкой (/select) для отправки .conf, или нажмите кнопки ниже для действий.";
  const buttons = list.map((r) => ({
    text: r.name,
    callback_data: `pick:select:${r.name}`,
  }));
  await sendMessage(env.TG_BOT_TOKEN, chatId, reply);
  if (buttons.length > 0) {
    buttons.push({ text: "🏠 В начало", callback_data: "nav:main" });
    await sendInlineKeyboard(env.TG_BOT_TOKEN, chatId, "Действия по роутерам:", buttons);
  }
}

// selectRouter asks the user which of their routers should receive the next .conf.
async function selectRouter(chatId: number, store: Store, env: Env): Promise<void> {
  await pickRouterList(chatId, store, env, "select");
}

// showMainMenu renders the top-level button menu.
async function showMainMenu(chatId: number, env: Env): Promise<void> {
  const buttons = [
    { text: "📡 Привязать роутер", callback_data: "nav:bind" },
    { text: "🖥 Выбрать роутер (.conf)", callback_data: "nav:select" },
    { text: "📊 Статус роутера", callback_data: "nav:status" },
    { text: "📋 Список роутеров", callback_data: "nav:list" },
    { text: "🗑 Отвязать роутер", callback_data: "nav:remove" },
    { text: "🧹 Удалить конфиги с роутера", callback_data: "nav:wipe" },
    { text: "🆘 Помощь", callback_data: "nav:help" },
  ];
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "Главное меню VPN Changer. Выберите действие:",
    buttons
  );
}

// pickRouterList shows the user's routers as buttons for a given action.
// action: "select" | "status" | "remove" | "wipe"
async function pickRouterList(chatId: number, store: Store, env: Env, action: string): Promise<void> {
  const list = await store.list(chatId);
  if (list.length === 0) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Роутеры не привязаны. Используйте «Привязать роутер».");
    return;
  }
  const labels: Record<string, string> = {
    select: "Выберите роутер, которому отправить следующий .conf:",
    status: "Выберите роутер для проверки:",
    remove: "Выберите роутер для отвязки:",
    wipe: "Выберите роутер, с которого удалить ВСЕ WireGuard-конфиги:",
  };
  const buttons = list.map((r) => ({
    text: r.name,
    callback_data: `pick:${action}:${r.name}`,
  }));
  buttons.push({ text: "🏠 В начало", callback_data: "nav:main" });
  await sendInlineKeyboard(env.TG_BOT_TOKEN, chatId, labels[action] || "Выберите роутер:", buttons);
}

// handleCallback processes all inline-button presses (menu & router actions).
interface CallbackQuery {
  id: string;
  from: { id: number };
  message: TelegramMessage;
  data?: string;
}

async function handleCallback(cq: CallbackQuery, env: Env): Promise<void> {
  const chatId = cq.message.chat.id;
  const data = cq.data || "";
  const store = new Store(env.STATE);

  try {
    if (data.startsWith("nav:")) {
      const nav = data.slice(4);
      switch (nav) {
        case "main":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          try {
            await store.deleteBindState(chatId);
          } catch {
            // no bind state
          }
          await showMainMenu(chatId, env);
          break;
        case "bind":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Начинаю привязку");
          await store.setBindState(chatId, { step: 0 });
          await sendInlineKeyboard(
            env.TG_BOT_TOKEN,
            chatId,
            "Привязка роутера.\n\nШаг 1/5: введите адрес роутера.\nНапример: https://ваш-ник.keenetic.link или https://192.168.1.1",
            [{ text: "🏠 В начало", callback_data: "nav:main" }]
          );
          break;
        case "select":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await pickRouterList(chatId, store, env, "select");
          break;
        case "status":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await pickRouterList(chatId, store, env, "status");
          break;
        case "list":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await listRouters(chatId, store, env);
          break;
        case "remove":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await pickRouterList(chatId, store, env, "remove");
          break;
        case "wipe":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await pickRouterList(chatId, store, env, "wipe");
          break;
        case "help":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await sendInlineKeyboard(
            env.TG_BOT_TOKEN,
            chatId,
            helpText(),
            [{ text: "🏠 В начало", callback_data: "nav:main" }]
          );
          break;
        default:
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Неизвестная команда");
      }
      return;
    }

    if (data.startsWith("pick:")) {
      const parts = data.split(":");
      const action = parts[1];
      const name = parts.slice(2).join(":");
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
      if (action === "select") {
        await store.get(chatId, name);
        await store.setSelected(chatId, name);
        await sendMessage(env.TG_BOT_TOKEN, chatId, `Роутер ${name} выбран. Отправьте WireGuard .conf — он будет применён именно к нему.`);
      } else if (action === "status") {
        await status(chatId, name, store, env);
      } else if (action === "remove") {
        // show confirmation step
        const buttons = [
          { text: "Да, отвязать", callback_data: `del:${name}` },
          { text: "🏠 В начало", callback_data: "nav:main" },
        ];
        await sendInlineKeyboard(
          env.TG_BOT_TOKEN,
          chatId,
          `Отвязать роутер «${name}»? Это действие нельзя отменить.`,
          buttons
        );
      } else if (action === "wipe") {
        const buttons = [
          { text: "Да, удалить все конфиги", callback_data: `dowipe:${name}` },
          { text: "🏠 В начало", callback_data: "nav:main" },
        ];
        await sendInlineKeyboard(
          env.TG_BOT_TOKEN,
          chatId,
          `Удалить ВСЕ WireGuard-конфиги с роутера «${name}»? VPN будет снят с приоритета, интернет вернётся на Ethernet.`,
          buttons
        );
      }
      return;
    }

    if (data.startsWith("del:")) {
      const name = data.slice(4);
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, `Отвязываю ${name}`);
      await unbind(chatId, name, store, env);
      return;
    }

    if (data.startsWith("dowipe:")) {
      const name = data.slice(7);
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, `Очищаю ${name}`);
      await wipeConfigs(chatId, name, store, env);
      return;
    }

    await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Неизвестная кнопка");
  } catch (e: any) {
    await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Ошибка: " + (e?.message || e));
  }
}

async function unbind(chatId: number, name: string, store: Store, env: Env): Promise<void> {
  try {
    await store.remove(chatId, name);
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Роутер ${name} удалён.`);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Ошибка: " + e.message);
  }
}

// wipeConfigs deletes every WireGuard config on the router. Deleting the
// interfaces also removes their ip.global.priority, so internet returns to
// the Ethernet provider automatically.
async function wipeConfigs(chatId: number, name: string, store: Store, env: Env): Promise<void> {
  let bd: Binding;
  try {
    bd = await store.get(chatId, name);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, e.message);
    return;
  }

  const c = new KeeneticClient(bd.url, bd.login, bd.password);
  const alive = await c.ping();
  if (!alive) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Роутер недоступен.");
    return;
  }
  try {
    await c.auth();
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Ошибка авторизации: " + e.message);
    return;
  }

  await sendMessage(env.TG_BOT_TOKEN, chatId, `Очищаю WireGuard-конфиги на роутере ${name}...`);
  try {
    const removed = await c.deleteAllWireGuard();
    if (bd.interface_id) {
      bd.interface_id = "";
      try {
        await store.update(bd);
      } catch {
        // router binding may be unchanged; ignore
      }
    }
    await sendMessage(
      env.TG_BOT_TOKEN,
      chatId,
      `С роутера ${name} удалено конфигов: ${removed}. VPN снят, интернет вернётся на Ethernet.`
    );
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Не удалось удалить конфиги: " + e.message);
  }
}

async function status(chatId: number, arg: string, store: Store, env: Env): Promise<void> {
  const name = arg.trim();
  try {
    const bd = await store.get(chatId, name);
    const c = new KeeneticClient(bd.url, bd.login, bd.password);
    const alive = await c.ping();
    if (!alive) {
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Роутер недоступен.");
      return;
    }
    await c.auth();
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Роутер ${bd.name} на связи и авторизован.`);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, e.message);
  }
}

async function setInterface(chatId: number, arg: string, store: Store, env: Env): Promise<void> {
  const fields = arg.trim().split(/\s+/);
  if (fields.length < 2) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Использование: /setiface <имя> <interface-id>");
    return;
  }
  const [name, iface] = [fields[0], fields[1] === "-" ? "" : fields[1]];
  try {
    const bd = await store.get(chatId, name);
    bd.interface_id = iface;
    await store.update(bd);
    const target = iface || "импорт как новый файл";
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Роутер ${name} теперь заменяет ${target}.`);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, e.message);
  }
}

async function handleDocument(
  msg: TelegramMessage,
  store: Store,
  env: Env
): Promise<void> {
  const chatId = msg.chat.id;
  const doc = msg.document!;
  const fileName = doc.file_name || "";

  if (!fileName.endsWith(".conf") && !fileName.endsWith(".wg")) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Пожалуйста, прикрепите файл конфигурации WireGuard .conf.");
    return;
  }

  const name = (msg.caption || "").trim() || (await store.getSelected(chatId)) || "";

  let bd: Binding;
  try {
    bd = await store.get(chatId, name);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, e.message);
    return;
  }

  // If a router was chosen via /select button, consume that selection.
  try {
    await store.deleteSelected(chatId);
  } catch {
    // ignore cleanup failures
  }

  let conf: string;
  try {
    conf = await downloadTelegramFile(env.TG_BOT_TOKEN, doc.file_id);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Не удалось скачать файл: " + e.message);
    return;
  }

  await applyConf(chatId, bd, fileName, conf, env, store);
}

async function applyConf(
  chatId: number,
  bd: Binding,
  fileName: string,
  conf: string,
  env: Env,
  store: Store
): Promise<void> {
  const c = new KeeneticClient(bd.url, bd.login, bd.password);

  const alive = await c.ping();
  if (!alive) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Роутер недоступен.");
    return;
  }
  try {
    await c.auth();
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Авторизация не удалась: " + e.message);
    return;
  }

  // Strategy: this config becomes the ONLY WireGuard VPN on the router.
  // 1) remove all existing WireGuard interfaces,
  // 2) import the new config (creates one clean interface),
  // 3) enable the imported interface.
  await sendMessage(env.TG_BOT_TOKEN, chatId, `Очищаю старые WireGuard-конфиги на роутере ${bd.name}...`);
  let removed = 0;
  try {
    removed = await c.deleteAllWireGuard();
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Не удалось очистить старые конфиги: " + e.message);
    return;
  }

  await sendMessage(env.TG_BOT_TOKEN, chatId, `Импортирую новый конфиг на роутер ${bd.name}...`);
  try {
    await c.importWireGuard(conf, fileName);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Ошибка импорта: " + e.message);
    return;
  }

  // Determine the single imported interface and enable it.
  let ifaces: any[] = [];
  try {
    ifaces = await c.showWireGuardInterfaces();
  } catch {}
  const newId = ifaces.length === 1 ? ifaces[0].id : "";
  if (!newId) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Конфигурация WireGuard загружена на ${bd.name} как ${fileName}. Не удалось определить интерфейс для включения (конфигов: ${ifaces.length}) — включите вручную.`);
    return;
  }

  try {
    await c.setInterfaceEnabled(newId, true);
    bd.interface_id = newId;
    await store.update(bd);
    // Make VPN the primary internet interface; Ethernet stays as fallback.
    try {
      await c.setGlobalPriority(newId, 10, 0);
    } catch (e: any) {
      await sendMessage(env.TG_BOT_TOKEN, chatId, `VPN включён (${newId}), но не удалось сделать его основным интернет-подключением: ` + e.message);
      return;
    }
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Конфигурация WireGuard на ${bd.name} включена (интерфейс ${newId}) и назначена основным интернет-подключением (Ethernet — резерв). Старых конфигов очищено: ${removed}.`);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Конфигурация загружена, но не удалось включить интерфейс: ` + e.message);
  }
}

async function adminRouters(chatId: number, store: Store, env: Env): Promise<void> {
  if (!isAdmin(env, chatId)) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Команда доступна только администраторам.");
    return;
  }
  const all = await store.all();
  if (all.length === 0) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Пока нет ни одного привязанного роутера.");
    return;
  }
  const byOwner: Record<number, Binding[]> = {};
  for (const b of all) {
    if (!byOwner[b.chat_id]) byOwner[b.chat_id] = [];
    byOwner[b.chat_id].push(b);
  }
  let reply = "Все роутеры:\n";
  for (const [owner, list] of Object.entries(byOwner)) {
    reply += `\nВладелец ${owner}:\n`;
    for (const r of list) {
      const target = r.interface_id || "новый импорт";
      reply += `  - ${r.name} — ${r.url} (цель: ${target})\n`;
    }
  }
  reply += "\nАдмин-команды:\n/admin_status <ownerId> <name>\n/admin_unbind <ownerId> <name>";
  await sendMessage(env.TG_BOT_TOKEN, chatId, reply);
}

async function adminStatus(chatId: number, arg: string, store: Store, env: Env): Promise<void> {
  if (!isAdmin(env, chatId)) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Команда доступна только администраторам.");
    return;
  }
  const fields = arg.trim().split(/\s+/);
  if (fields.length < 2) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Использование: /admin_status <ownerId> <имя>");
    return;
  }
  const owner = parseInt(fields[0], 10);
  const name = fields[1];
  try {
    const bd = await store.get(owner, name);
    const c = new KeeneticClient(bd.url, bd.login, bd.password);
    const alive = await c.ping();
    if (!alive) {
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Роутер недоступен.");
      return;
    }
    await c.auth();
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Роутер ${bd.name} владельца ${owner} на связи и авторизован.`);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, e.message);
  }
}

async function adminUnbind(chatId: number, arg: string, store: Store, env: Env): Promise<void> {
  if (!isAdmin(env, chatId)) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Команда доступна только администраторам.");
    return;
  }
  const fields = arg.trim().split(/\s+/);
  if (fields.length < 2) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Использование: /admin_unbind <ownerId> <имя>");
    return;
  }
  const owner = parseInt(fields[0], 10);
  const name = fields[1];
  try {
    await store.remove(owner, name);
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Роутер ${name} владельца ${owner} удалён.`);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, e.message);
  }
}
