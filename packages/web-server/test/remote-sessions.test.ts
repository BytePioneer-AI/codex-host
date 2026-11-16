import { defined } from "./support/defined.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import { RemoteSessions, remoteSessionId, remoteSessionIdentity } from "../src/remote-sessions.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import type { StreamSink } from "../src/transport.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";

it("archives and undoes through workspace RPCs without losing local archives or other hosts", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "remote-archive-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspaces = new Workspaces(new DataDir(directory), directory);
  workspaces.setReferenceArchives(["local-archived"]);
  const rpc = new RpcRegistry(),
    streams = new StreamRegistry();
  let follow: ((args: Record<string, unknown>, sink: StreamSink) => unknown) | undefined;
  const register = streams.register.bind(streams);
  streams.register = (name, handler) => {
    if (name === "workspace/follow") follow = handler;
    register(name, handler);
  };
  workspaces.register(rpc, streams);
  const frames: unknown[] = [];
  await defined(follow)(
    {},
    {
      id: "observer",
      closed: false,
      push: (frame) => frames.push(frame),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  const archived = new Set<string>();
  const writes: RemoteSessionOperation[] = [];
  let loseWrite = false,
    loseRead = false;
  let pauseList = false;
  const listing = Promise.withResolvers<undefined>();
  const releaseList = Promise.withResolvers<undefined>();
  t.after(() => releaseList.resolve(undefined));
  const row = {
    id: "same",
    cwd: "/remote",
    name: "Remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const remote = new RemoteSessions(
    new EventHub("archive"),
    async (op) => {
      if (op.kind === "hosts")
        return ["remote-control:a", "remote-control:b"].map((hostId) => ({ hostId, online: true }));
      if (op.kind === "list") {
        const data = archived.has(op.hostId) ? [] : [row];
        if (pauseList) {
          pauseList = false;
          listing.resolve(undefined);
          await releaseList.promise;
        }
        return { data, nextCursor: null };
      }
      if (op.kind === "read") {
        if (loseRead) throw new Error("read unavailable");
        return { result: { thread: row }, epoch: "epoch", requests: [] };
      }
      writes.push(op);
      if (loseWrite) throw new Error("unknown outcome");
      if (op.kind === "archive") {
        if (op.archived) archived.add(op.hostId);
        else archived.delete(op.hostId);
      }
      loseRead = true;
      return {};
    },
    workspaces,
  );
  t.after(() => remote.close());
  remote.install(rpc, streams);
  const a = remoteSessionId("remote-control:a", "same"),
    b = remoteSessionId("remote-control:b", "same");
  const call = (method: string, sessionId: string) =>
    rpc.dispatch(method, { args: { request: { sessionId } } });
  await remote.refresh();
  pauseList = true;
  const staleRefresh = remote.refresh();
  await listing.promise;
  assert.deepEqual(await call("workspace/archiveSession", a), {
    ok: true,
    value: { archivedSessionIds: ["local-archived", a] },
  });
  assert.deepEqual(frames.at(-1), { type: "archived", archivedSessionIds: ["local-archived", a] });
  releaseList.resolve(undefined);
  await staleRefresh;
  assert.deepEqual(workspaces.archivedSessionIds(), ["local-archived", a]);
  workspaces.setReferenceArchives(["local-new"]);
  assert.deepEqual(workspaces.archivedSessionIds(), ["local-new", a]);
  await remote.refresh(); // The active catalog no longer contains the archived row; undo still works.
  loseRead = false;
  assert.deepEqual(await call("workspace/unarchiveSession", a), {
    ok: true,
    value: { archivedSessionIds: ["local-new"] },
  });
  assert.deepEqual(
    writes.map((op) => "hostId" in op && op.hostId),
    ["remote-control:a", "remote-control:a"],
  );
  loseRead = false;
  loseWrite = true;
  const failed = await call("workspace/archiveSession", b);
  assert.ok(!failed.ok);
  assert.equal(failed.error.code, "remote/outcome-unknown");
  assert.deepEqual(workspaces.archivedSessionIds(), ["local-new"]);
  assert.equal(writes.length, 3);
});

function fixture() {
  const calls: RemoteSessionOperation[] = [];
  let offline = false,
    loseWrite = false;
  const row = {
    id: "same",
    cwd: "/private/remote",
    name: "Remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const events = new EventHub("fixture"),
    rpc = new RpcRegistry();
  for (const method of [
    "session/list",
    "session/projections",
    "session/prompt",
    "session/rename",
    "session/attachment",
    "session/fork",
    "session/page",
  ])
    rpc.register(method, () =>
      method === "session/list" ? { items: [{ sessionId: "same" }] } : { local: true },
    );
  const remote = new RemoteSessions(events, async (operation) => {
    calls.push(operation);
    if (offline) throw new Error("offline");
    if (operation.kind === "hosts")
      return [
        { hostId: "remote-ssh-discovered:a", online: true },
        { hostId: "remote-control:b", online: true },
      ];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read")
      return { epoch: "epoch-" + operation.hostId, result: { thread: row }, requests: [] };
    if (loseWrite) throw new Error("unknown");
    return {};
  });
  remote.install(rpc, new StreamRegistry());
  const call = (method: string, request: object = {}) =>
    rpc.dispatch(method, { args: { request } });
  return {
    remote,
    calls,
    call,
    offline: () => {
      offline = true;
    },
    loseWrite: () => {
      loseWrite = true;
    },
  };
}
it("retains undo identity when the catalog sees archive before its write acknowledgement", async (t) => {
  const applied = Promise.withResolvers<undefined>();
  const acknowledgement = Promise.withResolvers<undefined>();
  t.after(() => acknowledgement.resolve(undefined));
  let archived = false;
  const row = {
    id: "native",
    cwd: "/remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const remote = new RemoteSessions(new EventHub("race"), async (op) => {
    if (op.kind === "hosts") return [{ hostId: "remote-control:a", online: true }];
    if (op.kind === "list") return { data: archived ? [] : [row], nextCursor: null };
    if (op.kind === "read") return { result: { thread: row }, epoch: "epoch", requests: [] };
    if (op.kind === "archive") {
      archived = op.archived;
      if (archived) {
        applied.resolve(undefined);
        await acknowledgement.promise;
      }
    }
    return {};
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  for (const method of ["workspace/archiveSession", "workspace/unarchiveSession"])
    rpc.register(method, () => {
      throw new Error("must not route locally");
    });
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId("remote-control:a", "native");
  const call = (method: string) => rpc.dispatch(method, { args: { request: { sessionId: id } } });
  const archiving = call("workspace/archiveSession");
  await applied.promise;
  await remote.refresh();
  acknowledgement.resolve(undefined);
  assert.deepEqual(await archiving, { ok: true, value: { archivedSessionIds: [id] } });
  assert.deepEqual(await call("workspace/unarchiveSession"), {
    ok: true,
    value: { archivedSessionIds: [] },
  });
});
it("returns local sessions while remote discovery is stalled", async (t) => {
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  const remote = new RemoteSessions(new EventHub("slow"), async () => {
    await release.promise;
    return [];
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  rpc.register("session/list", () => ({ items: [{ sessionId: "local" }] }));
  remote.install(rpc, new StreamRegistry());
  const result = await Promise.race([
    rpc.dispatch("session/list", {}),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  assert.deepEqual(result, { ok: true, value: { items: [{ sessionId: "local" }] } });
});
it("rejects oversized CJK/escaped prompts and invalid input before any write", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  for (const [text, code] of [
    ["中".repeat(6000), "remote/too-large"],
    ["\u0001".repeat(4000), "remote/too-large"],
    ["", "remote/invalid-request"],
    ["a".repeat(8001), "remote/too-large"],
  ]) {
    const result = await f.call("session/prompt", {
      sessionId: remoteSessionId("remote-control:b", "same"),
      content: [{ type: "text", text }],
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, code);
  }
  assert.equal(f.calls.filter((op) => op.kind === "prompt").length, 0);
});
it("aggregates native owners with distinct host/thread identities and no local cwd", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  await f.remote.refresh();
  const result = await f.call("session/list");
  assert.ok(result.ok);
  const items = (result.value as { items: Array<{ sessionId: string; cwd?: string }> }).items;
  assert.equal(new Set(items.map((item) => item.sessionId)).size, 3);
  assert.equal(defined(items[0]).sessionId, "same");
  assert.equal(defined(items[1]).cwd, "");
  assert.deepEqual(remoteSessionIdentity(defined(items[1]).sessionId), {
    hostId: "remote-ssh-discovered:a",
    threadId: "same",
  });
  const local = await f.call("session/prompt", { sessionId: "same" });
  assert.deepEqual(local, { ok: true, value: { local: true } });
});
it("routes remote writes exactly once and reports unknown outcomes", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  f.loseWrite();
  const result = await f.call("session/prompt", {
    sessionId: remoteSessionId("remote-control:b", "same"),
    content: [{ type: "text", text: "hello" }],
  });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "remote/outcome-unknown");
  assert.deepEqual(
    f.calls.filter((op) => op.kind === "prompt"),
    [
      {
        kind: "prompt",
        hostId: "remote-control:b",
        threadId: "same",
        epoch: "epoch-remote-control:b",
        text: "hello",
      },
    ],
  );
});
it("keeps offline rows and refuses writes without a current remote read", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  await f.remote.refresh();
  f.offline();
  const list = await f.call("session/list");
  assert.ok(list.ok);
  assert.equal((list.value as { items: unknown[] }).items.length, 3);
  const result = await f.call("session/rename", {
    sessionId: remoteSessionId("remote-ssh-discovered:a", "same"),
    title: "new",
  });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "remote/offline");
  assert.equal(f.calls.filter((op) => op.kind === "rename").length, 0);
});
it("never delegates remote attachments, fork, or malformed identities to local handlers", async (t) => {
  const f = fixture();
  t.after(() => f.remote.close());
  for (const method of ["session/attachment", "session/fork"]) {
    const result = await f.call(method, {
      sessionId: remoteSessionId("remote-ssh-discovered:a", "same"),
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, "remote/unsupported");
  }
  assert.throws(() => remoteSessionIdentity("web-remote:invalid"));
});
it("does not collide when host and thread strings contain delimiters or Unicode", () => {
  assert.notEqual(
    remoteSessionId("remote-ssh-discovered:a:b", "c"),
    remoteSessionId("remote-ssh-discovered:a", "b:c"),
  );
  assert.deepEqual(remoteSessionIdentity(remoteSessionId("remote-ssh-discovered:主机", "线程")), {
    hostId: "remote-ssh-discovered:主机",
    threadId: "线程",
  });
});

it("waits for the local control baseline before publishing remote projection deltas", async (t) => {
  const events = new EventHub("fixture");
  const row = {
    id: "same",
    cwd: "remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  let offline = false;
  const remote = new RemoteSessions(events, async (operation) => {
    if (offline) throw new Error("offline");
    if (operation.kind === "hosts") return [{ hostId: "remote-ssh-discovered:a", online: true }];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    return { result: { thread: row }, epoch: "fixture", requests: [] };
  });
  t.after(() => remote.close());
  const streams = new StreamRegistry();
  let router: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    router = value;
  };
  remote.install(new RpcRegistry(), streams);
  const frames: unknown[] = [];
  const sink: StreamSink = {
    id: "control",
    closed: false,
    push: (frame) => frames.push(frame),
    end() {},
    fail() {},
    onClose() {},
  };
  const ready = Promise.withResolvers<undefined>();
  const subscribing = defined(router)("session/control", {}, sink, async (forward) => {
    await ready.promise;
    forward.push({ type: "baseline", value: { projections: {} } });
  });
  await remote.read(remoteSessionId("remote-ssh-discovered:a", "same"));
  assert.equal(frames.length, 0);
  ready.resolve(undefined);
  await subscribing;
  offline = true;
  await remote.refresh();
  assert.equal((frames[0] as { type: string }).type, "baseline");
  assert.ok(frames.slice(1).some((frame) => (frame as { type: string }).type === "projection"));
});

it("publishes host-scoped approvals to two clients and routes only the selected answer", async (t) => {
  const events = new EventHub("fixture");
  const frames: unknown[][] = [[], []];
  for (const values of frames) {
    const sink: StreamSink = {
      id: "observer",
      closed: false,
      push: (value) => values.push(value),
      end() {},
      fail() {},
      onClose() {},
    };
    await events.handler({}, sink);
  }
  const operations: RemoteSessionOperation[] = [];
  const row = {
    id: "same",
    cwd: "remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const remote = new RemoteSessions(events, async (operation) => {
    operations.push(operation);
    if (operation.kind === "hosts")
      return ["remote-ssh-discovered:a", "remote-control:b"].map((hostId) => ({
        hostId,
        online: true,
      }));
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read")
      return {
        result: { thread: row },
        epoch: "epoch",
        requests: [
          { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "same" } },
        ],
      };
    return {};
  });
  t.after(() => remote.close());
  await remote.read(remoteSessionId("remote-ssh-discovered:a", "same"));
  await remote.read(remoteSessionId("remote-control:b", "same"));
  type Frame = { type: string; agentId: string; eventId: string; event: string };
  const pending = frames.map((values) =>
    (values as Frame[]).filter((frame) => frame.type === "waterfall"),
  );
  assert.equal(defined(pending[0]).length, 2);
  assert.deepEqual(pending[0], pending[1]);
  const selected = defined(
    defined(pending[0]).find(
      (frame) => frame.agentId === remoteSessionId("remote-control:b", "same"),
    ),
  );
  assert.equal(selected.event, "approval/request");
  events.settle({
    eventId: selected.eventId,
    outcome: { kind: "resolved", value: "allowed-once" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const replies = operations.filter((operation) => operation.kind === "respond");
  assert.deepEqual(replies, [
    {
      kind: "respond",
      hostId: "remote-control:b",
      threadId: "same",
      epoch: "epoch",
      requestId: 7,
      result: { decision: "accept" },
    },
  ]);
  events.settle({ eventId: selected.eventId, outcome: { kind: "resolved", value: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.filter((operation) => operation.kind === "respond").length, 1);
});

it(
  "keeps a following view alive across a transient read failure and stops on close",
  { timeout: 12000 },
  async (t) => {
    const hostId = "remote-ssh-discovered:a";
    let reads = 0,
      closed = false;
    const remote = new RemoteSessions(new EventHub("recovery"), async (op) => {
      if (op.kind === "hosts") return [{ hostId, online: true }];
      const row = {
        id: "same",
        cwd: "/remote",
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 2,
        status: { type: "idle" },
        turns: [],
        name: reads >= 3 ? "Recovered" : "Before",
      };
      if (op.kind === "list") return { data: [row], nextCursor: null };
      if (op.kind === "read") {
        reads++;
        if (reads === 2) throw Error("temporary disconnect");
        return {
          result: { thread: { ...row, name: reads >= 3 ? "Recovered" : "Before" } },
          epoch: "epoch",
          requests: [],
        };
      }
      return {};
    });
    t.after(() => remote.close());
    const streams = new StreamRegistry();
    let route: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
    streams.routeSessions = (value) => {
      route = value;
    };
    remote.install(new RpcRegistry(), streams);
    const frames: unknown[] = [];
    const closing: Array<() => void> = [];
    await defined(route)(
      "session/follow",
      { request: { address: { sessionId: remoteSessionId(hostId, "same") } } },
      {
        id: "follow",
        get closed() {
          return closed;
        },
        push: (x) => frames.push(x),
        end() {},
        fail() {},
        onClose: (fn) => {
          closing.push(fn);
        },
      },
      async () => {},
    );
    const deadline = Date.now() + 8000;
    while (reads < 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(reads >= 3, "following must recover without reopening the session");
    assert.match(JSON.stringify(frames), /Recovered/);
    closed = true;
    for (const close of closing) close();
    const stopped = reads;
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal(reads, stopped);
  },
);

it("serves cached remote projections and pages without refreshing or cancelling approvals", async (t) => {
  const hostId = "remote-ssh-discovered:a";
  let reads = 0,
    unavailable = false;
  const calls: string[] = [];
  const events = new EventHub("cached");
  const frames: unknown[] = [];
  await events.handler(
    {},
    { id: "events", closed: false, push: (x) => frames.push(x), end() {}, fail() {}, onClose() {} },
  );
  const row = {
    id: "thread",
    cwd: "/remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    turns: [],
  };
  const remote = new RemoteSessions(events, async (op) => {
    calls.push(op.kind);
    if (op.kind === "hosts") return [{ hostId, online: true }];
    if (op.kind === "list") return { data: [row], nextCursor: null };
    if (op.kind === "read") {
      reads++;
      if (unavailable) throw Error("offline");
      return {
        result: { thread: row },
        epoch: "epoch",
        requests: [
          {
            id: 1,
            method: "item/commandExecution/requestApproval",
            params: { command: "echo test" },
          },
        ],
      };
    }
    return {};
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  for (const method of ["session/projections", "session/page", "session/prompt"])
    rpc.register(method, () => {
      throw Error("local handler must not run");
    });
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId(hostId, "thread");
  await remote.read(id);
  unavailable = true;
  const before = frames.length;
  const call = (method: string, extra: Record<string, unknown> = {}) =>
    rpc.dispatch(method, { args: { request: { sessionId: id, ...extra } } });
  assert.equal((await call("session/projections")).ok, true);
  assert.equal((await call("session/page", { throughSeq: 0 })).ok, true);
  assert.equal(reads, 1);
  assert.equal(frames.length, before);
  assert.equal(
    (await call("session/prompt", { content: [{ type: "text", text: "do not send" }] })).ok,
    false,
  );
  assert.equal(reads, 2);
  assert.equal(calls.includes("prompt"), false);
});

interface ExternalControlsFixtureOptions {
  modelThinkingAfterConfigure?: string;
  configureResult?: unknown;
  beforeConfigure?: (
    remote: RemoteSessions,
    operation: Extract<RemoteSessionOperation, { kind: "configure" }>,
  ) => void;
  takeNextReadGate?: () => Promise<unknown> | undefined;
  onReadGate?: () => void;
}

function externalControlsFixture(options: ExternalControlsFixtureOptions = {}) {
  const calls: RemoteSessionOperation[] = [];
  let includeMetadata = true;
  let modelId = "claude-model-v1.ZmFibGU";
  let thinkingOptionId = "medium";
  let permissionModeId = "default";
  const row = {
    id: "claude-thread",
    cwd: "/private/remote",
    name: "Claude remote",
    modelProvider: "codexhost",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  };
  const configuration = () => ({
    owner: "external" as const,
    harnessId: "claude-code",
    transportModelId: modelId,
    effectiveModel: { id: modelId },
    resolvedModelLabel: "Claude Code",
    effectiveThinkingOptionId: thinkingOptionId,
    availableThinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    effectivePermissionModeId: permissionModeId,
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    locked: true as const,
  });
  const inspection = {
    status: "ready" as const,
    catalog: {
      models: [
        {
          ref: { id: "claude-model-v1.ZmFibGU" },
          label: "Claude model one",
          supportedThinkingOptionIds: ["medium", "high"],
        },
        {
          ref: { id: "claude-model-v2" },
          label: "Claude model two",
          supportedThinkingOptionIds: ["medium", "high"],
        },
      ],
      defaultModel: { id: "claude-model-v1.ZmFibGU" },
      thinkingOptions: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "medium",
    },
    permissionModes: {
      modes: [
        { id: "default", label: "Default" },
        { id: "bypassPermissions", label: "Bypass permissions" },
      ],
      defaultModeId: "default",
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: true,
        permissionModeScope: "live" as const,
      },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  };
  const harness = {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    icon: "data:image/png;base64,AA==",
  };
  const events = new EventHub("external-controls");
  const rpc = new RpcRegistry();
  for (const method of [
    "session/projections",
    "session/modelCatalog",
    "session/selectModel",
    "commands/execute",
  ])
    rpc.register(method, () => {
      throw new Error("must not route locally");
    });
  const remote = new RemoteSessions(events, async (operation) => {
    calls.push(operation);
    if (operation.kind === "hosts") return [{ hostId: "remote-control:claude", online: true }];
    if (operation.kind === "list")
      return {
        data: [{ ...row, status: { ...row.status }, turns: [...row.turns] }],
        nextCursor: null,
      };
    if (operation.kind === "read") {
      const snapshot = {
        result: { thread: { ...row, status: { ...row.status }, turns: [...row.turns] } },
        epoch: "claude-epoch",
        ...(includeMetadata ? { configuration: configuration(), inspection, harness } : {}),
        requests: [],
      };
      const gate = options.takeNextReadGate?.();
      if (gate !== undefined) {
        options.onReadGate?.();
        await gate;
      }
      return snapshot;
    }
    if (operation.kind === "configure") {
      options.beforeConfigure?.(remote, operation);
      if (operation.modelId !== undefined) {
        modelId = operation.modelId;
        if (options.modelThinkingAfterConfigure !== undefined)
          thinkingOptionId = options.modelThinkingAfterConfigure;
      }
      if (operation.thinkingOptionId !== undefined) thinkingOptionId = operation.thinkingOptionId;
      if (operation.permissionModeId !== undefined) permissionModeId = operation.permissionModeId;
      return (
        options.configureResult ?? {
          effectiveModel: { id: modelId },
          effectiveThinkingOptionId: thinkingOptionId,
          effectivePermissionModeId: permissionModeId,
        }
      );
    }
    return {};
  });
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId("remote-control:claude", row.id);
  return {
    calls,
    events,
    remote,
    id,
    row,
    configuration,
    dropMetadata: () => {
      includeMetadata = false;
    },
    call: (method: string, request: object = {}) =>
      rpc.dispatch(method, { args: { request: { sessionId: id, ...request } } }),
  };
}

it("projects remote Harness controls and derives its catalog from remote inspection", async (t) => {
  const fixture = externalControlsFixture();
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);

  const projections = await fixture.call("session/projections");
  assert.ok(projections.ok, JSON.stringify(projections));
  const values = (projections.value as { values: Record<string, unknown> }).values;
  assert.deepEqual(values.harnessIdentity, {
    id: "claude-code",
    name: "Claude Code",
    icon: "data:image/png;base64,AA==",
  });
  assert.deepEqual(values.modelSelection, {
    lastUsed: {
      provider: "claude-code",
      model: "claude-model-v1.ZmFibGU",
      reasoningEffort: "medium",
    },
    next: {
      provider: "claude-code",
      model: "claude-model-v1.ZmFibGU",
      reasoningEffort: "medium",
    },
  });
  assert.deepEqual(values.permissions, { currentValue: "default" });
  assert.deepEqual(
    (values.nativePermissions as { harnessId: string; selectable: boolean }).harnessId,
    "claude-code",
  );
  assert.equal(
    (values.nativePermissions as { harnessId: string; selectable: boolean }).selectable,
    true,
  );

  const catalog = await fixture.call("session/modelCatalog");
  assert.ok(catalog.ok);
  assert.deepEqual((catalog.value as { groups: unknown[] }).groups, [
    {
      id: "claude-code",
      name: "Claude Code",
      models: [
        {
          id: "claude-model-v1.ZmFibGU",
          name: "Claude model one",
          reasoning: {
            efforts: [
              { id: "medium", name: "Medium" },
              { id: "high", name: "High" },
            ],
            defaultEffort: "medium",
          },
        },
        {
          id: "claude-model-v2",
          name: "Claude model two",
          reasoning: {
            efforts: [
              { id: "medium", name: "Medium" },
              { id: "high", name: "High" },
            ],
            defaultEffort: "medium",
          },
        },
      ],
    },
  ]);
});

it("routes remote model and permission changes as single-setting configure operations", async (t) => {
  const fixture = externalControlsFixture();
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);
  const before = fixture.calls.length;

  const modelResult = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "high",
  });
  assert.ok(modelResult.ok, JSON.stringify(modelResult));
  const modelOperations = fixture.calls
    .slice(before)
    .filter(
      (operation): operation is Extract<RemoteSessionOperation, { kind: "configure" }> =>
        operation.kind === "configure",
    );
  assert.equal(modelOperations.length, 2);
  assert.deepEqual(
    modelOperations.map(({ kind, epoch, hostId, threadId, ...settings }) => ({
      kind,
      epoch,
      hostId,
      threadId,
      settings,
    })),
    [
      {
        kind: "configure",
        epoch: "claude-epoch",
        hostId: "remote-control:claude",
        threadId: "claude-thread",
        settings: { modelId: "claude-model-v2" },
      },
      {
        kind: "configure",
        epoch: "claude-epoch",
        hostId: "remote-control:claude",
        threadId: "claude-thread",
        settings: { thinkingOptionId: "high" },
      },
    ],
  );
  for (const operation of modelOperations)
    assert.equal(
      [operation.modelId, operation.thinkingOptionId, operation.permissionModeId].filter(
        (value) => value !== undefined,
      ).length,
      1,
    );

  const permissionResult = await fixture.call("commands/execute", {
    line: "/permission bypassPermissions",
  });
  assert.ok(permissionResult.ok);
  const permissionOperation = fixture.calls.at(-2);
  assert.equal(permissionOperation?.kind, "configure");
  assert.deepEqual(
    permissionOperation &&
      "permissionModeId" in permissionOperation && {
        permissionModeId: permissionOperation.permissionModeId,
      },
    { permissionModeId: "bypassPermissions" },
  );
});

it("re-reads after model selection before comparing the requested thinking option", async (t) => {
  const fixture = externalControlsFixture({ modelThinkingAfterConfigure: "high" });
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);
  const result = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "medium",
  });
  assert.ok(result.ok, JSON.stringify(result));
  const configureOperations = fixture.calls.filter(
    (operation): operation is Extract<RemoteSessionOperation, { kind: "configure" }> =>
      operation.kind === "configure",
  );
  assert.deepEqual(
    configureOperations.map(({ modelId, thinkingOptionId }) => ({ modelId, thinkingOptionId })),
    [
      { modelId: "claude-model-v2", thinkingOptionId: undefined },
      { modelId: undefined, thinkingOptionId: "medium" },
    ],
  );
});

it("does not redundantly configure thinking already selected by the model switch", async (t) => {
  const fixture = externalControlsFixture({ modelThinkingAfterConfigure: "high" });
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);
  const result = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "high",
  });
  assert.ok(result.ok, JSON.stringify(result));
  const configureOperations = fixture.calls.filter(
    (operation): operation is Extract<RemoteSessionOperation, { kind: "configure" }> =>
      operation.kind === "configure",
  );
  assert.deepEqual(configureOperations, [
    {
      kind: "configure",
      hostId: "remote-control:claude",
      threadId: "claude-thread",
      epoch: "claude-epoch",
      modelId: "claude-model-v2",
    },
  ]);
});

it("reports partial completion when the post-model read fails without replaying the model", async (t) => {
  let failRead = false;
  const fixture = externalControlsFixture({
    beforeConfigure: () => {
      failRead = true;
    },
    takeNextReadGate: () => {
      if (!failRead) return undefined;
      failRead = false;
      return Promise.reject(new Error("transient read failure"));
    },
  });
  t.after(() => fixture.remote.close());
  const result = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "high",
  });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "remote/configuration-incomplete");
  assert.match(result.error.message, /Model.*confirmed.*Thinking/u);
  assert.deepEqual(
    fixture.calls.filter((op) => op.kind === "configure"),
    [
      {
        kind: "configure",
        hostId: "remote-control:claude",
        threadId: "claude-thread",
        epoch: "claude-epoch",
        modelId: "claude-model-v2",
      },
    ],
  );
  await fixture.remote.read(fixture.id);
  assert.equal(fixture.configuration().effectiveModel.id, "claude-model-v2");
  assert.equal(fixture.configuration().effectiveThinkingOptionId, "medium");
});

it("uses native confirmations when partial reads follow model changes in both directions", async (t) => {
  const fixture = externalControlsFixture({ beforeConfigure: () => fixture.dropMetadata() });
  t.after(() => fixture.remote.close());
  for (const model of ["claude-model-v2", "claude-model-v1.ZmFibGU"]) {
    const result = await fixture.call("session/selectModel", { provider: "claude-code", model });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(fixture.configuration().effectiveModel.id, model);
    const projections = await fixture.call("session/projections");
    assert.ok(projections.ok);
    const values = (projections.value as { values: Record<string, unknown> }).values;
    assert.deepEqual(values.modelSelection, {
      lastUsed: { provider: "claude-code", model, reasoningEffort: "medium" },
      next: { provider: "claude-code", model, reasoningEffort: "medium" },
    });
  }
  assert.deepEqual(
    fixture.calls.filter((op) => op.kind === "configure").map((op) => op.modelId),
    ["claude-model-v2", "claude-model-v1.ZmFibGU"],
  );
});

for (const configureResult of [{}, { effectiveModel: { id: 42 } }])
  it(`does not retain stale settings after an unconfirmed configuration response ${JSON.stringify(configureResult)}`, async (t) => {
    const fixture = externalControlsFixture({
      configureResult,
      beforeConfigure: () => fixture.dropMetadata(),
    });
    t.after(() => fixture.remote.close());
    for (const model of ["claude-model-v2", "claude-model-v1.ZmFibGU"]) {
      const result = await fixture.call("session/selectModel", { provider: "claude-code", model });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(fixture.configuration().effectiveModel.id, model);
      const projections = await fixture.call("session/projections");
      assert.ok(projections.ok);
      const values = (projections.value as { values: Record<string, unknown> }).values;
      assert.deepEqual(values.modelSelection, { lastUsed: null, next: null });
    }
    assert.equal(fixture.calls.filter((op) => op.kind === "configure").length, 2);
  });

it("compares Thinking with the model confirmation when optional read metadata is missing", async (t) => {
  const fixture = externalControlsFixture({
    modelThinkingAfterConfigure: "high",
    beforeConfigure: () => fixture.dropMetadata(),
  });
  t.after(() => fixture.remote.close());
  const result = await fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
    reasoningEffort: "medium",
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(fixture.configuration().effectiveThinkingOptionId, "medium");
  assert.deepEqual(
    fixture.calls.filter((op) => op.kind === "configure").map((op) => op.thinkingOptionId),
    [undefined, "medium"],
  );
});

it("does not let a pre-configure read overwrite an acknowledged model selection", async (t) => {
  const staleRead = Promise.withResolvers<undefined>();
  const staleReadStarted = Promise.withResolvers<undefined>();
  let armStaleRead = false;
  const fixture = externalControlsFixture({
    beforeConfigure: (remote, operation) => {
      if (operation.modelId !== "claude-model-v2") return;
      armStaleRead = true;
      void remote.read(remoteSessionId("remote-control:claude", "claude-thread"));
    },
    takeNextReadGate: () => {
      if (!armStaleRead) return undefined;
      armStaleRead = false;
      return staleRead.promise;
    },
    onReadGate: () => staleReadStarted.resolve(undefined),
  });
  t.after(() => fixture.remote.close());
  await fixture.remote.read(fixture.id);

  let settled = false;
  const selection = fixture.call("session/selectModel", {
    provider: "claude-code",
    model: "claude-model-v2",
  });
  await staleReadStarted.promise;
  void selection.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, "configure waits for the overlapping stale read");

  staleRead.resolve(undefined);
  const result = await selection;
  assert.ok(result.ok, JSON.stringify(result));
  const projections = await fixture.call("session/projections");
  assert.ok(projections.ok);
  const values = (projections.value as { values: Record<string, unknown> }).values;
  assert.deepEqual(values.modelSelection, {
    lastUsed: { provider: "claude-code", model: "claude-model-v2", reasoningEffort: "medium" },
    next: { provider: "claude-code", model: "claude-model-v2", reasoningEffort: "medium" },
  });
});

it("retains same-epoch remote controls across partial reads and catalog refresh summaries", async (t) => {
  const fixture = externalControlsFixture();
  t.after(() => fixture.remote.close());
  const summaries: Array<{ projections: { values: Record<string, unknown> }; running: boolean }> =
    [];
  fixture.events.emit = (event, ...args) => {
    if (event === "api-session/added") summaries.push(args[0] as (typeof summaries)[number]);
  };
  await fixture.remote.read(fixture.id);
  fixture.dropMetadata();
  await fixture.remote.read(fixture.id);
  const projections = await fixture.call("session/projections");
  assert.ok(projections.ok);
  const values = (projections.value as { values: Record<string, unknown> }).values;
  assert.deepEqual(values.harnessIdentity, {
    id: "claude-code",
    name: "Claude Code",
    icon: "data:image/png;base64,AA==",
  });
  assert.equal((values.nativePermissions as { harnessId: string }).harnessId, "claude-code");

  summaries.length = 0;
  fixture.row.status.type = "active";
  await fixture.remote.refresh();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.running, true);
  assert.deepEqual(summaries[0]?.projections.values.harnessIdentity, {
    id: "claude-code",
    name: "Claude Code",
    icon: "data:image/png;base64,AA==",
  });
});

it("keeps remote history readable and controls unavailable without optional metadata", async (t) => {
  const row = {
    id: "metadata-less",
    cwd: "/private/remote",
    name: "Metadata-less remote",
    modelProvider: "codexhost",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [{ id: "item-1", type: "text", text: "history" }],
      },
    ],
  };
  const calls: RemoteSessionOperation[] = [];
  const remote = new RemoteSessions(new EventHub("metadata-less"), async (operation) => {
    calls.push(operation);
    if (operation.kind === "hosts") return [{ hostId: "remote-control:plain", online: true }];
    if (operation.kind === "list") return { data: [row], nextCursor: null };
    if (operation.kind === "read")
      return { result: { thread: row }, epoch: "plain-epoch", requests: [] };
    return {};
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  for (const method of ["session/projections", "session/page", "session/selectModel"])
    rpc.register(method, () => {
      throw new Error("must not route locally");
    });
  remote.install(rpc, new StreamRegistry());
  const id = remoteSessionId("remote-control:plain", row.id);
  await remote.read(id);
  const projections = await rpc.dispatch("session/projections", {
    args: { request: { sessionId: id } },
  });
  assert.ok(projections.ok);
  const values = (projections.value as { values: Record<string, unknown> }).values;
  assert.equal(values.nativePermissions, null);
  assert.deepEqual(values.modelSelection, { lastUsed: null, next: null });
  assert.equal(values.harnessIdentity, null);
  assert.ok(
    (
      await rpc.dispatch("session/page", {
        args: { request: { sessionId: id, throughSeq: 0 } },
      })
    ).ok,
  );
  const rejected = await rpc.dispatch("session/selectModel", {
    args: { request: { sessionId: id, provider: "claude-code", model: "claude-model-v2" } },
  });
  assert.ok(!rejected.ok);
  assert.equal(rejected.error.code, "remote/unsupported");
  assert.equal(
    calls.some((operation) => operation.kind === "configure"),
    false,
  );
});
