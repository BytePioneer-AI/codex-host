import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { defaultProjections } from "../src/session-log.ts";
import { DataDir } from "../src/store.ts";
import {
  EventHub,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";
import { WebImages, WEB_IMAGE_INPUT, WEB_IMAGE_LIMITS } from "../src/web-images.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

interface Summary {
  sessionId: string;
  running: boolean;
  parentSessionId?: string;
  origin?: string;
  projections: { kind: string; asOfSeq: number; values: Record<string, unknown> };
}

class Streams extends StreamRegistry {
  readonly endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler): void {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ch-list-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("source", root, "Source title");
  const data = new DataDir(root);
  const events = new EventHub(root);
  const upserts: Summary[] = [];
  events.emit = (event, ...args) => {
    if (event === "api-session/added") upserts.push(args[0] as Summary);
  };
  const sessions = new ChSessions(host, new Workspaces(data, root), events, new WebImages(data));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new Streams();
  sessions.register(rpc, streams);
  const call = async <T>(method: string, request?: object): Promise<T> => {
    const result = await rpc.dispatch(method, { args: request ? { request } : {} });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  const list = async () => (await call<{ items: Summary[] }>("session/list")).items;
  const openStream = async (name: string, request?: object) => {
    const frames: Array<Record<string, unknown>> = [];
    const cleanups: Array<() => void> = [];
    const sink: StreamSink = {
      id: name,
      closed: false,
      push: (frame) => frames.push(structuredClone(frame) as Record<string, unknown>),
      onClose: (cleanup) => cleanups.push(cleanup),
      end: () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
      },
      fail: (code, message) => assert.fail(`${code}: ${message}`),
    };
    t.after(() => sink.end());
    const handler = streams.endpoints.get(name);
    assert.ok(handler);
    await handler(request ? { request } : {}, sink);
    return frames;
  };
  return { root, host, sessions, upserts, call, list, openStream };
}

it("lists only navigation facts without loading history or controls", async (t) => {
  const f = fixture(t);
  f.host.add("second", f.root, "Second title");
  f.host.add("third", f.root, "Third title");
  const source = f.host.threads.get("source");
  assert.ok(source);
  source.codexhostImportSource = { harnessId: "codex-cli", nativeSessionId: "original" };
  const items = await f.list();
  const row = items.find((item) => item.sessionId === "source");
  assert.ok(row);
  assert.deepEqual(row.projections, {
    kind: "cached",
    asOfSeq: 0,
    values: {
      nativeDiscovery: true,
      threadReference: { hostId: "local" },
      title: "Source title",
      codexhostImportSource: source.codexhostImportSource,
      harnessIdentity: { id: "fake", name: "CH Harness" },
      sessionListMetadata: { blank: false, lastPromptAt: 2_000_000 },
    },
  });
  assert.ok(
    f.host.requests.every(
      ({ method }) =>
        !["thread/read", "thread/turns/list", "codexhost/harness/inspect"].includes(method),
    ),
  );
  // Reconstruct the previous cold-list shape using the same fixture and image capability.
  const previous = items.map((item) => ({
    ...item,
    projections: {
      ...item.projections,
      values: {
        ...defaultProjections(),
        attachmentInput: WEB_IMAGE_INPUT,
        imageLimits: WEB_IMAGE_LIMITS,
        ...item.projections.values,
      },
    },
  }));
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  assert.ok(bytes(items) < bytes(previous) / 2);
  t.diagnostic(`Fixture summary JSON bytes: ${bytes(previous[0])} -> ${bytes(items[0])}`);
  t.diagnostic(`Fixture batch (3 rows) JSON bytes: ${bytes(previous)} -> ${bytes(items)}`);
});

it("keeps child and connection hints but excludes unrelated loaded projections from lists and upserts", async (t) => {
  const f = fixture(t);
  const child = f.host.add("child", f.root);
  child.parentThreadId = "source";
  child.status = { type: "active" };
  await f.list();
  for (const sessionId of ["source", "child"]) {
    await f.call("session/projections", { sessionId });
    await f.sessions["threads"].get(sessionId)?.controls;
  }
  const parentView = f.sessions["threads"].view("source");
  const childView = f.sessions["threads"].view("child");
  assert.ok(parentView && childView);
  const catalog = [{ id: "child", label: "Worker", mode: "continuable", activity: "running" }];
  const connection = { state: "reconnecting", message: "Host unavailable" };
  parentView.log.setProjection("subagentCatalog", catalog);
  parentView.log.setProjection("nativeConnection", connection);
  parentView.log.setProjection("nativeInteractionError", "Question reply failed");
  parentView.log.setProjection("testUnrelatedGlobal", "x".repeat(20_000));
  const timing = { settledMs: 1200, lastTurnCompleted: true };
  const usage = {
    uncachedInputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  childView.log.setProjection("subagent", { label: "Worker" });
  childView.log.setProjection("subagentTiming", timing);
  childView.log.setProjection("tokenUsage", usage);
  const source = f.host.threads.get("source");
  assert.ok(source);
  source.name = "Updated title";
  const items = await f.list();
  const parent = items.find((item) => item.sessionId === "source");
  const childRow = items.find((item) => item.sessionId === "child");
  assert.ok(parent && childRow);
  assert.deepEqual(parent.projections.values.subagentCatalog, catalog);
  assert.deepEqual(parent.projections.values.nativeConnection, connection);
  assert.equal(parent.projections.values.nativeInteractionError, "Question reply failed");
  assert.equal(childRow.running, true);
  assert.equal(childRow.parentSessionId, "source");
  assert.equal(childRow.origin, "subagent");
  assert.equal(childRow.projections.values.nativeDiscovery, false);
  assert.deepEqual(childRow.projections.values.subagent, { label: "Worker" });
  assert.deepEqual(childRow.projections.values.subagentTiming, timing);
  assert.deepEqual(childRow.projections.values.tokenUsage, usage);
  const upsert = f.upserts.find((item) => item.sessionId === "source");
  assert.ok(upsert);
  assert.deepEqual(upsert.projections, parent.projections);
  for (const item of [...items, upsert]) {
    for (const key of [
      "testUnrelatedGlobal",
      "permissions",
      "nativePermissions",
      "sessionStats",
      "plan",
      "imageLimits",
    ]) {
      assert.equal(Object.hasOwn(item.projections.values, key), false, key);
    }
  }
  // List omission does not remove the opened Session's complete control values.
  const opened = await f.call<{ values: Record<string, unknown> }>("session/projections", {
    sessionId: "source",
  });
  assert.deepEqual(opened.values.permissions, { currentValue: "ask" });
  assert.ok(opened.values.nativePermissions);
  assert.ok(opened.values.modelSelection);
  assert.deepEqual(opened.values.attachmentInput, WEB_IMAGE_INPUT);
  assert.deepEqual(opened.values.imageLimits, WEB_IMAGE_LIMITS);
  assert.deepEqual(opened.values.plan, { active: false, pending: false });
  assert.equal(opened.values.testUnrelatedGlobal, "x".repeat(20_000));
  const control = await f.openStream("session/control");
  const baseline = control[0]?.value as {
    projections: Record<string, { values: Record<string, unknown> }>;
  };
  assert.deepEqual(
    baseline.projections.source?.values.nativePermissions,
    opened.values.nativePermissions,
  );
  assert.equal(
    baseline.projections.source?.values.testUnrelatedGlobal,
    opened.values.testUnrelatedGlobal,
  );
});

it("keeps draft list/upsert hints light while detail, control and follow retain controls", async (t) => {
  const f = fixture(t);
  const inspect = t.mock.method(f.sessions.catalog, "inspect", async () => {
    throw new Error("List must not inspect draft controls");
  });
  const selection = { provider: "fake", model: "native" };
  await f.sessions.prepareDraft(
    { sessionId: "draft", cwd: f.root },
    { selection, permissionModeId: "ask" },
  );
  const draft = (await f.list()).find((item) => item.sessionId === "draft");
  assert.ok(draft);
  assert.deepEqual(draft.projections.values, {
    harnessIdentity: { id: "fake", name: "CH Harness" },
  });
  assert.deepEqual(f.upserts[0]?.projections, draft.projections);
  assert.equal(inspect.mock.calls.length, 0);
  inspect.mock.restore();
  const opened = await f.call<{ values: Record<string, unknown> }>("session/projections", {
    sessionId: "draft",
  });
  assert.deepEqual(opened.values.modelSelection, { lastUsed: null, next: selection });
  assert.deepEqual(opened.values.permissions, { currentValue: "ask" });
  assert.ok(opened.values.nativePermissions);
  assert.deepEqual(opened.values.attachmentInput, WEB_IMAGE_INPUT);
  assert.deepEqual(opened.values.imageLimits, WEB_IMAGE_LIMITS);
  const control = await f.openStream("session/control");
  const baseline = control[0]?.value as { projections: Record<string, unknown> };
  assert.deepEqual(baseline.projections.draft, { ...draft.projections, values: opened.values });
  const follow = await f.openStream("session/follow", { address: { sessionId: "draft" } });
  assert.deepEqual(follow[0]?.projections, baseline.projections.draft);
  await f.call("session/selectModel", { sessionId: "draft", ...selection });
  assert.deepEqual(f.upserts.at(-1)?.projections, draft.projections);
  assert.ok(control.some((frame) => frame.key === "nativePermissions"));
});
