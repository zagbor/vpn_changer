const TG_API = "https://api.telegram.org";

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export async function tgRequest(
  token: string,
  method: string,
  body?: unknown
): Promise<any> {
  const resp = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  return resp.json();
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string
): Promise<void> {
  const res = await tgRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
  });
  console.log("sendMessage", chatId, "ok:", res?.ok, "desc:", res?.description);
}

export async function getFileDirectURL(
  token: string,
  fileId: string
): Promise<string> {
  const res = await tgRequest(token, "getFile", { file_id: fileId });
  if (!res.ok) throw new Error("getFile failed: " + JSON.stringify(res));
  return `https://api.telegram.org/file/bot${token}/${res.result.file_path}`;
}

export async function downloadTelegramFile(
  token: string,
  fileId: string
): Promise<string> {
  const url = await getFileDirectURL(token, fileId);
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error("download failed: " + resp.status);
  return resp.text();
}

export async function setWebhook(
  token: string,
  url: string
): Promise<any> {
  return tgRequest(token, "setWebhook", {
    url,
    allowed_updates: ["message"],
  });
}

export function splitCmd(text: string): [string, string] {
  const fields = text.trim().split(/\s+/);
  if (!fields.length) return ["", ""];
  let cmd = fields[0];
  const atIdx = cmd.indexOf("@");
  if (atIdx >= 0) cmd = cmd.substring(0, atIdx);
  return [cmd, fields.slice(1).join(" ")];
}
