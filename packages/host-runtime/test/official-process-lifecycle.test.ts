import type { ChildProcess, ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnOfficialAppServerConnection } from "../src/official-app-server-connection.js";
import {
  OfficialProcessLifecycle,
  OfficialProcessStopTimeoutError,
} from "../src/official-process-lifecycle.js";

class FakeProcess extends EventEmitter {
  pid: number | undefined = 123;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
}

function lifecycle(child: FakeProcess, endInput?: () => void) {
  return new OfficialProcessLifecycle(child as unknown as ChildProcess, {
    timeoutMs: 10,
    ...(endInput ? { endInput } : {}),
  });
}

afterEach(() => vi.useRealTimers());

describe("official process ownership", () => {
  it("waits for actual exit after stdout closes", async () => {
    const child = new FakeProcess();
    const process = lifecycle(child);
    const stopped = vi.fn();
    void process.closed.then(stopped);
    child.stdout.end();
    child.emit("close", 0, null);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    child.emit("exit", 0, null);
    await expect(process.closed).resolves.toEqual({ code: 0, signal: null });
  });

  it("does not mistake a failed kill error for exit", async () => {
    const child = new FakeProcess();
    const process = lifecycle(child);
    const exited = vi.fn();
    void process.closed.then(exited);
    child.emit("error", new Error("kill EPERM"));
    await Promise.resolve();
    expect(exited).not.toHaveBeenCalled();
    child.emit("exit", null, "SIGTERM");
    await expect(process.closed).resolves.toMatchObject({ signal: "SIGTERM" });
  });

  it("recognizes a spawn failure without claiming a live child was stopped", async () => {
    const child = new FakeProcess();
    child.pid = undefined;
    const process = lifecycle(child);
    const error = new Error("spawn ENOENT");
    child.emit("error", error);
    await expect(process.stop()).resolves.toEqual({ code: null, signal: null, error });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("remembers the spawn event when no pid is available", async () => {
    const child = new FakeProcess();
    child.pid = undefined;
    const process = lifecycle(child);
    child.emit("spawn");
    child.emit("error", new Error("kill failed"));
    const exited = vi.fn();
    void process.closed.then(exited);
    await Promise.resolve();
    expect(exited).not.toHaveBeenCalled();
    child.emit("exit", 1, null);
    await expect(process.closed).resolves.toEqual({ code: 1, signal: null });
  });

  it("ends input and waits for graceful shutdown without killing", async () => {
    const child = new FakeProcess();
    const endInput = vi.fn(() => queueMicrotask(() => child.emit("exit", 0, null)));
    const process = lifecycle(child, endInput);
    const first = process.stop();
    const second = process.stop();
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ code: 0, signal: null });
    expect(endInput).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("escalates only after each preceding grace period expires", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") child.emit("exit", null, "SIGKILL");
      return true;
    });
    const endInput = vi.fn();
    const process = lifecycle(child, endInput);
    const stopping = process.stop();
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(stopping).resolves.toMatchObject({ signal: "SIGKILL" });
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("rejects unconfirmed termination and can observe a late real exit", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const process = lifecycle(child);
    const exited = vi.fn();
    void process.closed.then(exited);
    const failure = expect(process.stop()).rejects.toBeInstanceOf(OfficialProcessStopTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await failure;
    expect(exited).not.toHaveBeenCalled();
    child.emit("exit", null, "SIGKILL");
    await expect(process.stop()).resolves.toMatchObject({ signal: "SIGKILL" });
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("does not treat a thrown kill failure as confirmed termination", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    child.kill.mockImplementation(() => {
      throw new Error("kill denied");
    });
    const process = lifecycle(child);
    const failure = expect(process.stop()).rejects.toBeInstanceOf(OfficialProcessStopTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await failure;
    child.emit("exit", 0, null);
    await expect(process.closed).resolves.toMatchObject({ code: 0 });
  });
});

describe("owned stdio connection", () => {
  it("exposes process shutdown separately from best-effort connection close", async () => {
    const child = new FakeProcess();
    const connection = spawnOfficialAppServerConnection({
      stockCodexPath: "synthetic-codex",
      arguments: ["app-server"],
      environment: {},
      spawnOfficial: vi.fn(
        () => child as unknown as ChildProcessWithoutNullStreams,
      ) as unknown as typeof spawn,
      closeTimeoutMs: 10,
    });
    child.stdin.once("finish", () => child.emit("exit", 0, null));
    await expect(connection.stopProcess?.()).resolves.toEqual({ code: 0, signal: null });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("waits for a real child to flush its final output and exit on stdin EOF", async () => {
    const connection = spawnOfficialAppServerConnection({
      stockCodexPath: process.execPath,
      arguments: [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('stopped\\n'); });",
      ],
      environment: process.env,
      closeTimeoutMs: 5_000,
    });
    let output = "";
    connection.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const ended = new Promise<void>((resolve) => connection.stdout.once("end", resolve));
    try {
      await expect(connection.stopProcess?.()).resolves.toEqual({ code: 0, signal: null });
      await ended;
      expect(output).toBe("stopped\n");
    } finally {
      connection.close();
    }
  });
});
