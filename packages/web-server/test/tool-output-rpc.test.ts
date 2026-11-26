import assert from "node:assert/strict";
import { defined } from "./support/defined.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { webToolOutputPreviews, type WebToolOutputReference } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { capText } from "../src/projector.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { DataDir } from "../src/store.ts";
import { TOOL_OUTPUT_PREVIEW } from "../src/tool-output.ts";
import { IDLE_VIEW_MS } from "../src/web-thread-state.ts";
import { Workspaces } from "../src/workspaces.ts";
import {
  EventHub,
  RpcError,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

class Streams extends StreamRegistry {
  endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler) {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}

it("previews settled tool output identically on local and relay connections and reloads on demand", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tool-output-rpc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("tools", dir);
  host.add("other", dir);
  const tailMarker = "UNIQUE-BEYOND-PREVIEW-TAIL-MARKER";
  const rawOutput = "OUTPUT".repeat(15_000) + tailMarker + "Z".repeat(90_000);
  const expectedCapped = capText(rawOutput);
  defined(row.turns[0]).items.push({
    id: "command",
    type: "commandExecution",
    status: "completed",
    command: "diagnose",
    cwd: dir,
    aggregatedOutput: rawOutput,
    exitCode: 0,
  });
  const original = host.request.bind(host);
  let denied = false;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    // Native Codex is a supported owner now. Access revocation must be an
    // authoritative Host refusal, not merely a native ownership label.
    if (denied && method === "codexhost/thread/inspect")
      throw new RpcError("host/rejected", "Thread access revoked");
    return original<T>(method, params);
  };
  const sessions = new ChSessions(host, new Workspaces(new DataDir(dir), dir), new EventHub(dir));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry(),
    streams = new Streams();
  sessions.register(rpc, streams);
  const follow = async (relay: boolean) => {
    const frames: unknown[] = [],
      closes: Array<() => void> = [];
    const sink: StreamSink = {
      id: "test",
      relay,
      closed: false,
      push: (frame) => frames.push(structuredClone(frame)),
      onClose: (fn) => closes.push(fn),
      end: () => closes.forEach((fn) => fn()),
      fail: (code) => {
        throw new Error(code);
      },
    };
    await defined(streams.endpoints.get("session/follow"))(
      { request: { address: { sessionId: row.id }, assistantStream: true } },
      sink,
    );
    sink.end();
    return frames[0] as {
      epoch: string;
      cursor: number;
      records: Array<{
        event: {
          type: string;
          seq: number;
          data: { meta?: unknown; message: { content: Array<{ text: string }> } };
        };
      }>;
    };
  };
  const local = await follow(false),
    remote = await follow(true);
  const localTool = defined(local.records.find((r) => r.event.type === "tool/result"));
  const remoteTool = defined(remote.records.find((r) => r.event.type === "tool/result"));
  assert.equal(defined(localTool.event.data.message.content[0]).text.length, TOOL_OUTPUT_PREVIEW);
  assert.deepEqual(
    webToolOutputPreviews(localTool.event.data.meta),
    webToolOutputPreviews(remoteTool.event.data.meta),
  );
  const ref = defined(webToolOutputPreviews(localTool.event.data.meta)[0]).reference;
  const call = (reference: WebToolOutputReference) =>
    rpc.dispatch("session/toolOutput", { args: { request: reference } });
  const beforeReads = host.requests.filter((r) => r.method === "thread/turns/list").length;
  const full = await call(ref);
  assert.ok(full.ok);
  assert.equal((full.value as { text: string }).text, expectedCapped);
  assert.match((full.value as { text: string }).text, /characters truncated/);
  assert.equal(
    host.requests.filter((r) => r.method === "thread/turns/list").length,
    beforeReads + 1,
    "compacted output reloads its Turn from Host on demand",
  );

  // Both local and relay session/page return identical previews for settled large outputs.
  const pageRequest = {
    args: { request: { address: { sessionId: row.id }, throughSeq: local.cursor } },
  };
  const localPage = await rpc.dispatch("session/page", pageRequest);
  const relayPage = await rpc.dispatch("session/page", pageRequest, undefined, undefined, true);
  assert.ok(localPage.ok && relayPage.ok);
  assert.deepEqual(localPage.value, relayPage.value);
  assert.equal(JSON.stringify(localPage.value).includes(tailMarker), false);

  // Tampered or cross-session references are rejected without querying Host turns.
  const readsBeforeInvalid = host.requests.filter((r) => r.method === "thread/turns/list").length;
  for (const reference of [
    { ...ref, version: "old" },
    { ...ref, sessionId: "other" },
    { ...ref, part: 99 },
    { ...ref, callId: "forged" },
  ]) {
    const result = await call(reference);
    assert.ok(!result.ok);
    assert.equal(result.error.code, "session/tool-output-stale");
  }
  assert.equal(
    host.requests.filter((r) => r.method === "thread/turns/list").length,
    readsBeforeInvalid,
  );

  // Access revocation rejects before touching Turn history.
  denied = true;
  const inaccessible = await call(ref);
  assert.ok(!inaccessible.ok);
  assert.equal(inaccessible.error.code, "host/rejected");
  assert.equal(
    host.requests.filter((r) => r.method === "thread/turns/list").length,
    readsBeforeInvalid,
  );
});

it("keeps active Turn output full on local connections while previewing settled Turns", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tool-output-active-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("active-tools", dir);
  const activeOutput = "LIVE".repeat(22_500); // 90,000 chars (> TOOL_OUTPUT_LIMIT)
  row.status = { type: "active" };
  row.turns.push({
    id: "live-turn",
    status: "inProgress",
    items: [
      { id: "u-live", type: "userMessage", content: [{ type: "text", text: "run" }] },
      {
        id: "cmd-live",
        type: "commandExecution",
        status: "completed",
        command: "tail",
        cwd: dir,
        aggregatedOutput: activeOutput,
        exitCode: 0,
      },
    ],
  });
  const sessions = new ChSessions(host, new Workspaces(new DataDir(dir), dir), new EventHub(dir));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry(),
    streams = new Streams();
  sessions.register(rpc, streams);
  const frames: unknown[] = [];
  const sink: StreamSink = {
    id: "local",
    relay: false,
    closed: false,
    push: (frame) => frames.push(structuredClone(frame)),
    onClose: () => {},
    end: () => {},
    fail: (code) => {
      throw new Error(code);
    },
  };
  await defined(streams.endpoints.get("session/follow"))(
    { request: { address: { sessionId: row.id }, assistantStream: true } },
    sink,
  );
  const snapshot = frames[0] as {
    records: Array<{
      event: {
        type: string;
        data: { meta?: unknown; message: { content: Array<{ text: string }> } };
      };
    }>;
  };
  const liveTool = defined(snapshot.records.find((r) => r.event.type === "tool/result"));
  assert.equal(defined(liveTool.event.data.message.content[0]).text, activeOutput);
  assert.equal(webToolOutputPreviews(liveTool.event.data.meta).length, 0);
});

it("drops oversized settled outputs across paged history memory layers, preserves knownTurns, and detects stale reloads", async () => {
  const host = new FakeChChannel();
  const row = host.add("paged-tools", "/project");
  const bigOutput = (index: number) => `turn-${index}-` + "X".repeat(120_000);
  row.turns = Array.from({ length: 8 }, (_, index) => ({
    id: `turn-${index}`,
    status: "completed",
    items: [
      {
        id: `user-${index}`,
        type: "userMessage",
        content: [{ type: "text", text: `prompt ${index}` }],
      },
      {
        id: `cmd-${index}`,
        type: "commandExecution",
        status: "completed",
        command: `cmd ${index}`,
        cwd: "/project",
        aggregatedOutput: bigOutput(index),
        exitCode: 0,
      },
      { id: `agent-${index}`, type: "agentMessage", text: `answer ${index}` },
    ],
  }));

  const view = new ChThreadHistory(host, row, "fake", () => {});
  await view.refresh();
  await view.loadOlder();
  assert.equal(view.thread.turns.length, 8);

  // None of the three in-memory layers (thread.turns, ownerSnapshot, SessionLog.events)
  // retain > TOOL_OUTPUT_PREVIEW text for any settled oversized tool output.
  for (const turn of view.thread.turns) {
    const cmd = defined(turn.items.find((item) => item.type === "commandExecution"));
    assert.equal(String(cmd.aggregatedOutput).length, TOOL_OUTPUT_PREVIEW);
  }
  for (const turn of view.ownerSnapshot?.turnsPage.data ?? []) {
    const cmd = defined(turn.items.find((item) => item.type === "commandExecution"));
    assert.equal(String(cmd.aggregatedOutput).length, TOOL_OUTPUT_PREVIEW);
  }
  const toolEvents = view.log.events.filter((event) => event.type === "tool/result");
  assert.equal(toolEvents.length, 8);
  for (const event of toolEvents) {
    const data = event.data as { meta?: unknown; message: { content: Array<{ text: string }> } };
    assert.equal(defined(data.message.content[0]).text.length, TOOL_OUTPUT_PREVIEW);
    assert.equal(webToolOutputPreviews(data.meta).length, 1);
  }

  // Incremental knownTurns negotiation still works after compaction.
  row.turns.push({
    id: "turn-8",
    status: "completed",
    items: [
      { id: "user-8", type: "userMessage", content: [{ type: "text", text: "prompt 8" }] },
      { id: "agent-8", type: "agentMessage", text: "answer 8" },
    ],
  });
  await view.refresh(true);
  assert.equal(host.snapshotPlaceholders.at(-1), 4);

  // On-demand reload of a paged older Turn returns exact capped authoritative text in 1 page read.
  const oldestEvent = defined(toolEvents[0]);
  const oldestRef = defined(
    webToolOutputPreviews((oldestEvent.data as { meta?: unknown }).meta)[0],
  ).reference;
  const readsBefore = host.requests.filter((r) => r.method === "thread/turns/list").length;
  const loaded = await view.readToolOutput(oldestRef);
  assert.equal(loaded.text, capText(bigOutput(0)));
  assert.equal(
    host.requests.filter((r) => r.method === "thread/turns/list").length,
    readsBefore + 1,
    "older Turn reload uses its stored page cursor",
  );

  // If the Host's output changes underneath, SHA-256 verification rejects with session/tool-output-stale.
  const hostOldestCmd = defined(
    defined(row.turns[0]).items.find((item) => item.type === "commandExecution"),
  );
  hostOldestCmd.aggregatedOutput = "rewritten-by-host";
  await assert.rejects(view.readToolOutput(oldestRef), { code: "session/tool-output-stale" });
});

it("previews remote session pages on local connections and reloads compacted tool output from the remote host", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "remote-tool-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tailMarker = "REMOTE-TAIL-MARKER-9999";
  let remoteOutput = "R".repeat(80_000) + tailMarker;
  let reads = 0;
  const sessionId = remoteSessionId("remote-control:desktop-1", "remote-thread-1");
  const remote = new RemoteSessions(new EventHub(dir), async (operation) => {
    if (operation.kind === "hosts")
      return [{ hostId: "remote-control:desktop-1", online: true, epoch: "e1" }];
    if (operation.kind === "list")
      return {
        epoch: "e1",
        nextCursor: null,
        data: [
          {
            id: "remote-thread-1",
            cwd: "/remote",
            modelProvider: "codexhost",
            createdAt: 100,
            updatedAt: 200,
            status: { type: "idle" },
          },
        ],
      };
    if (operation.kind === "read") {
      reads += 1;
      return {
        epoch: "e1",
        requests: [],
        result: {
          thread: {
            id: "remote-thread-1",
            cwd: "/remote",
            modelProvider: "codexhost",
            createdAt: 100,
            updatedAt: 200,
            status: { type: "idle" },
            turns: [
              {
                id: "remote-turn-1",
                status: "completed",
                items: [
                  { id: "u1", type: "userMessage", content: [{ type: "text", text: "go" }] },
                  {
                    id: "c1",
                    type: "commandExecution",
                    status: "completed",
                    command: "cat log",
                    cwd: "/remote",
                    aggregatedOutput: remoteOutput,
                    exitCode: 0,
                  },
                ],
              },
            ],
          },
        },
      };
    }
    if (operation.kind === "queue") return { available: false, items: [] };
    if (operation.kind === "usage") throw new RpcError("remote/unsupported", "no usage");
    throw new Error(`Unexpected remote operation: ${operation.kind}`);
  });
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  const streams = new Streams();
  rpc.register("session/list", () => ({ items: [], archivedSessionIds: [] }));
  rpc.register("session/page", () => {
    throw new Error("local session/page must not handle remote id");
  });
  rpc.register("session/toolOutput", () => {
    throw new Error("local session/toolOutput must not handle remote id");
  });
  remote.install(rpc, streams);
  await remote.refresh();

  const page = await rpc.dispatch("session/page", {
    args: { request: { address: { sessionId }, throughSeq: 100 } },
  });
  assert.ok(page.ok);
  assert.equal(JSON.stringify(page.value).includes(tailMarker), false);
  const records = (
    page.value as {
      records: Array<{
        event: {
          type: string;
          data: { meta?: unknown; message: { content: Array<{ text: string }> } };
        };
      }>;
    }
  ).records;
  const tool = defined(records.find((r) => r.event.type === "tool/result"));
  assert.equal(defined(tool.event.data.message.content[0]).text.length, TOOL_OUTPUT_PREVIEW);
  const ref = defined(webToolOutputPreviews(tool.event.data.meta)[0]).reference;

  const readsBefore = reads;
  const loaded = await rpc.dispatch("session/toolOutput", { args: { request: ref } });
  assert.ok(loaded.ok);
  assert.equal((loaded.value as { text: string }).text, remoteOutput);
  assert.equal(reads, readsBefore + 1);

  remoteOutput = "mutated-remote-output";
  const stale = await rpc.dispatch("session/toolOutput", { args: { request: ref } });
  assert.ok(!stale.ok);
  assert.equal(stale.error.code, "session/tool-output-stale");
});

it("protects in-flight local and remote session/toolOutput reads from idle eviction and clears retired non-peer row turns", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "tool-output-evict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1. Local ChSessions: an in-flight session/toolOutput read must keep the view alive past IDLE_VIEW_MS.
  const host = new FakeChChannel();
  const row = host.add("local-evict", dir);
  const bigOutput = "LOCAL-EVICT-" + "L".repeat(75_000);
  defined(row.turns[0]).items.push({
    id: "cmd-evict",
    type: "commandExecution",
    status: "completed",
    command: "dump",
    cwd: dir,
    aggregatedOutput: bigOutput,
    exitCode: 0,
  });
  const localReloadStarted = Promise.withResolvers<void>();
  const releaseLocalReload = Promise.withResolvers<void>();
  t.after(() => releaseLocalReload.resolve());
  const baseHostRequest = host.request.bind(host);
  let holdLocalReload = false;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (holdLocalReload && method === "thread/turns/list") {
      localReloadStarted.resolve();
      await releaseLocalReload.promise;
    }
    return baseHostRequest<T>(method, params);
  };
  const sessions = new ChSessions(host, new Workspaces(new DataDir(dir), dir), new EventHub(dir));
  t.after(() => sessions.close());
  const localRpc = new RpcRegistry();
  const localStreams = new Streams();
  sessions.register(localRpc, localStreams);
  assert.ok((await localRpc.dispatch("session/list", { args: { request: {} } })).ok);

  const localPage = await localRpc.dispatch("session/page", {
    args: { request: { address: { sessionId: row.id }, throughSeq: 2 ** 40 + 100 } },
  });
  assert.ok(localPage.ok);
  const localRecords = (
    localPage.value as { records: Array<{ event: { type: string; data: { meta?: unknown } } }> }
  ).records;
  const localTool = defined(localRecords.find((record) => record.event.type === "tool/result"));
  const localRef = defined(webToolOutputPreviews(localTool.event.data.meta)[0]).reference;

  holdLocalReload = true;
  const localLoad = localRpc.dispatch("session/toolOutput", { args: { request: localRef } });
  await localReloadStarted.promise;
  // Trigger idle view timer past IDLE_VIEW_MS while session/toolOutput is in flight.
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(IDLE_VIEW_MS + 60_000);
  releaseLocalReload.resolve();
  const localLoaded = await localLoad;
  assert.ok(localLoaded.ok, "in-flight local session/toolOutput must survive idle eviction");
  assert.equal((localLoaded.value as { text: string }).text, bigOutput);

  // 2. Non-peer RemoteSessions: in-flight session/toolOutput survives idle eviction, and
  // retiring the view afterwards clears entry.row.turns without mutating the old array.
  const remoteOutput = "REMOTE-EVICT-" + "R".repeat(75_000);
  const sessionId = remoteSessionId("remote-control:desktop-evict", "remote-thread-evict");
  const remoteReloadStarted = Promise.withResolvers<void>();
  const releaseRemoteReload = Promise.withResolvers<void>();
  t.after(() => releaseRemoteReload.resolve());
  let holdRemoteReload = false;
  let remoteReads = 0;
  const remote = new RemoteSessions(new EventHub(dir), async (operation) => {
    if (operation.kind === "hosts")
      return [{ hostId: "remote-control:desktop-evict", online: true, epoch: "e1" }];
    if (operation.kind === "list")
      return {
        epoch: "e1",
        nextCursor: null,
        data: [
          {
            id: "remote-thread-evict",
            cwd: "/remote",
            modelProvider: "codexhost",
            createdAt: 100,
            updatedAt: 200,
            status: { type: "idle" },
          },
        ],
      };
    if (operation.kind === "read") {
      remoteReads += 1;
      if (holdRemoteReload) {
        remoteReloadStarted.resolve();
        await releaseRemoteReload.promise;
      }
      return {
        epoch: "e1",
        requests: [],
        result: {
          thread: {
            id: "remote-thread-evict",
            cwd: "/remote",
            modelProvider: "codexhost",
            createdAt: 100,
            updatedAt: 200,
            status: { type: "idle" },
            turns: [
              {
                id: "remote-turn-1",
                status: "completed",
                items: [
                  { id: "u1", type: "userMessage", content: [{ type: "text", text: "go" }] },
                  {
                    id: "c1",
                    type: "commandExecution",
                    status: "completed",
                    command: "dump",
                    cwd: "/remote",
                    aggregatedOutput: remoteOutput,
                    exitCode: 0,
                  },
                ],
              },
            ],
          },
        },
      };
    }
    if (operation.kind === "queue") return { available: false, items: [] };
    if (operation.kind === "usage") throw new RpcError("remote/unsupported", "no usage");
    throw new Error(`Unexpected remote operation: ${operation.kind}`);
  });
  t.after(() => remote.close());
  const remoteRpc = new RpcRegistry();
  const remoteStreams = new Streams();
  remoteRpc.register("session/list", () => ({ items: [], archivedSessionIds: [] }));
  remoteRpc.register("session/page", () => {
    throw new Error("local session/page must not handle remote id");
  });
  remoteRpc.register("session/toolOutput", () => {
    throw new Error("local session/toolOutput must not handle remote id");
  });
  remote.install(remoteRpc, remoteStreams);
  await remote.refresh();

  const remotePage = await remoteRpc.dispatch("session/page", {
    args: { request: { address: { sessionId }, throughSeq: 100 } },
  });
  assert.ok(remotePage.ok);
  const remoteRecords = (
    remotePage.value as { records: Array<{ event: { type: string; data: { meta?: unknown } } }> }
  ).records;
  const remoteTool = defined(remoteRecords.find((record) => record.event.type === "tool/result"));
  const remoteRef = defined(webToolOutputPreviews(remoteTool.event.data.meta)[0]).reference;

  const entry = defined(
    (
      remote as unknown as {
        entries: Map<string, { row: { turns: unknown[] }; view?: unknown }>;
      }
    ).entries.get(sessionId),
  );
  const turnsBeforeRetire = entry.row.turns;
  assert.equal(turnsBeforeRetire.length, 1);

  holdRemoteReload = true;
  const remoteLoad = remoteRpc.dispatch("session/toolOutput", { args: { request: remoteRef } });
  await remoteReloadStarted.promise;
  remote.discardIdleViews();
  t.mock.timers.tick(IDLE_VIEW_MS + 60_000);
  remote.discardIdleViews();
  assert.ok(entry.view, "in-flight remote session/toolOutput must protect view from eviction");

  releaseRemoteReload.resolve();
  const remoteLoaded = await remoteLoad;
  assert.ok(remoteLoaded.ok);
  assert.equal((remoteLoaded.value as { text: string }).text, remoteOutput);
  assert.equal(remoteReads, 2);

  // After settling and waiting a full IDLE_VIEW_MS, retiring drops the view and clears entry.row.turns
  // without mutating the previous turns array in place.
  remote.discardIdleViews();
  t.mock.timers.tick(IDLE_VIEW_MS);
  remote.discardIdleViews();
  assert.equal(entry.view, undefined);
  assert.deepEqual(entry.row.turns, []);
  assert.notEqual(entry.row.turns, turnsBeforeRetire);
  assert.equal(turnsBeforeRetire.length, 1);
});
