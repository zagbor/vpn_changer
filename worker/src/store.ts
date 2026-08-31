import type { Binding, BindState } from "./types.js";

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
}
