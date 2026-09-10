import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CodexRuntime } from "../src/codex-runtime/codex-runtime.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../src/official-app-server-connection.js";

function fixture(owned: boolean) {
  const exit = Promise.withResolvers<OfficialAppServerExit>();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const close = vi.fn(() => {
    stdin.end();
    stdout.end();
    stderr.end();
    exit.resolve({ code: 0, signal: null });
  });
  const stopProcess = vi.fn(() => exit.promise);
  const connection: OfficialAppServerConnection = {
    stdin,
    stdout,
    stderr,
    closed: exit.promise,
    close,
    ...(owned ? { stopProcess } : {}),
  };
  const onOutput = vi.fn(async () => undefined);
  const runtime = new CodexRuntime({
    generation: 1,
    connection,
    diagnosticOutput: new PassThrough(),
    onOutput,
    onClosed: vi.fn(),
  });
  return { runtime, connection, exit, close, stopProcess, onOutput, stdin, stdout };
}

describe("Codex runtime controlled shutdown", () => {
  it("does not confuse shared client closure with listener process exit", async () => {
    const f = fixture(false);
    try {
      await expect(f.runtime.stopProcess()).rejects.toThrow("owning listener");
      expect(f.close).not.toHaveBeenCalled();
      await expect(f.runtime.send({ method: "initialized" })).resolves.toBeUndefined();
    } finally {
      f.runtime.close();
    }
  });

  it("waits for owned process exit even when output has ended", async () => {
    const f = fixture(true);
    const stopped = vi.fn();
    const stopping = f.runtime.stopProcess().then(stopped);
    f.stdout.end();
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    f.exit.resolve({ code: 0, signal: null });
    await stopping;
    expect(stopped).toHaveBeenCalledWith({ code: 0, signal: null });
    f.runtime.close();
  });

  it("fails pending requests and suppresses retired runtime output", async () => {
    const f = fixture(true);
    const pending = expect(f.runtime.request("account/read", {})).rejects.toThrow("closing");
    const stopping = f.runtime.stopProcess();
    await pending;
    f.stdout.write(`${JSON.stringify({ method: "account/updated", params: {} })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.onOutput).not.toHaveBeenCalled();
    await expect(f.runtime.request("turn/start", {})).rejects.toThrow("closing");
    await expect(f.runtime.send({ method: "initialized" })).rejects.toThrow("closing");
    await expect(f.runtime.sendFrame(Buffer.from("{}\n"))).rejects.toThrow("closing");
    f.exit.resolve({ code: 0, signal: null });
    await stopping;
    f.runtime.close();
  });

  it("still permits hard cleanup if controlled stop failed", async () => {
    const f = fixture(true);
    f.stopProcess.mockRejectedValueOnce(new Error("exit unconfirmed"));
    await expect(f.runtime.stopProcess()).rejects.toThrow("exit unconfirmed");
    expect(f.close).not.toHaveBeenCalled();
    f.runtime.close();
    f.runtime.close();
    expect(f.close).toHaveBeenCalledOnce();
  });
});
