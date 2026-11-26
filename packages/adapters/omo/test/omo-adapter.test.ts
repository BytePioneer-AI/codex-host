import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
import {
  omoRpcProcessCommand,
  OmoRpcSession,
  type OmoRpcProcessAdapter,
  type OmoRpcProcessOptions,
} from "../src/omo-rpc-session.js";

/**
 * Synthetic `omo --mode rpc` peer written for this suite. It answers the
 * handshake and Session startup frames the adapter consumes, records the
 * environment it actually received, and writes the session file at Session
 * start. Like real 5.1.83 (task-9 evidence) it keeps that file after exit —
 * a no-conversation close leaves it behind, and the Adapter owns prewarm
 * cleanup. No OmO source or documentation sample was copied.
 */
const FIXTURE_SOURCE = `import fs from "node:fs";
import path from "node:path";

const scenario = process.env.FAKE_OMO_SCENARIO ?? "inspect";
const cwd = process.cwd();
const stateDir = path.join(cwd, ".fake-omo");
fs.mkdirSync(stateDir, { recursive: true });
const argv = process.argv.slice(2);
const forkFlag = argv.indexOf("--fork");
const forkSource =
  process.env.FAKE_OMO_FORK_SOURCE ?? (forkFlag >= 0 ? argv[forkFlag + 1] : undefined);
const reportedFile =
  process.env.FAKE_OMO_REPORTED_FILE ??
  process.env.FAKE_OMO_SESSION ??
  process.env.FAKE_OMO_STATE_FILE ??
  path.join(stateDir, "session-" + process.pid + ".jsonl");
fs.mkdirSync(path.dirname(reportedFile), { recursive: true });
const existingEntriesRaw = fs.existsSync(reportedFile)
  ? fs
      .readFileSync(reportedFile, "utf8")
      .split("\\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  : null;
const existingHeader =
  existingEntriesRaw?.find((entry) => entry.type === "session") ?? null;
const existingEntries =
  existingEntriesRaw?.filter((entry) => entry.type !== "session") ?? [];
if (existingEntriesRaw === null) {
  fs.writeFileSync(
    reportedFile,
    JSON.stringify({ type: "session", startupBookkeeping: true }) + "\\n",
  );
}
fs.writeFileSync(
  path.join(stateDir, "env.json"),
  JSON.stringify({
    CODEXHOST_TEST_MARKER: process.env.CODEXHOST_TEST_MARKER ?? null,
    CODEXHOST_TEST_BASE: process.env.CODEXHOST_TEST_BASE ?? null,
    PI_TELEMETRY: process.env.PI_TELEMETRY ?? null,
    PI_OFFLINE: process.env.PI_OFFLINE ?? null,
  }),
);
fs.writeFileSync(path.join(stateDir, "argv.json"), JSON.stringify(argv));

const inspecting = scenario === "inspect" || scenario.startsWith("inspect-");
const state = {
  sessionId: inspecting
    ? null
    : existingHeader?.id ??
      (forkSource
        ? (process.env.FAKE_OMO_FORK_STARTUP_ID ?? "session-fork-startup-" + process.pid)
        : (process.env.FAKE_OMO_STATE_ID ?? "session-alpha")),
  sessionFile: inspecting ? null : reportedFile,
  cwd,
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
  permissionPresetSource: "host_default",
  permissionPresetStatus: "applied",
  effectivePermissionPreset: "ask",
};

// Derivation surface: a --fork startup copies the synthetic source branch into
// a new session file; the fork command cuts that copy back to the prefix before
// the named user entry. Mirrors the observed 5.1.83 behaviour (task-12 gate).
let sessionEntries = existingEntries;
let derivedSeq = 0;
if (!inspecting && forkSource && existingEntriesRaw === null) {
  sessionEntries = fs
    .readFileSync(forkSource, "utf8")
    .split("\\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "session");
  writeSessionFile(reportedFile, state.sessionId, sessionEntries);
  state.messageCount = sessionEntries.length;
}

function writeSessionFile(file, id, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [JSON.stringify({ type: "session", version: 3, id, cwd }), ...entries.map((entry) => JSON.stringify(entry))].join("\\n") + "\\n",
  );
}

function write(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function respond(command, data) {
  const response = { id: command.id, type: "response", command: command.type, success: true };
  if (data !== undefined) response.data = data;
  write(response);
}

function respondError(command, errorCode, error) {
  write({ id: command.id, type: "response", command: command.type, success: false, error, errorCode });
}

const catalog = [
  {
    provider: "synthetic-provider",
    id: "synthetic-model",
    name: "Synthetic Model",
    reasoning: true,
    supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    provider: "synthetic-provider",
    id: "other-model",
    name: "Synthetic Other",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 64000,
    maxTokens: 4096,
  },
];

function handle(command) {
  switch (command.type) {
    case "set_client_info":
      respond(command, { accepted: true });
      return;
    case "get_state":
      respond(command, { ...state, messageCount: sessionEntries.length });
      return;
    case "set_permission_preset": {
      fs.appendFileSync(
        path.join(stateDir, "permission-presets.log"),
        JSON.stringify(command) + "\\n",
      );
      const refusal = process.env.FAKE_OMO_SET_PERMISSION_ERROR;
      if (refusal) {
        write({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: 'invalid_launch_profile: unknown permissionPreset "' + command.permissionPreset + '"',
          errorCode: refusal,
        });
        return;
      }
      state.permissionPreset = command.permissionPreset;
      state.permissionPresetSource = "client";
      state.permissionPresetStatus = "applied";
      if (process.env.FAKE_OMO_SET_PERMISSION_CONFIRM !== "false") {
        state.effectivePermissionPreset = command.permissionPreset;
      }
      respond(command, {
        permissionPreset: command.permissionPreset,
        permissionPresetSource: "client",
        permissionPresetStatus: process.env.FAKE_OMO_SET_PERMISSION_STATUS ?? "applied",
      });
      return;
    }
    case "get_protocol_info":
      respond(command, {
        protocolVersion: scenario === "inspect-incompatible" ? 2 : 1,
        serverVersion: "5.1.83",
        capabilities: ["multi_session", "session_model_scope", "effect_ledger"],
        mode: "classic",
      });
      return;
    case "get_available_models":
      respond(command, { models: catalog });
      return;
    case "get_available_thinking_levels": {
      const row = catalog.find(
        (model) =>
          state.model && model.provider === state.model.provider && model.id === state.model.id,
      );
      respond(command, { levels: row ? row.supportedThinkingLevels : ["off"] });
      return;
    }
    case "set_model": {
      fs.appendFileSync(
        path.join(stateDir, "config-commands.log"),
        JSON.stringify(command) + "\\n",
      );
      const refusal = process.env.FAKE_OMO_SET_MODEL_ERROR;
      if (refusal) {
        write({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: 'model_not_found: unknown model "' + command.provider + "/" + command.modelId + '"',
          errorCode: refusal,
        });
        return;
      }
      const row = catalog.find(
        (model) => model.provider === command.provider && model.id === command.modelId,
      );
      state.model = {
        provider: command.provider,
        id: command.modelId,
        name: row ? row.name : "Unknown Synthetic Model",
        reasoning: true,
      };
      const change = {
        type: "model_change",
        id: "m-" + (sessionEntries.length + 1),
        parentId: sessionEntries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        provider: command.provider,
        modelId: command.modelId,
      };
      sessionEntries.push(change);
      writeSessionFile(state.sessionFile, state.sessionId, sessionEntries);
      write({ type: "model_changed", model: { provider: command.provider, id: command.modelId } });
      respond(command, row ?? { provider: command.provider, id: command.modelId, name: "Unknown" });
      return;
    }
    case "set_thinking_level": {
      fs.appendFileSync(
        path.join(stateDir, "config-commands.log"),
        JSON.stringify(command) + "\\n",
      );
      if (process.env.FAKE_OMO_SET_THINKING_IGNORE === "1") {
        respond(command, {});
        return;
      }
      state.thinkingLevel = command.level;
      const change = {
        type: "thinking_level_change",
        id: "th-" + (sessionEntries.length + 1),
        parentId: sessionEntries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        thinkingLevel: command.level,
      };
      sessionEntries.push(change);
      writeSessionFile(state.sessionFile, state.sessionId, sessionEntries);
      respond(command, {});
      return;
    }
    case "get_tree":
      respond(command, {
        tree: sessionEntries.length === 0 ? [] : [{ entry: sessionEntries[0], children: [] }],
        leafId: sessionEntries.at(-1)?.id ?? null,
      });
      return;
    case "get_entries": {
      const since = typeof command.since === "string" ? command.since : undefined;
      const start = since === undefined ? 0 : sessionEntries.findIndex((e) => e.id === since) + 1;
      const limit = typeof command.limit === "number" ? command.limit : sessionEntries.length;
      const page = sessionEntries.slice(start, start + limit);
      const hasMore = start + page.length < sessionEntries.length;
      respond(command, {
        entries: page,
        hasMore,
        ...(hasMore ? { nextSince: page.at(-1)?.id } : {}),
      });
      return;
    }
    case "fork": {
      fs.appendFileSync(path.join(stateDir, "forks.log"), JSON.stringify(command) + "\\n");
      const index = sessionEntries.findIndex(
        (entry) => entry.id === command.entryId && entry.message?.role === "user",
      );
      if (index < 0) {
        respondError(command, "not_found", "no such user entry");
        return;
      }
      const text = JSON.stringify(sessionEntries[index].message.content);
      if (process.env.FAKE_OMO_FORK_CANCELLED === "1") {
        respond(command, { text, cancelled: true });
        return;
      }
      if (process.env.FAKE_OMO_FORK_CONFIRM === "false") {
        respond(command, { text, cancelled: false });
        return;
      }
      derivedSeq += 1;
      const derivedId =
        process.env.FAKE_OMO_FORK_DERIVED_ID ?? "session-fork-derived-" + process.pid + "-" + derivedSeq;
      const derivedFile = path.join(
        path.dirname(state.sessionFile),
        "derived-" + derivedSeq + ".jsonl",
      );
      sessionEntries = sessionEntries.slice(0, index);
      const deferBlank =
        process.env.FAKE_OMO_FORK_DEFER_EMPTY === "1" && sessionEntries.length === 0;
      if (!deferBlank) writeSessionFile(derivedFile, derivedId, sessionEntries);
      state.sessionId = derivedId;
      state.sessionFile = derivedFile;
      state.messageCount = sessionEntries.length;
      respond(command, { text, cancelled: false });
      return;
    }
    case "prompt":
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
  let forkSequence = 0;
  const processAdapter: OmoRpcProcessAdapter = {
    spawn(spawnOptions) {
      sessionSpawns.push(spawnOptions);
      const forked = spawnOptions.forkSessionFile !== undefined;
      if (forked) forkSequence += 1;
      const child = spawnFixture({
        ...spawnOptions,
        environment: {
          ...spawnOptions.environment,
          ...(spawnOptions.sessionFile === undefined
            ? {}
            : { FAKE_OMO_SESSION: spawnOptions.sessionFile }),
          ...(forked
            ? {
                FAKE_OMO_FORK_SOURCE: spawnOptions.forkSessionFile,
                // Each startup copy is its own native Session file, exactly
                // like `omo --mode rpc --fork <source>` on 5.1.83.
                FAKE_OMO_STATE_FILE: path.join(
                  spawnOptions.cwd,
                  ".fake-omo",
                  "derived",
                  `startup-${forkSequence}.jsonl`,
                ),
              }
            : {}),
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

const sessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
  autonomousTurns: { observe: true },
  steer: false,
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

/** Frames the fixture peer received for `set_permission_preset`, in order. */
function readPresetsLog(cwd: string): Array<Record<string, unknown>> {
  const log = path.join(cwd, ".fake-omo", "permission-presets.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Frames the fixture peer received for `fork`, in order. */
function readForksLog(cwd: string): Array<Record<string, unknown>> {
  const log = path.join(cwd, ".fake-omo", "forks.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Frames the fixture peer received for `set_model`/`set_thinking_level`, in
 * arrival order. Resumes and unspecified create inputs must leave it empty.
 */
function readConfigLog(cwd: string): Array<Record<string, unknown>> {
  const log = path.join(cwd, ".fake-omo", "config-commands.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * A synthetic source Session in the documented JSONL shape: a header plus
 * user/assistant message pairs linked by id/parentId. Written for this suite;
 * no OmO sample or asset was copied.
 */
function syntheticDerivationSource(
  cwd: string,
  sessionId: string,
  turns: readonly string[],
): string {
  const file = path.join(cwd, "source", "session.jsonl");
  mkdirSync(path.dirname(file), { recursive: true });
  const start = Date.parse("2026-11-26T08:00:00.000Z");
  const lines: Array<Record<string, unknown>> = [
    { type: "session", version: 3, id: sessionId, timestamp: new Date(start).toISOString(), cwd },
  ];
  let parentId: string | null = null;
  for (const [index, text] of turns.entries()) {
    const userId = `u${index + 1}`;
    const assistantId = `a${index + 1}`;
    const at = start + index * 10_000;
    lines.push({
      type: "message",
      id: userId,
      parentId,
      timestamp: new Date(at).toISOString(),
      inputSource: "rpc",
      message: { role: "user", content: [{ type: "text", text }], timestamp: at },
    });
    lines.push({
      type: "message",
      id: assistantId,
      parentId: userId,
      timestamp: new Date(at + 1_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `answer ${index + 1}` }],
        stopReason: "stop",
        timestamp: at + 1_000,
      },
    });
    parentId = assistantId;
  }
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
}

function derivationRef(cwd: string, sessionFile: string, sessionId: string): NativeSessionRef {
  return {
    harnessId: "omo",
    nativeSessionId: sessionId,
    locator: { sessionPath: sessionFile, cwd },
    formatVersion: 1,
  };
}

function sessionPathOf(ref: NativeSessionRef | undefined): string {
  const locator = ref?.locator;
  if (typeof locator !== "object" || locator === null || Array.isArray(locator)) {
    throw new Error("expected a Native Session Ref locator");
  }
  const value = (locator as Record<string, unknown>).sessionPath;
  if (typeof value !== "string") throw new Error("expected a Native Session file path");
  return value;
}

function derivedSessionFiles(cwd: string): string[] {
  const directory = path.join(cwd, ".fake-omo", "derived");
  return existsSync(directory) ? readdirSync(directory) : [];
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
    expect(inspection.capabilities).toEqual(sessionCapabilities);
    // The Permission Mode catalog ships with the selection capability (the
    // schema refine enforces the pair; the catalog is frozen from the probe).
    expect(inspection.permissionModes?.modes.map((mode) => mode.id)).toEqual([
      "full-access",
      "workspace",
      "read-only",
      "ask",
      "accept-edits",
      "auto",
    ]);
    expect(inspection.permissionModes?.defaultModeId).toBe("full-access");
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
    // The Host schema-validates every inspection result, availability included,
    // so the light path must carry the frozen Permission Mode catalog that
    // `selectPermissionMode: true` promises (the same refine as the full path).
    const parsedAvailability = harnessInspectionSchema.parse(availability);
    expect(parsedAvailability.permissionModes?.modes.map((mode) => mode.id)).toEqual([
      "full-access",
      "workspace",
      "read-only",
      "ask",
      "accept-edits",
      "auto",
    ]);
    expect(parsedAvailability.permissionModes?.defaultModeId).toBe("full-access");
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
          ...sessionCapabilities,
          configuration: { ...sessionCapabilities.configuration, selectPermissionMode: true },
        },
      }),
    ).toThrow(/Permission Mode catalog/u);
    expect(() =>
      harnessInspectionSchema.parse({
        status: "ready",
        catalog,
        permissionModes,
        capabilities: {
          ...sessionCapabilities,
          configuration: { ...sessionCapabilities.configuration, selectPermissionMode: false },
        },
      }),
    ).toThrow(/Permission Mode catalog/u);
  });
});

describe("OmO Adapter open", () => {
  it("opens a create Session from native get_state and publishes confirmed state", async () => {
    const cwd = temporaryDirectory();
    const sessionFile = path.join(cwd, "sessions", "alpha.jsonl");
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({ kind: "create", cwd });
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
      effectivePermissionModeId: "ask",
    });
    // Omitted configuration sends no native command; delegation item (b)
    // depends on this create path staying silent.
    expect(readConfigLog(cwd)).toEqual([]);
    expect(session.capabilities).toEqual(sessionCapabilities);
    expect(session.initialUsage).toBeNull();
    expect(fixture.sessionSpawns).toHaveLength(1);
    expect(fixture.sessionSpawns[0]?.cwd).toBe(path.resolve(cwd));
    expect(fixture.sessionSpawns[0]?.sessionFile).toBeUndefined();

    const emptySnapshot = await session.readSnapshot();
    expect(emptySnapshot).toMatchObject({ ok: true, value: { turns: [] } });
    await expect(session.execute(turnStart())).resolves.toEqual({
      ok: true,
      value: { turnId: "turn-1" },
    });
    // The synthetic peer never settles the Turn; close terminates it and ends
    // the output stream exactly once.
    await Promise.all([session.close(), session.close()]);
    await session.close();
    const iterator = session.outputs[Symbol.asyncIterator]();
    for (;;) {
      const output = await iterator.next();
      if (output.done) break;
    }
    await expect(session.execute(turnStart())).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });

  it("applies an explicit Model at create and publishes the confirmed effective state", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      model: { id: "synthetic-provider/other-model" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    // The published state is the native post-application state, not the request.
    expect(result.value.initialState).toMatchObject({
      effectiveModel: { id: "synthetic-provider/other-model" },
      resolvedModelLabel: "Synthetic Other",
      effectiveThinkingOptionId: "medium",
    });
    expect(readConfigLog(cwd)).toEqual([
      expect.objectContaining({
        type: "set_model",
        provider: "synthetic-provider",
        modelId: "other-model",
        scope: "session",
      }),
    ]);
    await result.value.close();
  });

  it("applies an explicit Thinking option at create with turn scope", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      thinkingOptionId: "high",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    expect(result.value.initialState).toMatchObject({
      effectiveModel: { id: "synthetic-provider/synthetic-model" },
      effectiveThinkingOptionId: "high",
    });
    expect(readConfigLog(cwd)).toEqual([
      expect.objectContaining({ type: "set_thinking_level", level: "high", scope: "turn" }),
    ]);
    await result.value.close();
  });

  it("applies an explicit Model before its explicit Thinking option at create", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      model: { id: "synthetic-provider/other-model" },
      thinkingOptionId: "high",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    expect(result.value.initialState).toMatchObject({
      effectiveModel: { id: "synthetic-provider/other-model" },
      effectiveThinkingOptionId: "high",
    });
    // Ordering matters: the level is validated against the newly selected Model.
    expect(readConfigLog(cwd).map((frame) => frame.type)).toEqual([
      "set_model",
      "set_thinking_level",
    ]);
    await result.value.close();
  });

  it("rejects an explicit Model the engine does not offer without writing configuration", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      model: { id: "requested/other-model" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    expect(readConfigLog(cwd)).toEqual([]);
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("rejects a create when the engine refuses the explicit Model and publishes nothing", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd, { FAKE_OMO_SET_MODEL_ERROR: "model_not_found" });
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      model: { id: "synthetic-provider/other-model" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    expect(readConfigLog(cwd)).toHaveLength(1);
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("rejects a create when the engine never confirms the explicit Thinking option", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd, { FAKE_OMO_SET_THINKING_IGNORE: "1" });
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      thinkingOptionId: "high",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    expect(readConfigLog(cwd)).toHaveLength(1);
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
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
    // Resume-kind Sessions never remove the persisted file, with or without a
    // Turn (only create-kind prewarm Sessions clean up; task-9 fix round).
    expect(existsSync(sessionFile)).toBe(true);
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
    const fixture = sessionFixture(cwd, { FAKE_OMO_REPORTED_FILE: otherFile });
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
        permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    await expect(
      fixture.adapter.open({
        kind: "create",
        cwd,
        executionPolicy: "unattended-full-access",
        permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    expect(fixture.sessionSpawns).toHaveLength(0);
  });

  it("builds the derivation launch as --fork and refuses resume + Fork startup", () => {
    const invocation = omoRpcProcessCommand(
      {
        cwd: os.tmpdir(),
        command: "/fake/omo",
        environment: { PATH: "" },
        forkSessionFile: "/sessions/source.jsonl",
      },
      { platform: "linux", isExecutable: () => true },
    );
    expect(invocation.arguments).toEqual(["--mode", "rpc", "--fork", "/sessions/source.jsonl"]);
    expect(() =>
      omoRpcProcessCommand(
        {
          cwd: os.tmpdir(),
          command: "/fake/omo",
          environment: { PATH: "" },
          sessionFile: "/sessions/source.jsonl",
          forkSessionFile: "/sessions/source.jsonl",
        },
        { platform: "linux", isExecutable: () => true },
      ),
    ).toThrowError(/cannot combine/u);
  });

  it("starts the production --fork command and mints a distinct Session", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", ["only turn"]);
    const rpc = new OmoRpcSession({
      cwd,
      command: createOmoCommandWrapper(),
      environment: { ...process.env, FAKE_OMO_SCENARIO: "session" },
      forkSessionFile: sourceFile,
      commandTimeoutMs: 5_000,
      startupTimeoutMs: 5_000,
      closeTimeoutMs: 1_000,
    });
    try {
      await rpc.start();
      expect(rpc.state.sessionId).not.toBe("session-source");
      const argv = JSON.parse(
        readFileSync(path.join(cwd, ".fake-omo", "argv.json"), "utf8"),
      ) as string[];
      expect(argv).toEqual(["--mode", "rpc", "--fork", sourceFile]);
    } finally {
      await rpc.close();
    }
  });

  it("derives a last-Turn rollback with the exact prefix and leaves the source untouched", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", [
      "first question",
      "second question",
    ]);
    const sourceRef = derivationRef(cwd, sourceFile, "session-source");
    const before = readFileSync(sourceFile);
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a derived Session");
    const session = result.value;
    const derivedId = session.initialState.nativeRef?.nativeSessionId;
    expect(derivedId).toBeDefined();
    expect(derivedId).not.toBe("session-source");
    expect(session.initialState.nativeRef?.locator).toMatchObject({ cwd });
    // The production process boundary received --fork, never --session.
    expect(fixture.sessionSpawns[0]?.forkSessionFile).toBe(sourceFile);
    expect(fixture.sessionSpawns[0]?.sessionFile).toBeUndefined();

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error("expected a derived snapshot");
    expect(snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "turn:u1",
    ]);
    expect(snapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "first question" }]);
    expect(readForksLog(cwd).map((frame) => frame.entryId)).toEqual(["u2"]);
    // Two files exist: the startup copy and the derived prefix. The intermediate
    // is the derived Session's native parent, so both stay; the source never moves.
    expect(derivedSessionFiles(cwd)).toHaveLength(2);
    expect(existsSync(sessionPathOf(session.initialState.nativeRef))).toBe(true);
    expect(readFileSync(sourceFile)).toEqual(before);
    await session.close();
  });

  it("derives a blank resumable Session when rolling back a one-Turn source", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", ["only question"]);
    const sourceRef = derivationRef(cwd, sourceFile, "session-source");
    const before = readFileSync(sourceFile);
    // Real 5.1.83 never writes the blank fork file; the adapter must persist it.
    const fixture = sessionFixture(cwd, { FAKE_OMO_FORK_DEFER_EMPTY: "1" });
    const result = await fixture.adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd });
    if (!result.ok) throw new Error("expected a derived Session");
    const session = result.value;
    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({ ok: true, value: { turns: [] } });
    expect(readForksLog(cwd).map((frame) => frame.entryId)).toEqual(["u1"]);
    const derivedFile = sessionPathOf(session.initialState.nativeRef);
    expect(existsSync(derivedFile)).toBe(true);
    const derivedEntries = readFileSync(derivedFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type?: string });
    expect(derivedEntries.filter((entry) => entry.type === "message")).toEqual([]);
    const nativeRef = session.initialState.nativeRef;
    if (!nativeRef) throw new Error("expected a derived Native Session Ref");
    await session.close();
    // The persisted identity resumes into the same blank Session.
    const resumed = await fixture.adapter.open({ kind: "resume", nativeRef, cwd });
    if (!resumed.ok) throw new Error("expected the blank Session to resume");
    expect(resumed.value.initialState.nativeRef).toEqual(nativeRef);
    await expect(resumed.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [] },
    });
    await resumed.value.close();
    expect(readFileSync(sourceFile)).toEqual(before);
  });

  it("forks at a middle Checkpoint and ends exactly at it", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", [
      "first question",
      "second question",
      "third question",
    ]);
    const sourceRef = derivationRef(cwd, sourceFile, "session-source");
    const before = readFileSync(sourceFile);
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "fork",
      sourceRef,
      checkpoint: {
        harnessId: "omo",
        nativeSessionId: "session-source",
        checkpointId: "u2",
        formatVersion: 1,
      },
      cwd,
    });
    if (!result.ok) throw new Error("expected a forked Session");
    const session = result.value;
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error("expected a forked snapshot");
    expect(snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "turn:u1",
      "turn:u2",
    ]);
    expect(snapshot.value.turns.at(-1)?.input).toEqual([{ type: "text", text: "second question" }]);
    expect(readForksLog(cwd).map((frame) => frame.entryId)).toEqual(["u3"]);
    expect(readFileSync(sourceFile)).toEqual(before);
    await session.close();
  });

  it("forks at the branch tip from the startup copy without a second fork", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", [
      "first question",
      "second question",
    ]);
    const sourceRef = derivationRef(cwd, sourceFile, "session-source");
    const before = readFileSync(sourceFile);
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "fork",
      sourceRef,
      checkpoint: {
        harnessId: "omo",
        nativeSessionId: "session-source",
        checkpointId: "u2",
        formatVersion: 1,
      },
      cwd,
    });
    if (!result.ok) throw new Error("expected a forked Session");
    const session = result.value;
    expect(session.initialState.nativeRef?.nativeSessionId).toMatch(/^session-fork-startup-/u);
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error("expected a forked snapshot");
    expect(snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "turn:u1",
      "turn:u2",
    ]);
    expect(readForksLog(cwd)).toEqual([]);
    expect(readFileSync(sourceFile)).toEqual(before);
    await session.close();
  });

  it("rejects an unknown Checkpoint and removes the startup copy", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", ["first question"]);
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "fork",
      sourceRef: derivationRef(cwd, sourceFile, "session-source"),
      checkpoint: {
        harnessId: "omo",
        nativeSessionId: "session-source",
        checkpointId: "missing",
        formatVersion: 1,
      },
      cwd,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "checkpointNotFound", retryable: false },
    });
    expect(derivedSessionFiles(cwd)).toEqual([]);
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("rejects a startup copy that kept the source identity and cleans it up", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", ["first question"]);
    const fixture = sessionFixture(cwd, { FAKE_OMO_FORK_STARTUP_ID: "session-source" });
    const result = await fixture.adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: derivationRef(cwd, sourceFile, "session-source"),
      cwd,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "protocolError", retryable: false },
    });
    expect(derivedSessionFiles(cwd)).toEqual([]);
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("rejects a cancelled fork instead of keeping the startup copy", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", [
      "first question",
      "second question",
    ]);
    const fixture = sessionFixture(cwd, { FAKE_OMO_FORK_CANCELLED: "1" });
    const result = await fixture.adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: derivationRef(cwd, sourceFile, "session-source"),
      cwd,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    expect(derivedSessionFiles(cwd)).toEqual([]);
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("restores current Model, Thinking, and Permission hints on a rollback", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", [
      "first question",
      "second question",
    ]);
    const before = readFileSync(sourceFile);
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: derivationRef(cwd, sourceFile, "session-source"),
      cwd,
      model: { id: "synthetic-provider/other-model" },
      thinkingOptionId: "high",
      permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
    });
    if (!result.ok) throw new Error("expected a derived Session");
    expect(result.value.initialState).toMatchObject({
      effectiveModel: { id: "synthetic-provider/other-model" },
      effectiveThinkingOptionId: "high",
      effectivePermissionModeId: "read-only",
    });
    const snapshot = await result.value.readSnapshot();
    if (!snapshot.ok) throw new Error("expected a derived snapshot");
    expect(snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "turn:u1",
    ]);
    expect(readPresetsLog(cwd).map((frame) => frame.permissionPreset)).toEqual(["read-only"]);
    expect(readFileSync(sourceFile)).toEqual(before);
    await result.value.close();
  });

  it("writes independently after a fork without touching the source", async () => {
    const cwd = temporaryDirectory();
    const sourceFile = syntheticDerivationSource(cwd, "session-source", [
      "first question",
      "second question",
    ]);
    const before = readFileSync(sourceFile);
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "fork",
      sourceRef: derivationRef(cwd, sourceFile, "session-source"),
      checkpoint: {
        harnessId: "omo",
        nativeSessionId: "session-source",
        checkpointId: "u1",
        formatVersion: 1,
      },
      cwd,
    });
    if (!result.ok) throw new Error("expected a forked Session");
    const derivedFile = sessionPathOf(result.value.initialState.nativeRef);
    const derivedBefore = readFileSync(derivedFile);
    await expect(
      result.value.execute({
        type: "model.select",
        model: { id: "synthetic-provider/other-model" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(readFileSync(derivedFile)).not.toEqual(derivedBefore);
    expect(readFileSync(sourceFile)).toEqual(before);
    await result.value.close();
  });

  it("rejects malformed derivation inputs before spawning anything", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const withoutLocator = {
      harnessId: "omo",
      nativeSessionId: "session-source",
      formatVersion: 1,
    } as NativeSessionRef;
    await expect(
      fixture.adapter.open({ kind: "rollbackLastTurn", sourceRef: withoutLocator, cwd }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      fixture.adapter.open({
        kind: "fork",
        sourceRef: {
          harnessId: "omo",
          nativeSessionId: "session-source",
          locator: { sessionPath: path.join(cwd, "source.jsonl"), cwd },
          formatVersion: 1,
        },
        checkpoint: {
          harnessId: "omo",
          nativeSessionId: "another-session",
          checkpointId: "u1",
          formatVersion: 1,
        },
        cwd,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(fixture.sessionSpawns).toHaveLength(0);
  });

  it("reports a typed failure when the source Session file cannot be read", async () => {
    const cwd = temporaryDirectory();
    const missingSource = path.join(cwd, "source", "missing.jsonl");
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: derivationRef(cwd, missingSource, "session-source"),
      cwd,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "processExited", retryable: true },
    });
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("applies unattended full access at create and confirms it applied", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      executionPolicy: "unattended-full-access",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    expect(result.value.initialState.effectivePermissionModeId).toBe("full-access");
    const presets = readPresetsLog(cwd);
    expect(presets).toHaveLength(1);
    expect(presets[0]?.permissionPreset).toBe("full-access");
    expect(presets[0]?.effectId).toBeUndefined();
    await result.value.close();
  });

  it("applies an explicit Permission Mode at create after the conflict checks", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd);
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    expect(result.value.initialState.effectivePermissionModeId).toBe("read-only");
    expect(readPresetsLog(cwd).map((frame) => frame.permissionPreset)).toEqual(["read-only"]);
    await result.value.close();
  });

  it("rejects an unattended create when the engine refuses the preset and closes the process", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd, {
      FAKE_OMO_SET_PERMISSION_ERROR: "invalid_launch_profile",
    });
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      executionPolicy: "unattended-full-access",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("rejects an unattended create whose applied confirmation never lands", async () => {
    const cwd = temporaryDirectory();
    const fixture = sessionFixture(cwd, { FAKE_OMO_SET_PERMISSION_CONFIRM: "false" });
    const result = await fixture.adapter.open({
      kind: "create",
      cwd,
      executionPolicy: "unattended-full-access",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    const pid = fixture.sessionChildren[0]?.pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("never resurrects resume configuration hints over native state", async () => {
    const cwd = temporaryDirectory();
    const sessionFile = path.join(cwd, "sessions", "alpha.jsonl");
    const fixture = sessionFixture(cwd);
    const nativeRef: NativeSessionRef = {
      harnessId: "omo",
      nativeSessionId: "session-alpha",
      locator: { sessionPath: sessionFile, cwd: path.resolve(cwd) },
      formatVersion: 1,
    };
    const result = await fixture.adapter.open({
      kind: "resume",
      nativeRef,
      cwd,
      // Persisted hints, not commands: the Session file already restored the
      // native state, and only that state may be published.
      model: { id: "requested/other-model" },
      thinkingOptionId: "high",
      permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an open Session");
    expect(result.value.initialState).toMatchObject({
      effectiveModel: { id: "synthetic-provider/synthetic-model" },
      effectiveThinkingOptionId: "medium",
      effectivePermissionModeId: "ask",
    });
    // No preset or Model/Thinking frame was sent for the hint: resume only
    // restores native state, it never replays the persisted configuration.
    expect(readPresetsLog(cwd)).toEqual([]);
    expect(readConfigLog(cwd)).toEqual([]);
    await result.value.close();
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
