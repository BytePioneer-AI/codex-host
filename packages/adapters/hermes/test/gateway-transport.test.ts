import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const processMocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
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
