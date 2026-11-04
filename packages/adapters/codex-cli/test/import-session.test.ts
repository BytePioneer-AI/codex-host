import type { HarnessSession, HarnessSessionImportSource } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarnessAdapter } from "../src/plugin.ts";
import { prepareCodexImport } from "../src/import-session.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function turn(id: string, status = "completed") {
  return {
    id,
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
    items: [
      { id: `user-${id}`, type: "userMessage", content: [{ type: "text", text: id }] },
      { id: `answer-${id}`, type: "agentMessage", text: `Answer ${id}` },
    ],
  };
}

const busy = { code: -32600, message: "thread source already has an active writer" };
function fixture(scenario: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-import-")));
  const home = join(root, ".codex");
  mkdirSync(home);
  const command = join(root, "codex");
  writeFileSync(
    command,
    `#!${process.execPath}\n${readFileSync(resolve("tests/fixtures/codex-auth-peer.cjs"), "utf8")}`,
  );
  chmodSync(command, 0o700);
  const source: HarnessSessionImportSource = {
    candidate: {
      nativeSessionId: "source",
      title: "Source",
      cwd: root,
      updatedAt: 1000,
      running: null,
    },
    nativeRef: nativeSessionRefSchema.parse({
      formatVersion: 1,
      harnessId: "codex-cli",
      nativeSessionId: "source",
    }),
  };
  writeFileSync(
    join(home, "scenario.json"),
    JSON.stringify({
      threadTurns: { source: [turn("old"), turn("latest"), turn("partial", "inProgress")] },
      ...scenario,
    }),
  );
  const adapter = createHarnessAdapter({
    platform: process.platform,
    managedRemoteHost: false,
    launchCommand: command,
    environment: { HOME: root, CODEX_HOME: home },
  });
  const sessions: HarnessSession[] = [];
  cleanups.push(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await adapter.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    adapter,
    source,
    root,
    home,
    command,
    prepare: async () => {
      const result = await adapter.sessionImport.prepareImport({ source });
      if (result.ok && result.value.session) sessions.push(result.value.session);
      return result;
    },
    records: () =>
      readFileSync(join(home, "rpc.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { method: string; pid: number; params: Record<string, unknown> },
        ),
    forks: () =>
      JSON.parse(readFileSync(join(home, "forked-threads.json"), "utf8")) as Record<
        string,
        { turns: ReturnType<typeof turn>[] }
      >,
  };
}

it("imports an available native Session without changing its identity or sending a Turn", async () => {
  const f = fixture();
  const result = await f.prepare();
  expect(result).toMatchObject({
    ok: true,
    value: { nativeRef: f.source.nativeRef, session: expect.any(Object) },
  });
  expect(f.records().filter(({ method }) => method === "thread/resume")).toHaveLength(1);
  expect(
    f
      .records()
      .some(({ method }) => ["thread/fork", "thread/start", "turn/start"].includes(method)),
  ).toBe(false);
});

it.each(["an active writer", "a live local writer"])(
  "forks only a confirmed %s through its most recent completed Turn",
  async (writer) => {
    const f = fixture({ resumeError: { ...busy, message: `thread source already has ${writer}` } });
    const result = await f.prepare();
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.session)
      throw new Error("Import did not return a live Session");
    const { nativeRef, session } = result.value;
    expect(nativeRef.nativeSessionId).not.toBe("source");
    expect(session.initialState.nativeRef).toEqual(nativeRef);
    expect(session.capabilities.history.fork).toBe(false);
    expect(await session.readSnapshot()).toMatchObject({
      ok: true,
      value: {
        turns: [
          { nativeTurnRef: { nativeTurnKey: "old" } },
          { nativeTurnRef: { nativeTurnKey: "latest" } },
        ],
      },
    });
    expect(f.records().find(({ method }) => method === "thread/fork")?.params).toEqual({
      cwd: f.root,
      threadId: "source",
      lastTurnId: "latest",
      excludeTurns: true,
    });
    expect(f.records().some(({ method }) => method === "turn/start")).toBe(false);
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("continued"),
        input: [{ type: "text", text: "Continue in the imported copy" }],
      }),
    ).toMatchObject({ ok: true });
    for await (const output of session.outputs) {
      if (output.kind === "event" && output.event.type === "turn.completed") {
        expect(output.event.nativeTurnRef?.nativeSessionId).toBe(nativeRef.nativeSessionId);
        break;
      }
    }
    expect(f.records().find(({ method }) => method === "turn/start")?.params.threadId).toBe(
      nativeRef.nativeSessionId,
    );
  },
);

it("pages beyond newer unfinished Turns before choosing a completed native boundary", async () => {
  const unfinished = Array.from({ length: 105 }, (_, index) => turn(`failed-${index}`, "failed"));
  const f = fixture({
    resumeError: busy,
    threadTurns: { source: [turn("boundary"), ...unfinished] },
  });
  const result = await f.prepare();
  expect(result.ok).toBe(true);
  expect(
    f
      .records()
      .filter(({ method }) => method === "thread/turns/list")
      .map(({ params }) => params.cursor),
  ).toEqual([null, "100"]);
  expect(f.records().find(({ method }) => method === "thread/fork")?.params.lastTurnId).toBe(
    "boundary",
  );
});

it.each([
  { code: -32600, message: "Invalid model configuration" },
  { code: -32603, message: busy.message },
])("does not derive history for unrelated resume failure $code $message", async (resumeError) => {
  const f = fixture({ resumeError });
  expect(await f.prepare()).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
  expect(
    f.records().some(({ method }) => ["thread/turns/list", "thread/fork"].includes(method)),
  ).toBe(false);
});

it.each([
  { threadTurns: { source: [turn("partial", "inProgress"), turn("failed", "failed")] } },
  {
    turnPages: {
      first: { data: [turn("partial", "inProgress")], nextCursor: "next" },
      next: { data: [], nextCursor: "next" },
    },
  },
  { turnListError: { code: -32000, message: "Native history unavailable" } },
])(
  "rejects missing or unreliable completed history without creating a copy: %j",
  async (scenario) => {
    const f = fixture({ resumeError: busy, ...scenario });
    expect(await f.prepare()).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(f.records().some(({ method }) => method === "thread/fork")).toBe(false);
  },
);

it("reports a native fork parameter rejection as a confirmed import failure", async () => {
  const f = fixture({
    resumeError: busy,
    forkError: { code: -32602, message: "Invalid fork boundary" },
  });
  expect(await f.prepare()).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
  expect(f.records().filter(({ method }) => method === "thread/fork")).toHaveLength(1);
});

it("retains an already-created identity when native configuration initialization fails", async () => {
  const f = fixture({ resumeError: busy, forkResult: { model: "" } });
  const result = await f.prepare();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.session).toBeUndefined();
  expect(result.value.nativeRef.nativeSessionId).toBe(Object.keys(f.forks())[0]);
  expect(f.records().filter(({ method }) => method === "thread/fork")).toHaveLength(1);
});

it("keeps the confirmed imported identity when a later snapshot cannot be read", async () => {
  const f = fixture({
    resumeError: busy,
    forkReadError: { code: -32000, message: "History temporarily unavailable" },
  });
  const result = await f.prepare();
  if (!result.ok || !result.value.session) throw new Error("Missing prepared Session");
  expect(await result.value.session.readSnapshot()).toMatchObject({ ok: false });
  expect(result.value.nativeRef.nativeSessionId).toBe(Object.keys(f.forks())[0]);
  expect(f.records().filter(({ method }) => method === "thread/fork")).toHaveLength(1);
});

it.each([
  { forkExitBeforeReply: true },
  { forkResult: { thread: {} } },
  { forkError: { code: -32603, message: "Native fork failed after dispatch" } },
])("rejects with an unknown outcome when fork creation was not confirmed: %j", async (scenario) => {
  const f = fixture({ resumeError: busy, ...scenario });
  await expect(f.prepare()).rejects.toThrow("fork outcome is unknown");
  expect(f.records().filter(({ method }) => method === "thread/fork")).toHaveLength(1);
});

it("bounds an unanswered fork RPC and does not report a safe-to-repeat failure", async () => {
  const f = fixture({ resumeError: busy, forkNoReply: true });
  await expect(
    prepareCodexImport({
      command: f.command,
      cwd: f.root,
      environment: { ...process.env, CODEX_HOME: f.home },
      threadId: "source",
      requestTimeoutMs: 1500,
      usage: { observe: () => null, read: async () => null },
    }),
  ).rejects.toThrow("fork outcome is unknown");
  expect(f.records().filter(({ method }) => method === "thread/fork")).toHaveLength(1);
});
