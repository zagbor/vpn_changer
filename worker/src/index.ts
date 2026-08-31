import { KeeneticClient } from "./keenetic.js";
import { sendMessage, downloadTelegramFile, splitCmd, type TelegramMessage } from "./telegram.js";
import { Store } from "./store.js";
import type { Env, Binding } from "./types.js";

const NAME_RE = /^[A-Za-z0-9_\-]{1,32}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("VPN Changer bot is running", { status: 200 });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      console.log("webhook received:", body);
      try {
        const update = JSON.parse(body);
        const msg = update?.message;
        if (msg) {
          console.log("processing message from chat", msg.chat?.id);
          await handleMessage(msg, env);
          console.log("finished message", msg.chat?.id);
        }
      } catch (e: any) {
        console.error("webhook error:", e?.message || e);
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
            allowed_updates: ["message"],
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

function helpText(): string {
  return [
    "VPN Changer — замена WireGuard на роутере Keenetic через Telegram.",
    "",
    "Один бот — много роутеров; каждый пользователь управляет своим.",
    "",
    "Команды:",
    "/bind — привязать роутер (URL, логин, пароль, имя, интерфейс)",
    "/routers — список ваших роутеров",
    "/setiface <имя> <id> — сменить заменяемый интерфейс (- = импорт нового)",
    "/status [имя] — проверить связь с роутером",
    "/unbind <имя> — отвязать роутер",
    "",
    "Смена VPN: просто отправьте WireGuard .conf файл.",
    "Если несколько роутеров — укажите имя в подписи к файлу.",
    "",
    "Для администраторов:",
    "/admin_routers — все роутеры всех пользователей",
    "/admin_status <ownerId> <имя> — проверить чужой роутер",
    "/admin_unbind <ownerId> <имя> — отвязать чужой роутер",
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
      await sendMessage(env.TG_BOT_TOKEN, chatId, helpText());
      break;

    case "/bind":
      await store.setBindState(chatId, { step: 0 });
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Привязка роутера.\n\nШаг 1/5: введите адрес роутера.\nНапример: https://ваш-ник.keenetic.link или https://192.168.1.1");
      break;

    case "/routers":
      await listRouters(chatId, store, env);
      break;

    case "/status":
      await status(chatId, arg, store, env);
      break;

    case "/unbind":
      if (!arg) {
        await sendMessage(env.TG_BOT_TOKEN, chatId, "Укажите имя: /unbind <имя>");
        return;
      }
      try {
        await store.remove(chatId, arg);
        await sendMessage(env.TG_BOT_TOKEN, chatId, `Роутер ${arg} удалён.`);
      } catch (e: any) {
        await sendMessage(env.TG_BOT_TOKEN, chatId, "Ошибка: " + e.message);
      }
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
  let out = `Диагностика ${bd.name} (хвост /rci/interface):\n`;
  try {
    const body = await c.rawGet("/rci/interface");
    out += `(всего ${body.length} chars)\n...${body.slice(-3400)}\n`;
  } catch (e: any) {
    out += `\nGET /rci/interface → ERR ${e.message}\n`;
  }
  await sendMessage(env.TG_BOT_TOKEN, chatId, out);
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
  reply += "\nОтправьте .conf, чтобы заменить VPN. При нескольких роутерах укажите имя в подписи.";
  await sendMessage(env.TG_BOT_TOKEN, chatId, reply);
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

  const name = (msg.caption || "").trim();

  let bd: Binding;
  try {
    bd = await store.get(chatId, name);
  } catch (e: any) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, e.message);
    return;
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
    await sendMessage(env.TG_BOT_TOKEN, chatId, `Конфигурация WireGuard на ${bd.name} включена (интерфейс ${newId}). Старых конфигов очищено: ${removed}.`);
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
