import * as md5mod from "js-md5";

const md5: (input: string) => string = (md5mod as any).default || md5mod;

// Uses js-md5 (RFC 1321 compliant, battle-tested).
export function md5hex(input: string): string {
  return md5(input);
}

export function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return crypto.subtle.digest("SHA-256", data).then((buf) => {
    const arr = new Uint8Array(buf);
    return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
  });
}
