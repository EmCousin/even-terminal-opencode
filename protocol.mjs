// Pure protocol helpers. No service discovery, network calls or startup effects.
export function messageText(message) {
  if (message.type === "user") return message.text ?? "";
  return (message.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

export function permissionDecision(decision) {
  const decisions = {
    allow: "once",
    allowAlways: "always",
    deny: "reject",
    once: "once",
    always: "always",
    reject: "reject",
  };
  if (!Object.hasOwn(decisions, decision))
    throw new Error("Invalid permission decision");
  return decisions[decision];
}

export function permissionCard(request) {
  return {
    type: "permission_request",
    toolUseId: request.id,
    toolName: request.action ?? request.permission ?? "tool",
    description:
      request.message ??
      request.action ??
      request.permission ??
      "Permission requested",
    detail: (request.resources ?? request.patterns ?? [])
      .join(", ")
      .slice(0, 300),
    options: [
      { text: "Yes", key: "allow" },
      { text: "Yes, and always allow", key: "allowAlways" },
      { text: "No", key: "deny" },
    ],
  };
}

export function formCard(form) {
  return {
    type: "user_question",
    toolUseId: form.id,
    questions: form.fields
      .filter((f) => !f.hidden)
      .map((f) => ({
        question: f.title ?? f.key,
        header: f.key,
        multiple: f.type === "multiselect",
        options: (
          f.options ??
          (f.type === "boolean"
            ? [
                { label: "Yes", value: "true" },
                { label: "No", value: "false" },
              ]
            : [])
        ).map((o) => ({
          label: o.label,
          description: o.description ?? "",
          preview: "",
        })),
      })),
  };
}

export function formAnswer(form, input) {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      /* plain voice reply */
    }
  }
  const fields = form.fields.filter((f) => !f.hidden && f.type !== "external");
  const isMap =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (!isMap && fields.length !== 1)
    throw new Error(
      "Answer multiple fields using a JSON object keyed by field name",
    );
  const answer = {};
  for (const field of fields) {
    let value = isMap ? (parsed[field.key] ?? parsed[field.title]) : parsed;
    if (value === undefined) value = field.default;
    if (
      field.when?.some((w) => {
        const other = answer[w.key];
        if (other === undefined) return true;
        const equal = Array.isArray(other)
          ? other.includes(w.value)
          : other === w.value;
        return w.op === "eq" ? !equal : equal;
      })
    )
      continue;
    if (value === undefined) {
      if (field.required) throw new Error(`Missing answer for ${field.key}`);
      continue;
    }
    const optionValue = (v) =>
      field.options?.find((o) => o.label === v || o.value === v)?.value ?? v;
    if (field.type === "multiselect")
      value = (Array.isArray(value) ? value : [value]).map((v) =>
        optionValue(String(v)),
      );
    else if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        const text = String(value).toLowerCase().trim();
        if (!["yes", "no", "true", "false"].includes(text))
          throw new Error(`Invalid boolean for ${field.key}`);
        value = text === "yes" || text === "true";
      }
    } else if (field.type === "number" || field.type === "integer") {
      if (
        typeof value === "boolean" ||
        value === null ||
        String(value).trim() === ""
      )
        throw new Error(`Invalid number for ${field.key}`);
      value = Number(value);
      if (
        !Number.isFinite(value) ||
        (field.type === "integer" && !Number.isInteger(value))
      )
        throw new Error(`Invalid number for ${field.key}`);
    } else value = optionValue(String(value));
    answer[field.key] = value;
  }
  // The V2 server performs the remaining schema validation (ranges, patterns,
  // conditional fields, custom choices). Never discard a request on failure.
  return answer;
}

export function createSseParser(onEvent) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const event = JSON.parse(data);
        onEvent(event.payload ?? event);
      } catch {
        /* malformed frame or keepalive */
      }
    }
  };
}

export function backoffDelay(attempt, random = Math.random) {
  return Math.round(
    Math.min(500 * 2 ** Math.min(attempt, 10), 30000) * (0.8 + random() * 0.4),
  );
}

export class SnapshotTranslator {
  constructor(emit, { maxParts = 512, verbose = false } = {}) {
    this.emit = emit;
    this.maxParts = maxParts;
    this.verbose = verbose;
    this.parts = new Map();
    this.blocks = new Map();
  }
  block(sessionId, next) {
    const previous = this.blocks.get(sessionId);
    if (previous === next) return;
    if (previous)
      this.emit(sessionId, {
        type: "status",
        state: `${previous}_end`,
        sessionId,
      });
    if (next) {
      this.blocks.set(sessionId, next);
      this.emit(sessionId, {
        type: "status",
        state: `${next}_start`,
        sessionId,
      });
    } else this.blocks.delete(sessionId);
  }
  delta(sessionId, messageId, delta) {
    if (!delta) return;
    const key = sessionId + ":" + messageId + ":text";
    const liveKey = sessionId + ":" + messageId + ":live";
    // Keep received live bytes separate from bytes already rendered by REST.
    // A REST projection may include deltas still queued on the SSE connection.
    // If a snapshot was the first evidence for this message, or reconnect lost
    // bytes, deltas have no usable offset: wait for authoritative snapshots.
    if (!this.parts.has(liveKey) && this.parts.has(key)) return;
    const live = (this.parts.get(liveKey) ?? "") + delta;
    this.parts.set(liveKey, live);
    const rendered = this.parts.get(key) ?? "";
    if (live.startsWith(rendered)) {
      const suffix = live.slice(rendered.length);
      if (suffix) {
        this.parts.set(key, live);
        this.block(sessionId, "text");
        this.emit(sessionId, { type: "text_delta", text: suffix });
      }
    }
    this.prune();
  }
  prune() {
    while (this.parts.size > this.maxParts)
      this.parts.delete(this.parts.keys().next().value);
    while (this.blocks.size > 100)
      this.blocks.delete(this.blocks.keys().next().value);
  }
  translate(sessionId, message) {
    if (message?.type !== "assistant") return;
    let fullText = "";
    for (const [index, part] of (message.content ?? []).entries()) {
      const key = `${sessionId}:${message.id}:${part.id ?? index}`;
      const previous = this.parts.get(key);
      if (part.type === "text") {
        fullText += part.text ?? "";
        const textKey = `${sessionId}:${message.id}:text`;
        const oldText = this.parts.get(textKey) ?? "";
        // REST projections can lag live deltas; never rewind the stream.
        if (fullText !== oldText && !oldText.startsWith(fullText)) {
          const delta = fullText.startsWith(oldText)
            ? fullText.slice(oldText.length)
            : fullText;
          if (delta) {
            this.block(sessionId, "text");
            this.emit(sessionId, { type: "text_delta", text: delta });
          }
          this.parts.set(textKey, fullText);
        }
      } else if (part.type === "reasoning") {
        // Snapshot refreshes must not re-open already-rendered thinking blocks.
        if (part.text && part.text !== previous) {
          this.block(sessionId, "think");
          this.parts.set(key, part.text);
        }
      } else if (part.type === "tool") {
        const status = part.state?.status;
        const name = part.name ?? part.tool ?? "tool";
        const toolId = part.id ?? key;
        if (previous === status) continue;
        this.parts.set(key, status);
        this.block(sessionId, null);
        if (
          !this.verbose &&
          /^(read|grep|glob|list|question|todowrite|todoread)$/.test(name)
        )
          continue;
        if (!previous)
          this.emit(sessionId, { type: "tool_start", name, toolId });
        if (["completed", "error"].includes(status)) {
          const input = part.state.input ?? {};
          const summary = String(
            input.command ?? input.filePath ?? input.file_path ?? name,
          )
            .split("\n")[0]
            .slice(0, 100);
          this.emit(sessionId, {
            type: "tool_end",
            name,
            toolId,
            summary,
            ...(status === "error" ? { detail: { error: "Tool failed" } } : {}),
          });
        }
      }
    }
    this.prune();
  }
  clear(sessionId) {
    this.block(sessionId, null);
    for (const key of this.parts.keys())
      if (key.startsWith(`${sessionId}:`)) this.parts.delete(key);
  }
}
