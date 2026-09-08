import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MuseServeClient, type JsonObject } from "../src/msp-client.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

class FakeMuseProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_000;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly requests: JsonObject[] = [];
  readonly kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.requests.push(JSON.parse(chunk.toString()) as JsonObject);
    });
  }

  respond(id: unknown, result: JsonObject = {}): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

describe("Muse serve transport", () => {
  let child: FakeMuseProcess;
  let client: MuseServeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    child = new FakeMuseProcess();
    vi.mocked(childProcess.spawn).mockReturnValue(
      child as unknown as childProcess.ChildProcessWithoutNullStreams,
    );
    client = new MuseServeClient({
      executable: "/synthetic/muse",
      cwd: "/synthetic/workspace",
      environment: {},
      requestTimeoutMs: 100,
      closeTimeoutMs: 20,
    });
  });

  afterEach(async () => {
    child.exit(0);
    const closing = client.close().catch(() => {});
    await vi.runAllTimersAsync();
    await closing;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("frames split replies and acknowledges initialization", async () => {
    const handshake = client.handshake();
    child.stdout.write('{"jsonrpc":"2.0","id":1,"result":');
    child.stdout.write('{"version":"1.0.3"}}\n');
    await expect(handshake).resolves.toEqual({ version: "1.0.3" });
    expect(child.requests.at(-1)).toEqual({ jsonrpc: "2.0", method: "initialized" });
    await vi.advanceTimersByTimeAsync(100);
    const request = client.request("model/list");
    child.respond(child.requests.at(-1)?.id, { models: [] });
    await expect(request).resolves.toEqual({ models: [] });
  });

  it("rejects spawn errors and rejects subsequent requests with the same failure", async () => {
    const failure = vi.fn();
    client.subscribeFailure(failure);
    const pending = expect(client.handshake()).rejects.toMatchObject({
      harnessError: { code: "processExited" },
    });
    child.emit("error", new Error("spawn /synthetic/muse ENOENT"));
    await pending;
    await expect(client.request("model/list")).rejects.toBe(failure.mock.calls[0]?.[0]);
    expect(failure).toHaveBeenCalledOnce();
  });

  it("notifies an acknowledged Turn when its process exits, once", async () => {
    const failure = vi.fn();
    client.subscribeFailure(failure);
    const accepted = client.request("turn/start");
    child.respond(1, { status: "accepted" });
    await accepted;
    child.stderr.write("native process failed\n");
    child.exit(17);
    child.stdin.emit("error", new Error("write EPIPE"));
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]?.[0]).toMatchObject({
      harnessError: {
        code: "processExited",
        message: "Muse serve exited with code 17",
        diagnostic: "native process failed\n",
      },
    });
    await expect(client.request("session/read")).rejects.toBe(failure.mock.calls[0]?.[0]);
  });

  it("delivers a preexisting process failure to a new subscriber", async () => {
    child.exit(1);
    const failure = vi.fn();
    client.subscribeFailure(failure);
    await vi.runAllTicks();
    expect(failure).toHaveBeenCalledOnce();
    const unsubscribed = vi.fn();
    client.subscribeFailure(unsubscribed)();
    await vi.runAllTicks();
    expect(unsubscribed).not.toHaveBeenCalled();
  });

  it("fails pending requests on stdin stream errors", async () => {
    const pending = expect(client.request("session/read")).rejects.toMatchObject({
      harnessError: { code: "processExited", message: expect.stringContaining("write EPIPE") },
    });
    child.stdin.emit("error", new Error("write EPIPE"));
    await pending;
  });

  it("fails an active connection when stdout ends and ignores late notifications", () => {
    const failure = vi.fn();
    const notification = vi.fn();
    client.subscribeFailure(failure);
    client.subscribe(notification);
    child.stdout.emit("end");
    child.stdout.write('{"jsonrpc":"2.0","method":"turn/completed"}\n');
    expect(failure).toHaveBeenCalledOnce();
    expect(notification).not.toHaveBeenCalled();
  });

  it("handles write callback failures before an error event", async () => {
    vi.spyOn(child.stdin, "write").mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as ((error: Error) => void) | undefined;
      callback?.(new Error("write EPIPE"));
      return false;
    });
    await expect(client.request("model/list")).rejects.toMatchObject({
      harnessError: { code: "processExited", message: expect.stringContaining("write EPIPE") },
    });
  });

  it("handles synchronous writes and notification pipe failures", async () => {
    const failure = vi.fn();
    client.subscribeFailure(failure);
    vi.spyOn(child.stdin, "write").mockImplementation(() => {
      throw new Error("stream is destroyed");
    });
    expect(() => client.notify("initialized")).not.toThrow();
    expect(failure).toHaveBeenCalledOnce();
    await expect(client.request("model/list")).rejects.toBe(failure.mock.calls[0]?.[0]);
  });

  it("expires an unacknowledged request and makes the transport terminal", async () => {
    const failure = vi.fn();
    client.subscribeFailure(failure);
    const pending = expect(client.request("turn/start")).rejects.toMatchObject({
      harnessError: { code: "protocolError", message: expect.stringContaining("turn/start") },
    });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(failure).toHaveBeenCalledOnce();
    await expect(client.request("session/read")).rejects.toBe(failure.mock.calls[0]?.[0]);
  });

  it("closes only after reaping the child and escalates past ignored SIGTERM", async () => {
    const failure = vi.fn();
    client.subscribeFailure(failure);
    const closed = vi.fn();
    const closing = client.close().then(closed);
    const closingAgain = client.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(closed).not.toHaveBeenCalled();
    child.exit(null, "SIGKILL");
    await Promise.all([closing, closingAgain]);
    expect(failure).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a close that cannot reap the process", async () => {
    const closing = expect(client.close()).rejects.toMatchObject({
      harnessError: { code: "processExited", message: expect.stringContaining("did not exit") },
    });
    await vi.advanceTimersByTimeAsync(40);
    await closing;
    child.exit(0);
  });

  it("closes an already exited process without waiting or signaling again", async () => {
    child.exit(0);
    await client.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
