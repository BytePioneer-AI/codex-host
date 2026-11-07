import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ChSessions } from "../src/ch-sessions.ts";
import { summarizeTurnDiffs } from "../src/ch-turn-changes.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import {
  EventHub,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";
import { FakeChChannel, startFakeChChannel } from "./support/ch-channel.ts";
import { startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";
import { defined } from "./support/defined.ts";
import type { WebFileDiff, WebTurnFileSummary } from "@codexhost/shared-contracts";

class Streams extends StreamRegistry {
  endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler) {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}

it("keeps first-screen and live projections compact while scoped RPCs return unchanged full diffs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ch-turn-diffs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("large", directory);
  const other = host.add("other", directory);
  const unchanged = Array.from(
    { length: 140 },
    (_, index) => `UNCHANGED_CONTENT_LINE_${index}_${"context".repeat(8)}`,
  );
  const file = (path: string) => ({
    path,
    kind: { type: "update", move_path: null },
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1,141 +1,141 @@\n-old\n+new\n${unchanged.map((line) => ` ${line}`).join("\n")}\n`,
  });
  row.turns = Array.from({ length: 7 }, (_, index) => ({
    id: `turn-${index}`,
    status: index === 6 ? "inProgress" : "completed",
    codexhostFileOperations: [],
    items: [
      {
        id: `user-${index}`,
        type: "userMessage",
        content: [{ type: "text", text: `Edit ${index}` }],
      },
      {
        id: `files-${index}`,
        type: "fileChange",
        status: "completed",
        changes: Array.from({ length: 12 }, (_, n) => file(`src/file-${n}.ts`)),
      },
      { id: `answer-${index}`, type: "agentMessage", text: `Edited ${index}` },
    ],
  }));
  row.status = { type: "active" };
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(directory), directory),
    new EventHub(directory),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new Streams();
  sessions.register(rpc, streams);
  const frames: Array<{
    type: string;
    key?: string;
    value?: unknown;
    projections?: { asOfSeq: number; values: Record<string, unknown> };
  }> = [];
  const cleanup: Array<() => void> = [];
  const sink: StreamSink = {
    id: "follow",
    closed: false,
    push: (frame) => frames.push(structuredClone(frame) as (typeof frames)[number]),
    onClose: (fn) => cleanup.push(fn),
    end: () => {
      for (const fn of cleanup.splice(0)) fn();
    },
    fail: (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  };
  t.after(() => sink.end());
  await defined(streams.endpoints.get("session/follow"))(
    { request: { address: { sessionId: row.id } } },
    sink,
  );
  const snapshot = defined(frames[0]);
  const baseline = defined(snapshot.projections);
  const summaries = baseline.values.codexhostTurnChanges as Record<string, WebTurnFileSummary[]>;
  assert.equal(Object.keys(summaries).length, 5);
  assert.equal(JSON.stringify(snapshot).includes("UNCHANGED_CONTENT_LINE"), false);
  for (const files of Object.values(summaries)) {
    assert.equal(files.length, 12);
    assert.ok(
      files.every(
        (entry) => entry.added === 1 && entry.removed === 1 && entry.revision.length === 16,
      ),
    );
    assert.ok(
      files.every((entry) => !Object.hasOwn(entry, "oldText") && !Object.hasOwn(entry, "newText")),
    );
  }
  const read = (sessionId: string, turn: number, path?: string) =>
    rpc.dispatch("codexhost/turnDiffs", {
      args: { request: { sessionId, turn, ...(path === undefined ? {} : { path }) } },
    });
  const full: Record<string, WebFileDiff[]> = {};
  for (const key of Object.keys(summaries)) {
    const result = await read(row.id, Number(key));
    assert.ok(result.ok);
    full[key] = (result.value as { diffs: WebFileDiff[] }).diffs;
    assert.equal(full[key]?.length, 12);
  }
  const turn = Number(Object.keys(summaries).at(-1));
  const selected = await read(row.id, turn, "src/file-3.ts");
  assert.ok(selected.ok);
  assert.deepEqual((selected.value as { diffs: WebFileDiff[] }).diffs, [
    {
      path: "src/file-3.ts",
      oldText: ["old", ...unchanged].join("\n"),
      newText: ["new", ...unchanged].join("\n"),
    },
  ]);
  const before = Buffer.byteLength(
    JSON.stringify({
      ...snapshot,
      projections: { ...baseline, values: { ...baseline.values, codexhostTurnChanges: full } },
    }),
  );
  const after = Buffer.byteLength(JSON.stringify(snapshot));
  t.diagnostic(
    `Same 7-Turn/12-file fixture first screen: full projection ${before} bytes -> summary ${after} bytes (${(100 * (1 - after / before)).toFixed(1)}% smaller)`,
  );
  assert.ok(after < before / 10);
  const cross = await read(other.id, turn, "src/file-3.ts");
  assert.ok(!cross.ok || (cross.value as { diffs: WebFileDiff[] }).diffs.length === 0);
  const invalid = await read(row.id, -1);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "session/diff-invalid");
  const live = defined(row.turns.at(-1));
  const changes = defined(live.items.find((item) => item.type === "fileChange"));
  (changes.changes as ReturnType<typeof file>[]).push(file("src/latest.ts"));
  host.changed(row.id);
  const until = Date.now() + 3000;
  while (
    !frames.some(
      (frame) =>
        frame.type === "projection" &&
        frame.key === "codexhostTurnChanges" &&
        JSON.stringify(frame.value).includes("src/latest.ts"),
    )
  ) {
    assert.ok(Date.now() < until, "live summary arrived");
    await delay(10);
  }
  const delta = frames
    .filter((frame) => frame.type === "projection" && frame.key === "codexhostTurnChanges")
    .at(-1);
  assert.equal(JSON.stringify(delta).includes("UNCHANGED_CONTENT_LINE"), false);
});

it("invalidates equal-count summaries when full diff content changes", () => {
  const first = summarizeTurnDiffs([{ path: "a", oldText: "old", newText: "new" }]);
  assert.deepEqual(
    first.map(({ added, removed }) => ({ added, removed })),
    [{ added: 1, removed: 1 }],
  );
  const same = summarizeTurnDiffs([{ path: "a", oldText: "old", newText: "new" }], first);
  assert.equal(same[0], first[0]);
  const changed = summarizeTurnDiffs([{ path: "a", oldText: "old", newText: "different" }], first);
  assert.notEqual(changed[0]?.revision, first[0]?.revision);
});

it(
  "authenticates native Thread diff RPCs and reports a missing diff",
  { timeout: 20_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-turn-diffs-auth-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    host.add("official", directory);
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "codexhost/thread/inspect" && params.threadId === "official")
        return { owner: "codex", locked: true } as T;
      return request<T>(method, params);
    };
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--ch-control-directory",
        directory,
      ],
      { authenticated: true },
    );
    const send = (headers: Record<string, string>) =>
      fetch(new URL("/api/codexhost/turnDiffs", url), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "diff",
          method: "codexhost/turnDiffs",
          payload: { args: { request: { sessionId: "official", turn: 1 } } },
        }),
      });
    assert.equal((await send({})).status, 401);
    const token = defined(new URL(url).searchParams.get("token"));
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await send({ ...headers, origin: "http://untrusted.invalid" })).status, 403);
    const result = (await (await send(headers)).json()) as {
      result: { ok: boolean; error: { code: string } };
    };
    assert.equal(result.result.ok, false);
    assert.equal(result.result.error.code, "session/diff-not-found");
  },
);
