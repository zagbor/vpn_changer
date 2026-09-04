import { KeeneticClient } from "./keenetic.js";
import { ImpioClient, ImpioError } from "./impio.js";
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
        await notifyAdmin(env, who(errMsg), e);
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

    if (url.pathname === "/testadmin") {
      const key = url.searchParams.get("key");
      if (!env.SETUP_KEY || key !== env.SETUP_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const adminChat = env.ADMIN_LOG_CHAT;
      if (!adminChat || !env.TG_BOT_TOKEN) {
        return new Response("ADMIN_LOG_CHAT not configured", { status: 500 });
      }
      const ok = true;
      try {
        await sendMessage(env.TG_BOT_TOKEN, adminChat, "✅ Тестовое уведомление админу. Бот настроен, логи будут приходить сюда.");
      } catch (e: any) {
        return new Response("send failed: " + e?.message, { status: 500 });
      }
      return new Response(JSON.stringify({ ok, adminChat }), {
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

    // Temporary diagnostic: probe a target URL from inside Cloudflare's
    // network so we can see exactly why the router appears unreachable.
    if (url.pathname === "/probe") {
      const key = url.searchParams.get("key");
      if (!env.SETUP_KEY || key !== env.SETUP_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const target = url.searchParams.get("url") || "";
      if (!target) {
        return new Response("missing url", { status: 400 });
      }
      const timeout = parseInt(url.searchParams.get("timeout") || "15", 10);
      const report: Record<string, any> = {
        target,
        dns: { ok: false },
        http: null,
        error: null,
      };
      try {
        const resp = await fetch(target, { signal: AbortSignal.timeout(timeout * 1000), redirect: "manual" });
        report.http = {
          status: resp.status,
          headers: Object.fromEntries(resp.headers.entries()),
        };
      } catch (e: any) {
        report.error = String(e?.message || e);
      }
      try {
        const dns = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(new URL(target).hostname)}&type=A`,
          { headers: { accept: "application/dns-json" } }
        ).then((r) => r.json());
        report.dns = dns;
      } catch (e: any) {
        report.dns = { ok: false, error: String(e?.message || e) };
      }
      return new Response(JSON.stringify(report, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
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
// detail identifies who triggered it so the operator knows where it came from.
async function notifyAdmin(env: Env, detail: string, err: unknown): Promise<void> {
  const adminChat = env.ADMIN_LOG_CHAT;
  if (!adminChat || !env.TG_BOT_TOKEN) return;

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
    detail,
    `ошибка: ${errText.slice(0, 600)}`,
  ].filter(Boolean).join(CRLF);

  try {
    await sendMessage(env.TG_BOT_TOKEN, adminChat, log);
  } catch {
    // never let logging break message handling
  }
}

// back sends an informational message to the user with a "home" button.
async function back(env: Env, chatId: number, text: string): Promise<void> {
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    text,
    [{ text: "🏠 В начало", callback_data: "nav:main" }]
  );
}

// who describes a user/chat for the admin log.
function who(msg: TelegramMessage | undefined, chatId?: number): string {
  if (msg?.chat?.id) {
    return `пользователь: ${msg.chat.id}${msg.chat.type ? " (" + msg.chat.type + ")" : ""}`;
  }
  if (chatId) return `пользователь: ${chatId}`;
  return "пользователь: неизвестен";
}

// userError logs the error to the admin AND shows it to the user (with home
// button). Use for every soft error we send the user so the operator sees logs.
async function userError(env: Env, text: string, msg?: TelegramMessage, chatId?: number): Promise<void> {
  try {
    await notifyAdmin(env, who(msg, chatId), new Error(text));
  } catch {
    // logging must never break the user-facing reply
  }
  const id = msg?.chat?.id ?? chatId;
  if (id) {
    await back(env, id, text);
  }
}

// retry runs fn up to attempts times, waiting delayMs between attempts.
// Used for transient network unavailability (router rebooting, Wi-Fi hop, etc.).
async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 3000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
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

  // Multi-step impio authorization
  const impioBindState = await store.getImpioBindState(chatId);
  if (impioBindState && msg.text) {
    await handleImpioBindStep(msg, impioBindState, store, env);
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

    case "/impio":
      await showMainMenu(chatId, env);
      break;

    case "/impio_login":
      await impioStartLogin(chatId, store, env);
      break;

    case "/impio_sync":
      await impioSync(chatId, arg, store, env);
      break;

    case "/impio_status":
      await impioStatus(chatId, store, env);
      break;

    case "/impio_logout":
      await impioLogout(chatId, store, env);
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
  let alive = false;
  try {
    alive = await retry(() => c.ping(), 3, 3000);
  } catch {
    alive = false;
  }
  if (!alive) {
    await userError(env, "Роутер недоступен. Проверьте URL.", undefined, chatId);
    return;
  }
  try {
    await retry(() => c.auth(), 3, 3000);
  } catch (e: any) {
    await userError(env, "Ошибка авторизации: " + e.message, undefined, chatId);
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
    await userError(env, "Ошибка сохранения: " + e.message, undefined, chatId);
    return;
  }

  const target = state.interface_id || "импорт как новый файл";
  await back(env, chatId, `Роутер ${state.name} привязан! Цель: ${target}.\nТеперь отправьте WireGuard .conf, чтобы заменить VPN.`);
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
    { text: "📡 Авторизация роутера", callback_data: "nav:router-auth" },
    { text: "🔑 Авторизация Impio", callback_data: "nav:impio-auth" },
    { text: "🔌 Подключение ключа на роутере", callback_data: "nav:io-connect" },
  ];
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "Главное меню VPN Changer. Выберите действие:",
    buttons
  );
}

// showRouterAuthMenu shows the router authorization submenu (bind / unbind).
async function showRouterAuthMenu(chatId: number, env: Env): Promise<void> {
  const buttons = [
    { text: "📡 Привязать роутер", callback_data: "nav:binds" },
    { text: "🚫 Отвязать роутер", callback_data: "nav:router-unbind" },
    { text: "🏠 В начало", callback_data: "nav:main" },
  ];
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "Авторизация роутера. Выберите действие:",
    buttons
  );
}

// showImpioAuthMenu shows the Impio account authorization submenu (bind / unbind).
async function showImpioAuthMenu(chatId: number, env: Env): Promise<void> {
  const buttons = [
    { text: "🔑 Привязать аккаунт Impio", callback_data: "nav:impio-bind" },
    { text: "🚫 Отвязать аккаунт Impio", callback_data: "nav:impio-unbind" },
    { text: "🏠 В начало", callback_data: "nav:main" },
  ];
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "Авторизация Impio. Выберите действие:",
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
        case "binds":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Начинаю привязку");
          await store.setBindState(chatId, { step: 0 });
          await sendInlineKeyboard(
            env.TG_BOT_TOKEN,
            chatId,
            "Привязка роутера.\n\nШаг 1/5: введите адрес роутера.\nНапример: https://ваш-ник.keenetic.link или https://192.168.1.1",
            [{ text: "🏠 В начало", callback_data: "nav:main" }]
          );
          break;
        case "router-auth":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await showRouterAuthMenu(chatId, env);
          break;
        case "router-unbind":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await pickRouterList(chatId, store, env, "remove");
          break;
        case "impio-login":
        case "impio-bind":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Начинаю авторизацию Impio");
          await impioStartLogin(chatId, store, env);
          break;
        case "impio-auth":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
          await showImpioAuthMenu(chatId, env);
          break;
        case "impio-unbind":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Отвязываю аккаунт Impio");
          await impioLogout(chatId, store, env);
          break;
        case "io-connect":
          await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Подключение ключа Impio");
          await ioConnectMenu(chatId, store, env);
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
        await back(env, chatId, `Роутер ${name} выбран. Отправьте WireGuard .conf — он будет применён именно к нему.`);
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

    if (data.startsWith("io:")) {
      const io = data.slice(3);
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
      switch (io) {
        case "login":
          await impioStartLogin(chatId, store, env);
          break;
        case "keys":
          await impioListKeys(chatId, store, env);
          break;
        case "sync":
          await impioPickRouterForSync(chatId, store, env);
          break;
        case "replace":
          await ioConnectMenu(chatId, store, env);
          break;
        case "status":
          await impioStatus(chatId, store, env);
          break;
        case "logout":
          await impioLogout(chatId, store, env);
          break;
        default:
          await back(env, chatId, "Неизвестное действие Impio.");
      }
      return;
    }

    // pick a router to apply an impio key to
    if (data.startsWith("iolet:")) {
      const name = data.slice(6);
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, `Применяю ключ на ${name}`);
      await impioFetchAndApply(chatId, name, store, env);
      return;
    }

    // "Connect key to router" flow (step 3 of the main menu).
    // ioconn:<routerName> — router chosen; auto-detect whether it already has a key.
    if (data.startsWith("ioconn:")) {
      const router = data.slice(7);
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Проверяю наличие ключа на роутере...");
      await impioConnectPickRouter(chatId, router, store, env);
      return;
    }
    // iocrtr — pick the router for the connect flow
    if (data === "iocrtr") {
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
      await impioConnectPickRouterList(chatId, store, env);
      return;
    }
    // ioprot:<typeVpn> — protocol chosen, proceed to old key (replace) or location (create)
    if (data.startsWith("ioprot:")) {
      const typeVpn = parseInt(data.slice(7), 10);
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Протокол выбран");
      await impioReplacePickProtocolDone(chatId, typeVpn, store, env);
      return;
    }
    // ioprotret — user wants to change the protocol after a failure
    if (data === "ioprotret") {
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
      await impioReplacePickProtocol(chatId, store, env);
      return;
    }
    // ioreplk:<keyId> — old key chosen (replace mode), now pick new location
    if (data.startsWith("ioreplk:")) {
      const keyId = parseInt(data.slice(8), 10);
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
      await impioReplacePickLocation(chatId, keyId, store, env);
      return;
    }
    // ioreplnew — user does not want to replace any key; create a fresh one.
    if (data === "ioreplnew") {
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Создаём новый ключ");
      await impioReplacePickLocation(chatId, 0, store, env, true);
      return;
    }
    // iorepll:<locationId> — location chosen, show the Execute button
    if (data.startsWith("iorepll:")) {
      const locationId = data.slice(8);
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id);
      await impioReplaceConfirm(chatId, locationId, store, env);
      return;
    }
    // ioreplexec — run all operations sequentially
    if (data === "ioreplexec") {
      await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Выполняю подключение ключа...");
      await impioReplaceExecute(chatId, store, env);
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
    try {
      await notifyAdmin(env, who(undefined, chatId) + " (кнопка: " + data + ")", e);
    } catch {
      // ignore
    }
    await answerCallbackQuery(env.TG_BOT_TOKEN, cq.id, "Ошибка: " + (e?.message || e));
  }
}

async function unbind(chatId: number, name: string, store: Store, env: Env): Promise<void> {
  try {
    await store.remove(chatId, name);
    await back(env, chatId, `Роутер ${name} удалён.`);
  } catch (e: any) {
    await userError(env, "Ошибка отвязки: " + e.message, undefined, chatId);
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
    await userError(env, e.message, undefined, chatId);
    return;
  }

  const c = new KeeneticClient(bd.url, bd.login, bd.password);
  let alive = false;
  try {
    alive = await retry(() => c.ping(), 3, 3000);
  } catch {
    alive = false;
  }
  if (!alive) {
    await userError(env, `Роутер ${name} недоступен.`, undefined, chatId);
    return;
  }
  try {
    await retry(() => c.auth(), 3, 3000);
  } catch (e: any) {
    await userError(env, "Ошибка авторизации: " + e.message, undefined, chatId);
    return;
  }

  await back(env, chatId, `Очищаю WireGuard-конфиги на роутере ${name}...`);
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
    await back(
      env,
      chatId,
      `С роутера ${name} удалено конфигов: ${removed}. VPN снят, интернет вернётся на Ethernet.`
    );
  } catch (e: any) {
    await userError(env, "Не удалось удалить конфиги: " + e.message, undefined, chatId);
  }
}

async function status(chatId: number, arg: string, store: Store, env: Env): Promise<void> {
  const name = arg.trim();
  try {
    const bd = await store.get(chatId, name);
    const c = new KeeneticClient(bd.url, bd.login, bd.password);
    let alive = false;
    try {
      alive = await retry(() => c.ping(), 3, 3000);
    } catch {
      alive = false;
    }
    if (!alive) {
      await userError(env, `Роутер ${bd.name} недоступен.`, undefined, chatId);
      return;
    }
    await retry(() => c.auth(), 3, 3000);
    await back(env, chatId, `Роутер ${bd.name} на связи и авторизован.`);
  } catch (e: any) {
    await userError(env, e.message, undefined, chatId);
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
    await userError(env, e.message, msg);
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
    await userError(env, "Не удалось скачать файл: " + e.message, msg);
    return;
  }

  await applyConf(chatId, bd, fileName, conf, env, store);
}

interface ApplyResult {
  ok: boolean;
  retryable: boolean;
  message: string;
}

async function applyConf(
  chatId: number,
  bd: Binding,
  fileName: string,
  conf: string,
  env: Env,
  store: Store,
  report = true
): Promise<ApplyResult> {
  const c = new KeeneticClient(bd.url, bd.login, bd.password);

  let alive = false;
  try {
    alive = await retry(() => c.ping(), 3, 3000);
  } catch {
    alive = false;
  }
  if (!alive) {
    const msg = `Роутер ${bd.name} недоступен.`;
    if (report) await userError(env, msg, undefined, chatId);
    return { ok: false, retryable: false, message: msg };
  }
  try {
    await retry(() => c.auth(), 3, 3000);
  } catch (e: any) {
    const msg = "Авторизация не удалась: " + e.message;
    if (report) await userError(env, msg, undefined, chatId);
    return { ok: false, retryable: false, message: msg };
  }

  // Strategy: this config becomes the ONLY WireGuard VPN on the router.
  // 1) remove all existing WireGuard interfaces,
  // 2) import the new config (creates one clean interface),
  // 3) enable the imported interface.
  await back(env, chatId, `Очищаю старые WireGuard-конфиги на роутере ${bd.name}...`);
  let removed = 0;
  try {
    removed = await c.deleteAllWireGuard();
  } catch (e: any) {
    const msg = "Не удалось очистить старые конфиги: " + e.message;
    if (report) await userError(env, msg, undefined, chatId);
    return { ok: false, retryable: true, message: msg };
  }

  await back(env, chatId, `Импортирую новый конфиг на роутер ${bd.name}...`);
  try {
    await c.importWireGuard(conf, fileName);
  } catch (e: any) {
    const msg = "Ошибка импорта: " + e.message;
    if (report) await userError(env, msg, undefined, chatId);
    return { ok: false, retryable: true, message: msg };
  }

  // Determine the single imported interface and enable it. Keenetic creates the
  // WireGuard interface asynchronously after import, so poll briefly until it
  // shows up before deciding the imported interface id.
  let ifaces: any[] = [];
  let newId = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      ifaces = await c.showWireGuardInterfaces();
    } catch {}
    if (ifaces.length === 1) {
      newId = ifaces[0].id;
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!newId) {
    const msg = `Конфигурация WireGuard загружена на ${bd.name} как ${fileName}. Не удалось определить интерфейс для включения (конфигов: ${ifaces.length}) — включите вручную.`;
    if (report) await userError(env, msg, undefined, chatId);
    return { ok: false, retryable: true, message: msg };
  }

  try {
    await c.setInterfaceEnabled(newId, true);
    bd.interface_id = newId;
    await store.update(bd);
    // Make VPN the primary internet interface; Ethernet stays as fallback.
    try {
      await c.setGlobalPriority(newId, 10, 0);
    } catch (e: any) {
      const msg = `VPN включён (${newId}), но не удалось сделать его основным интернет-подключением: ` + e.message;
      if (report) await userError(env, msg, undefined, chatId);
      return { ok: false, retryable: false, message: msg };
    }
    // Put the VPN interface on top and enabled in the "VPN" connection policy.
    try {
      await c.enableInVpnPolicy(newId);
    } catch (e: any) {
      const msg = `VPN включён и назначен основным, но не удалось включить его в политику VPN: ` + e.message;
      if (report) await userError(env, msg, undefined, chatId);
      return { ok: false, retryable: false, message: msg };
    }
    const okMsg = `Конфигурация WireGuard на ${bd.name} включена (интерфейс ${newId}), назначена основным интернет-подключением и поставлена первой в политике VPN (Ethernet — резерв). Старых конфигов очищено: ${removed}.`;
    await back(env, chatId, okMsg);
    return { ok: true, retryable: false, message: okMsg };
  } catch (e: any) {
    const msg = `Конфигурация загружена, но не удалось включить интерфейс: ` + e.message;
    if (report) await userError(env, msg, undefined, chatId);
    return { ok: false, retryable: true, message: msg };
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

// ---------------------------------------------------------------------------
// Impio (my.impio.space) — authorization & automatic key application
// ---------------------------------------------------------------------------

// impioStartLogin begins the multi-step authorization flow.
async function impioStartLogin(chatId: number, store: Store, env: Env): Promise<void> {
  await store.setImpioBindState(chatId, { step: 0 });
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "Авторизация на my.impio.space.\n\nШаг 1/2: введите логин (или email) от аккаунта impio.",
    [{ text: "🏠 В начало", callback_data: "nav:main" }]
  );
}

// impioCancel clears any in-progress impio auth.
async function impioCancel(chatId: number, store: Store, env: Env): Promise<void> {
  try {
    await store.deleteImpioBindState(chatId);
  } catch {
    // ignore
  }
  await showMainMenu(chatId, env);
}

// handleImpioBindStep processes each text step of the impio authorization flow.
async function handleImpioBindStep(
  msg: TelegramMessage,
  state: any,
  store: Store,
  env: Env
): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  switch (state.step) {
    case 0: // username
      state.username = text;
      state.step = 1;
      await store.setImpioBindState(chatId, state);
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Шаг 2/2: введите пароль от аккаунта impio.");
      break;

    case 1: // password -> attempt login
      state.password = text;
      state.step = 2;
      await store.setImpioBindState(chatId, state);
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Проверяю учётные данные...");
      try {
        const c = new ImpioClient();
        const res = await c.login(state.username, state.password);
        if (res.two_factor_required) {
          state.two_factor_token = res.two_factor_token;
          state.step = 3; // wait for 2FA code
          await store.setImpioBindState(chatId, state);
          await sendMessage(env.TG_BOT_TOKEN, chatId, "Включена двухфакторная аутентификация.\nВведите код подтверждения из приложения/сообщения:");
          return;
        }
        await saveImpioSession(chatId, state, c, store, env);
      } catch (e: any) {
        await store.deleteImpioBindState(chatId);
        await userError(env, "Не удалось авторизоваться на impio: " + e.message, msg);
      }
      break;

    case 2: // verify 2FA code
      if (!state.two_factor_token) {
        await impioCancel(chatId, store, env);
        return;
      }
      await sendMessage(env.TG_BOT_TOKEN, chatId, "Проверяю код...");
      try {
        const c = new ImpioClient();
        await c.verifyTwoFactor(state.two_factor_token, text);
        await saveImpioSession(chatId, state, c, store, env);
      } catch (e: any) {
        await store.deleteImpioBindState(chatId);
        await userError(env, "2FA-код неверный: " + e.message, msg);
      }
      break;

    default:
      await impioCancel(chatId, store, env);
  }
}

// saveImpioSession persists the verified impio credentials and confirms login.
async function saveImpioSession(
  chatId: number,
  state: any,
  c: ImpioClient,
  store: Store,
  env: Env
): Promise<void> {
  const account = {
    chat_id: chatId,
    username: state.username,
    password: state.password,
  };
  try {
    if (await store.hasImpio(chatId)) await store.updateImpio(account);
    else await store.addImpio(account);
  } catch (e: any) {
    await store.deleteImpioBindState(chatId);
    await userError(env, "Ошибка сохранения аккаунта impio: " + e.message, undefined, chatId);
    return;
  }
  await store.deleteImpioBindState(chatId);
  try {
    await c.logout();
  } catch {
    // ignore
  }
  await back(env, chatId, `Авторизация на my.impio.space прошла успешно (${state.username}).\n\nТеперь в главном меню нажмите «🔄 Подменить ключ на роутере через Impio».`);
}

// getImpioSession builds an ImpioClient and performs a fresh login using the
// stored credentials, returning the logged-in client.
async function getImpioSession(chatId: number, store: Store): Promise<ImpioClient> {
  const acc = await store.getImpio(chatId);
  const c = new ImpioClient();
  const res = await c.login(acc.username, acc.password);
  if (res.two_factor_required) {
    throw new ImpioError("Для аккаунта impio включена 2FA — авторизация требует код. Перепроверьте аккаунт.");
  }
  return c;
}

// impioStatus verifies the account can log in.
async function impioStatus(chatId: number, store: Store, env: Env): Promise<void> {
  let username = "";
  try {
    const acc = await store.getImpio(chatId);
    username = acc.username;
  } catch (e: any) {
    await back(env, chatId, e.message);
    return;
  }
  try {
    const c = await getImpioSession(chatId, store);
    const keys = await c.getKeys();
    try {
      await c.logout();
    } catch {
      // ignore
    }
    await back(env, chatId, `✅ Связь с my.impio.space работает (${username}).\nДоступных ключей: ${keys.length}.`);
  } catch (e: any) {
    await userError(env, "Не удалось подтвердить подключение к impio: " + e.message, undefined, chatId);
  }
}

// impioListKeys logs in and shows the user's keys.
async function impioListKeys(chatId: number, store: Store, env: Env): Promise<void> {
  let username = "";
  try {
    const acc = await store.getImpio(chatId);
    username = acc.username;
  } catch (e: any) {
    await back(env, chatId, e.message);
    return;
  }
  try {
    const c = await getImpioSession(chatId, store);
    const keys = await c.getKeys();
    try {
      await c.logout();
    } catch {
      // ignore
    }
    if (keys.length === 0) {
      await back(env, chatId, `В аккаунте impio (${username}) нет ключей.`);
      return;
    }
    let reply = `Ключи impio (${username}):\n`;
    for (const k of keys) {
      reply += `- #${k.id} ${k.name || ""} [${k.protocol_name || "?"}] ${k.location_name || ""}${k.is_connected ? " ● активен" : ""}\n`;
    }
    await back(env, chatId, reply);
  } catch (e: any) {
    await userError(env, "Не удалось получить ключи impio: " + e.message, undefined, chatId);
  }
}

// impioPickRouterForSync shows the user's routers to pick where to apply a key.
async function impioPickRouterForSync(chatId: number, store: Store, env: Env): Promise<void> {
  const list = await store.list(chatId);
  if (list.length === 0) {
    await back(env, chatId, "Нет привязанных роутеров. Сначала «Привязать роутер».");
    return;
  }
  const buttons = list.map((r) => ({
    text: r.name,
    callback_data: `iolet:${r.name}`,
  }));
  buttons.push({ text: "🏠 В начало", callback_data: "nav:main" });
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "Выберите роутер, на который применить ключ impio (старые ключи будут очищены, новый станет основным интернетом):",
    buttons
  );
}

// impioSync is the command entry that asks for a router, or applies to the
// selected router if only one is bound.
async function impioSync(chatId: number, arg: string, store: Store, env: Env): Promise<void> {
  const name = arg.trim();
  if (name) {
    try {
      await store.get(chatId, name);
    } catch (e: any) {
      await back(env, chatId, e.message);
      return;
    }
    await impioFetchAndApply(chatId, name, store, env);
    return;
  }
  const list = await store.list(chatId);
  if (list.length === 1) {
    await impioFetchAndApply(chatId, list[0].name, store, env);
    return;
  }
  await impioPickRouterForSync(chatId, store, env);
}

// impioFetchAndApply fetches the WireGuard key from impio and applies it to the
// given router, reusing applyConf (which clears old keys, imports, enables and
// makes the new key the primary internet).
async function impioFetchAndApply(
  chatId: number,
  name: string,
  store: Store,
  env: Env
): Promise<void> {
  let bd: Binding;
  try {
    bd = await store.get(chatId, name);
  } catch (e: any) {
    await back(env, chatId, e.message);
    return;
  }

  await back(env, chatId, "Забираю ключ из my.impio.space...");
  let client: ImpioClient | undefined;
  let config: Awaited<ReturnType<ImpioClient["getKeyConfig"]>> | undefined;
  try {
    // Whole impio flow (login -> keys -> config) is retried to ride out
    // transient upstream unavailability before touching the router.
    await retry(async () => {
      const c = await getImpioSession(chatId, store);
      const key = await c.pickWireGuardKey();
      const cfg = await c.getKeyConfig(key.id);
      client = c;
      config = cfg;
    }, 3, 2500);
  } catch (e: any) {
    await userError(env, "Не удалось получить ключ impio: " + e.message, undefined, chatId);
    return;
  }
  if (!client || !config) {
    await userError(env, "Не удалось получить ключ impio: пустой ответ.", undefined, chatId);
    return;
  }
  try {
    await client.logout();
  } catch {
    // ignore
  }

  const conf = config.content;
  const fileName = config.filename || "impvpn.conf";
  await applyConf(chatId, bd, fileName, conf, env, store);
}

// impioLogout removes the stored impio credentials.
async function impioLogout(chatId: number, store: Store, env: Env): Promise<void> {
  try {
    await store.removeImpio(chatId);
    await back(env, chatId, "Аккаунт impio отвязан.");
  } catch (e: any) {
    await back(env, chatId, e.message);
  }
}

// ioConnectMenu is the entry to "Подключение ключа на роутере": a small menu with
// a single "Подключить" button that starts the connect/replace flow.
async function ioConnectMenu(chatId: number, store: Store, env: Env): Promise<void> {
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "🔌 Подключение ключа на роутере.\n\nНажмите «Подключить», чтобы подключить ключ Impio к вашему роутеру.\n" +
      "• если на роутере ещё нет ключа — выпустим новый и установим его\n" +
      "• если ключ уже есть — выберете его в Impio, удалим и подменим новым",
    [
      { text: "✅ Подключить", callback_data: "iocrtr" },
      { text: "🏠 В начало", callback_data: "nav:main" },
    ]
  );
}

// impioConnectPickRouterList asks which router to connect the key to.
async function impioConnectPickRouterList(chatId: number, store: Store, env: Env): Promise<void> {
  const list = await store.list(chatId);
  if (list.length === 0) {
    await back(env, chatId, "Нет привязанных роутеров — сначала привяжите роутер.");
    return;
  }
  const buttons = list.map((r) => ({
    text: r.name,
    callback_data: `ioconn:${r.name}`,
  }));
  buttons.push({ text: "🏠 В начало", callback_data: "nav:main" });
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "Выберите роутер, к которому подключить ключ:",
    buttons
  );
}

// impioConnectPickRouter is called after a router is selected. It checks whether
// the router already has a WireGuard key, then branches:
//   - key exists -> mode "replace": pick the old key to delete, then new location
//   - no key     -> mode "create": pick the new location directly
async function impioConnectPickRouter(chatId: number, router: string, store: Store, env: Env): Promise<void> {
  let bd: Binding;
  try {
    bd = await store.get(chatId, router);
  } catch (e: any) {
    await back(env, chatId, e.message);
    return;
  }

  await back(env, chatId, `Проверяю наличие ключа на роутере ${router}...`);
  const c = new KeeneticClient(bd.url, bd.login, bd.password);
  let alive = false;
  try {
    alive = await retry(() => c.ping(), 3, 3000);
  } catch {
    alive = false;
  }
  if (!alive) {
    await userError(env, `Роутер ${router} недоступен.`, undefined, chatId);
    return;
  }
  try {
    await retry(() => c.auth(), 3, 3000);
  } catch (e: any) {
    await userError(env, "Авторизация на роутере не удалась: " + e.message, undefined, chatId);
    return;
  }

  let ifaces: any[] = [];
  try {
    ifaces = await c.showWireGuardInterfaces();
  } catch {
    ifaces = [];
  }
  const hasKey = ifaces.length > 0;

  await store.setImpioReplaceState(chatId, {
    mode: hasKey ? "replace" : "create",
    router,
  });

  // Ask which WireGuard protocol to use (available on impio).
  await impioReplacePickProtocol(chatId, store, env);
}

// WireGuard-compatible protocols on impio (those giving a [Interface]/[Peer]
// config compatible with Keenetic). type_vpn: 3 = WireGuard Xray, 4 = impWG,
// 11 = AmneziaWG. Other types (1,6,10 = VLESS variants) are NOT Keenetic-compatible.
const IMPIO_WG_PROTOCOLS: { type: number; name: string }[] = [
  { type: 3, name: "WireGuard Xray" },
  { type: 4, name: "impWG" },
  { type: 11, name: "AmneziaWG" },
];

// impioReplacePickProtocol asks which WireGuard protocol to use. All three
// supported protocols are shown; their per-location availability is verified
// during execution (switch-location), because availability depends on location.
async function impioReplacePickProtocol(chatId: number, store: Store, env: Env): Promise<void> {
  const cur = (await store.getImpioReplaceState(chatId)) || {};
  const buttons = IMPIO_WG_PROTOCOLS.map((p) => ({
    text: p.name,
    callback_data: `ioprot:${p.type}`,
  }));
  buttons.push({ text: "🏠 В начало", callback_data: "nav:main" });
  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    `✅ Роутер: ${cur.router}\n\nВопрос протокола: какой WireGuard-протокол использовать?`,
    buttons
  );
}

// impioReplacePickProtocolDone saves the chosen protocol and continues: for
// replace mode -> ask old key; for create mode -> ask location directly.
async function impioReplacePickProtocolDone(chatId: number, typeVpn: number, store: Store, env: Env): Promise<void> {
  const cur = (await store.getImpioReplaceState(chatId)) || {};
  const proto = IMPIO_WG_PROTOCOLS.find((p) => p.type === typeVpn);
  const protocolName = proto ? proto.name : `Тип ${typeVpn}`;
  await store.setImpioReplaceState(chatId, { ...cur, protocolType: typeVpn, protocolName });

  await impioReplacePickOldKey(chatId, cur.router || "", store, env);
}

// impioReplacePickOldKey saves the chosen router and, when the account has at
// least one key, asks which existing key on the service to replace (the one that
// will be deleted after the new key installs). A "Create new" button is always
// available instead. If the account has no keys, this step is skipped and we go
// straight to creating a fresh key.
async function impioReplacePickOldKey(chatId: number, router: string, store: Store, env: Env): Promise<void> {
  await store.setImpioReplaceState(chatId, { router, ...(await store.getImpioReplaceState(chatId) || {}) });

  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    "Загрузка списка ключей...",
    [{ text: "🏠 В начало", callback_data: "nav:main" }]
  );
  let c: ImpioClient | undefined;
  try {
    c = await getImpioSession(chatId, store);
    const keys = await c.getKeys();
    await c.logout().catch(() => {});
    if (keys.length === 0) {
      // No keys on impio — skip replacement, go straight to creating a new one.
      await impioReplacePickLocation(chatId, 0, store, env, true);
      return;
    }
    const buttons = keys.map((k) => ({
      text: `#${k.id} ${k.name || ""} [${k.location_name || "?"}]${
        (k as any).tariff_plan ? " (" + (k as any).tariff_plan + ")" : ""
      }`,
      callback_data: `ioreplk:${k.id}`,
    }));
    buttons.push({ text: "🆕 Создать новый", callback_data: "ioreplnew" });
    buttons.push({ text: "🏠 В начало", callback_data: "nav:main" });
    await sendInlineKeyboard(
      env.TG_BOT_TOKEN,
      chatId,
      `🔌 На роутере ${router} подключим ключ Impio.\n\nВыберите, какой ключ на my.impio.space заменить (он будет удалён после установки нового), либо создайте новый:`,
      buttons
    );
  } catch (e: any) {
    try { c?.logout().catch(() => {}); } catch {}
    await userError(env, "Не удалось получить ключи impio: " + e.message, undefined, chatId);
  }
}

// impioReplacePickLocation saves the old key (if replacing) and asks which
// location the new key should use. createOnly=true means there is no old key and
// no existing VPN on the router (we just issue and apply a fresh one).
async function impioReplacePickLocation(chatId: number, oldKeyId: number, store: Store, env: Env, createOnly = false): Promise<void> {
  const cur = (await store.getImpioReplaceState(chatId)) || {};
  const next: any = { ...cur };
  if (!createOnly) {
    next.oldKeyId = oldKeyId;
    next.mode = "replace";
  } else {
    next.mode = "create";
    delete next.oldKeyId;
  }
  await store.setImpioReplaceState(chatId, next);

  let c: ImpioClient | undefined;
  try {
    c = await getImpioSession(chatId, store);
    const locs = await c.getLocations(cur.protocolType);
    await c.logout().catch(() => {});
    const usable = locs.filter((l) => l.work !== false);
    if (usable.length === 0) {
      await store.deleteImpioReplaceState(chatId);
      await back(env, chatId, "Нет доступных локаций для выбранного протокола на сервисе.");
      return;
    }
    const buttons = usable.map((l) => ({
      text: l.server_count ? `${l.name} (${l.server_count})` : l.name,
      callback_data: `iorepll:${l.id}`,
    }));
    buttons.push({ text: "🏠 В начало", callback_data: "nav:main" });
    const head = createOnly
      ? `✅ Роутер: ${cur.router}\n🔌 Протокол: ${cur.protocolName || "?"}\n🔑 Создаём новый ключ.\n\nВ какую локацию выпустить новый ключ? (серверы: ${cur.protocolName || "?"})`
      : `✅ Роутер: ${cur.router}\n🔌 Протокол: ${cur.protocolName || "?"}\n✅ Старый ключ: #${oldKeyId}\n\nВ какую локацию создать новый ключ? (серверы: ${cur.protocolName || "?"})`;
    await sendInlineKeyboard(env.TG_BOT_TOKEN, chatId, head, buttons);
  } catch (e: any) {
    try { c?.logout().catch(() => {}); } catch {}
    await userError(env, "Не удалось получить локации impio: " + e.message, undefined, chatId);
  }
}

// impioReplaceConfirm saves the location and shows the final confirmation with
// the single "Выполнить" button.
async function impioReplaceConfirm(chatId: number, locationId: string, store: Store, env: Env): Promise<void> {
  let c: ImpioClient | undefined;
  let locationName = locationId;
  try {
    c = await getImpioSession(chatId, store);
    const cur0 = (await store.getImpioReplaceState(chatId)) || {};
    const locs = await c.getLocations(cur0.protocolType);
    const loc = locs.find((l) => String(l.id) === String(locationId));
    if (loc) locationName = loc.name;
    await c.logout().catch(() => {});
  } catch (e: any) {
    try { c?.logout().catch(() => {}); } catch {}
    await userError(env, "Не удалось получить локации impio: " + e.message, undefined, chatId);
    return;
  }

  const cur = (await store.getImpioReplaceState(chatId)) || {};
  await store.setImpioReplaceState(chatId, { ...cur, locationId, locationName });
  const mode = cur.mode || (cur.oldKeyId ? "replace" : "create");

  let summary = `Проверьте выбор перед выполнением:\n\n`;
  if (mode === "replace") {
    summary +=
      `📡 Роутер: ${cur.router}\n` +
      `🔌 Протокол: ${cur.protocolName || "?"}\n` +
      `🗑 Старый ключ Impio: #${cur.oldKeyId} (удалим)\n` +
      `📍 Новая локация: ${locationName}\n\n` +
      `Нажмите «Выполнить» — и бот поочерёдно:\n` +
      `1) создаст новый ключ на my.impio.space (имя: роутер)\n` +
      `2) переключит его в локацию ${locationName} (протокол ${cur.protocolName || "?"})\n` +
      `3) удалит старый ключ #${cur.oldKeyId}\n` +
      `4) подменит ключ на роутере ${cur.router}`;
  } else {
    summary +=
      `📡 Роутер: ${cur.router}\n` +
      `🔌 Протокол: ${cur.protocolName || "?"}\n` +
      `📍 Новая локация: ${locationName}\n\n` +
      `Нажмите «Выполнить» — и бот поочерёдно:\n` +
      `1) выпустит новый ключ на my.impio.space (имя: роутер)\n` +
      `2) переключит его в локацию ${locationName} (протокол ${cur.protocolName || "?"})\n` +
      `3) установит ключ на роутер ${cur.router}`;
  }

  await sendInlineKeyboard(
    env.TG_BOT_TOKEN,
    chatId,
    summary,
    [
      { text: "✅ Выполнить", callback_data: "ioreplexec" },
      { text: "🏠 В начало", callback_data: "nav:main" },
    ]
  );
}

// impioReplaceExecute runs all replace operations sequentially.
async function impioReplaceExecute(chatId: number, store: Store, env: Env): Promise<void> {
  const st = await store.getImpioReplaceState(chatId);
  if (!st || !st.router || !st.locationId) {
    await back(env, chatId, "Данные подключения ключа утеряны — начните заново.");
    return;
  }
  const router = st.router;
  const mode = st.mode === "create" ? "create" : "replace";
  const oldKeyId = st.oldKeyId;
  const locationIdStr = st.locationId;
  const locationName = st.locationName || st.locationId;
  // New key name = start of the router address/name: either the first 10 chars,
  // or everything up to the first dot if that dot comes before the 10th char.
  const keyNameRaw = router.replace(/\s+/g, "");
  const keyDot = keyNameRaw.indexOf(".");
  let keyName: string;
  if (keyDot !== -1 && keyDot < 10) keyName = keyNameRaw.slice(0, keyDot);
  else keyName = keyNameRaw.slice(0, 10);
  keyName = keyName || "router";

  let bd: Binding;
  try {
    bd = await store.get(chatId, router);
  } catch (e: any) {
    await store.deleteImpioReplaceState(chatId);
    await back(env, chatId, e.message);
    return;
  }

  let c: ImpioClient | undefined;
  try {
    c = await getImpioSession(chatId, store);

    await sendInlineKeyboard(
      env.TG_BOT_TOKEN,
      chatId,
      `⏳ Шаг 1/${mode === "replace" ? 4 : 3} — выпускаю новый ключ «${keyName}» на my.impio.space...`,
      [{ text: "🏠 В начало", callback_data: "nav:main" }]
    );

    // Determine tariff from the old key when replacing, otherwise default "format".
    let tariff = "format";
    if (mode === "replace" && oldKeyId) {
      const keys = await c.getKeys();
      const old = keys.find((k) => String(k.id) === String(oldKeyId));
      if (old && (old as any).tariff_plan) tariff = (old as any).tariff_plan;
    }
    let newKeyId: number;
    try {
      newKeyId = await c.createKey(tariff, { name: keyName });
    } catch {
      // Some API versions reject the extra "name" field; retry without it.
      newKeyId = await c.createKey(tariff);
    }

    await sendInlineKeyboard(
      env.TG_BOT_TOKEN,
      chatId,
      `✅ Ключ №${newKeyId} («${keyName}») выпущен.\n⏳ Шаг 2/${mode === "replace" ? 4 : 3} — переключаю в локацию ${locationName}...`,
      [{ text: "🏠 В начало", callback_data: "nav:main" }]
    );

    // File name pieces: key #, protocol, location (emberly; no emoji in it).
    const sfProto = (st.protocolName || (st.protocolType ? "wg" + st.protocolType : "wg"))
      .replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 12) || "wg";
    const sfLoc = String(locationName || "")
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, "").slice(0, 12) || "loc";

    const protocolTypes = st.protocolType ? [st.protocolType] : [4, 11];

    // Try to get a usable config for the current key. Returns null when no
    // server/config is available for the chosen location+protocol.
    const obtainConfig = async (keyId: number): Promise<string | null> => {
      let serverId: number | string | undefined;
      for (const tv of protocolTypes) {
        const servers = (await c!.getServers(locationIdStr, tv, keyId).catch(() => [])) as import("./impio.js").ImpioServer[];
        if (!servers.length) continue;
        const sorted = [...servers]
          .filter((s) => s.work !== false)
          .sort((a, b) => (a.load_percentage ?? 0) - (b.load_percentage ?? 0));
        for (const s of sorted) {
          try {
            const cfg = await c!.switchLocation(keyId, s.id, locationName);
            serverId = s.id;
            if (cfg && cfg.content) return cfg.content;
          } catch {
            // this server/location failed -> try the next one
          }
        }
        if (serverId) return null;
      }
      return null;
    };

    // First pass: use the already-created key. If the config turns out broken
    // (Keenetic can't import it: "unable to find private key", no interface,
    // empty config), release a fresh key and retry — up to MAX_INSTALL_ATTEMPTS.
    // The old key (replace mode) is deleted only AFTER a successful install.
    const MAX_INSTALL_ATTEMPTS = 3;
    let installed = false;
    let lastErr = "";
    let cfgContent: string | null = await obtainConfig(newKeyId);
    if (!cfgContent) {
      // No server/config for this location+protocol — offer another choice.
      try { await c!.deleteKey(newKeyId); } catch {}
      if (st.protocolType) {
        await askLocationAgainPreserving(chatId, store, env,
          `❗ В локации «${locationName}» протокол ${st.protocolName || st.protocolType} сейчас недоступен (нет свободных серверов).\n\n` +
          (mode === "replace" ? `Старый ключ #${oldKeyId} не тронут. ` : `Новый ключ не выпущен. `) +
          `Выберите другую локацию или протокол:`,
          mode === "replace" ? (oldKeyId ?? 0) : 0, true);
      } else {
        await askLocationAgainPreserving(chatId, store, env,
          `❗ Переход в локацию «${locationName}» сейчас невозможен (серверы перегружены или недоступны).\n\n` +
          (mode === "replace" ? `Старый ключ #${oldKeyId} не тронут. ` : `Новый ключ не выпущен. `) +
          `Выберите, пожалуйста, другую локацию:`,
          mode === "replace" ? (oldKeyId ?? 0) : 0);
      }
      return;
    }

    for (let attempt = 1; attempt <= MAX_INSTALL_ATTEMPTS && !installed; attempt++) {
      if (attempt > 1) {
        // The config was broken / router rejected the current key — new key.
        try { if (newKeyId) await c.deleteKey(newKeyId); } catch {}
        try {
          newKeyId = await c.createKey(tariff, { name: keyName });
        } catch {
          newKeyId = await c.createKey(tariff);
        }
        await sendInlineKeyboard(
          env.TG_BOT_TOKEN,
          chatId,
          `🔄 Ключ №${newKeyId} («${keyName}») не встал на роутер — выпустил новый.\n⏳ Переключаю новый ключ в локацию ${locationName}...`,
          [{ text: "🏠 В начало", callback_data: "nav:main" }]
        );
        cfgContent = await obtainConfig(newKeyId);
        if (!cfgContent) {
          lastErr = `ключ №${newKeyId} не дал рабочий конфиг в локации «${locationName}»`;
          continue;
        }
      }

      await sendInlineKeyboard(
        env.TG_BOT_TOKEN,
        chatId,
        `⏳ Устанавливаю ключ №${newKeyId} на роутер ${router}...`,
        [{ text: "🏠 В начало", callback_data: "nav:main" }]
      );
      const fileName = `imp-${newKeyId}-${sfProto}-${sfLoc}.conf`;
      const res = await applyConf(chatId, bd, fileName, cfgContent!, env, store, false);
      if (res.ok) {
        installed = true;
      } else {
        lastErr = res.message;
        if (!res.retryable) break;
      }
    }

    if (!installed) {
      // Clean up the freshly created (unused) key.
      try { if (newKeyId) await c.deleteKey(newKeyId); } catch {}
      try { await c.logout(); } catch {}
      await userError(env, `Не удалось установить ключ на роутер ${router}${lastErr ? `: ${lastErr}` : ""}.`, undefined, chatId);
      return;
    }

    // Installed OK — now (replace mode) delete the old key.
    if (mode === "replace" && oldKeyId) {
      await sendInlineKeyboard(
        env.TG_BOT_TOKEN,
        chatId,
        `✅ Ключ №${newKeyId} установлен на роутер ${router}.\n🗑 Удаляю старый ключ #${oldKeyId}...`,
        [{ text: "🏠 В начало", callback_data: "nav:main" }]
      );
      try {
        await c.deleteKey(oldKeyId);
        await sendInlineKeyboard(env.TG_BOT_TOKEN, chatId, `✅ Старый ключ #${oldKeyId} удалён.`, [{ text: "🏠 В начало", callback_data: "nav:main" }]);
      } catch (e: any) {
        await userError(env, `Ключ №${newKeyId} установлен, но не удалось удалить старый #${oldKeyId}: ${e.message}`, undefined, chatId);
      }
    }
    try { await c.logout(); } catch {}
    await store.deleteImpioReplaceState(chatId);
  } catch (e: any) {
    try { c?.logout().catch(() => {}); } catch {}
    await userError(env, "Не удалось подключить ключ impio: " + e.message, undefined, chatId);
  }
}

// askLocationAgainPreserving re-offers the location list after a switch failure,
// keeping the already-chosen router (and old key, when replacing) in state.
// When offerProtocol is true, an extra "change protocol" button is shown.
async function askLocationAgainPreserving(chatId: number, store: Store, env: Env, msg: string, oldKeyId: number, offerProtocol = false): Promise<void> {
  const cur = (await store.getImpioReplaceState(chatId)) || {};
  const next: any = { ...cur, locationId: undefined, locationName: undefined };
  if (oldKeyId > 0) {
    next.oldKeyId = oldKeyId;
    next.mode = "replace";
  } else {
    delete next.oldKeyId;
    next.mode = "create";
  }
  await store.setImpioReplaceState(chatId, next);
  let c: ImpioClient | undefined;
  try {
    c = await getImpioSession(chatId, store);
    const cur0 = (await store.getImpioReplaceState(chatId)) || {};
    const locs = await c.getLocations(cur0.protocolType);
    await c.logout().catch(() => {});
    const usable = locs.filter((l) => l.work !== false);
    const buttons = usable.map((l) => ({
      text: l.server_count ? `${l.name} (${l.server_count})` : l.name,
      callback_data: `iorepll:${l.id}`,
    }));
    if (offerProtocol) {
      buttons.push({ text: "🔌 Сменить протокол", callback_data: "ioprotret" });
    }
    buttons.push({ text: "🏠 В начало", callback_data: "nav:main" });
    await sendInlineKeyboard(env.TG_BOT_TOKEN, chatId, msg, buttons);
  } catch (e: any) {
    try { c?.logout().catch(() => {}); } catch {}
    await userError(env, "Не удалось получить локации impio: " + e.message, undefined, chatId);
  }
}


