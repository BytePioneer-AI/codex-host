/** Web Codex and shared external Threads coexist without touching the GUI's native Codex. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeHarnessPluginRoute } from "@codexhost/shared-contracts";
import { WebHarnessPreferences } from "../src/harness-preferences.ts";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { HarnessRegistry } from "../src/harnesses.ts";
import { MixedSessions } from "../src/mixed-sessions.ts";
import { Sessions } from "../src/sessions.ts";
import { DataDir } from "../src/store.ts";
import {
  EventHub,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";
import { WebFiles } from "../src/web-files.ts";
import { WebImages } from "../src/web-images.ts";
import { Workspaces } from "../src/workspaces.ts";
import { MixedChHost, writeWebCodexPlugin } from "./support/web-codex.ts";

interface Summary {
  sessionId: string;
  projections: { values: Record<string, unknown> };
}

function capture() {
  const frames: Record<string, unknown>[] = [];
  const listeners: Array<() => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const listener of listeners.splice(0)) listener();
  };
  const sink: StreamSink = {
    id: "mixed-test",
    get closed() {
      return closed;
    },
    push(frame) {
      if (!closed) frames.push(frame as Record<string, unknown>);
    },
    end: close,
    fail(code, message) {
      frames.push({ type: "error", code, message });
      close();
    },
    onClose(listener) {
      if (closed) listener();
      else listeners.push(listener);
    },
  };
  return { frames, sink, close };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function setup(t: TestContext, sharedPreferences = false) {
  const root = mkdtempSync(join(tmpdir(), "mixed-sessions-"));
  const plugins = writeWebCodexPlugin(root);
  const data = new DataDir(join(root, "web"));
  const localData = new DataDir(join(data.root, "codex-sessions"));
  const host = new MixedChHost();
  host.add("gui-external", root, "Shared external Thread");
  host.add("gui-official", root, "GUI official Codex").modelProvider = "openai";
  const events = new EventHub(root);
  const workspaces = new Workspaces(data, root, true);
  const preferences = sharedPreferences
    ? new WebHarnessPreferences(undefined, data, events, join(root, "code-home"))
    : undefined;
  const harnesses = new HarnessRegistry([plugins], new Set(["codex"]), {
    scope: "web-codex",
    preferences: () => preferences,
  });
  const shared = new ChSessions(
    host,
    workspaces,
    events,
    new WebImages(data),
    new WebFiles(data),
    undefined,
    preferences,
  );
  const local = new Sessions(localData, harnesses, workspaces, events);
  const sessions = new MixedSessions(shared, local, harnesses, workspaces, events);
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  const handlers = new Map<string, StreamHandler>();
  const register = streams.register.bind(streams);
  streams.register = (endpoint, handler) => {
    handlers.set(endpoint, handler);
    register(endpoint, handler);
  };
  workspaces.register(rpc, streams);
  sessions.register(rpc, streams);
  sessions.registerCommands(rpc);
  sessions.registerImport(rpc);
  const eventSink = capture();
  events.handler({}, eventSink.sink);
  globalThis.fakeHarnessLog = [];
  globalThis.fakeHarnessScripts = {};
  t.after(async () => {
    eventSink.close();
    await sessions.close();
    await harnesses.close();
    await preferences?.close();
    globalThis.fakeHarnessLog = undefined;
    globalThis.fakeHarnessScripts = undefined;
    rmSync(root, { recursive: true, force: true });
  });
  async function call<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await rpc.dispatch(method, { args });
    assert.ok(
      result.ok,
      result.ok ? undefined : `${method}: ${result.error.code}: ${result.error.message}`,
    );
    return result.value as T;
  }
  const request = <T = unknown>(method: string, value: Record<string, unknown>) =>
    call<T>(method, { request: value });
  const create = async () =>
    (await request<{ sessionId: string }>("session/create", { cwd: root })).sessionId;
  const select = (sessionId: string, provider: "fake" | "codex") =>
    request("session/selectModel", {
      sessionId,
      provider,
      model: provider === "codex" ? "codex-model" : "native",
    });
  const prompt = (sessionId: string, text: string) =>
    request("session/prompt", {
      sessionId,
      requestId: `request-${text}`,
      mode: "queue",
      content: [{ type: "text", text }],
    });
  async function follow(endpoint: string, args: Record<string, unknown> = {}) {
    const handler = handlers.get(endpoint);
    assert.ok(handler, `${endpoint} must be registered`);
    const observer = capture();
    t.after(observer.close);
    await handler(args, observer.sink);
    return observer;
  }
  return {
    preferences,
    root,
    data,
    localData,
    host,
    events: eventSink.frames,
    sessions,
    rpc,
    call,
    request,
    create,
    select,
    prompt,
    follow,
  };
}

it("combines model catalogs and lists while excluding GUI native Codex", async (t) => {
  const bench = setup(t);
  const catalog = await bench.call<{
    groups: Array<{ id: string }>;
    default: { provider: string };
  }>("session/modelCatalog");
  assert.deepEqual(catalog.groups.map((group) => group.id).sort(), ["codex", "fake"]);
  assert.equal(catalog.default.provider, "fake");
  const { items } = await bench.call<{ items: Summary[] }>("session/list");
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["gui-external"],
  );
  assert.equal(
    bench.host.requests.some(({ method }) =>
      ["thread/start", "thread/resume", "turn/start"].includes(method),
    ),
    false,
  );
  assert.deepEqual(
    globalThis.fakeHarnessLog,
    [],
    "catalog inspection must not allocate a Codex Session",
  );
});

it("keeps Codex available when CH has no ready external Harness", async (t) => {
  const bench = setup(t);
  const nativeRequest = bench.host.request.bind(bench.host);
  bench.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    method === "codexhost/harness/plugins/list"
      ? ({ plugins: [] } as T)
      : nativeRequest<T>(method, params);
  const catalog = await bench.call<{
    groups: Array<{ id: string }>;
    default: { provider: string };
  }>("session/modelCatalog");
  assert.deepEqual(
    catalog.groups.map((group) => group.id),
    ["codex"],
  );
  assert.equal(catalog.default.provider, "codex");
  const id = await bench.create();
  await bench.prompt(id, "Codex without external Harness");
  await waitFor(
    () => globalThis.fakeHarnessLog?.some((item) => item.command === "turn.start") === true,
    "Codex turn without CH Harness",
  );
  assert.equal(
    bench.host.requests.some(({ method }) => ["thread/start", "turn/start"].includes(method)),
    false,
  );
});

it("moves an unsent draft between sources and sends only through its final source", async (t) => {
  const bench = setup(t);
  const id = await bench.create();
  await bench.select(id, "codex");
  let projections = await bench.request<{ values: Record<string, unknown> }>(
    "session/projections",
    { sessionId: id },
  );
  assert.deepEqual(projections.values.harnessIdentity, { id: "codex", name: "Web Codex" });
  assert.deepEqual(projections.values.attachmentInput, { enabled: false });
  await bench.select(id, "fake");
  projections = await bench.request<{ values: Record<string, unknown> }>("session/projections", {
    sessionId: id,
  });
  assert.deepEqual(projections.values.harnessIdentity, { id: "fake", name: "CH Harness" });
  await bench.select(id, "codex");
  assert.deepEqual(globalThis.fakeHarnessLog, []);
  await bench.prompt(id, "Web-owned Codex");
  await waitFor(
    () => globalThis.fakeHarnessLog?.some((item) => item.command === "turn.start") === true,
    "Codex turn",
  );
  assert.equal(
    bench.host.requests.some(({ method }) => ["thread/start", "turn/start"].includes(method)),
    false,
  );
  const list = await bench.call<{ items: Summary[] }>("session/list");
  assert.equal(list.items.filter((item) => item.sessionId === id).length, 1);
  const wrong = await bench.rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: id, provider: "fake", model: "native" } },
  });
  assert.equal(wrong.ok, false, "a started native Session cannot migrate to CH");
  await bench.prompt("gui-external", "existing CH route");
  assert.equal(bench.host.requests.filter(({ method }) => method === "turn/start").length, 1);
  assert.equal(
    bench.host.requests.find(({ method }) => method === "turn/start")?.params.threadId,
    "gui-external",
  );
});

it("does not create Codex implicitly for a projectless draft or route official GUI IDs", async (t) => {
  const bench = setup(t);
  const draft = await bench.request<{ sessionId: string }>("session/create", {});
  await bench.select(draft.sessionId, "codex");
  const rejected = await bench.rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: draft.sessionId,
        requestId: "projectless-codex",
        content: [{ type: "text", text: "Requires an explicit workspace" }],
      },
    },
  });
  assert.ok(!rejected.ok);
  assert.equal(rejected.error.code, "workspace/invalid-path");
  for (const method of [
    "session/prompt",
    "session/cancel",
    "session/rename",
    "session/fork",
    "workspace/pinSession",
  ]) {
    const result = await bench.rpc.dispatch(method, {
      args: {
        request: {
          sessionId: "gui-official",
          title: "Do not change",
          content: [{ type: "text", text: "Do not execute" }],
        },
      },
    });
    assert.equal(result.ok, false, method);
  }
  assert.equal(
    bench.host.requests.some(({ method }) =>
      [
        "turn/start",
        "turn/interrupt",
        "thread/name/set",
        "thread/start",
        "codexhost/thread/fork",
      ].includes(method),
    ),
    false,
  );
  assert.deepEqual(bench.host.pinWrites, []);
  assert.deepEqual(globalThis.fakeHarnessLog, []);
});

it("routes commands and permission catalog by Session identity, not current default", async (t) => {
  const bench = setup(t);
  const id = await bench.create();
  await bench.select(id, "codex");
  await bench.call("commands/execute", { agentId: id, line: "/permission yolo" });
  await bench.prompt(id, "local permissions");
  await waitFor(
    () => globalThis.fakeHarnessLog?.some((item) => item.command === "turn.start") === true,
    "Codex turn",
  );
  const permission = await bench.call<{ options: unknown[] }>("permissionPresets/catalog", {
    sessionId: id,
  });
  assert.ok(permission.options.length > 0);
  await bench.call("commands/execute", { agentId: "gui-external", line: "/permission auto" });
  assert.equal(bench.host.modes.get("gui-external"), "auto");
  assert.equal(
    bench.host.requests.filter(({ method }) => method === "codexhost/thread/permission-mode/select")
      .length,
    1,
  );
  const projections = await bench.request<{ values: { permissions: { currentValue: string } } }>(
    "session/projections",
    { sessionId: id },
  );
  assert.equal(projections.values.permissions.currentValue, "yolo");
});

it("combines source control baselines and forwards later source-specific projections", async (t) => {
  const bench = setup(t);
  const id = await bench.create();
  await bench.select(id, "codex");
  await bench.prompt(id, "local controls");
  await waitFor(
    () => globalThis.fakeHarnessLog?.some((item) => item.command === "turn.start") === true,
    "Codex turn",
  );
  await bench.request("session/projections", { sessionId: "gui-external" });
  const observer = await bench.follow("session/control");
  assert.equal(observer.frames.filter((frame) => frame.type === "baseline").length, 1);
  const baseline = observer.frames[0]?.value as { projections: Record<string, unknown> };
  assert.ok(baseline.projections[id]);
  assert.ok(baseline.projections["gui-external"]);
  await bench.request("session/rename", { sessionId: id, title: "Local updated" });
  await bench.request("session/rename", { sessionId: "gui-external", title: "Shared updated" });
  assert.ok(
    observer.frames.some(
      (frame) =>
        frame.type === "projection" &&
        frame.sessionId === id &&
        frame.key === "title" &&
        frame.value === "Local updated",
    ),
  );
  assert.ok(
    observer.frames.some(
      (frame) =>
        frame.type === "projection" &&
        frame.sessionId === "gui-external" &&
        frame.key === "title" &&
        frame.value === "Shared updated",
    ),
  );
  const history = await bench.follow("session/follow", {
    request: { address: { kind: "session", sessionId: id } },
  });
  await waitFor(() => history.frames.some((frame) => frame.type === "snapshot"), "local snapshot");
  assert.equal((history.frames[0]?.header as { id: string }).id, id);
  const page = await bench.request<{ records: unknown[] }>("session/page", {
    address: { kind: "session", sessionId: id },
    throughSeq: 100,
  });
  assert.ok(Array.isArray(page.records));
});

it("keeps an already-open control stream alive when a draft becomes a Codex Session", async (t) => {
  const bench = setup(t);
  const observer = await bench.follow("session/control");
  const id = await bench.create();
  await bench.select(id, "codex");
  await bench.prompt(id, "Control survives draft binding");
  await waitFor(
    () => globalThis.fakeHarnessLog?.some((item) => item.command === "turn.start") === true,
    "Codex turn after opening control",
  );
  assert.equal(observer.sink.closed, false);
  assert.equal(
    observer.frames.some((frame) => frame.type === "error"),
    false,
  );
  const afterBinding = observer.frames.length;
  await bench.request("session/rename", { sessionId: id, title: "Bound Codex title" });
  await bench.call("commands/execute", { agentId: id, line: "/permission yolo" });
  const later = observer.frames.slice(afterBinding);
  assert.ok(
    later.some(
      (frame) =>
        frame.type === "projection" &&
        frame.sessionId === id &&
        frame.key === "title" &&
        frame.value === "Bound Codex title",
    ),
  );
  assert.ok(
    later.some(
      (frame) =>
        frame.type === "projection" &&
        frame.sessionId === id &&
        frame.key === "permissions" &&
        (frame.value as { currentValue?: string }).currentValue === "yolo",
    ),
  );
  assert.equal(
    observer.sink.closed,
    false,
    "ownership handoff must retain the live control subscription",
  );
  assert.equal(observer.frames.filter((frame) => frame.type === "baseline").length, 1);
  assert.equal(
    observer.frames.some((frame) => frame.type === "error"),
    false,
  );
});

it("keeps local pins visible through CH refresh and never sends them to GUI pin service", async (t) => {
  const bench = setup(t);
  bench.host.pinnedIds = ["gui-external", "gui-official"];
  const id = await bench.create();
  await bench.select(id, "codex");
  await bench.prompt(id, "pin local");
  await waitFor(
    () => globalThis.fakeHarnessLog?.some((item) => item.command === "turn.start") === true,
    "Codex turn",
  );
  await bench.call("session/list");
  await bench.request("workspace/pinSession", { sessionId: id });
  await bench.call("session/list");
  const observer = await bench.follow("workspace/follow");
  assert.deepEqual(
    (observer.frames[0]?.value as { pinnedSessionIds: string[] }).pinnedSessionIds.sort(),
    ["gui-external", id].sort(),
  );
  assert.deepEqual(bench.host.pinWrites, []);
  const unpinned = await bench.request<{ pinnedSessionIds: string[] }>("workspace/unpinSession", {
    sessionId: "gui-external",
  });
  assert.deepEqual(unpinned.pinnedSessionIds, [id]);
  assert.deepEqual(bench.host.pinWrites, [{ threadId: "gui-external", pinned: false }]);
  assert.deepEqual(observer.frames.at(-1)?.pinnedSessionIds, [id]);
  await bench.request("workspace/unpinSession", { sessionId: id });
  assert.deepEqual(observer.frames.at(-1)?.pinnedSessionIds, []);
  assert.equal(bench.host.pinWrites.length, 1);
});

it("rejects Codex uploads and attached prompts while preserving shared draft uploads", async (t) => {
  const bench = setup(t);
  const id = await bench.create();
  await bench.select(id, "codex");
  const requestsBeforeUpload = bench.host.requests.length;
  const uploaded = await bench.rpc.dispatch("fileUploads/upload", {
    args: {
      agentId: id,
      request: { name: "note.txt", data: Buffer.from("data").toString("base64") },
    },
  });
  assert.equal(uploaded.ok, false);
  await assert.rejects(
    bench.sessions.uploadFile(
      id,
      (async function* () {
        yield Buffer.from("data");
      })(),
      "note.txt",
    ),
  );
  const attached = await bench.rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: id,
        requestId: "attached",
        content: [{ type: "file", receiptId: "not-valid" }],
      },
    },
  });
  assert.equal(attached.ok, false);
  assert.deepEqual(globalThis.fakeHarnessLog, []);
  assert.equal(
    bench.host.requests.length,
    requestsBeforeUpload,
    "rejected local attachments do not reach CH",
  );
  await bench.select(id, "fake");
  const file = await bench.sessions.uploadFile(
    id,
    (async function* () {
      yield Buffer.from("shared attachment");
    })(),
    "note.txt",
  );
  assert.ok(file.receiptId);
  assert.equal(
    bench.host.requests.some(({ method }) => ["thread/start", "turn/start"].includes(method)),
    false,
  );
});

it("does not expose an upload-only CH draft after the same draft is submitted to Codex", async (t) => {
  const bench = setup(t);
  const id = await bench.create();
  await bench.sessions.uploadFile(
    id,
    (async function* () {
      yield Buffer.from("staged before source selection");
    })(),
    "note.txt",
  );
  await bench.select(id, "codex");
  await bench.prompt(id, "Only this text is submitted");
  await waitFor(
    () => globalThis.fakeHarnessLog?.some((item) => item.command === "turn.start") === true,
    "Codex turn after staging a shared file",
  );
  const list = await bench.call<{ items: Summary[] }>("session/list");
  assert.equal(list.items.filter((item) => item.sessionId === id).length, 1);
  assert.equal(
    bench.host.requests.some(({ method }) => ["thread/start", "turn/start"].includes(method)),
    false,
  );
});

it("does not let concurrent create calls overwrite one draft's working directory", async (t) => {
  const bench = setup(t);
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const models = bench.sessions.catalog.models.bind(bench.sessions.catalog);
  let first = true;
  t.mock.method(bench.sessions.catalog, "models", async () => {
    if (first) {
      first = false;
      entered.resolve(undefined);
      await released.promise;
    }
    return models();
  });
  t.after(() => released.resolve(undefined));
  const request = (cwd: string) =>
    bench.rpc.dispatch("session/create", {
      args: { request: { sessionId: "concurrent-draft", cwd } },
    });
  const initial = request(bench.root);
  await entered.promise;
  const competing = request(bench.localData.root);
  await new Promise<void>((resolve) => setImmediate(resolve));
  released.resolve(undefined);
  const [initialResult, competingResult] = await Promise.all([initial, competing]);
  assert.equal(
    [initialResult, competingResult].filter((result) => result.ok).length,
    1,
    "only one cwd may bind this draft identity",
  );
  const list = await bench.call<{ items: Array<Summary & { cwd: string }> }>("session/list");
  assert.equal(list.items.filter((item) => item.sessionId === "concurrent-draft").length, 1);
  assert.equal(
    list.items.find((item) => item.sessionId === "concurrent-draft")?.cwd,
    initialResult.ok ? bench.root : bench.localData.root,
    "the losing request must not overwrite the successful request's cwd",
  );
});

it("deduplicates a first Codex submission retry after binding and rejects changed content", async (t) => {
  const bench = setup(t);
  const sessionId = await bench.create();
  await bench.select(sessionId, "codex");
  const original = {
    sessionId,
    requestId: "initial-request",
    mode: "queue",
    content: [{ type: "text", text: "Once only" }],
  };
  const accepted = await bench.request("session/prompt", original);
  await waitFor(
    () =>
      bench.localData
        .readLines<{ type: string }>(`sessions/${sessionId}/events.jsonl`)
        .some((event) => event.type === "turn/end"),
    "first Codex turn to finish",
  );
  assert.deepEqual(await bench.request("session/prompt", original), accepted);
  const changed = await bench.rpc.dispatch("session/prompt", {
    args: {
      request: {
        ...original,
        content: [{ type: "text", text: "Different request under the same ID" }],
      },
    },
  });
  assert.equal(changed.ok, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    globalThis.fakeHarnessLog?.filter((entry) => entry.command === "turn.start").length,
    1,
  );
  const projections = await bench.request<{ values: { inbox: { "next-turn": unknown[] } } }>(
    "session/projections",
    { sessionId },
  );
  assert.deepEqual(projections.values.inbox["next-turn"], []);
  await bench.request("session/prompt", { ...original, requestId: "second-request" });
  await waitFor(
    () => globalThis.fakeHarnessLog?.filter((entry) => entry.command === "turn.start").length === 2,
    "a genuinely new request",
  );
});

it("accepts advertised thinking options when a model omits its option allow-list", async (t) => {
  const bench = setup(t);
  const nativeRequest = bench.host.request.bind(bench.host);
  bench.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/harness/inspect")
      return {
        ...bench.host.inspection,
        catalog: {
          ...bench.host.inspection.catalog,
          thinkingOptions: [{ id: "high", label: "High" }],
        },
        capabilities: {
          ...bench.host.inspection.capabilities,
          configuration: {
            ...bench.host.inspection.capabilities.configuration,
            selectThinkingOption: true,
          },
        },
      } as T;
    return nativeRequest<T>(method, params);
  };
  const sessionId = await bench.create();
  await bench.request("session/selectModel", {
    sessionId,
    provider: "fake",
    model: "native",
    reasoningEffort: "high",
  });
  const projections = await bench.request<{
    values: { modelSelection: { next: { reasoningEffort?: string } } };
  }>("session/projections", { sessionId });
  assert.equal(projections.values.modelSelection.next.reasoningEffort, "high");
  const missing = await bench.rpc.dispatch("session/selectModel", {
    args: {
      request: { sessionId, provider: "fake", model: "native", reasoningEffort: "unadvertised" },
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(
    bench.host.requests.some(({ method }) => ["thread/start", "turn/start"].includes(method)),
    false,
  );
});

for (const source of ["fake", "codex"] as const) {
  it(`keeps an old ${source} draft's displayed native permission after another client changes defaults`, async (t) => {
    const bench = setup(t, true);
    const preferences = bench.preferences;
    assert.ok(preferences);
    await preferences.remember(source, {
      model: { id: source === "codex" ? "codex-model" : "native" },
    });
    const id = await bench.create();
    const before = await bench.request<{ values: { permissions: { currentValue: string } } }>(
      "session/projections",
      { sessionId: id },
    );
    assert.equal(before.values.permissions.currentValue, "ask");
    await preferences.remember(source, {
      model: { id: source === "codex" ? "codex-model" : "native" },
      permissionModeId: source === "codex" ? "yolo" : "auto",
    });
    const updated = await preferences.get(source);
    await bench.prompt(id, "preserve draft permission");
    if (source === "fake") {
      const start = bench.host.requests.find((request) => request.method === "thread/start");
      assert.ok(start);
      assert.equal(decodeHarnessPluginRoute(String(start.params.model))?.permissionModeId, "ask");
    } else {
      await waitFor(
        () => globalThis.fakeHarnessLog?.some((item) => item.command === "turn.start") === true,
        "Codex start",
      );
      const actual = await bench.request<{ values: { permissions: { currentValue: string } } }>(
        "session/projections",
        { sessionId: id },
      );
      assert.equal(actual.values.permissions.currentValue, "ask");
    }
    assert.deepEqual(
      await preferences.get(source),
      updated,
      "materialization must not save old defaults",
    );
  });
}

it("concurrent uploads and a failed upload preserve newer preferences and the old draft configuration", async (t) => {
  const bench = setup(t, true);
  const preferences = bench.preferences;
  assert.ok(preferences);
  bench.host.inspection.catalog.models.push({ ref: { id: "alternate" }, label: "Alternate" });
  const id = await bench.create();
  const reading = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  const first = bench.sessions.uploadFile(
    id,
    (async function* () {
      reading.resolve(undefined);
      await resume.promise;
      yield Buffer.from("first");
    })(),
    "first.txt",
  );
  await reading.promise;
  await preferences.remember("fake", { model: { id: "alternate" }, permissionModeId: "auto" });
  const updated = await preferences.get();
  const second = bench.sessions.uploadFile(
    id,
    (async function* () {
      yield Buffer.from("second");
    })(),
    "second.txt",
  );
  await assert.rejects(
    bench.sessions.uploadFile(
      id,
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("upload failed");
      })(),
      "failed.txt",
    ),
    /upload failed/,
  );
  resume.resolve(undefined);
  await Promise.all([first, second]);
  assert.deepEqual(await preferences.get(), updated);
  await bench.prompt(id, "old draft after uploads");
  const start = bench.host.requests.find((request) => request.method === "thread/start");
  assert.ok(start);
  const route = decodeHarnessPluginRoute(String(start.params.model));
  assert.equal(route?.model?.id, "native");
  assert.equal(route?.permissionModeId, "ask");
  assert.deepEqual(await preferences.get(), updated);
});
