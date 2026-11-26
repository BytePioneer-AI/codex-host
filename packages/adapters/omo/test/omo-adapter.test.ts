import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  harnessInspectionSchema,
  harnessModelCatalogSchema,
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { OmoAdapter, type OmoAdapterOptions } from "../src/omo-adapter.js";
import { createOmoInspectSession, omoInspectProcessCommand } from "../src/omo-inspect.js";
import type { OmoRpcProcessAdapter, OmoRpcProcessOptions } from "../src/omo-rpc-session.js";

/**
 * Synthetic `omo --mode rpc` peer written for this suite. It answers the
 * handshake and Session startup frames the adapter consumes, records the
 * environment it actually received, and models OmO's empty-Session cleanup:
 * the session file is written at startup and removed on stdin EOF when no
 * prompt arrived. No OmO source or documentation sample was copied.
 */
const FIXTURE_SOURCE = `import fs from "node:fs";
import path from "node:path";

const scenario = process.env.FAKE_OMO_SCENARIO ?? "inspect";
const cwd = process.cwd();
const stateDir = path.join(cwd, ".fake-omo");
fs.mkdirSync(stateDir, { recursive: true });
const reportedFile =
  process.env.FAKE_OMO_STATE_FILE ??
  process.env.FAKE_OMO_SESSION ??
  path.join(stateDir, "session-" + process.pid + ".jsonl");
fs.mkdirSync(path.dirname(reportedFile), { recursive: true });
fs.writeFileSync(reportedFile, JSON.stringify({ type: "session", startupBookkeeping: true }) + "\\n");
fs.writeFileSync(
  path.join(stateDir, "env.json"),
  JSON.stringify({
    CODEXHOST_TEST_MARKER: process.env.CODEXHOST_TEST_MARKER ?? null,
    CODEXHOST_TEST_BASE: process.env.CODEXHOST_TEST_BASE ?? null,
    PI_TELEMETRY: process.env.PI_TELEMETRY ?? null,
    PI_OFFLINE: process.env.PI_OFFLINE ?? null,
  }),
);
fs.writeFileSync(path.join(stateDir, "argv.json"), JSON.stringify(process.argv.slice(2)));

const inspecting = scenario === "inspect" || scenario.startsWith("inspect-");
const state = {
  sessionId: inspecting ? null : (process.env.FAKE_OMO_STATE_ID ?? "session-alpha"),
  sessionFile: inspecting ? null : reportedFile,
  model: {
    provider: "synthetic-provider",
    id: "synthetic-model",
    name: "Synthetic Model",
    reasoning: true,
  },
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  messageCount: 0,
  pendingDialogs: [],
  permissionPreset: "ask",
  effectivePermissionPreset: "ask",
};

let promptReceived = false;

function write(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function respond(command, data) {
  const response = { id: command.id, type: "response", command: command.type, success: true };
  if (data !== undefined) response.data = data;
  write(response);
}

function handle(command) {
  switch (command.type) {
    case "set_client_info":
      respond(command, { accepted: true });
      return;
    case "get_state":
      respond(command, state);
      return;
    case "get_protocol_info":
      respond(command, {
        protocolVersion: scenario === "inspect-incompatible" ? 2 : 1,
        serverVersion: "5.1.83",
        capabilities: ["multi_session"],
        mode: "classic",
      });
      return;
    case "get_available_models":
      respond(command, {
        models: [
          {
            provider: "synthetic-provider",
            id: "synthetic-model",
            name: "Synthetic Model",
            reasoning: true,
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      });
      return;
    case "prompt":
      promptReceived = true;
      fs.appendFileSync(path.join(stateDir, "prompts.log"), JSON.stringify(command) + "\\n");
      respond(command, { disposition: "started" });
      return;
    default:
      respond(command, { echoed: command.type });
      return;
  }
}

if (scenario === "inspect-exit") {
  process.exit(1);
}

if (scenario === "inspect-silent") {
  // Never reads stdin and never answers; the caller must bound every stage.
  setInterval(() => {}, 1000);
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) handle(JSON.parse(line));
      newline = buffer.indexOf("\\n");
    }
  });
  process.stdin.on("end", () => {
    if (!promptReceived) fs.rmSync(reportedFile, { force: true });
    process.exit(0);
  });
}
`;

const temporaryRoots: string[] = [];
const adapters: OmoAdapter[] = [];
const fixtureChildren: ChildProcessWithoutNullStreams[] = [];
let fixturePath = "";
let fixtureRoot = "";

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "omo-adapter-fixture-"));
  fixturePath = path.join(fixtureRoot, "fake-omo.mjs");
  writeFileSync(fixturePath, FIXTURE_SOURCE, "utf8");
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close().catch(() => undefined)));
  for (const child of fixtureChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "omo-adapter-test-"));
  temporaryRoots.push(directory);
  return directory;
}

/** A real executable that forwards the production argv to the synthetic peer. */
function createOmoCommandWrapper(): string {
  if (process.platform === "win32") {
    const wrapper = path.join(fixtureRoot, "fake-omo.cmd");
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = path.join(fixtureRoot, "fake-omo");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`, "utf8");
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/** Proves the OS no longer owns the PID; the ESRCH receipt is returned. */
async function expectProcessGone(pid: number): Promise<void> {
  let receipt: NodeJS.ErrnoException | undefined;
  await vi.waitFor(
    () => {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        alive = false;
        receipt = error as NodeJS.ErrnoException;
      }
      expect(alive).toBe(false);
      expect(receipt?.code).toBe("ESRCH");
    },
    { timeout: 5_000, interval: 25 },
  );
  console.log(`[t6] process.exit receipt pid=${pid} code=${receipt?.code ?? "missing"}`);
}

interface FixtureAdapter {
  readonly adapter: OmoAdapter;
  readonly inspectSpawns: OmoRpcProcessOptions[];
  readonly sessionSpawns: OmoRpcProcessOptions[];
  readonly inspectChildren: ChildProcessWithoutNullStreams[];
  readonly sessionChildren: ChildProcessWithoutNullStreams[];
  readonly versionReads: string[];
}

function createFixtureAdapter(
  options: Omit<OmoAdapterOptions, "processAdapter" | "inspectProcessAdapter"> & {
    scenario?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
): FixtureAdapter {
  const inspectSpawns: OmoRpcProcessOptions[] = [];
  const sessionSpawns: OmoRpcProcessOptions[] = [];
  const inspectChildren: ChildProcessWithoutNullStreams[] = [];
  const sessionChildren: ChildProcessWithoutNullStreams[] = [];
  const versionReads: string[] = [];
  const spawnFixture = (spawnOptions: OmoRpcProcessOptions) => {
    const child = spawn(process.execPath, [fixturePath], {
      cwd: spawnOptions.cwd,
      env: spawnOptions.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    fixtureChildren.push(child);
    return child;
  };
  const inspectProcessAdapter: OmoRpcProcessAdapter = {
    spawn(spawnOptions) {
      inspectSpawns.push(spawnOptions);
      const child = spawnFixture(spawnOptions);
      inspectChildren.push(child);
      return child;
    },
  };
  const processAdapter: OmoRpcProcessAdapter = {
    spawn(spawnOptions) {
      sessionSpawns.push(spawnOptions);
      const child = spawnFixture({
        ...spawnOptions,
        environment: {
          ...spawnOptions.environment,
          ...(spawnOptions.sessionFile === undefined
            ? {}
            : { FAKE_OMO_SESSION: spawnOptions.sessionFile }),
        },
      });
      sessionChildren.push(child);
      return child;
    },
  };
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_OMO_SCENARIO: options.scenario ?? "inspect",
    ...options.environment,
  };
  const adapter = new OmoAdapter({
    ...options,
    environment,
    resolveExecutable: options.resolveExecutable ?? (() => "fake-omo"),
    inspectProcessAdapter,
    processAdapter,
    readVersion: async (executable) => {
      versionReads.push(executable);
      return "5.1.83";
    },
    commandTimeoutMs: options.commandTimeoutMs ?? 5_000,
    startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
    closeTimeoutMs: options.closeTimeoutMs ?? 1_000,
  });
  adapters.push(adapter);
  return { adapter, inspectSpawns, sessionSpawns, inspectChildren, sessionChildren, versionReads };
}

const stagingCapabilities = {
  configuration: {
    selectModel: false,
    selectThinkingOption: false,
    selectPermissionMode: false,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
} as const;

function sessionFixture(cwd: string, environment: NodeJS.ProcessEnv = {}): FixtureAdapter {
  return createFixtureAdapter({
    scenario: "session",
    environment: {
      FAKE_OMO_STATE_ID: "session-alpha",
      FAKE_OMO_STATE_FILE: path.join(cwd, "sessions", "alpha.jsonl"),
      ...environment,
    },
  });
}

function turnStart() {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse("turn-1"),
    input: [{ type: "text" as const, text: "hello" }],
  };
}

describe("OmO Adapter inspect", () => {
  it("builds the inspect launch as a no-session RPC process", () => {
    const invocation = omoInspectProcessCommand(
      { cwd: os.tmpdir(), command: "/fake/omo", environment: { PATH: "" } },
      { platform: "linux", isExecutable: () => true },
    );
    expect(invocation.arguments).toEqual(["--mode", "rpc", "--no-session"]);
  });

  it("runs the production inspect command through the no-session process boundary", async () => {
    const cwd = temporaryDirectory();
    const session = createOmoInspectSession({
      cwd,
      command: createOmoCommandWrapper(),
      environment: { ...process.env, FAKE_OMO_SCENARIO: "inspect" },
      commandTimeoutMs: 5_000,
      startupTimeoutMs: 5_000,
      closeTimeoutMs: 1_000,
    });
    try {
      const inspected = await session.inspect();
      expect(inspected.protocol.serverVersion).toBe("5.1.83");
      const argv = JSON.parse(
        readFileSync(path.join(cwd, ".fake-omo", "argv.json"), "utf8"),
      ) as string[];
      expect(argv).toContain("--mode");
      expect(argv).toContain("rpc");
      expect(argv).toContain("--no-session");
      expect(argv).not.toContain("--session");
    } finally {
      await session.close();
    }
  });

  it("inspects through a short-lived handshake and publishes the native catalog", async () => {
    const cwd = temporaryDirectory();
    const fixture = createFixtureAdapter({ scenario: "inspect" });
    const inspection = await fixture.adapter.inspect({ cwd });
    expect(harnessInspectionSchema.parse(inspection)).toEqual(inspection);
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") throw new Error("expected a ready inspection");
    expect(inspection.catalog.models.map((model) => model.ref.id)).toContain(
      "synthetic-provider/synthetic-model",
    );
    expect(inspection.catalog.thinkingOptions.map(({ id }) => id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(inspection.capabilities).toEqual(stagingCapabilities);
    // Staging rule: no permission catalog until its selection capability exists.
    expect(inspection).not.toHaveProperty("permissionModes");
    expect(fixture.inspectSpawns).toHaveLength(1);
    expect(fixture.inspectSpawns[0]?.environment?.PI_OFFLINE).toBe("1");
  });

  it("caches the ready catalog per cwd, bypasses it on refresh, and starts one process", async () => {
    const cwd = temporaryDirectory();
    const fixture = createFixtureAdapter({ scenario: "inspect" });
    await fixture.adapter.inspect({ cwd });
    await fixture.adapter.inspect({ cwd });
    expect(fixture.inspectSpawns).toHaveLength(1);
    await fixture.adapter.inspect({ cwd, refresh: true });
    expect(fixture.inspectSpawns).toHaveLength(2);
    await fixture.adapter.inspect({ cwd });
    expect(fixture.inspectSpawns).toHaveLength(2);
  });

  it("answers availability from the CLI version without entering the catalog cache", async () => {
    const cwd = temporaryDirectory();
    const fixture = createFixtureAdapter({ scenario: "inspect" });
    const availability = await fixture.adapter.inspect({ cwd, purpose: "availability" });
    expect(availability).toMatchObject({ status: "ready", catalog: { models: [] } });
    expect(fixture.inspectSpawns).toHaveLength(0);
    expect(fixture.versionReads).toEqual(["fake-omo"]);
    await fixture.adapter.inspect({ cwd });
    expect(fixture.inspectSpawns).toHaveLength(1);
    await fixture.adapter.inspect({ cwd, purpose: "availability" });
    expect(fixture.inspectSpawns).toHaveLength(1);
    expect(fixture.versionReads).toHaveLength(2);
    await fixture.adapter.inspect({ cwd });
    expect(fixture.inspectSpawns).toHaveLength(1);
  });

  it("reports notInstalled without spawning when no omo executable resolves", async () => {
    const fixture = createFixtureAdapter({
      scenario: "inspect",
      resolveExecutable: () => undefined,
    });
    const inspection = await fixture.adapter.inspect({ cwd: temporaryDirectory() });
    expect(harnessInspectionSchema.parse(inspection)).toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false },
    });
    expect(fixture.inspectSpawns).toHaveLength(0);
  });

  it("reports unavailable when the handshake process cannot stay up", async () => {
    const fixture = createFixtureAdapter({ scenario: "inspect-exit" });
    const inspection = await fixture.adapter.inspect({ cwd: temporaryDirectory() });
    expect(harnessInspectionSchema.parse(inspection)).toMatchObject({
      status: "unavailable",
      error: { code: "unavailable" },
    });
    expect(fixture.inspectSpawns).toHaveLength(1);
  });

  it("bounds a silent handshake instead of waiting forever", async () => {
    const fixture = createFixtureAdapter({
      scenario: "inspect-silent",
      commandTimeoutMs: 300,
      startupTimeoutMs: 300,
    });
    const startedAt = Date.now();
    const inspection = await fixture.adapter.inspect({ cwd: temporaryDirectory() });
    expect(inspection.status).toBe("unavailable");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("treats a configured but unusable command as not installed, not a crash", async () => {
    const missing = path.join(os.tmpdir(), "omo missing path", 'om"o', "omo.exe");
    const adapter = new OmoAdapter({
      environment: { PATH: "", CODEXHOST_OMO_COMMAND: `"${missing}"` },
    });
    adapters.push(adapter);
    await expect(adapter.inspect({ cwd: temporaryDirectory() })).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false },
    });
  });

  it("reports a protocol error for an incompatible engine", async () => {
    const fixture = createFixtureAdapter({ scenario: "inspect-incompatible" });
    const inspection = await fixture.adapter.inspect({ cwd: temporaryDirectory() });
    expect(harnessInspectionSchema.parse(inspection)).toMatchObject({
      status: "error",
      error: { code: "protocolError", retryable: false },
    });
  });

  it("requires the Permission Mode catalog and selection capability to agree", () => {
    const catalog = harnessModelCatalogSchema.parse({ models: [], thinkingOptions: [] });
    const permissionModes = {
      modes: [{ id: harnessPermissionModeIdSchema.parse("ask"), label: "Ask" }],
      defaultModeId: harnessPermissionModeIdSchema.parse("ask"),
    };
    expect(() =>
      harnessInspectionSchema.parse({
        status: "ready",
        catalog,
        capabilities: {
          ...stagingCapabilities,
          configuration: { ...stagingCapabilities.configuration, selectPermissionMode: true },
        },
      }),
    ).toThrow(/Permission Mode catalog/u);
    expect(() =>
      harnessInspectionSchema.parse({
        status: "ready",
        catalog,
        permissionModes,
        capabilities: stagingCapabilities,
      }),
    ).toThrow(/Permission Mode catalog/u);
  });
});

describe("OmO Adapter open", () => {
  it("opens a create Session from native get_state and publishes confirmed state", async () => {
    const cwd = temporaryDirectory();
    const sessionFile = path.join(cwd, "sessions", "alpha.jsonl");
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      model: { id: "requested/other-model" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    const session = result.value;
    expect(session.initialState).toEqual({
      nativeRef: {
        harnessId: "omo",
        nativeSessionId: "session-alpha",
        locator: { sessionPath: sessionFile, cwd: path.resolve(cwd) },
        formatVersion: 1,
      },
      effectiveModel: { id: "synthetic-provider/synthetic-model" },
      resolvedModelLabel: "Synthetic Model",
      effectiveThinkingOptionId: "medium",
    });
    // requested≠effective: the requested Model was never confirmed and must not be echoed.
    expect(session.initialState.effectiveModel?.id).not.toBe("requested/other-model");
    expect(session.capabilities).toEqual(stagingCapabilities);
    expect(session.initialUsage).toBeNull();
    expect(fixture.sessionSpawns).toHaveLength(1);
    expect(fixture.sessionSpawns[0]?.cwd).toBe(path.resolve(cwd));
    expect(fixture.sessionSpawns[0]?.sessionFile).toBeUndefined();

    const iterator = session.outputs[Symbol.asyncIterator]();
    const pendingOutput = iterator.next();
    await expect(session.execute(turnStart())).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    await Promise.all([session.close(), session.close()]);
    await session.close();
    await expect(pendingOutput).resolves.toMatchObject({ done: true });
    await expect(session.execute(turnStart())).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });

  it("propagates per-Session environment overrides to the spawned process", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd, { CODEXHOST_TEST_BASE: "factory" });
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      environment: { CODEXHOST_TEST_MARKER: "override", CODEXHOST_TEST_BASE: "thread" },
    });
    if (!result.ok) throw new Error("expected an open Session");
    const recorded = JSON.parse(
      readFileSync(path.join(cwd, ".fake-omo", "env.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(recorded.CODEXHOST_TEST_MARKER).toBe("override");
    expect(recorded.CODEXHOST_TEST_BASE).toBe("thread");
    expect(recorded.PI_TELEMETRY).toBe("0");
    expect(fixture.sessionSpawns[0]?.environment?.CODEXHOST_TEST_MARKER).toBe("override");
    await result.value.close();
  });

  it("does not submit content for a prewarmed Session and leaves no empty session file", async () => {
    const cwd = temporaryDirectory();
    const sessionFile = path.join(cwd, "sessions", "alpha.jsonl");
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({ kind: "create", cwd, prewarm: true });
    expect(result.ok).toBe(true);
    expect(existsSync(sessionFile)).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    await result.value.close();
    expect(existsSync(sessionFile)).toBe(false);
    expect(readdirSync(path.join(cwd, "sessions"))).toEqual([]);
    expect(existsSync(path.join(cwd, ".fake-omo", "prompts.log"))).toBe(false);
  });

  it("resumes the persisted Session file and verifies the native identity", async () => {
    const cwd = temporaryDirectory();
    const sessionFile = path.join(cwd, "sessions", "alpha.jsonl");
    const fixture = sessionFixture(cwd);
    const nativeRef: NativeSessionRef = {
      harnessId: "omo",
      nativeSessionId: "session-alpha",
      locator: { sessionPath: sessionFile, cwd: path.resolve(cwd) },
      formatVersion: 1,
    };
    const result = await fixture.adapter.open({ kind: "resume", nativeRef, cwd });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    expect(result.value.initialState.nativeRef).toEqual(nativeRef);
    expect(fixture.sessionSpawns[0]?.sessionFile).toBe(sessionFile);
    await result.value.close();
  });

  it("rejects a resume whose native Session identity differs and closes the process", async () => {
    const cwd = temporaryDirectory();
    const sessionFile = path.join(cwd, "sessions", "alpha.jsonl");
    const fixture = sessionFixture(cwd, {
      FAKE_OMO_STATE_ID: "session-beta",
      FAKE_OMO_STATE_FILE: sessionFile,
    });
    const nativeRef: NativeSessionRef = {
      harnessId: "omo",
      nativeSessionId: "session-alpha",
      locator: { sessionPath: sessionFile, cwd: path.resolve(cwd) },
      formatVersion: 1,
    };
    const result = await fixture.adapter.open({ kind: "resume", nativeRef, cwd });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound", retryable: false },
    });
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("rejects a resume that opened a different Session file and closes the process", async () => {
    const cwd = temporaryDirectory();
    const sessionFile = path.join(cwd, "sessions", "alpha.jsonl");
    const otherFile = path.join(cwd, "sessions", "other.jsonl");
    const fixture = sessionFixture(cwd, { FAKE_OMO_STATE_FILE: otherFile });
    const nativeRef: NativeSessionRef = {
      harnessId: "omo",
      nativeSessionId: "session-alpha",
      locator: { sessionPath: sessionFile, cwd: path.resolve(cwd) },
      formatVersion: 1,
    };
    const result = await fixture.adapter.open({ kind: "resume", nativeRef, cwd });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "protocolError", retryable: false },
    });
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("rejects corrupt Native Session Refs before spawning anything", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const withoutLocator = {
      harnessId: "omo",
      nativeSessionId: "session-alpha",
      formatVersion: 1,
    } as NativeSessionRef;
    await expect(
      fixture.adapter.open({ kind: "resume", nativeRef: withoutLocator, cwd }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      fixture.adapter.open({
        kind: "resume",
        nativeRef: { ...withoutLocator, harnessId: "pi" } as NativeSessionRef,
        cwd,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      fixture.adapter.open({
        kind: "create",
        cwd,
        permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      fixture.adapter.open({ kind: "create", cwd, executionPolicy: "unattended-full-access" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(fixture.sessionSpawns).toHaveLength(0);
  });

  it("refuses Fork and last-Turn rollback before spawning anything", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const sourceRef: NativeSessionRef = {
      harnessId: "omo",
      nativeSessionId: "session-alpha",
      locator: { sessionPath: path.join(cwd, "sessions", "alpha.jsonl"), cwd },
      formatVersion: 1,
    };
    await expect(
      fixture.adapter.open({
        kind: "fork",
        sourceRef,
        checkpoint: {
          harnessId: "omo",
          nativeSessionId: "session-alpha",
          checkpointId: "turn-1",
          formatVersion: 1,
        },
        cwd,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      fixture.adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(fixture.sessionSpawns).toHaveLength(0);
  });

  it("closes live Session processes when the Adapter closes", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({ kind: "create", cwd });
    if (!result.ok) throw new Error("expected an open Session");
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await fixture.adapter.close();
    await expectProcessGone(pid as number);
    await expect(result.value.execute(turnStart())).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });

  it("closes idempotently and aborts an in-flight inspect handshake", async () => {
    const fixture = createFixtureAdapter({
      scenario: "inspect-silent",
      commandTimeoutMs: 30_000,
      startupTimeoutMs: 30_000,
      closeTimeoutMs: 500,
    });
    const pending = fixture.adapter.inspect({ cwd: temporaryDirectory() });
    const child = fixture.inspectChildren[0];
    expect(child?.pid).toBeDefined();
    await Promise.all([fixture.adapter.close(), fixture.adapter.close()]);
    await fixture.adapter.close();
    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
    await expectProcessGone((child as ChildProcessWithoutNullStreams).pid as number);
    await expect(fixture.adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
  });
});
