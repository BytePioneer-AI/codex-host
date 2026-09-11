import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";

function fixture() {
  const exit = Promise.withResolvers<OfficialAppServerExit>();
  const backend: OwnedOfficialBackend = {
    closed: exit.promise,
    start: vi.fn(async () => {}),
    connect: async () => {
      throw new Error("No client expected");
    },
    stop: vi.fn(async () => {
      exit.resolve({ code: 0, signal: null });
    }),
  };
  const createBackend = vi.fn(() => backend);
  const scope = new OfficialRuntimeScope({
    permanentHome: "/synthetic/home",
    createBackend,
    diagnosticOutput: new PassThrough(),
  });
  return { scope, backend, createBackend, exit };
}

describe("official Runtime Scope terminal shutdown", () => {
  it("rejects a late Account-runtime owner start after Scope close", async () => {
    const f = fixture();
    await f.scope.close();
    try {
      await expect(f.scope.owner.start()).rejects.toThrow("unavailable");
      expect(f.createBackend).not.toHaveBeenCalled();
    } finally {
      await f.scope.owner.stop();
    }
  });

  it("retries failed close rather than letting the caller release its file lease", async () => {
    const f = fixture();
    const stop = vi.spyOn(f.backend, "stop");
    stop
      .mockRejectedValueOnce(new Error("unconfirmed"))
      .mockRejectedValueOnce(new Error("unconfirmed"));
    await f.scope.start();
    try {
      await expect(f.scope.close()).rejects.toThrow("unavailable");
      await expect(f.scope.close()).rejects.toThrow("unavailable");
      expect(stop).toHaveBeenCalledTimes(2);
      await f.scope.close();
      expect(stop).toHaveBeenCalledTimes(3);
    } finally {
      stop.mockReset().mockImplementation(async () => {
        f.exit.resolve({ code: 0, signal: null });
      });
      await f.scope.owner.stop();
    }
  });

  it("does not publish ready when close races backend startup", async () => {
    const f = fixture();
    const started = Promise.withResolvers<undefined>();
    vi.spyOn(f.backend, "start").mockReturnValue(started.promise);
    const phases: string[] = [];
    f.scope.gate.subscribe(() => {
      phases.push(f.scope.gate.phase);
    });
    const starting = f.scope.start();
    const outcome = expect(starting).rejects.toThrow("unavailable");
    const closing = f.scope.close();
    started.resolve(undefined);
    await closing;
    await outcome;
    expect(phases).not.toContain("ready");
  });
});
