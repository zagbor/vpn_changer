import { md5hex, sha256hex } from "./md5.js";
import type { AscParams, PeerParams, WireGuardInterface } from "./types.js";

async function resolveViaDoH(hostname: string): Promise<string[]> {
  // Try Google DoH first (different IP pool than Cloudflare's own DNS)
  const providers = [
    "https://dns.google/resolve",
    "https://cloudflare-dns.com/dns-query",
  ];
  for (const base of providers) {
    try {
      const resp = await fetch(
        `${base}?name=${encodeURIComponent(hostname)}&type=A`,
        {
          headers: { Accept: "application/dns-json" },
          signal: AbortSignal.timeout(5000),
        },
      );
      const data = (await resp.json()) as {
        Answer?: { data: string; type?: number }[];
      };
      const ips = (data.Answer || [])
        .filter((a) => !a.type || a.type === 1)
        .map((a) => a.data);
      if (ips.length > 0) return ips;
    } catch {
      // Try next provider
    }
  }
  return [];
}

export class KeeneticClient {
  private baseURL: string;
  private alternateBaseURL?: string;
  private login: string;
  private pass: string;
  private cookie = "";

  constructor(baseURL: string, login: string, pass: string) {
    let url = (baseURL || "").trim();
    let scheme = "notset";
    if (/^https:\/\//i.test(url)) scheme = "https";
    else if (/^http:\/\//i.test(url)) scheme = "http";

    if (scheme === "notset") {
      url = "https://" + url.replace(/^\/+/, "");
    }
    const host = url.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");

    // Prefer HTTPS: Keenetic often rejects RCI auth over plain HTTP even when
    // the router is reachable. Keep an HTTP variant only as a fallback for
    // routers that do not serve HTTPS at all.
    this.baseURL = `https://${host}`;
    this.alternateBaseURL = `http://${host}`;
    this.login = login;
    this.pass = pass;
  }

  async ping(): Promise<boolean> {
    if (await this.tryPing(this.baseURL)) return true;
    // Try DoH-resolved IPs with SNI override
    const hostname = this.baseURL.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const ips = await resolveViaDoH(hostname);
    for (const ip of ips) {
      try {
        const resp = await fetch(`https://${ip}/rci/show/version`, {
          headers: { Host: hostname },
          cf: { connect: { servername: hostname } },
          signal: AbortSignal.timeout(15000),
        });
        if (resp.status === 200 || resp.status === 401) return true;
      } catch {
        // IP failed
      }
    }
    if (this.alternateBaseURL) return this.tryPing(this.alternateBaseURL);
    return false;
  }

  private async tryPing(base: string): Promise<boolean> {
    try {
      const resp = await fetch(`${base}/rci/show/version`, {
        signal: AbortSignal.timeout(15000),
      });
      return resp.status === 200 || resp.status === 401;
    } catch {
      return false;
    }
  }

  // fetchBase requests against the primary (https) base, falling back to the
  // alternate (http) base only on network-level failures. It never falls back
  // on HTTP error statuses, so Keenetic's auth rejects are preserved.
  // When the primary URL returns 503 "Not Reachable" (netcraze tunnel issue),
  // it attempts a DoH-resolved IP fallback with proper SNI via cf.connect.
  private async fetchBase(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseURL}${path}`;
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      // Network-level failure: try alternate (http) base
      if (this.alternateBaseURL && this.alternateBaseURL !== this.baseURL) {
        return await fetch(`${this.alternateBaseURL}${path}`, init);
      }
      throw e;
    }

    // Check for netcraze tunnel "Not Reachable" — fall back to DoH IP resolution
    const xDetail = resp.headers.get("x-detail") || "";
    if (resp.status === 503 && /not reachable/i.test(xDetail)) {
      const hostname = this.baseURL.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      const altIp = await this.tryDoHFallback(hostname, path, init);
      if (altIp) return altIp;
    }

    return resp;
  }

  // Attempt to reach the router via DoH-resolved IPs using cf.connect for
  // proper SNI and Host header override. Returns the first successful response.
  private async tryDoHFallback(
    hostname: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response | null> {
    const ips = await resolveViaDoH(hostname);
    for (const ip of ips) {
      try {
        const resp = await fetch(`https://${ip}${path}`, {
          ...init,
          headers: {
            ...(init?.headers || {}),
            Host: hostname,
          },
          cf: { connect: { servername: hostname } },
          signal: AbortSignal.timeout(15000),
        });
        // If we get a response that isn't a netcraze error, use it
        const detail = resp.headers.get("x-detail") || "";
        if (resp.status !== 503 || !/not reachable/i.test(detail)) {
          return resp;
        }
      } catch {
        // IP failed, try next
      }
    }
    // If all DoH IPs fail, try HTTP alternate as last resort
    if (this.alternateBaseURL && this.alternateBaseURL !== this.baseURL) {
      try {
        return await fetch(`${this.alternateBaseURL}${path}`, init);
      } catch {
        // Give up
      }
    }
    return null;
  }

  async auth(): Promise<void> {
    const resp = await this.fetchBase("/auth", {
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 200 || resp.status === 201 || resp.status === 202) {
      return;
    }
    if (resp.status !== 401) {
      throw new Error(`Router unavailable (status ${resp.status})`);
    }

    const realm = resp.headers.get("x-ndm-realm") || "";
    const challenge = resp.headers.get("x-ndm-challenge") || "";
    const setCookie = (resp.headers.get("set-cookie") || "").split(";")[0];

    if (!realm || !challenge || !setCookie) {
      throw new Error("Missing auth challenge headers");
    }

    const md5sum = md5hex(`${this.login}:${realm}:${this.pass}`);
    const passHash = await sha256hex(challenge + md5sum);

    const resp2 = await this.fetchBase("/auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: setCookie,
      },
      body: JSON.stringify({ login: this.login, password: passHash }),
      signal: AbortSignal.timeout(15000),
    });

    if (resp2.status === 401) {
      throw new Error("Authentication failed: wrong login or password");
    }
    if (resp2.status < 200 || resp2.status > 299) {
      throw new Error(`Authentication failed (status ${resp2.status})`);
    }
    this.cookie = setCookie;
  }

  private async ensureAuth(): Promise<void> {
    if (!this.cookie) await this.auth();
  }

  // rawGet performs an authenticated GET and returns the raw response body.
  async rawGet(path: string): Promise<string> {
    const { data } = await this.do("GET", path);
    return typeof data === "string" ? data : JSON.stringify(data);
  }

  private async do(
    method: string,
    path: string,
    body?: unknown,
    contentType?: string
  ): Promise<{ data: any; status: number }> {
    const retries = 4;
    const delayMs = 1200;
    let lastErr: any;

    for (let attempt = 0; attempt < retries; attempt++) {
      await this.ensureAuth();
      const headers: Record<string, string> = {};
      if (contentType) headers["Content-Type"] = contentType;
      if (this.cookie) headers["Cookie"] = this.cookie;

      const resp = await this.fetchBase(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });

      const text = await resp.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      // Transient 5xx / 429 — retry with a pause.
      if (
        resp.status === 500 ||
        resp.status === 502 ||
        resp.status === 503 ||
        resp.status === 429
      ) {
        lastErr = new Error(`Router unavailable (status ${resp.status})`);
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }

      return { data, status: resp.status };
    }

    throw lastErr || new Error("RCI request failed after retries");
  }

  private checkError(data: any): void {
    if (data && typeof data === "object" && Array.isArray(data.status)) {
      for (const s of data.status) {
        if (s && s.status === "error") {
          throw new Error(`RCI error: ${s.message} (${s.code}) ${s.ident || ""}`);
        }
      }
    }
    if (!Array.isArray(data)) return;
    for (const r of data) {
      const statuses = r?.parse?.status;
      if (!Array.isArray(statuses)) continue;
      for (const s of statuses) {
        if (s.status === "error") {
          throw new Error(`RCI error: ${s.message} (${s.code}) ${s.ident}`);
        }
      }
    }
  }

  async importWireGuard(confContent: string, name: string): Promise<void> {
    const encoded = btoa(confContent);
    const { data, status } = await this.do(
      "POST",
      "/rci/interface/wireguard/import",
      { import: encoded, name: "", filename: name || "import.conf" },
      "application/json"
    );
    if (status < 200 || status > 299) {
      throw new Error(`Import failed (status ${status}): ${JSON.stringify(data)}`);
    }
    this.checkError(data);
  }

  // showWireGuardInterfaces lists WireGuard interfaces. It reads /rci/interface
  // because /rci/show/interface may return 503 on some firmware and does not
  // reliably expose wireguard descriptors.
  async showWireGuardInterfaces(): Promise<WireGuardInterface[]> {
    const { data, status } = await this.do("GET", "/rci/interface");
    if (status < 200 || status > 299) {
      throw new Error(`Show interface failed (status ${status})`);
    }
    const out: WireGuardInterface[] = [];
    if (data && typeof data === "object") {
      for (const [id, obj] of Object.entries(data as Record<string, any>)) {
        if (id.toLowerCase().startsWith("wireguard")) {
          out.push({
            id,
            type: "wireguard",
            name: obj?.description || "",
            state: obj?.up ? "up" : "down",
          });
        }
      }
    }
    return out;
  }

  // setInterfaceEnabled brings a WireGuard interface up (true) or down (false).
  // Uses the CLI up/down command through /rci/, then persists the config.
  async setInterfaceEnabled(id: string, enabled: boolean): Promise<void> {
    const cmd = enabled ? "up" : "down";
    const { data, status } = await this.do(
      "POST",
      "/rci/",
      [{ parse: `interface ${id} ${cmd}` }],
      "application/json"
    );
    if (status < 200 || status > 299) {
      throw new Error(`Enable/disable ${id} failed (status ${status}): ${JSON.stringify(data)}`);
    }
    this.checkError(data);
    try {
      await this.do("POST", "/rci/", [{ parse: "system configuration save" }], "application/json");
    } catch {
      // saving is optional for runtime up/down
    }
  }

  // setGlobalPriority marks an interface as a global (internet) provider with a
  // given priority. Lower priority number = higher route preference among the
  // router's "Connection priorities" (failover/balance). order is the tie-break.
  // NOTE: the CLI command `interface <id> ip global <N>` is the reliable way to
  // set this; the RCI POST (ip.global.priority) is ignored by Keenetic and the
  // priority stays unchanged, so we use the CLI command instead.
  async setGlobalPriority(id: string, priority: number, order = 0): Promise<void> {
    let cmd = `interface ${id} ip global ${priority}`;
    if (order) cmd += ` order ${order}`;
    const { data, status } = await this.do(
      "POST",
      "/rci/",
      [{ parse: cmd }],
      "application/json"
    );
    if (status < 200 || status > 299) {
      throw new Error(`Set priority on ${id} failed (status ${status}): ${JSON.stringify(data)}`);
    }
    this.checkError(data);
    try {
      await this.do("POST", "/rci/", [{ parse: "system configuration save" }], "application/json");
    } catch {
      // saving is optional
    }
  }

  // runCLI executes an NDMS CLI command via /rci/ and returns the raw response.
  async runCLI(cmd: string): Promise<any> {
    const { data, status } = await this.do(
      "POST",
      "/rci/",
      [{ parse: cmd }],
      "application/json"
    );
    if (status < 200 || status > 299) {
      throw new Error(`CLI '${cmd}' failed (status ${status})`);
    }
    return data;
  }

  // enableInVpnPolicy makes the given interface the FIRST permitted connection of
  // the "VPN" connection policy (see UI "Connection Policies"). This is what the
  // VPN policy checkbox does: it must be checked for the VPN interface and it
  // must appear at the top (first place) of that policy. Other already-permitted
  // connections are kept (Redundancy/failover), just moved after this one.
  // The target policy is found by its description "VPN"; falls back to Policy0.
  async enableInVpnPolicy(interfaceId: string): Promise<void> {
    // 1) Find policies
    const { data: policies, status: polStatus } = await this.do("GET", "/rci/ip/policy");
    if (polStatus < 200 || polStatus > 299) {
      throw new Error(`Read policies failed (status ${polStatus})`);
    }
    let polName: string | null = null;
    if (policies && typeof policies === "object") {
      for (const [name, pol] of Object.entries(policies as Record<string, any>)) {
        const desc = (pol?.description || "").toString().toLowerCase();
        if (desc === "vpn" || desc.includes("vpn")) { polName = name; break; }
      }
      if (!polName && (policies as any).Policy0) polName = "Policy0";
    }
    if (!polName) throw new Error("Не найдена политика VPN (ip policy).");

    // 2) Read current permitted connections of that policy
    const { data: curData } = await this.do("GET", `/rci/ip/policy/${polName}`);
    const curPermit: { interface: string; enabled?: boolean; no?: boolean }[] =
      Array.isArray(curData?.permit) ? curData.permit : [];

    // 3) Build new permit list: target first (enabled), all others kept.
    const others = curPermit.filter((p) => (p.interface || "") !== interfaceId);
    const newPermit: { interface: string; enabled: boolean }[] = [
      { interface: interfaceId, enabled: true },
    ];
    for (const o of others) {
      // keep entries that were enabled; drop explicit "no" disables for others
      if (o.no) continue;
      newPermit.push({ interface: o.interface, enabled: o.enabled !== false });
    }

    // 4) Apply
    const { data, status } = await this.do(
      "POST",
      `/rci/ip/policy/${polName}`,
      { permit: newPermit },
      "application/json"
    );
    if (status < 200 || status > 299) {
      throw new Error(`Set policy ${polName} failed (status ${status}): ${JSON.stringify(data)}`);
    }
    this.checkError(data);
    try {
      await this.do("POST", "/rci/", [{ parse: "system configuration save" }], "application/json");
    } catch {
      // saving is optional
    }
  }

  // wireGuardInterfaceIDs returns just the IDs of all WireGuard interfaces.
  async wireGuardInterfaceIDs(): Promise<string[]> {
    const ifaces = await this.showWireGuardInterfaces();
    return ifaces.map((i) => i.id);
  }

  // disableAllWireGuard turns off every WireGuard interface except keepOn.
  async disableAllWireGuardExcept(keepOn: string): Promise<string[]> {
    const ids = await this.wireGuardInterfaceIDs();
    for (const id of ids) {
      if (id !== keepOn) {
        try {
          await this.setInterfaceEnabled(id, false);
        } catch {
          // ignore individual failures; continue with others
        }
      }
    }
    return ids;
  }

  // deleteInterface removes a WireGuard interface. Tries CLI "no interface"
  // first, then falls back to an op delete on the interface resource.
  async deleteInterface(id: string): Promise<void> {
    // Attempt CLI delete.
    try {
      const { data, status } = await this.do(
        "POST",
        "/rci/",
        [{ parse: `no interface ${id}` }],
        "application/json"
      );
      if (status >= 200 && status <= 299) {
        this.checkError(data);
        // Verify the interface is really gone; if still present, try op delete.
        const still = await this.wireGuardInterfaceIDs();
        if (!still.includes(id)) return;
      }
    } catch {
      // fall through to op delete
    }
    const { data, status } = await this.do(
      "POST",
      `/rci/interface/${id}`,
      { op: "delete" },
      "application/json"
    );
    if (status < 200 || status > 299) {
      throw new Error(`Delete ${id} failed (status ${status}): ${JSON.stringify(data)}`);
    }
    this.checkError(data);
  }

  // deleteAllWireGuard removes every WireGuard interface on the router.
  async deleteAllWireGuard(): Promise<number> {
    const ids = await this.wireGuardInterfaceIDs();
    let removed = 0;
    for (const id of ids) {
      try {
        await this.deleteInterface(id);
        removed++;
      } catch {
        // ignore individual failures
      }
    }
    return removed;
  }


  async updateWireGuard(interfaceID: string, confContent: string): Promise<void> {
    const { asc, peer } = parseConf(confContent);
    const commands: string[] = [];

    const ascCmd = buildASCCommand(interfaceID, asc);
    if (ascCmd) commands.push(ascCmd);

    if (peer.public_key) {
      commands.push(...buildPeerCommands(interfaceID, peer));
    }
    commands.push("system configuration save");

    const requests = commands.map((cmd) => ({ parse: cmd }));
    const { data, status } = await this.do("POST", "/rci/", requests, "application/json");
    if (status < 200 || status > 299) {
      throw new Error(`Command failed (status ${status}): ${JSON.stringify(data)}`);
    }
    this.checkError(data);
  }
}

// --- .conf parser ---

function parseConf(conf: string): { asc: AscParams; peer: PeerParams } {
  const emptyAsc: AscParams = {
    jc: "", jmin: "", jmax: "", s1: "", s2: "",
    h1: "", h2: "", h3: "", h4: "", s3: "", s4: "",
    i1: "", i2: "", i3: "", i4: "", i5: "",
  };
  const peer: PeerParams = { public_key: "", endpoint: "", allowed_ips: [], keepalive: 0, preshared: "" };

  let currentSection = "";
  const sections: Record<string, Record<string, string>> = {};

  for (const rawLine of conf.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      sections[currentSection] = {};
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;

    const key = line.substring(0, eqIdx).trim();
    const val = line.substring(eqIdx + 1).trim();
    if (currentSection && sections[currentSection]) {
      sections[currentSection][key] = val;
    }
  }

  const iface = sections["interface"] || {};
  const asc: AscParams = {
    ...emptyAsc,
    jc: iface["Jc"] || "",
    jmin: iface["Jmin"] || "",
    jmax: iface["Jmax"] || "",
    s1: iface["S1"] || "",
    s2: iface["S2"] || "",
    h1: iface["H1"] || "",
    h2: iface["H2"] || "",
    h3: iface["H3"] || "",
    h4: iface["H4"] || "",
    s3: iface["S3"] || "",
    s4: iface["S4"] || "",
    i1: iface["I1"] || "",
    i2: iface["I2"] || "",
    i3: iface["I3"] || "",
    i4: iface["I4"] || "",
    i5: iface["I5"] || "",
  };

  const sec = sections["peer"];
  if (!sec) throw new Error("conf missing [Peer] section");

  peer.public_key = sec["PublicKey"] || "";
  peer.endpoint = sec["Endpoint"] || "";
  peer.preshared = sec["PresharedKey"] || "";
  peer.keepalive = parseInt(sec["PersistentKeepalive"] || "0", 10) || 0;

  const allowedIPs = sec["AllowedIPs"] || "";
  peer.allowed_ips = allowedIPs
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return { asc, peer };
}

function hasAnyASC(a: AscParams): boolean {
  return !!(a.jc || a.jmin || a.jmax || a.s1 || a.s2 || a.h1 || a.h2 || a.h3 || a.h4 || a.s3 || a.s4 || a.i1 || a.i2 || a.i3 || a.i4 || a.i5);
}

function buildASCCommand(id: string, a: AscParams): string {
  if (!hasAnyASC(a)) return "";
  const z = (s: string) => s || "0";
  let cmd = `interface ${id} wireguard asc ${a.jc} ${a.jmin} ${a.jmax} ${a.s1} ${a.s2} ${a.h1} ${a.h2} ${a.h3} ${a.h4}`;
  if (a.s3 || a.s4 || a.i1 || a.i2 || a.i3 || a.i4 || a.i5) {
    cmd += ` ${z(a.s3)} ${z(a.s4)} ${z(a.i1)} ${z(a.i2)} ${z(a.i3)} ${z(a.i4)} ${z(a.i5)}`;
  }
  return cmd;
}

function buildPeerCommands(id: string, p: PeerParams): string[] {
  const cmds: string[] = [];
  if (p.endpoint) cmds.push(`interface ${id} wireguard peer ${p.public_key} endpoint ${p.endpoint}`);
  if (p.keepalive > 0) cmds.push(`interface ${id} wireguard peer ${p.public_key} keepalive-interval ${p.keepalive}`);
  if (p.preshared) cmds.push(`interface ${id} wireguard peer ${p.public_key} preshared-key ${p.preshared}`);
  for (const cidr of p.allowed_ips) {
    cmds.push(`interface ${id} wireguard peer ${p.public_key} allow-ips ${cidr}`);
  }
  return cmds;
}
