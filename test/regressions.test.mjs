import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createBridge } from "../bridge.mjs";
import { SnapshotTranslator } from "../protocol.mjs";

const assistant = (id, text) => ({ id, type: "assistant", content: [{ type: "text", text }], tokens: { input: 2, output: 1 }, cost: 0.01 });
const user = { id: "msg_user", type: "user", text: "Do the work" };
async function fixture(t, request) {
  const bridge = createBridge({ token: "test-token", log() {}, request });
  const server = bridge.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { bridge.stop(); server.closeAllConnections(); server.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  return { ...bridge, get: path => fetch(base + path, { headers }), post: (path, body) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) }) };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.ok(predicate(), "condition did not become true");
}

test("startup rejects empty, whitespace and non-string bridge tokens", () => {
  for (const token of ["", "   ", null, 123]) assert.throws(() => createBridge({ token }), /token/i);
});

test("snapshot ahead of queued deltas never renders overlapping text twice", () => {
  const events = [];
  const translator = new SnapshotTranslator((id, message) => events.push(message));
  translator.delta("ses_a", "msg_a", "Hello");
  translator.translate("ses_a", assistant("msg_a", "Hello world"));
  translator.delta("ses_a", "msg_a", " world");
  translator.delta("ses_a", "msg_a", "!");
  assert.equal(events.filter(m => m.type === "text_delta").map(m => m.text).join(""), "Hello world!");
});

test("mid-message snapshots and late deltas cannot corrupt text after reconnect", () => {
  const events = [];
  const translator = new SnapshotTranslator((id, message) => events.push(message));
  translator.delta("ses_a", "msg_a", "Hello");
  translator.translate("ses_a", assistant("msg_a", "Hello world"));
  // The world delta was lost during disconnect; the next delta is not an offset.
  translator.delta("ses_a", "msg_a", "!");
  translator.translate("ses_a", assistant("msg_a", "Hello world!"));
  assert.equal(events.filter(m => m.type === "text_delta").map(m => m.text).join(""), "Hello world!");
});

test("old completion cannot mark a newly admitted prompt idle", async t => {
  let resolveHistory;
  const f = await fixture(t, async (path, options) => {
    if (options?.method === "POST") return { data: {} };
    if (path.includes("/message?")) return new Promise(resolve => { resolveHistory = resolve; });
    return { data: [] };
  });
  f.mapEvent({ type: "session.execution.started", data: { sessionID: "ses_a" } });
  f.mapEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
  await waitFor(() => resolveHistory);
  assert.equal((await f.post("/api/prompt", { sessionId: "ses_a", text: "New turn" })).status, 202);
  resolveHistory({ data: [assistant("msg_old", "Old answer"), user], cursor: {} });
  await new Promise(r => setTimeout(r, 20));
  const result = await (await f.get("/api/messages?sessionId=ses_a&after=0")).json();
  assert.equal(result.state, "busy");
  assert.equal(result.messages.some(m => m.type === "result"), false);
});

test("history exposes a live cursor separately from transcript rows", async t => {
  const f = await fixture(t, async path => ({ data: path.includes("/message?") ? [assistant("msg_a", "Answer"), user] : path.includes("active") ? {} : [] }));
  const history = await (await f.get("/api/messages?sessionId=ses_a")).json();
  assert.equal(history.after, 0);
  assert.ok(history.messages.every(m => !Object.hasOwn(m, "id")));
  f.mapEvent({ type: "session.text.delta", data: { sessionID: "ses_a", assistantMessageID: "msg_next", delta: "Live" } });
  const live = await (await f.get("/api/messages?sessionId=ses_a&after=" + history.after)).json();
  assert.equal(live.messages.find(m => m.type === "text_delta").text, "Live");
});

test("completion paginates to the latest user boundary and totals the whole turn", async t => {
  const pages = [];
  const f = await fixture(t, async path => {
    pages.push(path);
    if (path.includes("cursor=older")) return { data: [...Array.from({ length: 2 }, (_, i) => assistant("msg_" + (1 - i), "part")), user], cursor: { next: null } };
    if (path.includes("/message?")) return { data: Array.from({ length: 10 }, (_, i) => assistant("msg_" + (11 - i), "part")), cursor: { next: "older" } };
    return { data: [] };
  });
  f.mapEvent({ type: "session.execution.started", data: { sessionID: "ses_a" } });
  f.mapEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
  await waitFor(() => f.replay.get("ses_a")?.some(m => m.type === "result"));
  const result = f.replay.get("ses_a").find(m => m.type === "result");
  assert.equal(result.inputTokens, 24);
  assert.ok(Math.abs(result.costUsd - 0.12) < 1e-9);
  const cursorRequest = pages.find(path => path.includes("cursor=older"));
  assert.ok(cursorRequest);
  assert.equal(new URL("http://stub" + cursorRequest).searchParams.has("order"), false);
});

test("polling rejects invalid replay cursors", async t => {
  const f = await fixture(t, async () => ({ data: [] }));
  for (const after of ["NaN", "-1", "1.5"]) assert.equal((await f.get("/api/messages?sessionId=ses_a&after=" + after)).status, 400);
});

test("history bootstrap carries only genuine live event IDs", async t => {
  const f = await fixture(t, async path => ({ data: path.includes("/message?") ? [assistant("msg_history", "Past answer"), user] : path.includes("active") ? {} : [] }));
  f.mapEvent({ type: "session.text.delta", data: { sessionID: "ses_a", assistantMessageID: "msg_live", delta: "Live" } });
  const bootstrap = await (await f.get("/api/messages?sessionId=ses_a")).json();
  assert.equal(bootstrap.history.length, 2);
  assert.deepEqual(bootstrap.messages, f.replay.get("ses_a"));
  assert.equal(bootstrap.after, bootstrap.messages.at(-1).id);
  f.mapEvent({ type: "session.text.delta", data: { sessionID: "ses_a", assistantMessageID: "msg_live", delta: " more" } });
  const next = await (await f.get("/api/messages?sessionId=ses_a&after=" + bootstrap.after)).json();
  assert.deepEqual(next.messages.map(m => m.text), [" more"]);
});

test("in-flight snapshots from an old generation cannot render into a new turn", async t => {
  let resolveSnapshot;
  const f = await fixture(t, async (path, options) => {
    if (options?.method === "POST") return { data: {} };
    if (path.endsWith("/message/msg_old")) return new Promise(resolve => { resolveSnapshot = resolve; });
    return { data: [] };
  });
  f.mapEvent({ type: "session.step.started", data: { sessionID: "ses_a", assistantMessageID: "msg_old" } });
  await waitFor(() => resolveSnapshot);
  assert.equal((await f.post("/api/prompt", { sessionId: "ses_a", text: "New turn" })).status, 202);
  resolveSnapshot({ data: assistant("msg_old", "Stale answer") });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.replay.get("ses_a").some(message => message.text === "Stale answer"), false);
});
