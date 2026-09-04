// Client for my.impio.space (impVPN personal cabinet).
// Session-based: login sets a session cookie that must be sent with every
// request. Because Cloudflare Workers are stateless, the session cookie is
// kept within a single ImpioClient instance (one login -> keys -> config flow).

const IMPIO_BASE = "https://my.impio.space";

export interface ImpioConfig {
  content: string;
  filename?: string;
  openwrt_outbound?: string;
}

export interface ImpioLocation {
  id: number | string;
  name: string;
  work?: boolean;
  server_count?: number | null;
}

export interface ImpioServer {
  id: number | string;
  type_vpn?: number;
  work?: boolean;
  load_percentage?: number;
}

export interface ImpioKey {
  id: number | string;
  name?: string | null;
  tariff_plan?: string;
  location_name?: string | null;
  is_connected?: boolean;
  server_type_vpn?: number | null;
  protocol_name?: string | null;
  billing_status?: string;
}

export class ImpioError extends Error {
  status: number;
  detail: string;
  constructor(message: string, status = 0, detail = "") {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export class ImpioClient {
  private baseURL: string;
  // Cookie jar: name -> value. Workers only exposes the first Set-Cookie via
  // headers.get("set-cookie"), so we collect every Set-Cookie with
  // getSetCookie() and keep the full jar to send back as a single Cookie header.
  private cookieJar: Record<string, string> = {};

  constructor(baseURL: string = IMPIO_BASE) {
    this.baseURL = baseURL.replace(/\/+$/, "");
  }

  private cookieHeader(): string {
    const parts = Object.entries(this.cookieJar).map(
      ([k, v]) => `${k}=${v}`
    );
    return parts.join("; ");
  }

  // captureCookie stores every Set-Cookie from a response into the jar.
  private captureCookie(resp: Response): void {
    let setCookies: string[] = [];
    const gsc = (resp.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie;
    if (typeof gsc === "function") {
      try {
        setCookies = gsc.call(resp.headers) || [];
      } catch {
        setCookies = [];
      }
    }
    if (setCookies.length === 0) {
      const single = resp.headers.get("set-cookie");
      if (single) setCookies = [single];
    }
    for (const sc of setCookies) {
      const m = sc.match(/^\s*([^=;,\s]+)=([^;]*)/);
      if (!m) continue;
      this.cookieJar[m[1]] = m[2];
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    withAuth = true
  ): Promise<{ data: any; resp: Response }> {
    const send = async (): Promise<{ data: any; resp: Response }> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      const cookie = this.cookieHeader();
      if (withAuth && cookie) headers["Cookie"] = cookie;

      const resp = await fetch(`${this.baseURL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      this.captureCookie(resp);

      let data: any;
      try {
        data = await resp.json();
      } catch {
        data = null;
      }
      return { data, resp };
    };

    const first = await send();
    if (first.resp.status === 401 && withAuth) {
      // Session may have expired: try one refresh, then retry once.
      if (await this.refresh()) {
        return send();
      }
    }
    return first;
  }

  private extractDetail(data: any): string {
    if (!data || typeof data !== "object") return "";
    if (typeof data.detail === "string") return data.detail;
    if (data.message) return String(data.message);
    return JSON.stringify(data).slice(0, 200);
  }

  // login authenticates with username/password. If 2FA is enabled the response
  // carries two_factor_required + two_factor_token; call verifyTwoFactor next.
  async login(
    username: string,
    password: string
  ): Promise<{ two_factor_required?: boolean; two_factor_token?: string }> {
    const { data, resp } = await this.request(
      "POST",
      "/auth/login",
      { username, password },
      false
    );
    if (resp.status !== 200) {
      throw new ImpioError(
        `Ошибка входа на impio: ${this.extractDetail(data) || resp.status}`,
        resp.status,
        this.extractDetail(data)
      );
    }
    return data || {};
  }

  async verifyTwoFactor(token: string, code: string): Promise<void> {
    const { data, resp } = await this.request(
      "POST",
      "/auth/2fa/verify",
      { two_factor_token: token, code },
      false
    );
    if (resp.status !== 200) {
      throw new ImpioError(
        `2FA не принят: ${this.extractDetail(data) || resp.status}`,
        resp.status
      );
    }
  }

  // refresh renews the session cookie via /auth/refresh.
  private async refresh(): Promise<boolean> {
    try {
      const { resp } = await this.request("POST", "/auth/refresh", undefined, true);
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  async getKeys(): Promise<ImpioKey[]> {
    const { data, resp } = await this.request("GET", "/api/keys");
    if (resp.status !== 200 || !Array.isArray(data)) {
      throw new ImpioError(
        `Не удалось получить ключи: ${this.extractDetail(data) || resp.status}`,
        resp.status
      );
    }
    return data;
  }

  async getKeyConfig(keyId: number | string): Promise<ImpioConfig> {
    const { data, resp } = await this.request("GET", `/api/keys/${keyId}/config`);
    if (resp.status !== 200 || !data || typeof data.content !== "string") {
      throw new ImpioError(
        `Не удалось получить конфиг ключа: ${this.extractDetail(data) || resp.status}`,
        resp.status
      );
    }
    if (!data.filename) data.filename = "impvpn.conf";
    return data as ImpioConfig;
  }

  // pickWireGuardKey returns the first key whose protocol is WireGuard, falling
  // back to the first key overall. Prefers connected/active keys.
  async pickWireGuardKey(): Promise<ImpioKey> {
    const keys = await this.getKeys();
    if (keys.length === 0) {
      throw new ImpioError("В аккаунте impio нет ни одного ключа.");
    }
    const wg = keys.filter((k) =>
      /wireguard|wg/i.test(k.protocol_name || "")
    );
    const pool = wg.length ? wg : keys;
    return (
      pool.find((k) => k.is_connected) ||
      pool[0]
    );
  }

  // getLocations returns the locations. When typeVpn is provided, only locations
  // that have servers of that protocol type are returned (each protocol has its
  // own set of locations — do not mix them).
  async getLocations(typeVpn?: number): Promise<ImpioLocation[]> {
    const q = typeVpn ? `?type_vpn=${encodeURIComponent(typeVpn)}` : "";
    const { data, resp } = await this.request("GET", `/api/locations${q}`);
    if (resp.status !== 200 || !Array.isArray(data)) {
      throw new ImpioError(
        `Не удалось получить список локаций: ${this.extractDetail(data) || resp.status}`,
        resp.status
      );
    }
    return data;
  }

  // getServers returns the servers for a location/protocol/key combination.
  // typeVpn: 4 = WG/impWG (Keenetic), 11 = AmneziaWG etc.
  async getServers(
    locationId: number | string,
    typeVpn: number,
    keyId: number | string
  ): Promise<ImpioServer[]> {
    const q = `location_id=${encodeURIComponent(locationId)}&type_vpn=${encodeURIComponent(
      typeVpn
    )}&key_id=${encodeURIComponent(keyId)}`;
    const { data, resp } = await this.request("GET", `/api/servers?${q}`);
    if (resp.status !== 200 || !Array.isArray(data)) {
      throw new ImpioError(
        `Не удалось получить серверы: ${this.extractDetail(data) || resp.status}`,
        resp.status
      );
    }
    return data;
  }

  // createKey creates a new key and returns its id. prepaid_months must be >= 1.
  // The optional name is applied if the service accepts it (some endpoints reject
  // unknown fields; that is handled by the caller tolerating an error).
  async createKey(
    tariffPlan: string,
    opts?: {
      name?: string;
      trialPeriod?: boolean;
      usersTotal?: number;
      prepaidMonths?: number;
    }
  ): Promise<number> {
    const body: Record<string, unknown> = {
      tariff_plan: tariffPlan,
      trial_period: opts?.trialPeriod ?? false,
      users_total: opts?.usersTotal ?? 1,
      prepaid_months: opts?.prepaidMonths ?? 1,
    };
    if (opts?.name) body.name = opts.name;
    const { data, resp } = await this.request(
      "POST",
      "/api/keys",
      body,
      true
    );
    if (resp.status !== 200 || !data || typeof data.id === "undefined") {
      throw new ImpioError(
        `Не удалось создать ключ: ${this.extractDetail(data) || resp.status}`,
        resp.status
      );
    }
    return data.id;
  }

  // deleteKey removes a key on the service.
  async deleteKey(keyId: number | string): Promise<void> {
    const { data, resp } = await this.request(
      "DELETE",
      `/api/keys/${keyId}`,
      undefined,
      true
    );
    if (resp.status !== 200) {
      throw new ImpioError(
        `Не удалось удалить ключ: ${this.extractDetail(data) || resp.status}`,
        resp.status
      );
    }
  }

  // switchLocation changes a key's server/location and returns the resulting
  // WireGuard config (content). serverId is the id from getServers(); pick a
  // server with low load_percentage to avoid the "Switch location failed" bug.
  async switchLocation(
    keyId: number | string,
    serverId: number | string,
    locationName: string
  ): Promise<ImpioConfig> {
    const { data, resp } = await this.request(
      "POST",
      `/api/keys/${keyId}/switch-location`,
      { server_id: serverId, location_name: locationName },
      true
    );
    if (resp.status !== 200) {
      throw new ImpioError(
        `Не удалось сменить локацию: ${this.extractDetail(data) || resp.status}`,
        resp.status
      );
    }
    // Switch-location returns {status:"ok", config:{...}} — the config field may
    // be a plain string OR an object wrapping it ({config: "...", name_key: "..."}).
    // Normalize so content is always the WireGuard .conf string.
    let raw = data?.config;
    let content: string = "";
    if (typeof raw === "string") {
      content = raw;
    } else if (raw && typeof raw === "object" && typeof (raw as any).config === "string") {
      content = (raw as any).config;
    } else if (raw && typeof raw === "object" && typeof (raw as any).content === "string") {
      content = (raw as any).content;
    }
    return {
      content,
      filename: "impvpn.conf",
    };
  }

  async logout(): Promise<void> {
    try {
      await this.request("POST", "/auth/logout", undefined, true);
    } catch {
      // ignore logout errors
    }
    this.cookieJar = {};
  }
}
