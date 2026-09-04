export interface Binding {
  chat_id: number;
  name: string;
  url: string;
  login: string;
  password: string;
  interface_id?: string;
}

export interface BindState {
  step: number;
  url?: string;
  login?: string;
  password?: string;
  name?: string;
  interface_id?: string;
}

// Impio (my.impio.space) account credentials bound to a chat, stored the same
// way as router bindings (plaintext in KV, analogous to Binding.password).
export interface ImpioAccount {
  chat_id: number;
  username: string;
  password: string;
}

// Multi-step state for authorizing to impio (like router bind).
export interface ImpioBindState {
  step: number;
  username?: string;
  password?: string;
  two_factor_token?: string;
}

// Multi-step state for the "replace key" flow: collect router + old key +
// new location first, then execute all operations on a final "Выполнить" tap.
// mode: "create" = no key on router yet (just issue+apply); "replace" = the
// router already has a key, so we also delete a chosen old key and swap.
export interface ImpioReplaceState {
  mode?: "create" | "replace";
  router?: string;
  protocolType?: number;
  protocolName?: string;
  oldKeyId?: number;
  locationId?: string;
  locationName?: string;
}

export interface WireGuardInterface {
  id: string;
  type: string;
  name: string;
  state?: string;
}

export interface AscParams {
  jc: string;
  jmin: string;
  jmax: string;
  s1: string;
  s2: string;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  s3: string;
  s4: string;
  i1: string;
  i2: string;
  i3: string;
  i4: string;
  i5: string;
}

export interface PeerParams {
  public_key: string;
  endpoint: string;
  allowed_ips: string[];
  keepalive: number;
  preshared: string;
}

export interface Env {
  STATE: KVNamespace;
  TG_BOT_TOKEN: string;
  TG_ALLOWED_IDS?: string;
  TG_ADMIN_IDS?: string;
  TLSSKIPVERIFY?: string;
  SETUP_KEY?: string;
  ADMIN_LOG_CHAT?: number;
}
