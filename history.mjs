import { messageText } from "./protocol.mjs";

export function historyTranscript(messages) {
  return messages.flatMap(message => {
    if (!["user", "assistant"].includes(message.type)) return [];
    const text = messageText(message);
    return text ? [{ role: message.type, text }] : [];
  });
}

export async function loadTurnHistory(request, sessionId, isCurrent = () => true) {
  const messages = [];
  const seenMessages = new Set();
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < 200; page++) {
    const query = cursor ? "limit=100&cursor=" + encodeURIComponent(cursor) : "limit=100&order=desc";
    const response = await request("/api/session/" + encodeURIComponent(sessionId) + "/message?" + query);
    if (!isCurrent()) return null;
    for (const message of response.data ?? []) {
      if (message.id && seenMessages.has(message.id)) continue;
      if (message.id) seenMessages.add(message.id);
      if (message.type === "user") return messages.reverse();
      messages.push(message);
    }
    // In descending order, next points to older messages. Cursor requests
    // must not also send order (the V2 API rejects that combination).
    cursor = response.cursor?.next;
    if (!cursor) return messages.reverse();
    if (seenCursors.has(cursor)) throw new Error("OpenCode repeated a history cursor");
    seenCursors.add(cursor);
  }
  throw new Error("Turn history exceeded the pagination safety limit");
}

export function createTurnFinisher({ request, state, translator, emit, provider, isStopped }) {
  return async function finishTurn(id) {
    const current = state(id);
    const generation = current.generation;
    if (current.state !== "busy" || current.finishing === generation) return;
    current.finishing = generation;
    const isCurrent = () => !isStopped() && current.generation === generation && current.state === "busy";
    try {
      const messages = await loadTurnHistory(request, id, isCurrent);
      if (!messages || !isCurrent()) return;
      const turn = messages.filter(message => message.type === "assistant");
      for (const message of turn) translator.translate(id, message);
      translator.block(id, null);
      const last = turn.at(-1);
      if (last && last.id !== current.resultId) {
        emit(id, { type: "result", success: !last.error,
          text: turn.map(messageText).filter(Boolean).join("\n") || "Turn complete.",
          sessionId: id, provider,
          durationMs: current.busySince ? Date.now() - current.busySince : 0,
          costUsd: turn.reduce((sum, m) => sum + (m.cost ?? 0), 0),
          inputTokens: turn.reduce((sum, m) => sum + (m.tokens?.input ?? 0), 0),
          outputTokens: turn.reduce((sum, m) => sum + (m.tokens?.output ?? 0), 0) });
        current.resultId = last.id;
      }
      current.state = "idle";
      current.busySince = 0;
      emit(id, { type: "status", state: "idle", sessionId: id });
    } finally {
      if (current.finishing === generation) current.finishing = null;
    }
  };
}
