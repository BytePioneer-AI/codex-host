import { type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyDeepSeekVersionOutput,
  probeDeepSeekExecutableGeneration,
  type DeepSeekGenerationProbeError,
  type DeepSeekGenerationProbeDependencies,
} from "../src/generation-selector.js";
import { deepSeekProcessInvocation } from "../src/executable.js";

const temporaryDirectories: string[] = [];
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

function executable(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-dsh-version-"));
  temporaryDirectories.push(directory);
  const target = path.join(directory, "dsh.exe");
  writeFileSync(target, "fixture");
  chmodSync(target, 0o755);
  return target;
}

interface FakeChild extends ChildProcess {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
}

function childProcess(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  return child;
}

function close(
  child: ChildProcess,
  code: number | null,
  signal: NodeJS.Signals | null = null,
): void {
  Object.assign(child, { exitCode: code, signalCode: signal });
  child.emit("close", code, signal);
}

function dependencies(
  child: ChildProcess,
  overrides: Partial<DeepSeekGenerationProbeDependencies> = {},
): DeepSeekGenerationProbeDependencies {
  return {
    spawn: vi.fn(() => child),
    terminateProcessTree: vi.fn(() => {
      queueMicrotask(() => close(child, null, "SIGKILL"));
    }),
    ...overrides,
  };
}

function errorCode(code: DeepSeekGenerationProbeError["code"]): {
  code: DeepSeekGenerationProbeError["code"];
} {
  return { code };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DeepSeek executable generation probe", () => {
  it.each([
    ["0.1.2-rc.1", "modern", "0.1.2-rc.1"],
    ["0.1.5-rc.1", "modern", "0.1.5-rc.1"],
    ["0.1.5-rc.2", "modern", "0.1.5-rc.2"],
    ["0.1.5-rc.1\n", "modern", "0.1.5-rc.1"],
    ["0.1.5-rc.1\r\n", "modern", "0.1.5-rc.1"],
    ["0.1.5-rc.2\n", "modern", "0.1.5-rc.2"],
    ["0.1.5-rc.2\r\n", "modern", "0.1.5-rc.2"],
    ["0.1.2-rc.1\n", "modern", "0.1.2-rc.1"],
    ["0.1.2-rc.1\r\n", "modern", "0.1.2-rc.1"],
  ] as const)("classifies the exact supported output %j", (output, generation, version) => {
    expect(classifyDeepSeekVersionOutput(output)).toEqual({ generation, version });
  });

  it.each(["", " 0.1.2-rc.1", "v0.1.2-rc.1", "0.1.2-rc.1\n\n", "version\n"])(
    "rejects non-canonical or multi-line output %j",
    (output) => {
      expect(() => classifyDeepSeekVersionOutput(output)).toThrowError(
        expect.objectContaining(errorCode("protocolError")),
      );
    },
  );

  it.each([
    "0.1.0-rc.7",
    "0.1.1-rc.1",
    "0.1.1-rc.2",
    "0.1.5-alpha.1",
    "0.1.5-rc.3",
    "0.1.5",
    "0.1.6-rc.1",
    "0.1.5-rc.1+build.1",
    "0.1.5-rc.2+build.1",
    "0.1.2-alpha.1",
    "0.1.2-alpha.2",
    "0.1.2-alpha.3",
    "0.1.2-alpha.4",
    "0.1.2-alpha.5",
    "0.1.2-alpha.6",
    "0.1.2-alpha.99",
    "0.1.2-rc.2",
    "0.1.2-rc.99",
    "0.1.2",
    "0.1.3",
    "0.1.2-alpha.4+build.1",
    "0.1.2-alpha.5+build.1",
    "0.1.2-rc.1+build.1",
  ])("rejects recognized but unsupported version %s without retry", (output) => {
    try {
      classifyDeepSeekVersionOutput(output);
      throw new Error("expected unsupported version to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "unsupported", retryable: false });
      expect((error as Error).message).toContain(
        "仅支持 dsh-v0.1.2-rc.1、dsh-v0.1.5-rc.1 和 dsh-v0.1.5-rc.2",
      );
      expect((error as Error).message).toContain(
        "only supports dsh-v0.1.2-rc.1, dsh-v0.1.5-rc.1 and dsh-v0.1.5-rc.2",
      );
      expect((error as Error).message).toContain("推荐安装 dsh-v0.1.5-rc.2");
      expect((error as Error).message).toContain("dsh-v0.1.5-rc.2 is recommended");
    }
  });

  it("runs the resolved executable with an argument array and returns its generation", async () => {
    const command = executable();
    const child = childProcess();
    const probeDependencies = dependencies(child);
    const environment = { PATH: "fixture-path", TEST_MARKER: "yes" };
    const pending = probeDeepSeekExecutableGeneration({ command, environment }, probeDependencies);
    child.stdout.emit("data", Buffer.from("0.1.2-rc.1\n"));
    close(child, 0);

    await expect(pending).resolves.toEqual({
      generation: "modern",
      version: "0.1.2-rc.1",
      command: { command, arguments: [], kind: "configured" },
    });
    expect(probeDependencies.spawn).toHaveBeenCalledWith(command, ["--version"], {
      env: environment,
      detached: process.platform !== "win32",
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: false,
    });
  });

  it("classifies missing commands and spawn ENOENT as not installed", async () => {
    await expect(
      probeDeepSeekExecutableGeneration({ command: path.join(os.tmpdir(), "missing-dsh") }),
    ).rejects.toMatchObject(errorCode("notInstalled"));

    const child = childProcess();
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable() },
      dependencies(child),
    );
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    child.emit("error", error);
    await expect(pending).rejects.toMatchObject(errorCode("notInstalled"));
  });

  it("maps a nonzero version process to a retryable process exit", async () => {
    const child = childProcess();
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable() },
      dependencies(child),
    );
    close(child, 7);
    await expect(pending).rejects.toMatchObject({ code: "processExited", retryable: true });
  });

  it("rejects successful probes that write stderr", async () => {
    const child = childProcess();
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable() },
      dependencies(child),
    );
    child.stdout.emit("data", "0.1.1-rc.2\n");
    child.stderr.emit("data", "API_KEY=secret-canary unexpected warning\n");
    close(child, 0);
    await expect(pending).rejects.toMatchObject({
      code: "protocolError",
      stderrTail: "API_KEY=[redacted] unexpected warning\n",
    });
  });

  it("accepts version probes whose only stderr is ambient Node warnings", async () => {
    const child = childProcess();
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable() },
      dependencies(child),
    );
    child.stdout.emit("data", "0.1.2-rc.1\n");
    // Two separate data chunks, exactly how Node's undici emits them.
    child.stderr.emit(
      "data",
      "(node:34177) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n",
    );
    child.stderr.emit(
      "data",
      "(Use `node --trace-warnings ...` to show where the warning was created)\n",
    );
    close(child, 0);
    await expect(pending).resolves.toMatchObject({
      generation: "modern",
      version: "0.1.2-rc.1",
    });
  });

  it("still rejects when real stderr accompanies ambient Node warnings", async () => {
    const child = childProcess();
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable() },
      dependencies(child),
    );
    child.stdout.emit("data", "0.1.1-rc.2\n");
    child.stderr.emit(
      "data",
      "(node:34177) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n",
    );
    child.stderr.emit(
      "data",
      "(Use `node --trace-warnings ...` to show where the warning was created)\n",
    );
    child.stderr.emit("data", "EADDRINUSE port 3080 is taken\n");
    close(child, 0);
    await expect(pending).rejects.toMatchObject({
      code: "protocolError",
      stderrTail: "EADDRINUSE port 3080 is taken\n",
    });
  });

  it("bounds both output streams and terminates an overflowing probe", async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const child = childProcess();
      const probeDependencies = dependencies(child);
      const pending = probeDeepSeekExecutableGeneration(
        { command: executable(), outputLimitBytes: 8 },
        probeDependencies,
      );
      child[stream].emit("data", "123456789");
      await expect(pending).rejects.toMatchObject(errorCode("protocolError"));
      expect(probeDependencies.terminateProcessTree).toHaveBeenCalledOnce();
    }
  });

  it("retains and redacts the tail of one oversized stderr chunk", async () => {
    const child = childProcess();
    const probeDependencies = dependencies(child);
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable(), outputLimitBytes: 64 },
      probeDependencies,
    );
    child.stderr.emit("data", `${"discarded ".repeat(100)}API_KEY=secret-canary diagnostic-tail`);

    await expect(pending).rejects.toMatchObject({
      code: "protocolError",
      stderrTail: expect.stringContaining("API_KEY=[redacted] diagnostic-tail"),
    });
    await expect(pending).rejects.not.toMatchObject({
      stderrTail: expect.stringContaining("secret-canary"),
    });
    expect(probeDependencies.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it("supports caller cancellation and a bounded timeout", async () => {
    const cancelledChild = childProcess();
    const controller = new AbortController();
    const cancelledDependencies = dependencies(cancelledChild);
    const cancelled = probeDeepSeekExecutableGeneration(
      { command: executable(), signal: controller.signal },
      cancelledDependencies,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject(errorCode("cancelled"));
    expect(cancelledDependencies.terminateProcessTree).toHaveBeenCalledOnce();

    const timedOutChild = childProcess();
    const timedOutDependencies = dependencies(timedOutChild);
    const timedOut = probeDeepSeekExecutableGeneration(
      { command: executable(), timeoutMs: 10 },
      timedOutDependencies,
    );
    await expect(timedOut).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect(timedOutDependencies.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it("accepts the Node timer limit and rejects limit plus one before spawn", async () => {
    const child = childProcess();
    const probeDependencies = dependencies(child);
    const pending = probeDeepSeekExecutableGeneration(
      {
        command: executable(),
        timeoutMs: MAX_TIMER_MILLISECONDS,
        cleanupTimeoutMs: MAX_TIMER_MILLISECONDS,
      },
      probeDependencies,
    );
    child.stdout.emit("data", "0.1.5-rc.1\n");
    close(child, 0);
    await expect(pending).resolves.toMatchObject({ generation: "modern", version: "0.1.5-rc.1" });

    for (const option of ["timeoutMs", "cleanupTimeoutMs"] as const) {
      const rejectedDependencies = dependencies(childProcess());
      await expect(
        probeDeepSeekExecutableGeneration(
          { command: executable(), [option]: MAX_TIMER_MILLISECONDS + 1 },
          rejectedDependencies,
        ),
      ).rejects.toThrow(`${option} must be a positive safe integer`);
      expect(rejectedDependencies.spawn).not.toHaveBeenCalled();
    }
  });

  it("waits for delayed process close before rejecting cancellation", async () => {
    const child = childProcess();
    const terminateProcessTree = vi.fn(() => undefined);
    const controller = new AbortController();
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable(), signal: controller.signal, cleanupTimeoutMs: 100 },
      dependencies(child, { terminateProcessTree }),
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    close(child, null, "SIGKILL");
    await expect(pending).rejects.toMatchObject(errorCode("cancelled"));
  });

  it("reports bounded cleanup failure when the process never closes", async () => {
    const child = childProcess();
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable(), outputLimitBytes: 8, cleanupTimeoutMs: 10 },
      dependencies(child, {
        terminateProcessTree: vi.fn(() => undefined),
      }),
    );
    child.stdout.emit("data", "123456789");
    await expect(pending).rejects.toMatchObject({
      code: "processExited",
      retryable: false,
      cleanupFailed: true,
      cause: expect.any(AggregateError),
    });
  });

  it("contains process-tree termination errors during cleanup", async () => {
    const child = childProcess();
    const terminateProcessTree = vi.fn(() => {
      queueMicrotask(() => close(child, null, "SIGKILL"));
      throw new Error("kill failed");
    });
    const controller = new AbortController();
    const pending = probeDeepSeekExecutableGeneration(
      { command: executable(), signal: controller.signal },
      dependencies(child, { terminateProcessTree }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "processExited",
      retryable: false,
      cleanupFailed: true,
      cause: expect.any(AggregateError),
    });
  });

  it("cleans up a spawned process whose stdout pipe is unavailable", async () => {
    const child = childProcess();
    Object.assign(child, { stdout: null });
    const probeDependencies = dependencies(child);
    await expect(
      probeDeepSeekExecutableGeneration(
        { command: executable(), cleanupTimeoutMs: 100 },
        probeDependencies,
      ),
    ).rejects.toMatchObject(errorCode("protocolError"));
    expect(probeDependencies.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it("normalizes the selector's raw .cmd command again for full Modern Web startup", () => {
    const webArguments = ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"];
    expect(
      deepSeekProcessInvocation(
        String.raw`C:\Program Files\Deep%Seek\dsh.cmd`,
        webArguments,
        { ComSpec: String.raw`C:\Windows\System32\cmd.exe` },
        "win32",
      ),
    ).toEqual({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      arguments: [
        "/d",
        "/v:off",
        "/s",
        "/c",
        String.raw`""C:\Program Files\Deep%%Seek\dsh.cmd" "web" "--no-open" "--host" "127.0.0.1" "--port" "0""`,
      ],
      windowsVerbatimArguments: true,
    });
  });
});
