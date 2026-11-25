import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import {
  THREAD_HANDOFF_METHOD,
  WEB_HANDOFF_PROJECTION,
  harnessIdSchema,
  hostThreadIdSchema,
  threadHandoffMetadataSchema,
  type ThreadHandoffMetadata,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "../src/ch-host-client.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { handoffChThread } from "../src/ch-thread-handoff.ts";
import type { WireEvent } from "../src/session-log.ts";
import { DataDir } from "../src/store.ts";
import {
  EventHub,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { defined } from "./support/defined.ts";

function sampleMetadata(
  sourceThreadId: string,
  targetHarnessId: string,
  overrides: Partial<ThreadHandoffMetadata> = {},
): ThreadHandoffMetadata {
  return threadHandoffMetadataSchema.parse({
    sourceThreadId: hostThreadIdSchema.parse(sourceThreadId),
    sourceHarnessId: harnessIdSchema.parse("fake"),
    sourceHarnessLabel: "CH Harness",
    targetHarnessId: harnessIdSchema.parse(targetHarnessId),
    targetHarnessLabel: targetHarnessId === "codex" ? "Codex" : targetHarnessId,
    totalTurns: 6,
    boundaryTurnNumber: 6,
    includedTurnNumbers: [1, 5, 6],
    omittedTurns: 3,
    preview: "<handoff_context>\nsummary\n</handoff_context>",
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  });
}

function fixture(t: TestContext, count = 6) {
  const root = mkdtempSync(join(tmpdir(), "ch-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  const handoffs = new Map<string, ThreadHandoffMetadata>();
  const source = host.add("source", join(root, "workspace"));
  const initial = defined(source.turns[0]);
  source.turns = Array.from({ length: count }, (_, i) => ({ ...initial, id: `native-${i}` }));

  let handoffCount = 0;
  const baseRequest = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === THREAD_HANDOFF_METHOD) {
      host.requests.push({ method, params: structuredClone(params) });
      handoffCount += 1;
      const targetId = `handoff-${handoffCount}`;
      const targetHarnessId = String(params.targetHarnessId);
      const created = host.add(targetId, source.cwd, source.name ?? source.id, false);
      created.turns = [];
      const meta = sampleMetadata(String(params.sourceThreadId), targetHarnessId, {
        ...(typeof params.targetModel === "string" ? { targetModel: params.targetModel } : {}),
        totalTurns: source.turns.length,
        boundaryTurnNumber:
          source.turns.findIndex((turn) => turn.id === params.lastTurnId) + 1 ||
          source.turns.length,
      });
      handoffs.set(targetId, meta);
      return { threadId: targetId, handoff: meta } as T;
    }
    const result = await baseRequest<T>(method, params);
    if (method === "codexhost/thread/inspect") {
      const meta = handoffs.get(String(params.threadId));
      if (meta && result && typeof result === "object") {
        return { ...(result as Record<string, unknown>), handoff: meta } as T;
      }
    }
    return result;
  };

  const makeSessions = () => {
    const sessions = new ChSessions(
      host,
      new Workspaces(new DataDir(root), root),
      new EventHub(root),
    );
    t.after(() => sessions.close());
    const rpc = new RpcRegistry();
    const handlers = new Map<string, StreamHandler>();
    const streams = new StreamRegistry();
    const origRegister = streams.register.bind(streams);
    streams.register = (endpoint, handler) => {
      handlers.set(endpoint, handler);
      origRegister(endpoint, handler);
    };
    sessions.register(rpc, streams);
    const call = async <T>(method: string, request: object = {}): Promise<T> => {
      const result = await rpc.dispatch(method, { args: { request } });
      assert.ok(result.ok, result.ok ? undefined : result.error.message);
      return result.value as T;
    };
    return { sessions, rpc, streams, handlers, call };
  };

  return { root, host, handoffs, source, makeSessions };
}

it("hands off at latest or exact atSeq boundary and forwards target harness/model/thinking", async (t) => {
  const { host, source, makeSessions } = fixture(t, 8);
  const { call } = makeSessions();

  const latest = await call<{ sessionId: string; handoff: ThreadHandoffMetadata }>(
    "session/handoff",
    {
      sessionId: source.id,
      targetHarnessId: "codex",
      targetModel: "gpt-5.4",
      targetThinkingOptionId: "high",
    },
  );
  assert.equal(latest.sessionId, "handoff-1");
  assert.equal(latest.handoff.targetHarnessId, "codex");
  assert.equal(latest.handoff.targetModel, "gpt-5.4");
  assert.deepEqual(host.requests.find((r) => r.method === THREAD_HANDOFF_METHOD)?.params, {
    sourceThreadId: source.id,
    lastTurnId: "native-7",
    targetHarnessId: "codex",
    targetModel: "gpt-5.4",
    targetThinkingOptionId: "high",
  });

  // Load an older page and hand off at an exact earlier turn boundary.
  const page = (beforeSeq?: number) =>
    call<{ records: Array<{ event: WireEvent }> }>("session/page", {
      address: { sessionId: source.id },
      throughSeq: Number.MAX_SAFE_INTEGER,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: 1000,
    });
  const tail = await page();
  const older = await page(defined(tail.records[0]).event.seq);
  const oldEnd = defined(older.records.find((r) => r.event.type === "turn/end")).event.seq;

  const cut = await call<{ sessionId: string; handoff: ThreadHandoffMetadata }>("session/handoff", {
    sessionId: source.id,
    atSeq: oldEnd,
    targetHarnessId: "pi",
  });
  assert.equal(cut.sessionId, "handoff-2");
  assert.deepEqual(host.requests.filter((r) => r.method === THREAD_HANDOFF_METHOD).at(-1)?.params, {
    sourceThreadId: source.id,
    lastTurnId: "native-0",
    targetHarnessId: "pi",
  });

  const list = await call<{ items: Array<{ sessionId: string }> }>("session/list");
  assert.ok(list.items.some((row) => row.sessionId === "handoff-1"));
});

it("exposes codexhostHandoff projection immediately and after a fresh server reload", async (t) => {
  const { handoffs, source, makeSessions } = fixture(t, 2);
  const first = makeSessions();
  const created = await first.call<{ sessionId: string; handoff: ThreadHandoffMetadata }>(
    "session/handoff",
    { sessionId: source.id, targetHarnessId: "codex" },
  );
  assert.ok(handoffs.has(created.sessionId));

  // Fresh ChSessions simulates a page/server reload with no in-memory handoff cache.
  const reloaded = makeSessions();
  const pushed: Array<{
    type?: string;
    key?: string;
    value?: unknown;
    sessionId?: string;
  }> = [];
  const sink: StreamSink = {
    id: "handoff-sink",
    push(event: unknown) {
      pushed.push(event as { type?: string; key?: string; value?: unknown; sessionId?: string });
    },
    end() {},
    fail() {},
    onClose() {},
    closed: false,
  };
  await defined(reloaded.handlers.get("session/control"))({}, sink);

  await reloaded.call("session/page", {
    address: { sessionId: created.sessionId },
    throughSeq: Number.MAX_SAFE_INTEGER,
  });

  // Allow async control load to settle if needed.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const handoffProjection = pushed.find(
    (entry) => entry.sessionId === created.sessionId && entry.key === WEB_HANDOFF_PROJECTION,
  );
  assert.deepEqual(handoffProjection?.value, created.handoff);
});

it("exposes codexhostHandoff from realtime ClientThreadSnapshot on reload", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-handoff-rt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  const target = host.add("handoff-rt", join(root, "ws"));
  target.turns = [];
  const meta = sampleMetadata("source-rt", "fake");

  const realtimeHost: ChHostClient = Object.assign(host, {
    realtime: {
      subscribe: () => () => {},
      request: <T = unknown>(method: string, params: Record<string, unknown>) =>
        host.request<T>(method, params),
      snapshot: async (threadId: string) => ({
        cursor: { epoch: "00000000-0000-4000-8000-000000000001", sequence: 1 },
        thread: { ...structuredClone(target), id: threadId, turns: [] },
        turnsPage: { data: [], nextCursor: null },
        configuration: {},
        interactions: [],
        handoff: meta,
      }),
      respond: async () => ({ resolved: true }),
    },
  });

  const view = new ChThreadHistory(realtimeHost, target, "fake", () => {});
  await view.refresh(true);
  assert.deepEqual(view.log.projections[WEB_HANDOFF_PROJECTION], meta);
});

it("rejects drafts, invalid params, empty histories, and retired views without calling Host", async (t) => {
  const { host, source, makeSessions } = fixture(t, 0);
  const { rpc, call } = makeSessions();
  const draft = await call<{ sessionId: string }>("session/create", { cwd: source.cwd });

  assert.equal(
    (
      await rpc.dispatch("session/handoff", {
        args: { request: { sessionId: draft.sessionId, targetHarnessId: "codex" } },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await rpc.dispatch("session/handoff", {
        args: { request: { sessionId: source.id, targetHarnessId: "" } },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await rpc.dispatch("session/handoff", {
        args: { request: { sessionId: source.id, targetHarnessId: "codex" } },
      })
    ).ok,
    false,
  );

  // Retired view rejected before hitting Host.
  const host2 = new FakeChHost();
  const thread2 = host2.add("source-2", "/project");
  const view2 = new ChThreadHistory(host2, thread2, "fake", () => {});
  await view2.refresh();
  const seq = defined(view2.log.events.find((e) => e.type === "turn/end")).seq;
  view2.retire();
  await assert.rejects(
    handoffChThread(host2, view2, { atSeq: seq, targetHarnessId: "codex" }),
    /superseded/,
  );
  assert.equal(
    host.requests.some((r) => r.method === THREAD_HANDOFF_METHOD),
    false,
  );
  assert.equal(
    host2.requests.some((r) => r.method === THREAD_HANDOFF_METHOD),
    false,
  );
});
