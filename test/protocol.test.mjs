import test from "node:test";
import assert from "node:assert/strict";
import {
  SnapshotTranslator,
  permissionDecision,
  permissionCard,
  formAnswer,
  formCard,
  createSseParser,
  backoffDelay,
} from "../protocol.mjs";

test("snapshot text grows incrementally without duplicates or user/chain-of-thought leakage", () => {
  const events = [];
  const t = new SnapshotTranslator((id, m) => events.push(m));
  t.translate("ses_a", {
    id: "msg_user",
    type: "user",
    text: "private prompt",
  });
  const m = {
    id: "msg_a",
    type: "assistant",
    content: [
      { type: "reasoning", text: "private reasoning" },
      { type: "text", text: "Hello" },
    ],
  };
  t.translate("ses_a", m);
  t.translate("ses_a", m);
  m.content[1].text += " world";
  t.translate("ses_a", m);
  assert.deepEqual(
    events.filter((e) => e.type === "text_delta").map((e) => e.text),
    ["Hello", " world"],
  );
  assert.equal(events.filter((e) => e.state === "think_start").length, 1);
  assert.equal(JSON.stringify(events).includes("private"), false);
});

test("text rewrites are not sliced at the old length", () => {
  const events = [];
  const t = new SnapshotTranslator((id, m) => events.push(m));
  for (const text of ["abc", "xyz"])
    t.translate("ses_a", {
      id: "msg_a",
      type: "assistant",
      content: [{ type: "text", text }],
    });
  assert.deepEqual(
    events.filter((e) => e.type === "text_delta").map((e) => e.text),
    ["abc", "xyz"],
  );
});

test("live deltas and REST snapshots share text state, including lagging snapshots", () => {
  const events = [];
  const translator = new SnapshotTranslator((id, m) => events.push(m));
  translator.delta("ses_a", "msg_a", "Hello");
  const snapshot = (text) => ({
    id: "msg_a",
    type: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text },
    ],
  });
  translator.translate("ses_a", snapshot("Hel"));
  translator.translate("ses_a", snapshot("Hello"));
  translator.delta("ses_a", "msg_a", " world");
  translator.translate("ses_a", snapshot("Hello world!"));
  assert.deepEqual(
    events.filter((e) => e.type === "text_delta").map((e) => e.text),
    ["Hello", " world", "!"],
  );
});

test("V2 tools use name/id, deduplicate start/end and omit large outputs", () => {
  const events = [];
  const t = new SnapshotTranslator((id, m) => events.push(m));
  const m = {
    id: "msg_a",
    type: "assistant",
    content: [
      {
        id: "call_a",
        type: "tool",
        name: "shell",
        state: { status: "running", input: { command: "npm test" } },
      },
    ],
  };
  t.translate("ses_a", m);
  t.translate("ses_a", m);
  m.content[0].state.status = "completed";
  m.content[0].state.content = [{ text: "secret".repeat(10000) }];
  t.translate("ses_a", m);
  t.translate("ses_a", m);
  assert.deepEqual(
    events.filter((e) => e.type.startsWith("tool_")).map((e) => e.type),
    ["tool_start", "tool_end"],
  );
  assert.equal(events.at(-1).summary, "npm test");
  assert.equal(events.at(-1).toolId, "call_a");
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("quiet read tools produce no cards and tracked state is bounded", () => {
  const events = [];
  const t = new SnapshotTranslator((id, m) => events.push(m), { maxParts: 5 });
  for (let i = 0; i < 20; i++)
    t.translate("ses_a", {
      id: `msg_${i}`,
      type: "assistant",
      content: [
        {
          type: "tool",
          id: `tool_${i}`,
          name: "read",
          state: { status: "completed" },
        },
      ],
    });
  assert.equal(events.length, 0);
  assert.equal(t.parts.size, 5);
  t.clear("ses_a");
  assert.equal(t.parts.size, 0);
});

test("permission options and explicit decisions fail closed", () => {
  assert.equal(permissionDecision("allowAlways"), "always");
  assert.equal(permissionDecision("allow"), "once");
  assert.equal(permissionDecision("deny"), "reject");
  for (const value of [undefined, "typo", "toString", "__proto__"])
    assert.throws(() => permissionDecision(value));
  const card = permissionCard({
    id: "per_a",
    action: "shell",
    resources: ["npm test"],
    message: "Run tests?",
  });
  assert.equal(card.toolName, "shell");
  assert.equal(card.description, "Run tests?");
  assert.equal(card.detail, "npm test");
  assert.equal(card.options.length, 3);
});

test("form choices map displayed labels back to wire values", () => {
  const form = {
    id: "frm_a",
    fields: [
      {
        key: "mode",
        title: "Choose mode",
        type: "string",
        required: true,
        options: [{ label: "Fast", value: "fast" }],
      },
    ],
  };
  assert.deepEqual(formAnswer(form, "Fast"), { mode: "fast" });
  assert.deepEqual(formAnswer(form, '{"Choose mode":"Fast"}'), {
    mode: "fast",
  });
  assert.equal(formCard(form).questions[0].options[0].label, "Fast");
});

test("typed multi-field forms support booleans, numbers and multiselect", () => {
  const form = {
    fields: [
      { key: "ok", type: "boolean" },
      { key: "count", type: "integer" },
      {
        key: "choices",
        type: "multiselect",
        options: [{ label: "Alpha", value: "a" }],
      },
    ],
  };
  assert.deepEqual(
    formAnswer(form, { ok: "Yes", count: "3", choices: ["Alpha"] }),
    { ok: true, count: 3, choices: ["a"] },
  );
  assert.throws(() => formAnswer(form, "hello"), /multiple fields/);
  assert.throws(() => formAnswer(form, { ok: "maybe" }), /boolean/);
  assert.throws(() => formAnswer(form, { count: "1.5" }), /number/);
});

test("required fields and invalid numerical values are rejected", () => {
  assert.throws(
    () =>
      formAnswer(
        { fields: [{ key: "a", type: "string", required: true }] },
        {},
      ),
    /Missing/,
  );
  for (const value of ["", "abc", true, null])
    assert.throws(() =>
      formAnswer({ fields: [{ key: "a", type: "number" }] }, value),
    );
});

test("conditional fields use normalized answers and multiselect membership", () => {
  const form = {
    fields: [
      {
        key: "choice",
        type: "multiselect",
        options: [{ label: "Alpha", value: "a" }],
      },
      {
        key: "detail",
        type: "string",
        required: true,
        when: [{ key: "choice", op: "eq", value: "a" }],
      },
    ],
  };
  assert.deepEqual(formAnswer(form, { choice: [] }), { choice: [] });
  assert.deepEqual(formAnswer(form, { choice: ["Alpha"], detail: "yes" }), {
    choice: ["a"],
    detail: "yes",
  });
  assert.throws(() => formAnswer(form, { choice: ["Alpha"] }), /Missing/);
});

test("SSE supports split chunks, CRLF, multiline data and payload wrappers", () => {
  const events = [];
  const parse = createSseParser((e) => events.push(e));
  parse(':heartbeat\r\n\r\ndata: {"pay');
  parse(
    'load\":{\"type\":\"session.step.streamed\",\r\ndata: \"data\":{\"sessionID\":\"ses_a\"}}}\r\n\r\n',
  );
  parse('data: malformed\n\ndata: {"type":"ok"}\n\n');
  assert.deepEqual(
    events.map((e) => e.type),
    ["session.step.streamed", "ok"],
  );
});

test("reconnect backoff caps at 30 seconds without jitter", () => {
  assert.equal(
    backoffDelay(0, () => 0.5),
    500,
  );
  assert.equal(
    backoffDelay(2, () => 0.5),
    2000,
  );
  assert.equal(
    backoffDelay(100, () => 0.5),
    30000,
  );
});
