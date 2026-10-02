import { EventEmitter } from "node:events";
import type * as HermesRuntime from "../src/hermes-runtime.js";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const processMocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
const runtimeMocks = vi.hoisted(() => ({ native: vi.fn(), command: vi.fn() }));
vi.mock("../src/hermes-runtime.js", async (original) => ({
  ...(await original<typeof HermesRuntime>()),
  nativeHermesPythonCommand: runtimeMocks.native,
  hermesPythonCommand: runtimeMocks.command,
}));
vi.mock("node:child_process", () => ({ ...processMocks, execFile: vi.fn() }));
import { HermesGatewayTransport } from "../src/gateway-transport.js";

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 678901,
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
  processMocks.spawn.mockReturnValue(child);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  const transport = new HermesGatewayTransport("/verified/python", process.cwd(), {}, 50);
  const frame = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  return { child, transport, kill, frame };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("Hermes gateway runtime selection", () => {
  function respondingProcess(exclusive: boolean) {
    processMocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
      });
      child.stdin.on("finish", () => child.emit("close", 0));
      queueMicrotask(() =>
        child.stdout.write(
          JSON.stringify({
            id: "codexhost-1",
            result: { per_session_exclusive_submit: exclusive },
          }) + "\n",
        ),
      );
      return child;
    });
  }
  it("uses the selected managed launcher instead of stale venv discovery", async () => {
    runtimeMocks.native.mockResolvedValue({
      command: "/managed/python",
      arguments: ["native bootstrap"],
    });
    runtimeMocks.command.mockResolvedValue({
      command: "/managed/python",
      arguments: ["native bootstrap", "gateway"],
    });
    respondingProcess(true);
    const runtime = await HermesGatewayTransport.probe("/selected/hermes", "/workspace", {});
    expect(runtime).toEqual({ launcher: "/selected/hermes" });
    expect(processMocks.spawn).toHaveBeenCalledWith(
      "/managed/python",
      ["native bootstrap", "gateway"],
      expect.any(Object),
    );
  });
  it("reports an unusable advertised native gateway instead of silently downgrading", async () => {
    runtimeMocks.native.mockResolvedValue({ command: "/managed/python", arguments: [] });
    runtimeMocks.command.mockResolvedValue({ command: "/managed/python", arguments: ["gateway"] });
    respondingProcess(false);
    await expect(
      HermesGatewayTransport.probe("/selected/hermes", "/workspace", {}),
    ).rejects.toThrow("exclusive turns");
  });
  it("does not start a second process or spawn after close during runtime resolution", async () => {
    let resolve!: (command: { command: string; arguments: string[] }) => void;
    runtimeMocks.command.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    processMocks.spawn.mockClear();
    const transport = new HermesGatewayTransport(
      { launcher: "/selected/hermes" },
      "/workspace",
      {},
    );
    const started = transport.start();
    await expect(transport.start()).rejects.toThrow("started twice");
    await expect(transport.prepareSession()).rejects.toThrow("cannot be prepared");
    await transport.close();
    resolve({ command: "/managed/python", arguments: [] });
    await expect(started).rejects.toThrow("closed during runtime resolution");
    expect(processMocks.spawn).not.toHaveBeenCalled();
  });

  it("treats explicit Python as authoritative", async () => {
    runtimeMocks.native.mockClear();
    respondingProcess(true);
    expect(
      await HermesGatewayTransport.probe("/selected/hermes", "/workspace", {
        CODEXHOST_HERMES_GATEWAY_PYTHON: "/explicit/python",
      }),
    ).toBe("/explicit/python");
    expect(runtimeMocks.native).not.toHaveBeenCalled();
  });
});

describe("Hermes gateway process ownership", () => {
  it("settles failed spawn through close without waiting for a nonexistent exit", async () => {
    const f = childFixture();
    const started = f.transport.start();
    f.child.emit("error", new Error("EACCES"));
    f.child.emit("close", -1);
    await expect(started).rejects.toThrow("EACCES");
    await expect(f.transport.close()).resolves.toBeUndefined();
  });
  it("handles EPIPE and terminates an unresponsive owned process tree", async () => {
    vi.useFakeTimers();
    const f = childFixture();
    const started = f.transport.start();
    f.frame({ id: "codexhost-1", result: { per_session_exclusive_submit: true } });
    await started;
    const fault = vi.fn();
    f.transport.onFault = fault;
    f.child.stdin.emit("error", new Error("EPIPE"));
    await vi.advanceTimersByTimeAsync(4100);
    f.child.emit("close", 0);
    await f.transport.close();
    expect(fault).toHaveBeenCalledOnce();
    if (process.platform !== "win32") expect(f.kill).toHaveBeenCalledWith(-678901, "SIGKILL");
    else
      expect(processMocks.spawnSync).toHaveBeenCalledWith(
        "taskkill.exe",
        expect.any(Array),
        expect.any(Object),
      );
    await expect(f.transport.request("later", {})).rejects.toThrow("closed");
  });
  it("caches initialization failure before the caller starts waiting", async () => {
    const f = childFixture();
    const started = f.transport.start();
    f.frame({ id: "codexhost-1", result: { per_session_exclusive_submit: true } });
    await started;
    f.frame({
      method: "event",
      params: { type: "error", session_id: "s", payload: { message: "native init failed" } },
    });
    await expect(f.transport.waitForSession("s")).rejects.toThrow("native init failed");
    f.child.exitCode = 1;
    f.child.emit("exit", 1);
    f.child.emit("close", 1);
    await f.transport.close();
    if (process.platform !== "win32") expect(f.kill).toHaveBeenCalledWith(-678901, "SIGKILL");
  });
  it("keeps read-only query deadlines nonfatal while still dropping late replies", async () => {
    vi.useFakeTimers();
    const f = childFixture();
    const started = f.transport.start();
    f.frame({ id: "codexhost-1", result: { per_session_exclusive_submit: true } });
    await started;
    const fault = vi.fn();
    f.transport.onFault = fault;
    const reading = f.transport.request("session.usage", { session_id: "s" }, 50, false);
    const rejected = expect(reading).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    f.frame({ id: "codexhost-2", result: { input: 900 } });
    expect(fault).not.toHaveBeenCalled();
    const submitting = f.transport.request("prompt.submit", { session_id: "s", text: "go" });
    f.frame({ id: "codexhost-3", result: { status: "streaming" } });
    await expect(submitting).resolves.toEqual({ status: "streaming" });
    f.child.exitCode = 0;
    f.child.emit("close", 0);
    await f.transport.close();
  });

  it("closes on an unanswered RPC deadline instead of allowing an uncertain second turn", async () => {
    vi.useFakeTimers();
    const f = childFixture();
    const started = f.transport.start();
    const rejected = expect(started).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    f.child.emit("close", 0);
    await f.transport.close();
    await expect(f.transport.request("prompt.submit", {})).rejects.toThrow("closed");
  });
});
