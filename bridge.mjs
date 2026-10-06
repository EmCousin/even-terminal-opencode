import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import express from "express";
import { createOpenCodeClient, discoverConnection } from "./opencode-client.mjs";
import { historyTranscript, createTurnFinisher } from "./history.mjs";
import { ReplayHub, replayCursor } from "./replay.mjs";
import {
  SnapshotTranslator,
  permissionDecision,
  permissionCard,
  formCard,
  formAnswer,
  createSseParser,
  backoffDelay,
} from "./protocol.mjs";

const port = Number(process.env.PORT ?? 3458);
const projectDir = process.env.PROJECT_DIR ?? process.env.HOME ?? homedir();
export function createBridge({
  token = process.env.BRIDGE_TOKEN ?? randomBytes(16).toString("hex"),
  request,
  connection,
  log = console.log,
  wireProvider = process.env.WIRE_PROVIDER ?? "claude",
} = {}) {
  if (typeof token !== "string" || !token.trim()) throw new Error("Bridge token must be a non-empty string");
  const app = express();
  app.use((req, res, next) => {
    const route = req.path.replace(
      /\/api\/session\/[^/]+/g,
      "/api/session/:id",
    );
    res.on("finish", () =>
      log(`[bridge] ${req.method} ${route} ${res.statusCode} from ${req.ip}`),
    );
    next();
  });
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    const supplied = auth?.startsWith("Bearer ")
      ? auth.slice(7)
      : req.query.token;
    if (supplied !== token)
      return res.status(401).json({ error: "Unauthorized" });
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  const sessions = new Map();
  const hub = new ReplayHub({ log });
  const clients = hub.clients;
  const replay = hub.messages;
  const pendingPermissions = new Map();
  const pendingForms = new Map();
  const refreshes = new Map();
  const askSyncs = new Map();
  const timers = new Set();
  const abort = new AbortController();
  let stopped = false;
  let started = false;
  const translator = new SnapshotTranslator(emit, {
    verbose: process.env.VERBOSE_TOOLS === "true",
  });
  const getConnection = connection ?? discoverConnection;
  const oc = request ?? createOpenCodeClient({ connection: getConnection, signal: abort.signal });
  const provider = wireProvider;
  const finishTurn = createTurnFinisher({ request: oc, state, translator, emit, provider, isStopped: () => stopped });
  function later(fn, ms) {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped)
        Promise.resolve()
          .then(fn)
          .catch((error) =>
            log(`[bridge] background task failed (${error.name})`),
          );
    }, ms);
    timers.add(timer);
    return timer;
  }

  function state(sessionId) {
    if (!sessions.has(sessionId))
      sessions.set(sessionId, {
        state: "idle",
        busySince: 0,
        text: new Map(),
        roles: new Map(),
        updated: Date.now(),
        resultId: null,
        generation: 0,
        finishing: null,
      });
    sessions.get(sessionId).updated = Date.now();
    return sessions.get(sessionId);
  }

  function emit(sessionId, message) { if (!stopped) hub.emit(sessionId, message); }

  function hasPending(id) {
    return [...pendingPermissions.values(), ...pendingForms.values()].some(
      (p) => p.sessionID === id,
    );
  }

  function trackPermission(p) {
    if (!p?.id || !p.sessionID || pendingPermissions.has(p.id)) return;
    pendingPermissions.set(p.id, p);
    emit(p.sessionID, permissionCard(p));
  }

  async function syncAsks(id) {
    if (askSyncs.has(id)) return askSyncs.get(id);
    const task = syncAskSnapshot(id).finally(() => askSyncs.delete(id));
    askSyncs.set(id, task);
    return task;
  }

  async function syncAskSnapshot(id) {
    const results = await Promise.allSettled([
      oc(`/api/session/${encodeURIComponent(id)}/permission`),
      oc(`/api/session/${encodeURIComponent(id)}/form`),
    ]);
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") continue; // an outage must not drop unanswered cards
      const rows = result.value?.data ?? [];
      const map = index === 0 ? pendingPermissions : pendingForms;
      const ids = new Set(rows.map((p) => p.id));
      for (const [key, p] of map)
        if (p.sessionID === id && !ids.has(key)) {
          map.delete(key);
          emit(id, {
            type: "notification",
            message: "Request handled outside the glasses",
          });
        }
      for (const p of rows) {
        if (index === 0) trackPermission(p);
        else if (!map.has(p.id)) {
          map.set(p.id, p);
          emit(id, formCard(p));
        }
      }
    }
  }

  async function refreshMessage(id, messageId) {
    const current = state(id);
    const generation = current.generation;
    const response = await oc(
      `/api/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageId)}`,
    );
    if (stopped || current.generation !== generation) return;
    translator.translate(id, response.data);
    state(id).lastAssistant =
      response.data?.type === "assistant"
        ? response.data
        : state(id).lastAssistant;
  }

  function scheduleRefresh(id, messageId) {
    if (!messageId) return;
    const key = `${id}:${messageId}`;
    const existing = refreshes.get(key);
    if (existing) {
      existing.dirty = true;
      return;
    }
    const entry = { dirty: false, failures: 0 };
    refreshes.set(key, entry);
    const run = async () => {
      entry.dirty = false;
      try {
        await refreshMessage(id, messageId);
        entry.failures = 0;
      } catch {
        entry.dirty = ++entry.failures < 3;
      }
      if (stopped) return;
      if (entry.dirty) later(run, 200);
      else refreshes.delete(key);
    };
    later(run, 100);
  }

  function sessionIdFromEvent(event, properties) {
    return (
      properties.sessionID ??
      properties.part?.sessionID ??
      properties.info?.sessionID ??
      event.sessionID ??
      event.data?.sessionID
    );
  }

  function textPart(sessionId, part) {
    if (part.type !== "text" || typeof part.text !== "string") return;
    if (state(sessionId).roles.get(part.messageID) !== "assistant") return;
    const current = state(sessionId).text.get(part.id) ?? "";
    if (part.text.length > current.length) {
      emit(sessionId, {
        type: "text_delta",
        text: part.text.slice(current.length),
      });
    }
    state(sessionId).text.set(part.id, part.text);
  }

  function textDelta(sessionId, properties) {
    if (properties.field !== "text" || typeof properties.delta !== "string")
      return;
    if (state(sessionId).roles.get(properties.messageID) !== "assistant")
      return;
    const current = state(sessionId).text.get(properties.partID) ?? "";
    state(sessionId).text.set(properties.partID, current + properties.delta);
    emit(sessionId, { type: "text_delta", text: properties.delta });
  }

  function mapEvent(event) {
    // V2 server events carry their payload in `data`; accept `properties` too for
    // compatibility with earlier OpenCode event streams.
    const p = event.properties ?? event.data ?? {};
    const sessionId =
      sessionIdFromEvent(event, p) ?? p.form?.sessionID ?? p.request?.sessionID;
    if (typeof sessionId !== "string" || !/^ses/.test(sessionId)) return;
    if (
      [
        "session.status",
        "session.idle",
        "session.step.streamed",
        "message.updated",
        "message.part.updated",
        "message.part.delta",
        "session.error",
      ].includes(event.type)
    ) {
      log(`[bridge] upstream ${event.type} session=${sessionId.slice(0, 10)}`);
    }
    const current = state(sessionId);

    switch (event.type) {
      case "message.updated": {
        const info = p.info ?? {};
        const role =
          info.role ??
          (info.type === "assistant" || info.type === "user"
            ? info.type
            : undefined);
        if (info.id && role) current.roles.set(info.id, role);
        break;
      }
      case "session.status": {
        const status = p.status?.type ?? p.status;
        const next =
          status === "busy" || status === "running" || status === "retry"
            ? "busy"
            : "idle";
        current.state = next;
        current.busySince = next === "busy" ? Date.now() : 0;
        emit(sessionId, { type: "status", state: next, sessionId });
        break;
      }
      case "session.execution.started":
        current.generation++;
        current.lastAssistant = null;
        current.state = "busy";
        current.busySince = Date.now();
        emit(sessionId, { type: "status", state: "busy", sessionId });
        break;
      case "session.step.started":
      case "session.step.streamed":
        if (current.state !== "busy") current.generation++;
        current.state = "busy";
        if (!current.busySince) {
          current.busySince = Date.now();
          emit(sessionId, { type: "status", state: "busy", sessionId });
        }
        scheduleRefresh(sessionId, p.assistantMessageID);
        break;
      case "session.step.ended":
      case "session.step.failed":
        scheduleRefresh(sessionId, p.assistantMessageID);
        break;
      case "session.text.delta":
        translator.delta(sessionId, p.assistantMessageID, p.delta);
        break;
      case "session.text.ended":
      case "session.tool.input.started":
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.failed":
        scheduleRefresh(sessionId, p.assistantMessageID);
        break;
      case "session.reasoning.started":
      case "session.reasoning.delta":
        translator.block(sessionId, "think");
        break;
      case "session.reasoning.ended":
        translator.block(sessionId, null);
        break;
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        void finishTurn(sessionId).catch(() => {}); // polling retries failed final snapshots
        break;
      case "form.created":
        if (p.form && !pendingForms.has(p.form.id)) {
          pendingForms.set(p.form.id, p.form);
          emit(sessionId, formCard(p.form));
        }
        break;
      case "form.replied":
      case "form.cancelled":
        pendingForms.delete(p.id);
        emit(sessionId, { type: "notification", message: "Question handled" });
        break;
      case "session.retry.scheduled":
        emit(sessionId, {
          type: "notification",
          title: "Retrying",
          message: `Retrying (attempt ${p.attempt})`,
        });
        break;
      case "session.idle":
        current.state = "idle";
        current.busySince = 0;
        emit(sessionId, { type: "status", state: "idle", sessionId });
        break;
      case "message.part.delta":
        textDelta(sessionId, p);
        break;
      case "message.part.updated": {
        const part = p.part ?? {};
        textPart(sessionId, part);
        if (part.type === "tool") {
          if (part.state?.status === "running")
            emit(sessionId, {
              type: "tool_start",
              name: part.tool ?? "tool",
              toolId: part.id,
            });
          if (["completed", "error"].includes(part.state?.status))
            emit(sessionId, {
              type: "tool_end",
              name: part.tool ?? "tool",
              toolId: part.id,
              detail: part.state,
            });
        }
        break;
      }
      case "permission.asked":
      case "permission.requested":
        trackPermission(p.request ?? p);
        break;
      case "permission.replied":
        pendingPermissions.delete(p.requestID ?? p.id);
        break;
      case "question.asked":
        emit(sessionId, {
          type: "user_question",
          questions: p.questions ?? [],
          toolUseId: p.id,
        });
        break;
      case "session.error":
      case "session.execution.failed":
        current.state = "idle";
        current.busySince = 0;
        emit(sessionId, {
          type: "error",
          message: p.error?.message ?? String(p.error ?? "OpenCode error"),
        });
        emit(sessionId, { type: "status", state: "idle", sessionId });
        break;
    }
    if (event.type.startsWith("form.") || event.type.startsWith("permission."))
      void syncAsks(sessionId);
  }

  async function syncSessionStates() {
    try {
      const active = await oc("/api/session/active");
      const now = Date.now();
      for (const id of Object.keys(active.data ?? {})) state(id);
      for (const [sessionId, current] of sessions) {
        const isActive = Boolean(active.data?.[sessionId]);
        if (isActive && current.state !== "busy") {
          current.state = "busy";
          current.busySince = now;
          emit(sessionId, { type: "status", state: "busy", sessionId });
        } else if (
          !isActive &&
          current.state === "busy" &&
          (!current.busySince || now - current.busySince >= 5000)
        ) {
          await finishTurn(sessionId);
        }
      }
    } catch {
      // Keep the last known status if OpenCode is temporarily unavailable.
    }
    later(syncSessionStates, 2000);
  }

  async function syncPending() {
    await Promise.all([...sessions.keys()].map(syncAsks));
    // Retain live clients and pending requests, discard old idle session state.
    for (const [id, current] of sessions)
      if (
        current.state === "idle" &&
        !clients.has(id) &&
        !hasPending(id) &&
        Date.now() - current.updated > 3600000
      ) {
        translator.clear(id);
        sessions.delete(id);
        replay.delete(id);
      }
    later(syncPending, 30000);
  }

  async function subscribe(attempt = 0) {
    const upstreamAbort = new AbortController();
    let watchdog;
    const armWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        timers.delete(watchdog);
      }
      watchdog = later(() => upstreamAbort.abort(), 45000);
    };
    try {
      const { base, authorization } = await getConnection();
      armWatchdog();
      const response = await fetch(`${base}/api/event`, {
        headers: { authorization, accept: "text/event-stream" },
        signal: AbortSignal.any([abort.signal, upstreamAbort.signal]),
      });
      if (!response.ok)
        throw new Error(`OpenCode event stream returned ${response.status}`);
      if (!response.body) throw new Error("OpenCode event stream unavailable");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      attempt = 0;
      void Promise.all([...sessions.keys()].map(syncAsks));
      for (const [id, current] of sessions)
        if (current.state === "busy" && current.lastAssistant?.id)
          scheduleRefresh(id, current.lastAssistant.id);
      const parse = createSseParser(mapEvent);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armWatchdog();
        parse(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!stopped)
        log(`[bridge] OpenCode event stream unavailable (${error.name})`);
    } finally {
      if (watchdog) {
        clearTimeout(watchdog);
        timers.delete(watchdog);
      }
    }
    later(() => subscribe(attempt + 1), backoffDelay(attempt));
  }

  function sessionSummary(session, active) {
    const stamp = session.time?.updated ?? session.time?.created ?? Date.now();
    return {
      id: session.id,
      title: session.title || "OpenCode session",
      timestamp: new Date(stamp).toISOString(),
      cwd: session.location?.directory ?? projectDir,
      provider,
      status: hasPending(session.id)
        ? "awaiting"
        : active?.[session.id]
          ? "busy"
          : "idle",
    };
  }

  app.get("/api/info", async (_req, res) => {
    try {
      const [info, model] = await Promise.all([
        oc("/api/info"),
        oc("/api/model/default"),
      ]);
      res.json({
        account: {},
        model: model?.data?.name ?? model?.data?.id ?? "OpenCode",
        version: info.version ?? "Unknown",
        provider,
      });
    } catch (error) {
      res
        .status(503)
        .json({
          account: {},
          model: "OpenCode",
          version: "Unknown",
          provider,
          error: error.message,
        });
    }
  });

  app.get("/api/sessions", async (_req, res) => {
    try {
      const [listed, active] = await Promise.all([
        oc("/api/session?limit=100&order=desc"),
        oc("/api/session/active"),
      ]);
      res.json({
        sessions: (listed.data ?? [])
          .filter((s) => !s.parentID && !s.time?.archived)
          .map((session) => sessionSummary(session, active.data ?? {})),
      });
    } catch (error) {
      res.status(503).json({ sessions: [], error: error.message });
    }
  });

  app.post("/api/prompt", async (req, res) => {
    const { text, sessionId, cwd } = req.body ?? {};
    if (!text || typeof text !== "string")
      return res.status(400).json({ error: "Missing 'text' field" });
    let id =
      typeof sessionId === "string" && /^ses/.test(sessionId)
        ? sessionId
        : null;
    if (sessionId && !id)
      return res.status(400).json({ error: "Invalid OpenCode sessionId" });
    let admissionGeneration;
    try {
      if (!id) {
        const created = await oc("/api/session", {
          method: "POST",
          body: JSON.stringify({
            title:
              text.trim().replace(/\s+/g, " ").slice(0, 80) ||
              "OpenCode session",
            location: {
              directory:
                typeof cwd === "string" && cwd.startsWith("/")
                  ? cwd
                  : projectDir,
            },
          }),
        });
        id = created?.data?.id;
        if (!id) throw new Error("OpenCode did not return a session ID");
      }

      const current = state(id);
      admissionGeneration = ++current.generation;
      current.state = "busy";
      current.busySince = Date.now();
      emit(id, { type: "user_prompt", text, sessionId: id });
      emit(id, { type: "status", state: "busy", sessionId: id });
      await oc(`/api/session/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      res.status(202).json({ ok: true, sessionId: id, provider });
    } catch (error) {
      if (id && state(id).generation === admissionGeneration) {
        state(id).state = "idle";
        state(id).busySince = 0;
        emit(id, { type: "error", message: error.message });
        emit(id, { type: "status", state: "idle", sessionId: id });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/events", (req, res) => {
    const id = req.query.sessionId;
    if (typeof id !== "string" || !/^ses/.test(id))
      return res
        .status(400)
        .json({ error: "Invalid 'sessionId' query parameter" });
    state(id);
    let after;
    try { after = replayCursor(req.headers["last-event-id"] ?? req.query.after ?? 0); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const restored = [...pendingPermissions.values(), ...pendingForms.values()]
      .filter(p => p.sessionID === id)
      .map(p => pendingPermissions.has(p.id) ? permissionCard(p) : formCard(p));
    hub.subscribe(id, res, { after, needReplay: req.query.needReplay === "true", restored });
    void syncAsks(id);
  });

  app.get("/api/status", async (req, res) => {
    const id = req.query.sessionId;
    if (typeof id !== "string" || !/^ses/.test(id))
      return res
        .status(400)
        .json({ error: "Invalid 'sessionId' query parameter" });
    try {
      const active = await oc("/api/session/active");
      // OpenCode's active-session endpoint is authoritative. A missing session means
      // the agent loop has finished, even if this bridge missed its idle event.
      await syncAsks(id);
      const next = hasPending(id)
        ? "awaiting"
        : active.data?.[id]
          ? "busy"
          : "idle";
      state(id);
      res.json({ state: next, sessionId: id, provider });
    } catch (error) {
      res
        .status(503)
        .json({
          error: error.message,
          state: state(id).state,
          sessionId: id,
          provider,
        });
    }
  });

  async function sessionHistory(id) {
    if (!/^ses/.test(id)) throw new Error("Unknown OpenCode session");
    const [response, active] = await Promise.all([
      oc(`/api/session/${encodeURIComponent(id)}/message?limit=100&order=desc`),
      oc("/api/session/active"),
    ]);
    const rawMessages = (response.data ?? []).slice().reverse();
    const history = historyTranscript(rawMessages);
    await syncAsks(id);
    // Historical transcript rows never supply live replay IDs.
    const messages = (replay.get(id) ?? []).slice();
    const after = hub.cursor(id);
    const next = hasPending(id)
      ? "awaiting"
      : active.data?.[id]
        ? "busy"
        : "idle";
    state(id);
    return {
      history,
      messages,
      state: next,
      sessionId: id,
      provider,
      after,
      cursor: response.cursor?.next ?? null,
    };
  }

  app.get("/api/messages", async (req, res) => {
    const id = req.query.sessionId;
    if (typeof id !== "string" || !/^ses/.test(id))
      return res
        .status(400)
        .json({ error: "Invalid 'sessionId' query parameter" });
    try {
      if (req.query.after !== undefined) {
        let after;
        try { after = replayCursor(req.query.after); }
        catch (error) { return res.status(400).json({ error: error.message }); }
        return res.json({
          messages: (replay.get(id) ?? []).filter(message => message.id > after),
          after: Math.max(after, hub.cursor(id)),
          state: hasPending(id) ? "awaiting" : state(id).state,
          sessionId: id, provider,
        });
      }
      res.json(await sessionHistory(id));
    } catch (error) {
      res
        .status(error.message === "Unknown OpenCode session" ? 404 : 503)
        .json({
          messages: [],
          state: state(id).state,
          sessionId: id,
          provider,
          error: error.message,
        });
    }
  });

  app.get("/api/sessions/:sessionId/history", async (req, res) => {
    const id = req.params.sessionId;
    try {
      if (!/^ses/.test(id)) throw new Error("Unknown OpenCode session");
      const started = Date.now();
      // History should stay usable while an agent waits for a ring approval.
      const result = await sessionHistory(id);
      log(
        `[bridge] history ready session=${id.slice(0, 10)} wait_ms=${Date.now() - started} entries=${result.history.length}`,
      );
      res.json({ history: result.history });
    } catch (error) {
      res
        .status(error.message === "Unknown OpenCode session" ? 404 : 503)
        .json({
          messages: [],
          state: state(id).state,
          sessionId: id,
          provider,
          error: error.message,
        });
    }
  });

  app.post("/api/interrupt", async (req, res) => {
    const id = req.body?.sessionId;
    if (typeof id !== "string" || !/^ses/.test(id))
      return res.status(400).json({ error: "Invalid OpenCode sessionId" });
    try {
      await oc(`/api/session/${encodeURIComponent(id)}/interrupt`, {
        method: "POST",
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/permission-response", async (req, res) => {
    const { sessionId, permissionId, toolUseId, decision } = req.body ?? {};
    if (typeof sessionId !== "string" || !/^ses/.test(sessionId)) {
      return res
        .status(400)
        .json({ error: "Missing OpenCode sessionId or permission ID" });
    }
    let reply;
    try {
      reply = permissionDecision(decision);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      await syncAsks(sessionId);
      const requestId =
        permissionId ??
        toolUseId ??
        [...pendingPermissions.values()].find((p) => p.sessionID === sessionId)
          ?.id;
      if (
        typeof requestId !== "string" ||
        pendingPermissions.get(requestId)?.sessionID !== sessionId
      )
        return res.status(404).json({ error: "Pending permission not found" });
      await oc(
        `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ decision: reply }),
        },
      );
      const toolName = pendingPermissions.get(requestId)?.action ?? "tool";
      pendingPermissions.delete(requestId);
      emit(sessionId, {
        type: "permission_result",
        toolName,
        decision:
          reply === "reject"
            ? "denied"
            : reply === "always"
              ? "always"
              : "allowed",
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/question-response", async (req, res) => {
    const { sessionId, toolUseId, formId, answer } = req.body ?? {};
    if (typeof sessionId !== "string" || !/^ses/.test(sessionId))
      return res.status(400).json({ error: "Invalid sessionId" });
    if (answer === undefined)
      return res.status(400).json({ error: "Missing answer" });
    try {
      await syncAsks(sessionId);
      const id =
        formId ??
        toolUseId ??
        [...pendingForms.values()].find((f) => f.sessionID === sessionId)?.id;
      const form = pendingForms.get(id);
      if (!form || form.sessionID !== sessionId)
        return res.status(404).json({ error: "Pending form not found" });
      if (answer === "skip")
        await oc(
          `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
      else {
        let values;
        try {
          values = formAnswer(form, answer);
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }
        await oc(
          `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(id)}/reply`,
          { method: "POST", body: JSON.stringify({ answer: values }) },
        );
        emit(sessionId, { type: "question_answer", answers: values });
      }
      pendingForms.delete(id);
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  return {
    app,
    token,
    mapEvent,
    syncAsks,
    syncSessionStates,
    translator,
    replay,
    pendingPermissions,
    pendingForms,
    start() {
      if (started || stopped) return;
      started = true;
      later(subscribe, 0);
      later(syncSessionStates, 0);
      later(syncPending, 0);
    },
    stop() {
      stopped = true;
      abort.abort();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      refreshes.clear();
      hub.stop();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const bridge = createBridge();
  const server = bridge.app.listen(port, "0.0.0.0", () => {
    console.log(`Even Terminal OpenCode bridge listening on ${port}`);
    bridge.start();
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      bridge.stop();
      server.close();
    });
}
