// A deterministic native protocol peer. Real-runtime coverage lives in native.test.ts.
const { createInterface } = require("node:readline");
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const store = process.env.ZCODE_FIXTURE_STORE;
const processProfile = process.env.ZCODE_FIXTURE_PROFILE === "process";
const deferred = new Set();
let sessions = {};
try {
  sessions = JSON.parse(readFileSync(store, "utf8"));
} catch {}
let active;
let configuredWorkspace;
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const save = () => {
  if (store)
    writeFileSync(
      store,
      JSON.stringify(
        Object.fromEntries(Object.entries(sessions).filter(([id]) => !deferred.has(id))),
      ),
    );
};
const settings = () => ({
  model: {
    ...(process.env.ZCODE_FIXTURE_NO_MODELS
      ? {}
      : { current: { providerId: "fixture", modelId: "model" } }),
    available: process.env.ZCODE_FIXTURE_NO_MODELS
      ? []
      : [
          { ref: { providerId: "fixture", modelId: "model" }, label: "Fixture" },
          ...(processProfile
            ? [
                {
                  ref: { providerId: "fixture", modelId: "other" },
                  label: "Other",
                  reasoning: { levels: [{ value: "high", label: "High" }] },
                },
              ]
            : []),
        ],
  },
  thoughtLevel: { enabled: false, available: [] },
  mode: { current: "build" },
});
const workspace = () => ({ workspacePath: process.cwd(), workspaceKey: process.cwd() });
function event(s, type, payload, turnId) {
  const value = {
    eventId: randomUUID(),
    sessionId: s.session.sessionId,
    type,
    payload,
    turnId,
    seq: ++s.runtime.eventSeq,
    timestamp: Date.now(),
  };
  write({ method: "session/event", params: value });
  return value;
}
function terminal(s, turnId, user, status = "success") {
  const now = Date.now(),
    id = randomUUID();
  if (status === "success")
    s.messages.push({
      info: {
        messageId: id,
        sessionId: s.session.sessionId,
        parentMessageId: user,
        role: "assistant",
        time: { created: now, completed: now },
        finish: "stop",
      },
      parts: [
        {
          partId: id + ":text",
          messageId: id,
          sessionId: s.session.sessionId,
          type: "text",
          text: "Fixture reply.",
        },
      ],
    });
  const done = event(
    s,
    "turn.completed",
    { resultType: status, response: "Fixture reply." },
    turnId,
  );
  if (process.env.ZCODE_FIXTURE_DUPLICATES) write({ method: "session/event", params: done });
  active = undefined;
  save();
  write({
    method: "state.updated",
    params: { sessionId: s.session.sessionId, reason: "prompt_completed" },
  });
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params: p = {} } = JSON.parse(line);
  if (!method) return;
  if (process.env.ZCODE_FIXTURE_LOG)
    appendFileSync(process.env.ZCODE_FIXTURE_LOG, JSON.stringify({ method, params: p }) + "\n");
  const s = sessions[p.sessionId];
  const reply = (result) => write({ id, result });
  if (method === "workspace/readState") {
    if (processProfile)
      return write({
        id,
        error: { code: -32601, message: "Method not found: workspace/readState" },
      });
    configuredWorkspace = p.workspace;
    return reply({ workspace: p.workspace, settings: settings() });
  }
  if (method === "workspace/readPresentation" && processProfile) {
    configuredWorkspace = p.workspace;
    return reply({ workspace: p.workspace, mode: "build", slashCommands: [] });
  }
  if (method === "session/create") {
    const sessionId = randomUUID(),
      now = Date.now();
    const value = {
      protocol: { name: "ZCode Protocol", version: 1 },
      session: {
        sessionId,
        workspace: p.workspace ?? workspace(),
        title: "Fixture",
        status: "idle",
        mode: p.mode ?? "build",
        sessionKind: "interactive",
        createdAt: now,
        updatedAt: now,
      },
      settings: settings(),
      projection: { status: "idle", contextUsed: 12, contextWindow: 10000 },
      messages: [],
      runtime: { eventSeq: 0 },
    };
    value.settings.mode.current = p.mode ?? value.settings.mode.current;
    sessions[sessionId] = value;
    if (p.persistence === "deferred") deferred.add(sessionId);
    save();
    return reply(value);
  }
  if (method === "session/list")
    return reply({ sessions: Object.values(sessions).map((s) => s.session) });
  if (!s) return write({ id, error: { code: -32004, message: "Session missing" } });
  if (method === "session/resume" && process.env.ZCODE_FIXTURE_RESUME_WORKSPACE)
    return reply({
      ...s,
      session: {
        ...s.session,
        workspace: {
          ...s.session.workspace,
          workspacePath: process.env.ZCODE_FIXTURE_RESUME_WORKSPACE,
        },
      },
    });
  if (method === "session/read" && processProfile)
    return reply({
      ...s,
      settings: {
        ...s.settings,
        model: {
          ...s.settings.model,
          available: s.settings.model.available.filter(
            (model) => model.ref.modelId === s.settings.model.current?.modelId,
          ),
        },
      },
    });
  if (method === "session/resume" || method === "session/read") return reply(s);
  if (method === "session/close" && processProfile) {
    if (deferred.has(p.sessionId)) {
      delete sessions[p.sessionId];
      deferred.delete(p.sessionId);
      save();
    }
    return reply({ closed: true });
  }
  if (method === "session/setModel") {
    s.settings.model.current = p.model;
    save();
    return reply(s);
  }
  if (method === "session/events") return reply({ events: [] });
  if (method === "session/subscribe") return reply({ eventSeq: s.runtime.eventSeq, events: [] });
  if (method === "session/usage")
    return reply({ inputTokens: 9, outputTokens: 3, totalTokens: 12 });
  if (method === "session/stop") {
    reply({ stopped: true });
    if (active) terminal(s, active.turnId, active.user, "cancelled");
    return;
  }
  if (method === "session/send") {
    if (configuredWorkspace?.workspaceKey !== s.session.workspace.workspaceKey)
      return write({
        id,
        error: { code: -32000, message: "Provider registry belongs to another workspace" },
      });
    const user = randomUUID(),
      turnId = randomUUID();
    s.messages.push({
      info: {
        messageId: user,
        sessionId: s.session.sessionId,
        role: "user",
        time: { created: Date.now() },
      },
      parts: [
        {
          partId: user + ":text",
          messageId: user,
          sessionId: s.session.sessionId,
          type: "text",
          text: p.content,
        },
      ],
    });
    // Notifications intentionally race the acceptance response.
    event(s, "turn.started", { messageId: user, input: p.content, inputId: p.inputId }, turnId);
    reply({ accepted: true });
    active = { turnId, user };
    if (p.content === "hang") return;
    if (p.content === "exit") return setTimeout(() => process.exit(7), 10);
    if (p.content === "malformed") return setTimeout(() => process.stdout.write("bad json\n"), 10);
    if (p.content === "silent") return;
    event(
      s,
      "model.streaming",
      { kind: "text_delta", assistantMessageId: "live-assistant", delta: "Fixture reply." },
      turnId,
    );
    setTimeout(() => terminal(s, turnId, user), 5);
    return;
  }
  write({ id, error: { code: -32601, message: "Unsupported fixture method" } });
});
