import type { Binding, BindState, ImpioAccount, ImpioBindState, ImpioReplaceState } from "./types.js";

export class Store {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  // Bindings
  private bindingKey(chatId: number, name: string): string {
    return `b:${chatId}:${name}`;
  }

  async add(b: Binding): Promise<void> {
    const existing = await this.kv.get(this.bindingKey(b.chat_id, b.name));
    if (existing) throw new Error("Binding name already in use");
    await this.kv.put(this.bindingKey(b.chat_id, b.name), JSON.stringify(b));
  }

  async update(b: Binding): Promise<void> {
    const existing = await this.kv.get(this.bindingKey(b.chat_id, b.name));
    if (!existing) throw new Error("Binding not found");
    await this.kv.put(this.bindingKey(b.chat_id, b.name), JSON.stringify(b));
  }

  async remove(chatId: number, name: string): Promise<void> {
    const existing = await this.kv.get(this.bindingKey(chatId, name));
    if (!existing) throw new Error("Binding not found");
    await this.kv.delete(this.bindingKey(chatId, name));
  }

  async get(chatId: number, name: string): Promise<Binding> {
    if (name) {
      const data = await this.kv.get(this.bindingKey(chatId, name));
      if (!data) {
        // Fallback: if the user has exactly one router, use it even if the
        // supplied name doesn't match any binding (e.g. caption noise).
        const list = await this.list(chatId);
        if (list.length === 1) return list[0];
        throw new Error("Binding not found");
      }
      return JSON.parse(data);
    }
    // No name: find all for this user
    const list = await this.list(chatId);
    if (list.length === 0) throw new Error("No router bound. Use /bind first.");
    if (list.length === 1) return list[0];
    throw new Error("Multiple routers bound; specify name (see /routers)");
  }

  async list(chatId: number): Promise<Binding[]> {
    const prefix = `b:${chatId}:`;
    const keys = await this.kv.list({ prefix });
    const bindings: Binding[] = [];
    for (const key of keys.keys) {
      const data = await this.kv.get(key.name);
      if (data) bindings.push(JSON.parse(data));
    }
    return bindings;
  }

  async all(): Promise<Binding[]> {
    const keys = await this.kv.list({ prefix: "b:" });
    const bindings: Binding[] = [];
    for (const key of keys.keys) {
      const data = await this.kv.get(key.name);
      if (data) bindings.push(JSON.parse(data));
    }
    return bindings;
  }

  // Bind state (multi-step flow)
  async getBindState(chatId: number): Promise<BindState | null> {
    const data = await this.kv.get(`bind:${chatId}`);
    return data ? JSON.parse(data) : null;
  }

  async setBindState(chatId: number, state: BindState): Promise<void> {
    await this.kv.put(`bind:${chatId}`, JSON.stringify(state), {
      expirationTtl: 600, // 10 minutes
    });
  }

  async deleteBindState(chatId: number): Promise<void> {
    await this.kv.delete(`bind:${chatId}`);
  }

  // Selected router for next .conf upload (temporary, per user).
  async getSelected(chatId: number): Promise<string | null> {
    return this.kv.get(`sel:${chatId}`);
  }

  async setSelected(chatId: number, name: string): Promise<void> {
    await this.kv.put(`sel:${chatId}`, name, { expirationTtl: 1800 }); // 30 min
  }

  async deleteSelected(chatId: number): Promise<void> {
    await this.kv.delete(`sel:${chatId}`);
  }

  // --- Impio (my.impio.space) account credentials ---
  private impioKey(chatId: number): string {
    return `impio:${chatId}`;
  }

  async addImpio(a: ImpioAccount): Promise<void> {
    const existing = await this.kv.get(this.impioKey(a.chat_id));
    if (existing) throw new Error("Аккаунт impio уже сохранён: сначала выйдите из текущего.");
    await this.kv.put(this.impioKey(a.chat_id), JSON.stringify(a));
  }

  async updateImpio(a: ImpioAccount): Promise<void> {
    const existing = await this.kv.get(this.impioKey(a.chat_id));
    if (!existing) throw new Error("Аккаунт impio не найден.");
    await this.kv.put(this.impioKey(a.chat_id), JSON.stringify(a));
  }

  async getImpio(chatId: number): Promise<ImpioAccount> {
    const data = await this.kv.get(this.impioKey(chatId));
    if (!data) throw new Error("Аккаунт impio не привязан. Сначала авторизуйтесь на my.impio.space.");
    return JSON.parse(data);
  }

  async hasImpio(chatId: number): Promise<boolean> {
    return !!(await this.kv.get(this.impioKey(chatId)));
  }

  async removeImpio(chatId: number): Promise<void> {
    const existing = await this.kv.get(this.impioKey(chatId));
    if (!existing) throw new Error("Аккаунт impio не найден.");
    await this.kv.delete(this.impioKey(chatId));
  }

  // Impio bind state (multi-step authorization)
  async getImpioBindState(chatId: number): Promise<ImpioBindState | null> {
    const data = await this.kv.get(`iobind:${chatId}`);
    return data ? JSON.parse(data) : null;
  }

  async setImpioBindState(chatId: number, state: ImpioBindState): Promise<void> {
    await this.kv.put(`iobind:${chatId}`, JSON.stringify(state), {
      expirationTtl: 600, // 10 minutes
    });
  }

  async deleteImpioBindState(chatId: number): Promise<void> {
    await this.kv.delete(`iobind:${chatId}`);
  }

  // Impio replace-key multi-step state
  async getImpioReplaceState(chatId: number): Promise<ImpioReplaceState | null> {
    const data = await this.kv.get(`iorepl:${chatId}`);
    return data ? JSON.parse(data) : null;
  }

  async setImpioReplaceState(chatId: number, state: ImpioReplaceState): Promise<void> {
    await this.kv.put(`iorepl:${chatId}`, JSON.stringify(state), {
      expirationTtl: 900, // 15 minutes
    });
  }

  async deleteImpioReplaceState(chatId: number): Promise<void> {
    await this.kv.delete(`iorepl:${chatId}`);
  }
}
