import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  OfficialRuntimeClient,
  OfficialRuntimeScope,
} from "../src/codex-runtime/official-runtime-scope.js";
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

describe("Desktop initialization without native admission", () => {
  const params = { clientInfo: { name: "codex_desktop", version: "synthetic" } };

  it("returns Host metadata without starting Codex or publishing ready", async () => {
    const f = fixture();
    const client = new OfficialRuntimeClient({ scope: f.scope, output: async () => {} });
    try {
      await expect(client.initializeProtocol(params)).resolves.toEqual({
        result: {
          userAgent: "codexhost",
          codexHome: "/synthetic/home",
          platformFamily: process.platform === "win32" ? "windows" : "unix",
          platformOs:
            process.platform === "darwin"
              ? "macos"
              : process.platform === "win32"
                ? "windows"
                : process.platform,
        },
      });
      expect(f.scope.gate.phase).toBe("unavailable");
      expect(f.createBackend).not.toHaveBeenCalled();
      await expect(client.request("model/list", {})).rejects.toThrow("unavailable");
      await f.scope.close();
      await expect(client.initializeProtocol(params)).rejects.toThrow("unavailable");
      await client.close();
      await expect(client.initializeProtocol(params)).rejects.toThrow("unavailable");
    } finally {
      await client.close();
      await f.scope.close();
    }
  });

  it("does not attach a new Desktop client to the authentication-only staging backend", async () => {
    const f = fixture();
    f.scope.gate.initialized();
    const change = f.scope.gate.beginChange();
    const client = new OfficialRuntimeClient({ scope: f.scope, output: async () => {} });
    const connect = vi.spyOn(f.backend, "connect");
    try {
      await f.scope.owner.start({ mode: "management-only", homeOverride: "/synthetic/staging" });
      await expect(client.initializeProtocol(params)).resolves.toMatchObject({
        result: { userAgent: "codexhost", codexHome: "/synthetic/home" },
      });
      expect(connect).not.toHaveBeenCalled();
      expect(f.scope.gate.phase).toBe("changing");
    } finally {
      await client.close();
      await f.scope.close();
      change.finish("unavailable");
    }
  });
});

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
