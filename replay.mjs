export function replayCursor(value = 0) {
  if (!(["number", "string"].includes(typeof value)) || (typeof value === "string" && !value.trim())) throw new Error("Invalid replay cursor");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid replay cursor");
  return cursor;
}

export class ReplayHub {
  constructor({ log = console.log, limit = 500 } = {}) {
    this.log = log;
    this.limit = limit;
    this.messages = new Map();
    this.clients = new Map();
    this.heartbeats = new Map();
  }
  cursor(id) { return this.messages.get(id)?.at(-1)?.id ?? 0; }
  emit(id, message) {
    if (!id) return;
    if (["user_prompt", "status", "tool_start", "tool_end", "error"].includes(message.type)) this.log("[bridge] emit " + message.type + " session=" + id.slice(0, 10) + " listeners=" + (this.clients.get(id)?.size ?? 0));
    const entries = this.messages.get(id) ?? [];
    const sequence = (entries.at(-1)?.id ?? 0) + 1;
    const item = { ...message, id: sequence };
    entries.push(item);
    this.messages.set(id, entries.slice(-this.limit));
    for (const response of this.clients.get(id) ?? []) {
      if (!this.write(response, item)) response.destroy();
    }
  }
  write(response, message) {
    const prefix = message.id === undefined ? "" : "id: " + message.id + "\n";
    return response.write(prefix + "data: " + JSON.stringify(message) + "\n\n");
  }
  subscribe(id, response, { after = 0, needReplay = false, restored = [] } = {}) {
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    response.write(":ok\n\n");
    const entries = needReplay || after > 0 ? (this.messages.get(id) ?? []).filter(m => m.id > after) : [];
    for (const message of entries) {
      // A reconnect replay can exceed the socket's high-water mark. Node
      // buffers it; the live fan-out disconnects persistently slow clients.
      this.write(response, message);
    }
    for (const card of restored) if (!entries.some(m => m.toolUseId === card.toolUseId)) this.write(response, card);
    const clients = this.clients.get(id) ?? new Set();
    clients.add(response);
    this.clients.set(id, clients);
    this.log("[bridge] stream open session=" + id.slice(0, 10));
    const heartbeat = setInterval(() => { if (!response.write(":heartbeat\n\n")) response.destroy(); }, 15000);
    this.heartbeats.set(response, heartbeat);
    response.once("close", () => {
      clearInterval(heartbeat);
      this.heartbeats.delete(response);
      clients.delete(response);
      if (!clients.size) this.clients.delete(id);
      this.log("[bridge] stream closed session=" + id.slice(0, 10));
    });
  }
  stop() {
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
    for (const clients of this.clients.values()) for (const response of clients) response.end();
    this.clients.clear();
  }
}
