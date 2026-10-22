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
import { afterEach, describe, expect, it } from "vitest";

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
