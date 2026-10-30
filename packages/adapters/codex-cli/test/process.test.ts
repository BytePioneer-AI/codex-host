import type { HarnessSession } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  type HostTurnId,
} from "@codexhost/shared-contracts";
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
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHarnessAdapter } from "../src/plugin.ts";

interface RpcRecord {
  method: string;
  params: Record<string, unknown>;
  env: {
    CODEX_HOME?: string;
    CODEX_CLI_PATH?: string;
    CODEX_THREAD_ID?: string;
    NODE_OPTIONS?: string;
    NODE_PATH?: string;
    codexhostKeys: string[];
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function fixture(scenario: object = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-cli-process-")));
  const home = join(root, ".codex");
  mkdirSync(home);
  const command = join(root, "codex");
  writeFileSync(
    command,
    `#!${process.execPath}\n${readFileSync(resolve("tests/fixtures/codex-auth-peer.cjs"), "utf8")}`,
  );
  chmodSync(command, 0o700);
  writeFileSync(join(home, "scenario.json"), JSON.stringify(scenario));
  const adapter = createHarnessAdapter({
    platform: process.platform,
    managedRemoteHost: false,
    launchCommand: command,
    environment: {
      HOME: root,
      CODEX_HOME: home,
      CODEXHOST_HOST_RUNTIME_PATH: "/do-not-execute-desktop-host",
      CODEX_CLI_PATH: "/do-not-execute-desktop-shim",
      CODEX_THREAD_ID: "gui-thread",
      NODE_OPTIONS: "--import=/do-not-execute-hook",
      NODE_PATH: "/do-not-execute-node",
    },
  });
  cleanups.push(async () => {
    await adapter.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    adapter,
    home,
    command,
    records: () =>
      readFileSync(join(home, "rpc.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RpcRecord),
  };
}

async function runTurn(session: HarnessSession, turnId: HostTurnId, text: string) {
  expect(
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] }),
  ).toMatchObject({ ok: true });
  for await (const output of session.outputs) {
    if (output.kind === "event" && output.event.type === "turn.completed")
      return output.event.outcome;
  }
  throw new Error("Missing native Turn completion");
}

describe("Codex CLI native process", () => {
  it("creates, resumes and lists Sessions in the native home with Desktop routing removed", async () => {
    const f = fixture();
    expect((await f.adapter.inspect()).status).toBe("ready");
    expect(await f.adapter.sessionImport.listCandidates()).toEqual({ ok: true, value: [] });
    const created = await f.adapter.open({ kind: "create", cwd: f.home });
    if (!created.ok) throw new Error(created.error.message);
    try {
      const nativeRef = created.value.initialState.nativeRef;
      expect(nativeRef).toMatchObject({ harnessId: "codex-cli", formatVersion: 1 });
      expect(nativeRef).not.toHaveProperty("locator");
      expect(await runTurn(created.value, hostTurnIdSchema.parse("turn-1"), "hello")).toEqual({
        status: "succeeded",
      });
      if (!nativeRef) throw new Error("Session published no native reference");
      const resumed = await f.adapter.open({ kind: "resume", cwd: f.home, nativeRef });
      expect(resumed.ok).toBe(true);
      if (resumed.ok) await resumed.value.close();
    } finally {
      await created.value.close();
    }
    const records = f.records();
    expect(records.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(records.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    for (const { env } of records) {
      expect(env.CODEX_HOME).toBe(f.home);
      expect(env.CODEX_CLI_PATH).toBeUndefined();
      expect(env.CODEX_THREAD_ID).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.NODE_PATH).toBeUndefined();
      expect(env.codexhostKeys).toEqual([]);
    }
  });

  it("discovers and resolves native Sessions beyond the first 200 without starting a Turn", async () => {
    const threads = Array.from({ length: 405 }, (_, i) => ({
      id: `session-${i}`,
      name: `Session ${i}`,
      preview: "Earlier question",
      cwd: "/native/project",
      updatedAt: 1_000 + i,
      ephemeral: false,
      parentThreadId: null,
    }));
    const f = fixture({ threads });
    const listed = await f.adapter.sessionImport.listCandidates();
    expect(listed.ok && listed.value).toHaveLength(405);
    expect(
      f
        .records()
        .filter((r) => r.method === "thread/list")
        .map((r) => r.params.cursor),
    ).toEqual([null, "200", "400"]);
    const resolved = await f.adapter.sessionImport.resolveCandidate("session-404");
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        candidate: { nativeSessionId: "session-404", updatedAt: 1_404_000, running: null },
        nativeRef: { harnessId: "codex-cli", nativeSessionId: "session-404" },
      },
    });
    expect(await f.adapter.sessionImport.resolveCandidate("missing")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    expect(
      f.records().some((r) => ["thread/start", "thread/resume", "turn/start"].includes(r.method)),
    ).toBe(false);
  });

  for (const scenario of ["repeated", "empty", "failed"])
    it(`rejects a ${scenario} later native list page rather than returning a partial list`, async () => {
      const thread = {
        id: "session-1",
        name: "Session",
        preview: "",
        cwd: "/project",
        updatedAt: 1_000,
        ephemeral: false,
        parentThreadId: null,
      };
      const f = fixture({
        threadPages: {
          first: { data: [thread], nextCursor: "next" },
          next: { data: scenario === "empty" ? [] : [thread], nextCursor: "next" },
        },
        ...(scenario === "failed" ? { threadListErrorCursor: "next" } : {}),
      });
      expect(await f.adapter.sessionImport.listCandidates()).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      expect(f.records().filter((r) => r.method === "thread/list")).toHaveLength(2);
    });

  it("groups same-page and cross-page segments by logical ID using native canonical metadata", async () => {
    const base = {
      id: "logical",
      name: "Older segment",
      preview: "",
      cwd: "/native/project",
      updatedAt: 1_000,
      ephemeral: false,
      parentThreadId: null,
    };
    const other = { ...base, id: "other" };
    const canonical = { ...base, name: "Canonical history", updatedAt: 500 };
    const f = fixture({
      threadPages: {
        first: { data: [base, { ...base, updatedAt: 3_000 }, other], nextCursor: "next" },
        next: {
          data: [{ ...base, updatedAt: 2_000 }, other, { ...base, id: "unique" }],
          nextCursor: null,
        },
      },
      threadReads: { logical: canonical, other: { ...other, name: "Other canonical" } },
    });
    expect(await f.adapter.sessionImport.listCandidates()).toMatchObject({
      ok: true,
      value: [
        { nativeSessionId: "logical", title: "Canonical history", updatedAt: 500_000 },
        { nativeSessionId: "other", title: "Other canonical" },
        { nativeSessionId: "unique", title: "Older segment" },
      ],
    });
    expect(
      f
        .records()
        .filter((r) => r.method === "thread/read")
        .map((r) => r.params),
    ).toEqual([
      { threadId: "logical", includeTurns: false },
      { threadId: "other", includeTurns: false },
    ]);
    expect(
      f.records().some((r) => ["thread/start", "thread/resume", "turn/start"].includes(r.method)),
    ).toBe(false);
  });

  it("re-reads the selected identity and metadata instead of trusting unique list rows", async () => {
    const listed = {
      id: "selected",
      name: "Stale title",
      preview: "",
      cwd: "/old/project",
      updatedAt: 1_000,
      ephemeral: false,
      parentThreadId: null,
    };
    const f = fixture({
      threads: [listed],
      threadReads: {
        selected: { ...listed, name: "Fresh title", cwd: "/fresh/project", updatedAt: 2_000 },
      },
    });
    expect(await f.adapter.sessionImport.resolveCandidate("selected")).toMatchObject({
      ok: true,
      value: {
        candidate: {
          nativeSessionId: "selected",
          title: "Fresh title",
          cwd: "/fresh/project",
          updatedAt: 2_000_000,
        },
        nativeRef: { harnessId: "codex-cli", nativeSessionId: "selected" },
      },
    });
    writeFileSync(
      join(f.home, "scenario.json"),
      JSON.stringify({ threads: [listed], threadReads: { selected: null } }),
    );
    expect(await f.adapter.sessionImport.resolveCandidate("selected")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("omits vanished, mismatched and no-longer-importable duplicate groups without hiding healthy Sessions", async () => {
    const base = {
      name: "History",
      preview: "",
      cwd: "/project",
      updatedAt: 1_000,
      ephemeral: false,
      parentThreadId: null,
    };
    const threads = ["gone", "wrong", "child", "ephemeral"].flatMap((id) => [
      { ...base, id },
      { ...base, id },
    ]);
    const f = fixture({
      threads: [...threads, { ...base, id: "healthy" }],
      threadReads: {
        gone: null,
        wrong: { ...base, id: "someone-else" },
        child: { ...base, id: "child", parentThreadId: "parent" },
        ephemeral: { ...base, id: "ephemeral", ephemeral: true },
      },
    });
    expect(await f.adapter.sessionImport.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "healthy" }],
    });
    for (const id of ["gone", "wrong", "child", "ephemeral"])
      expect(await f.adapter.sessionImport.resolveCandidate(id)).toMatchObject({
        ok: false,
        error: { code: "sessionNotFound" },
      });
  });

  it("reports native read failures instead of returning an apparently empty import list", async () => {
    const thread = {
      id: "broken",
      name: "History",
      preview: "",
      cwd: "/project",
      updatedAt: 1_000,
      ephemeral: false,
      parentThreadId: null,
    };
    const f = fixture({
      threads: [thread, thread],
      threadReadErrors: { broken: { code: -32000, message: "Native metadata unavailable" } },
    });
    expect(await f.adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("cancels canonical reads on close and starts no more discovery work", async () => {
    const thread = {
      id: "pending",
      name: "History",
      preview: "",
      cwd: "/project",
      updatedAt: 1_000,
      ephemeral: false,
      parentThreadId: null,
    };
    const f = fixture({ threads: [thread, thread], threadReadWaitFile: "never-written" });
    const reading = f.adapter.sessionImport.listCandidates();
    await vi.waitFor(() => expect(f.records().some((r) => r.method === "thread/read")).toBe(true));
    await f.adapter.close();
    expect(await reading).toMatchObject({ ok: false });
    const count = f.records().length;
    expect(await f.adapter.sessionImport.listCandidates()).toMatchObject({ ok: false });
    expect(f.records()).toHaveLength(count);
  });

  it("refuses a changed native identity on resume and historical reads", async () => {
    const f = fixture({ resumeThreadId: "wrong-session" });
    const nativeRef = nativeSessionRefSchema.parse({
      formatVersion: 1,
      harnessId: "codex-cli",
      nativeSessionId: "expected",
    });
    expect(await f.adapter.open({ kind: "resume", cwd: f.home, nativeRef })).toMatchObject({
      ok: false,
      error: {
        code: "nativeFailure",
        message: expect.stringContaining("different native Session"),
      },
    });
    writeFileSync(
      join(f.home, "scenario.json"),
      JSON.stringify({ threadReads: { expected: { id: "wrong-session" } } }),
    );
    const resumed = await f.adapter.open({ kind: "resume", cwd: f.home, nativeRef });
    if (!resumed.ok) throw new Error(resumed.error.message);
    try {
      expect(await resumed.value.readSnapshot()).toMatchObject({
        ok: false,
        error: {
          code: "nativeFailure",
          message: expect.stringContaining("different native Session"),
        },
      });
    } finally {
      await resumed.value.close();
    }
  });

  it("rejects native steering without forwarding input to Codex", async () => {
    const f = fixture();
    const created = await f.adapter.open({ kind: "create", cwd: f.home });
    if (!created.ok) throw new Error(created.error.message);
    try {
      expect(created.value.capabilities.steer).toBe(false);
      expect(
        await created.value.execute({
          type: "turn.steer",
          turnId: hostTurnIdSchema.parse("turn-1"),
          input: [{ type: "text", text: "follow-up" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(f.records().some(({ method }) => method === "turn/steer")).toBe(false);
    } finally {
      await created.value.close();
    }
  });

  it("sends no approval or sandbox parameters when no Permission Mode was chosen", async () => {
    const f = fixture();
    const created = await f.adapter.open({ kind: "create", cwd: f.home });
    if (!created.ok) throw new Error(created.error.message);
    try {
      expect(created.value.initialState.effectivePermissionModeId).toBeUndefined();
      expect(await runTurn(created.value, hostTurnIdSchema.parse("turn-1"), "hello")).toEqual({
        status: "succeeded",
      });
    } finally {
      await created.value.close();
    }
    const start = f.records().find(({ method }) => method === "thread/start");
    expect(start?.params).not.toHaveProperty("approvalPolicy");
    expect(start?.params).not.toHaveProperty("sandbox");
    const turnStart = f.records().find(({ method }) => method === "turn/start");
    expect(turnStart?.params).not.toHaveProperty("approvalPolicy");
    expect(turnStart?.params).not.toHaveProperty("sandboxPolicy");
  });

  it("sends only the chosen native approval policy and sandbox mode names", async () => {
    const f = fixture();
    const created = await f.adapter.open({
      kind: "create",
      cwd: f.home,
      permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
    });
    if (!created.ok) throw new Error(created.error.message);
    try {
      expect(created.value.initialState.effectivePermissionModeId).toBe("read-only");
      expect(await runTurn(created.value, hostTurnIdSchema.parse("turn-1"), "hello")).toEqual({
        status: "succeeded",
      });
    } finally {
      await created.value.close();
    }
    const start = f.records().find(({ method }) => method === "thread/start");
    expect(start?.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "read-only" });
    const turnStart = f.records().find(({ method }) => method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly" },
    });
    expect(turnStart?.params.sandboxPolicy).not.toHaveProperty("networkAccess");
    expect(turnStart?.params.sandboxPolicy).not.toHaveProperty("writableRoots");
  });

  it("reports a missing native CLI instead of starting a Session", async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "codex-cli-missing-")));
    cleanups.push(async () => rmSync(empty, { recursive: true, force: true }));
    const adapter = createHarnessAdapter({
      platform: process.platform,
      managedRemoteHost: false,
      launchCommand: join(empty, "missing-codex"),
      environment: { HOME: empty, PATH: empty },
    });
    cleanups.push(async () => adapter.close());
    expect(await adapter.inspect()).toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled" },
    });
    expect(await adapter.open({ kind: "create", cwd: empty })).toMatchObject({
      ok: false,
      error: { code: "notInstalled" },
    });
  });

  it("resumes a native Session without a home locator", async () => {
    const f = fixture();
    const created = await f.adapter.open({ kind: "create", cwd: f.home });
    if (!created.ok) throw new Error(created.error.message);
    const nativeRef = created.value.initialState.nativeRef;
    await created.value.close();
    if (!nativeRef) throw new Error("Session published no native reference");
    const resumed = await f.adapter.open({
      kind: "resume",
      cwd: f.home,
      nativeRef: nativeSessionRefSchema.parse(nativeRef),
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) await resumed.value.close();
    const invalid = await f.adapter.open({
      kind: "resume",
      cwd: f.home,
      nativeRef: nativeSessionRefSchema.parse({
        formatVersion: 1,
        harnessId: "pi",
        nativeSessionId: nativeRef.nativeSessionId,
      }),
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
  });
});
