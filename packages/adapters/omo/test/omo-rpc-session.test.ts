import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OmoProtocolError } from "../src/omo-protocol.js";
import {
  OmoRpcClosedError,
  OmoRpcCommandTimeoutError,
  OmoRpcFaultError,
  OmoRpcResponseError,
  OmoRpcSession,
  omoRpcProcessCommand,
  type OmoRpcEventFrame,
  type OmoRpcProcessAdapter,
} from "../src/omo-rpc-session.js";
import { isWindowsUncDirectory } from "../src/omo-unc-launch.js";

const fixture = path.join(import.meta.dirname, "fixtures", "fake-omo.mjs");
const roots: string[] = [];
const sessions: OmoRpcSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close().catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "omo-rpc-test-"));
  roots.push(directory);
  return directory;
}

/** Bounds a wait so a hung transport fails the test instead of the suite. */
function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface SessionHandle {
  readonly rpc: OmoRpcSession;
  readonly faults: OmoRpcFaultError[];
  child(): ChildProcessWithoutNullStreams;
  nextFault(timeoutMs?: number): Promise<OmoRpcFaultError>;
}

/**
 * Spawns the synthetic peer through the process boundary the session exposes.
 * The peer is a real OS process, so shutdown and PID receipts are real too.
 */
function createSession(
  scenario: string,
  options: {
    commandTimeoutMs?: number;
    startupTimeoutMs?: number;
    closeTimeoutMs?: number;
    environment?: NodeJS.ProcessEnv;
  } = {},
): SessionHandle {
  let child: ChildProcessWithoutNullStreams | null = null;
  const adapter: OmoRpcProcessAdapter = {
    spawn(spawnOptions) {
      child = spawn(process.execPath, [fixture], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.environment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      return child;
    },
  };
  const faults: OmoRpcFaultError[] = [];
  const waiters: ((fault: OmoRpcFaultError) => void)[] = [];
  const rpc = new OmoRpcSession(
    {
      cwd: temporaryDirectory(),
      environment: { FAKE_OMO_SCENARIO: scenario, ...options.environment },
      commandTimeoutMs: options.commandTimeoutMs ?? 2_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
      closeTimeoutMs: options.closeTimeoutMs ?? 500,
      onFault: (fault) => {
        faults.push(fault);
        for (const waiter of waiters.splice(0)) waiter(fault);
      },
    },
    adapter,
  );
  sessions.push(rpc);
  return {
    rpc,
    faults,
    child() {
      if (!child) throw new Error("the fake process has not spawned");
      return child;
    },
    nextFault(timeoutMs = 5_000) {
      const observed = faults[0];
      if (observed) return Promise.resolve(observed);
      return bounded(new Promise((resolve) => waiters.push(resolve)), timeoutMs, "fault");
    },
  };
}

function nextEvent(
  iterator: AsyncIterableIterator<OmoRpcEventFrame>,
  timeoutMs = 2_000,
): Promise<OmoRpcEventFrame> {
  return bounded(
    iterator.next().then((result) => {
      if (result.done) throw new Error("the event iterator ended before the expected event");
      return result.value;
    }),
    timeoutMs,
    "event",
  );
}

async function expectIteratorDone(
  iterator: AsyncIterableIterator<OmoRpcEventFrame>,
  timeoutMs = 2_000,
): Promise<void> {
  await bounded(
    iterator.next().then((result) => {
      expect(result.done).toBe(true);
    }),
    timeoutMs,
    "event iterator termination",
  );
}

function requirePid(child: ChildProcessWithoutNullStreams): number {
  if (child.pid === undefined) throw new Error("the fake process has no PID");
  return child.pid;
}

/** Proves the OS no longer owns the PID; the ESRCH receipt is returned. */
async function expectProcessGone(pid: number): Promise<NodeJS.ErrnoException> {
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
  const observed = receipt as NodeJS.ErrnoException;
  console.log(`[t5] process.exit receipt pid=${pid} code=${observed.code ?? "missing"}`);
  return observed;
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("OmO RPC startup", () => {
  it("declares interactive_user, parses state, and applies the transport environment", async () => {
    const handle = createSession("normal", {
      environment: { CODEXHOST_TEST_MARKER: "kept", PI_TELEMETRY: "1" },
    });
    await handle.rpc.start();

    expect(handle.rpc.state).toMatchObject({
      sessionId: "synthetic-session-id",
      sessionFile: "/synthetic/agent/sessions/project/synthetic-session.jsonl",
      model: { provider: "synthetic-provider", id: "synthetic-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      currentTurnId: null,
      permissionPreset: "ask",
      effectivePermissionPreset: "ask",
      messageCount: 0,
    });
    expect(handle.rpc.state.pendingDialogs).toEqual([
      { id: "synthetic-dialog", method: "confirm", title: "Synthetic" },
    ]);

    const clientInfo = await handle.rpc.send("probe.client_info");
    expect(clientInfo.data).toMatchObject({ capabilities: ["interactive_user"], width: 80 });
    const capabilities = (clientInfo.data as { capabilities: string[] }).capabilities;
    expect(capabilities).not.toContain("question");
    expect(capabilities).not.toContain("secret_input_v1");

    const environment = await handle.rpc.send("probe.environment");
    expect(environment.data).toEqual({
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      CODEXHOST_TEST_MARKER: "kept",
    });
  });

  it("keeps a sanitized stderr tail for fault diagnostics", async () => {
    const handle = createSession("normal");
    await handle.rpc.start();
    await handle.rpc.send("stderr");
    await vi.waitFor(
      () => {
        expect(handle.rpc.stderrTail).toContain("api_key=[redacted]");
      },
      { timeout: 2_000, interval: 20 },
    );
    expect(handle.rpc.stderrTail).not.toContain("sk-synthetic-secret");
  });
});

describe("OmO RPC event sink", () => {
  it("drops startup chatter while real and unknown events keep wire order", async () => {
    const handle = createSession("normal");
    await handle.rpc.start();
    const events = handle.rpc.events();

    expect(await nextEvent(events)).toEqual({ type: "turn_start" });
    expect(await nextEvent(events)).toEqual({
      type: "future.additive.event",
      payload: { ok: true },
    });
    expect(await nextEvent(events)).toEqual({
      type: "entry_appended",
      entry: { id: "entry-1", type: "custom", customType: "synthetic.kept" },
    });

    // Chatter emitted after startup is filtered by frame shape, not just by timing.
    await handle.rpc.send("chatter-after");
    expect(await nextEvent(events)).toEqual({ type: "test.sentinel" });
  });
});

describe("OmO RPC command correlation", () => {
  it("times out one command, ignores its late answer, and keeps serving", async () => {
    const handle = createSession("withhold-slow", { commandTimeoutMs: 100 });
    await handle.rpc.start();

    const timedOut = await handle.rpc
      .send("slow", {}, { timeoutMs: 100 })
      .catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(OmoRpcCommandTimeoutError);
    expect(timedOut).toMatchObject({ command: "slow", timeoutMs: 100 });
    expect(handle.rpc.fault).toBeNull();

    // The flush answer follows the late answer for the abandoned id, so stream
    // order proves the late answer was consumed before this resolves.
    await handle.rpc.send("flush");
    expect(handle.rpc.fault).toBeNull();
    const after = await handle.rpc.send("probe.environment");
    expect(after.data).toMatchObject({ PI_TELEMETRY: "0" });
    expect(handle.faults).toEqual([]);

    const refused = await handle.rpc.send("refuse").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OmoRpcResponseError);
    expect(refused).toMatchObject({
      command: "refuse",
      errorCode: "streaming",
      category: "busy",
      message: "synthetic refusal",
    });
    expect(handle.rpc.fault).toBeNull();
  });
});

describe("OmO RPC fault paths", () => {
  it("faults on an unexpected exit, rejects the pending command, and ends the sink", async () => {
    const handle = createSession("exit-mid", { commandTimeoutMs: 10_000 });
    await handle.rpc.start();
    const events = handle.rpc.events();
    const fault = handle.nextFault();
    const pending = handle.rpc.send("prompt", { message: "hello" });

    const observed = await fault;
    expect(observed).toMatchObject({ kind: "processExited" });
    await expect(pending).rejects.toBe(observed);
    await expectIteratorDone(events);
    expect(handle.rpc.fault).toBe(observed);
    await expectProcessGone(requirePid(handle.child()));
  });

  it("classifies a spawn ENOENT as notInstalled", async () => {
    const missing = path.join(temporaryDirectory(), "missing-omo");
    const adapter: OmoRpcProcessAdapter = {
      spawn(spawnOptions) {
        return spawn(missing, ["--mode", "rpc"], {
          cwd: spawnOptions.cwd,
          env: spawnOptions.environment,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    };
    const faults: OmoRpcFaultError[] = [];
    const rpc = new OmoRpcSession(
      {
        cwd: temporaryDirectory(),
        startupTimeoutMs: 2_000,
        closeTimeoutMs: 200,
        onFault: (fault) => faults.push(fault),
      },
      adapter,
    );
    sessions.push(rpc);

    const error = await rpc.start().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OmoRpcFaultError);
    expect(error).toMatchObject({ kind: "notInstalled" });
    expect(rpc.fault).toBe(error);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBe(error);
    await expect(rpc.close()).resolves.toBeUndefined();
  });

  it("closes admission when the launch itself throws", async () => {
    const rpc = new OmoRpcSession(
      { cwd: temporaryDirectory(), closeTimeoutMs: 200 },
      {
        spawn() {
          throw new OmoRpcFaultError("notInstalled", "synthetic missing CLI");
        },
      },
    );
    sessions.push(rpc);
    const error = await rpc.start().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OmoRpcFaultError);
    expect(error).toMatchObject({ kind: "notInstalled" });
    expect(rpc.fault).toBe(error);
    await expect(rpc.close()).resolves.toBeUndefined();
  });

  it("bounds a silent startup and reclaims the process", async () => {
    const handle = createSession("silent-start", {
      startupTimeoutMs: 300,
      closeTimeoutMs: 300,
    });
    const startedAtMs = Date.now();
    const error = await handle.rpc.start().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(OmoRpcFaultError);
    expect(error).toMatchObject({ kind: "unavailable" });
    expect((error as Error).message).toContain("timed out");
    expect(Date.now() - startedAtMs).toBeLessThan(5_000);
    expect(handle.rpc.fault).toBe(error);
    expect(handle.faults).toEqual([error]);
    await expectProcessGone(requirePid(handle.child()));
  });

  it.each([
    ["garbage", "invalid_json"],
    ["oversize", "frame_too_large"],
  ] as const)("faults on %s with a typed framer error", async (command, kind) => {
    const handle = createSession("normal", { commandTimeoutMs: 10_000 });
    await handle.rpc.start();
    const events = handle.rpc.events();
    const fault = handle.nextFault(10_000);
    const pending = handle.rpc.send(command);

    const observed = await fault;
    expect(observed.kind).toBe("protocolError");
    expect(observed.cause).toBeInstanceOf(OmoProtocolError);
    expect((observed.cause as OmoProtocolError).kind).toBe(kind);
    await expect(pending).rejects.toBe(observed);
    await expectIteratorDone(events);
    await expectProcessGone(requirePid(handle.child()));
  });
});

describe("OmO RPC close", () => {
  it("closes idempotently, ends the sink, and proves process exit", async () => {
    const handle = createSession("normal");
    await handle.rpc.start();
    const events = handle.rpc.events();
    const pid = requirePid(handle.child());

    const first = handle.rpc.close();
    const second = handle.rpc.close();
    expect(second).toBe(first);
    await first;

    const receipt = await expectProcessGone(pid);
    expect(receipt.code).toBe("ESRCH");
    await expectIteratorDone(events);
    expect(handle.rpc.fault).toBeNull();
    await expect(handle.rpc.send("probe.client_info")).rejects.toBeInstanceOf(OmoRpcClosedError);
    await expect(handle.rpc.close()).resolves.toBeUndefined();
  });

  it("closes mid-command and escalates for a child that ignores EOF and SIGTERM", async () => {
    const handle = createSession("stubborn", { closeTimeoutMs: 200 });
    await handle.rpc.start();
    const events = handle.rpc.events();
    const pid = requirePid(handle.child());

    const inFlight = handle.rpc.send("hold", {}, { timeoutMs: 10_000 }).catch((error) => error);
    const closeStartedAtMs = Date.now();
    await handle.rpc.close();
    expect(Date.now() - closeStartedAtMs).toBeLessThan(5_000);

    expect(await inFlight).toBeInstanceOf(OmoRpcClosedError);
    await expectProcessGone(pid);
    await expectIteratorDone(events);
    expect(handle.rpc.fault).toBeNull();
  });
});

describe("OmO RPC process invocation", () => {
  const windows = { platform: "win32" as const };

  function npmShim(target: string, pathExtFix = false): string {
    return `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
${pathExtFix ? "" : "  SET PATHEXT=%PATHEXT:;.JS;=;%\n"})

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${pathExtFix ? "set PATHEXT=%PATHEXT:;.JS;=;% & " : ""}"%_prog%"  "%dp0%\\${target}" %*`;
  }

  function npmInstallation(): { shim: string; entry: string; node: string } {
    const directory = temporaryDirectory();
    const packageDirectory = path.join(directory, "node_modules", "omo-ai");
    const entry = path.join(packageDirectory, "dist", "cli.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "process.exit(0);\n");
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ name: "omo-ai", bin: { omo: "dist/cli.js" } }),
    );
    const shim = path.join(directory, "omo.cmd");
    writeFileSync(shim, npmShim("node_modules\\omo-ai\\dist\\cli.js"), { mode: 0o755 });
    const node = path.join(directory, "node-tools", "node.exe");
    mkdirSync(path.dirname(node), { recursive: true });
    writeFileSync(node, "");
    return { shim, entry, node };
  }

  it("spawns a native omo.exe directly", () => {
    const invocation = omoRpcProcessCommand(
      { cwd: "C:\\work", command: "C:\\tools\\omo.exe", environment: {} },
      { ...windows, isExecutable: () => true },
    );
    expect(invocation).toEqual({
      command: "C:\\tools\\omo.exe",
      arguments: ["--mode", "rpc"],
      windowsVerbatimArguments: false,
    });
  });

  it("passes a resume session file as --session", () => {
    const invocation = omoRpcProcessCommand(
      {
        cwd: "C:\\work",
        command: "C:\\tools\\omo.exe",
        environment: {},
        sessionFile: "C:\\sessions\\resumed.jsonl",
      },
      { ...windows, isExecutable: () => true },
    );
    expect(invocation.arguments).toEqual([
      "--mode",
      "rpc",
      "--session",
      "C:\\sessions\\resumed.jsonl",
    ]);
  });

  it("wraps an npm .cmd shim in cmd.exe outside a UNC directory", () => {
    const invocation = omoRpcProcessCommand(
      {
        cwd: "C:\\work",
        command: "C:\\npm\\omo.cmd",
        environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      },
      { ...windows, isExecutable: () => true },
    );
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.arguments.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("classifies UNC working directories", () => {
    expect(isWindowsUncDirectory(String.raw`\\wsl.localhost\Ubuntu\home\dev\project`)).toBe(true);
    expect(isWindowsUncDirectory("C:\\work")).toBe(false);
  });

  it("does not wrap a native executable for a UNC working directory", () => {
    const invocation = omoRpcProcessCommand(
      { cwd: String.raw`\\server\share\project`, command: "C:\\tools\\omo.exe", environment: {} },
      { ...windows, isExecutable: () => true },
    );
    expect(invocation).toEqual({
      command: "C:\\tools\\omo.exe",
      arguments: ["--mode", "rpc"],
      windowsVerbatimArguments: false,
    });
  });

  it("bypasses a recognised npm omo-ai shim in a UNC working directory", () => {
    const installation = npmInstallation();
    const invocation = omoRpcProcessCommand(
      {
        cwd: String.raw`\\server\share\project`,
        command: installation.shim,
        environment: { PATH: path.dirname(installation.node) },
      },
      windows,
    );
    expect(invocation).toEqual({
      command: installation.node,
      arguments: [installation.entry, "--mode", "rpc"],
      windowsVerbatimArguments: false,
    });
  });

  it("refuses an unrecognised batch launcher in a UNC working directory", () => {
    const directory = temporaryDirectory();
    const shim = path.join(directory, "omo.cmd");
    writeFileSync(shim, "@ECHO off\r\ncustom launcher\r\n", { mode: 0o755 });
    const error = captureError(() =>
      omoRpcProcessCommand(
        { cwd: String.raw`\\server\share\project`, command: shim, environment: {} },
        windows,
      ),
    );
    expect(error).toBeInstanceOf(OmoRpcFaultError);
    expect(error).toMatchObject({ kind: "unavailable" });
    expect((error as Error).message).toContain("UNC working directory");
  });

  it("reports a missing executable as notInstalled", () => {
    const error = captureError(() =>
      omoRpcProcessCommand(
        { cwd: "C:\\work", command: "C:\\missing\\omo.exe", environment: {} },
        { ...windows, isExecutable: () => false },
      ),
    );
    expect(error).toBeInstanceOf(OmoRpcFaultError);
    expect(error).toMatchObject({ kind: "notInstalled" });
  });
});
