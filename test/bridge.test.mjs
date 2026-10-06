import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createBridge } from "../bridge.mjs";

async function fixture(t, request) {
  const bridge = createBridge({ request, token: "test-token", log() {} });
  const server = bridge.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    bridge.stop();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...bridge,
    base,
    async get(path) {
      return fetch(base + path, {
        headers: { authorization: "Bearer test-token" },
      });
    },
    async post(path, body) {
      return fetch(base + path, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    },
  };
}

test("auth rejects missing or wrong tokens and accepts bearer/query auth", async (t) => {
  const f = await fixture(t, async () => ({ data: [] }));
  assert.equal((await fetch(f.base + "/api/sessions")).status, 401);
  assert.equal((await fetch(f.base + "/api/sessions?token=bad")).status, 401);
  assert.equal(
    (await fetch(f.base + "/api/sessions?token=test-token")).status,
    200,
  );
  assert.equal((await f.get("/api/sessions")).status, 200);
});

test("sessions present as a known provider and exclude subagents/archives", async (t) => {
  const f = await fixture(t, async (path) =>
    path.includes("active")
      ? { data: { ses_a: {} } }
      : {
          data: [
            { id: "ses_a", title: "Main", location: { directory: "/project" } },
            { id: "ses_child", parentID: "ses_a" },
            { id: "ses_old", time: { archived: 1 } },
          ],
        },
  );
  const { sessions } = await (await f.get("/api/sessions")).json();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].provider, "claude");
  assert.equal(sessions[0].cwd, "/project");
});

test("V2 streamed events fetch projected messages and emit only incremental text", async (t) => {
  let text = "Hello";
  let requests = 0;
  const f = await fixture(t, async (path) => {
    assert.equal(path, "/api/session/ses_a/message/msg_a");
    requests++;
    return {
      data: {
        id: "msg_a",
        type: "assistant",
        content: [{ type: "text", text }],
      },
    };
  });
  const event = {
    type: "session.step.streamed",
    data: { sessionID: "ses_a", assistantMessageID: "msg_a" },
  };
  f.mapEvent(event);
  f.mapEvent(event);
  f.mapEvent(event);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(requests, 1);
  text += " world";
  f.mapEvent(event);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(
    f.replay
      .get("ses_a")
      .filter((e) => e.type === "text_delta")
      .map((e) => e.text),
    ["Hello", " world"],
  );
});

test("session-only ring approval uses oldest request and maps always-allow", async (t) => {
  const pending = [
    { id: "per_first", sessionID: "ses_a", action: "shell", resources: [] },
    { id: "per_second", sessionID: "ses_a", action: "edit", resources: [] },
  ];
  const calls = [];
  const f = await fixture(t, async (path, options) => {
    if (options?.method === "POST") {
      calls.push([path, JSON.parse(options.body)]);
      pending.shift();
      return null;
    }
    return { data: path.endsWith("/permission") ? pending : [] };
  });
  const response = await f.post("/api/permission-response", {
    sessionId: "ses_a",
    decision: "allowAlways",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    ["/api/session/ses_a/permission/per_first/reply", { decision: "always" }],
  ]);
  assert.equal(f.pendingPermissions.has("per_first"), false);
  assert.equal(f.pendingPermissions.has("per_second"), true);
});

test("permission validation never approves invalid decisions or cross-session IDs", async (t) => {
  const calls = [];
  const f = await fixture(t, async (path, options) => {
    if (options) calls.push(path);
    return { data: [] };
  });
  assert.equal(
    (
      await f.post("/api/permission-response", {
        sessionId: "ses_a",
        decision: "typo",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.post("/api/permission-response", {
        sessionId: "ses_a",
        decision: "allow",
        toolUseId: "per_other",
      })
    ).status,
    404,
  );
  assert.equal(calls.length, 0);
});

test("failed permission reply retains the pending card for retry", async (t) => {
  const p = { id: "per_a", sessionID: "ses_a", action: "shell", resources: [] };
  const f = await fixture(t, async (path, options) => {
    if (options) throw new Error("upstream offline");
    return { data: path.endsWith("/permission") ? [p] : [] };
  });
  assert.equal(
    (
      await f.post("/api/permission-response", {
        sessionId: "ses_a",
        decision: "allow",
      })
    ).status,
    500,
  );
  assert.equal(f.pendingPermissions.has("per_a"), true);
  assert.equal(
    f.replay.get("ses_a").some((m) => m.type === "permission_result"),
    false,
  );
});

test("V2 form replies map option labels to values and clear only after success", async (t) => {
  const form = {
    id: "frm_a",
    sessionID: "ses_a",
    title: "Mode",
    fields: [
      {
        key: "mode",
        type: "string",
        options: [{ value: "fast", label: "Fast" }],
      },
    ],
  };
  const calls = [];
  const f = await fixture(t, async (path, options) => {
    if (options) {
      calls.push([path, JSON.parse(options.body)]);
      return null;
    }
    return { data: path.endsWith("/form") ? [form] : [] };
  });
  assert.equal(
    (
      await f.post("/api/question-response", {
        sessionId: "ses_a",
        answer: "Fast",
      })
    ).status,
    200,
  );
  assert.deepEqual(calls, [
    ["/api/session/ses_a/form/frm_a/reply", { answer: { mode: "fast" } }],
  ]);
  assert.equal(f.pendingForms.size, 0);
});

test("failed form replies retain the request; skip cancels through DELETE", async (t) => {
  const form = {
    id: "frm_a",
    sessionID: "ses_a",
    fields: [{ key: "text", type: "string" }],
  };
  const calls = [];
  const f = await fixture(t, async (path, options) => {
    if (options) {
      calls.push(options.method);
      if (options.method === "POST") throw new Error("offline");
      return null;
    }
    return { data: path.endsWith("/form") ? [form] : [] };
  });
  assert.equal(
    (
      await f.post("/api/question-response", {
        sessionId: "ses_a",
        answer: "hello",
      })
    ).status,
    502,
  );
  assert.equal(f.pendingForms.size, 1);
  assert.equal(
    (
      await f.post("/api/question-response", {
        sessionId: "ses_a",
        answer: "skip",
      })
    ).status,
    200,
  );
  assert.deepEqual(calls, ["POST", "DELETE"]);
});

test("snapshot resync recovers asks and an outage does not remove them", async (t) => {
  let offline = false;
  const f = await fixture(t, async (path) => {
    if (offline) throw new Error("offline");
    return {
      data: path.endsWith("/permission")
        ? [{ id: "per_a", sessionID: "ses_a", resources: [] }]
        : [],
    };
  });
  await f.syncAsks("ses_a");
  await f.syncAsks("ses_a");
  assert.equal(
    f.replay.get("ses_a").filter((m) => m.type === "permission_request").length,
    1,
  );
  offline = true;
  await f.syncAsks("ses_a");
  assert.equal(f.pendingPermissions.size, 1);
});

test("prompt creates a V2 session then durably submits text", async (t) => {
  const calls = [];
  const f = await fixture(t, async (path, options) => {
    calls.push([path, JSON.parse(options.body)]);
    return { data: { id: "ses_new" } };
  });
  const response = await f.post("/api/prompt", {
    text: "hello",
    cwd: "/project",
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).sessionId, "ses_new");
  assert.deepEqual(calls[0], [
    "/api/session",
    { title: "hello", location: { directory: "/project" } },
  ]);
  assert.deepEqual(calls[1], [
    "/api/session/ses_new/prompt",
    { text: "hello" },
  ]);
  assert.equal(
    (await f.post("/api/prompt", { text: "hello", sessionId: "not-a-session" }))
      .status,
    400,
  );
});

test("history does not wait for idle and polling supports after cursors", async (t) => {
  const f = await fixture(t, async (path) => {
    if (path.includes("/message?"))
      return {
        data: [
          {
            id: "msg_a",
            type: "assistant",
            content: [{ type: "text", text: "Hello" }],
          },
          { id: "msg_u", type: "user", text: "Hi" },
        ],
      };
    return { data: path.includes("active") ? { ses_a: {} } : [] };
  });
  const history = await (await f.get("/api/sessions/ses_a/history")).json();
  assert.deepEqual(history.history, [
    { role: "user", text: "Hi" },
    { role: "assistant", text: "Hello" },
  ]);
  f.mapEvent({ type: "session.step.started", data: { sessionID: "ses_a" } });
  const first = await (
    await f.get("/api/messages?sessionId=ses_a&after=0")
  ).json();
  assert.equal(first.messages.length, 1);
  const second = await (
    await f.get(`/api/messages?sessionId=ses_a&after=${first.messages[0].id}`)
  ).json();
  assert.equal(second.messages.length, 0);
});

test("HTTP SSE replays only events after Last-Event-ID", async (t) => {
  const f = await fixture(t, async () => ({ data: [] }));
  f.mapEvent({ type: "session.step.started", data: { sessionID: "ses_a" } });
  f.mapEvent({
    type: "session.error",
    data: { sessionID: "ses_a", error: { message: "oops" } },
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(
    f.base + "/api/events?sessionId=ses_a&needReplay=true",
    {
      headers: { authorization: "Bearer test-token", "last-event-id": "1" },
      signal: controller.signal,
    },
  );
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const { value } = await response.body.getReader().read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /id: 2/);
  assert.doesNotMatch(text, /id: 1\n/);
});

test("V2 execution completion emits final text before result and does not duplicate results", async (t) => {
  const f = await fixture(t, async () => ({
    data: [
      {
        id: "msg_a",
        type: "assistant",
        content: [{ type: "text", text: "Done" }],
        tokens: { input: 10, output: 3 },
        cost: 0.01,
      },
      { id: "msg_u", type: "user", text: "Work" },
    ],
  }));
  f.mapEvent({
    type: "session.execution.started",
    data: { sessionID: "ses_a" },
  });
  f.mapEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_a" },
  });
  await new Promise((r) => setTimeout(r, 20));
  f.mapEvent({
    type: "session.execution.succeeded",
    data: { sessionID: "ses_a" },
  });
  const messages = f.replay.get("ses_a");
  assert.equal(messages.filter((m) => m.type === "result").length, 1);
  assert.equal(messages.find((m) => m.type === "result").text, "Done");
  assert.equal(messages.find((m) => m.type === "result").inputTokens, 10);
  assert.ok(
    messages.findIndex((m) => m.type === "text_delta") <
      messages.findIndex((m) => m.type === "result"),
  );
  assert.equal(messages.at(-1).state, "idle");
});

test("V2 form-created events surface immediately and global forms are ignored", async (t) => {
  const form = {
    id: "frm_a",
    sessionID: "ses_a",
    fields: [{ key: "mode", type: "string" }],
  };
  const f = await fixture(t, async (path) => ({
    data: path.endsWith("/form") ? [form] : [],
  }));
  f.mapEvent({ type: "form.created", data: { form } });
  assert.equal(f.replay.get("ses_a")[0].type, "user_question");
  f.mapEvent({
    type: "form.created",
    data: { form: { ...form, id: "frm_global", sessionID: "global" } },
  });
  assert.equal(f.pendingForms.has("frm_global"), false);
});

test("real upstream HTTP/SSE adapter authenticates and translates V2 deltas", async (t) => {
  let upstreamStream;
  let connections = 0;
  const authorization =
    "Basic " + Buffer.from("opencode:stub-password").toString("base64");
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, authorization);
    if (req.url === "/api/event") {
      connections++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"server.connected","data":{}}\n\n');
      upstreamStream = res;
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data:
            req.url === "/api/session/active"
              ? {}
              : req.url.endsWith("/permission") && connections > 1
                ? [
                    {
                      id: "per_recovered",
                      sessionID: "ses_a",
                      action: "shell",
                      resources: [],
                    },
                  ]
                : [],
        }),
      );
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const bridge = createBridge({
    token: "test-token",
    log() {},
    connection: async () => ({
      base: `http://127.0.0.1:${upstream.address().port}`,
      authorization,
    }),
  });
  t.after(() => bridge.stop());
  bridge.start();
  for (let i = 0; i < 100 && !upstreamStream; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(upstreamStream);
  upstreamStream.write(
    'data: {"type":"session.text.delta","data":{"sessionID":"ses_a","assistantMessageID":"msg_a","ordinal":0,"delta":"Live"}}\n\n',
  );
  for (let i = 0; i < 100 && !bridge.replay.get("ses_a"); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    bridge.replay.get("ses_a").find((m) => m.type === "text_delta").text,
    "Live",
  );
  upstreamStream.end();
  for (
    let i = 0;
    i < 300 && !bridge.pendingPermissions.has("per_recovered");
    i++
  )
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(connections, 2);
  assert.equal(bridge.pendingPermissions.has("per_recovered"), true);
});

test("SSE restores an outstanding permission that fell out of the replay window", async (t) => {
  const permission = {
    id: "per_a",
    sessionID: "ses_a",
    action: "shell",
    resources: [],
  };
  const f = await fixture(t, async (path) => ({
    data: path.endsWith("/permission") ? [permission] : [],
  }));
  await f.syncAsks("ses_a");
  for (let i = 0; i < 510; i++)
    f.mapEvent({
      type: "session.text.delta",
      data: { sessionID: "ses_a", assistantMessageID: "msg_a", delta: "x" },
    });
  assert.equal(
    f.replay.get("ses_a").some((m) => m.type === "permission_request"),
    false,
  );
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(f.base + "/api/events?sessionId=ses_a", {
    headers: { authorization: "Bearer test-token" },
    signal: controller.signal,
  });
  const { value } = await response.body.getReader().read();
  assert.match(new TextDecoder().decode(value), /permission_request/);
});
