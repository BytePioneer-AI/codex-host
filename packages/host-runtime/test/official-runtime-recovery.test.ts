import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import {
  OfficialRuntimeClient,
  OfficialRuntimeScope,
  type OfficialRuntimeRecoveryOptions,
} from "../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../src/official-app-server-connection.js";
import { createFixture, writeRequest } from "./app-server-host-fixture.js";

function connection() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    let newline: number;
    while ((newline = input.indexOf("\n")) >= 0) {
      const request = JSON.parse(input.slice(0, newline)) as JsonObject;
      input = input.slice(newline + 1);
      if (request.id === undefined) continue;
      const result =
        request.method === "initialize" ? { userAgent: "synthetic-native" } : { data: [] };
      stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  const finish = (exit: OfficialAppServerExit): void => {
    stdin.end();
    stdout.end();
    stderr.end();
    closed.resolve(exit);
  };
  const value: OfficialAppServerConnection & { dropAbnormally(): void } = {
    stdin,
    stdout,
    stderr,
    closed: closed.promise,
    close: () => finish({ code: 0, signal: null }),
    // The shared app-server drops one client connection while its process stays alive.
    dropAbnormally: () =>
      finish({ code: 1, signal: null, error: new Error("WebSocket closed (1006)") }),
  };
  return value;
}

/** A synthetic shared stock listener; each createBackend call is one process generation. */
function officialProcesses() {
  const events: string[] = [];
  const generations: {
    exit: PromiseWithResolvers<OfficialAppServerExit>;
    connections: ReturnType<typeof connection>[];
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  let failingStarts = 0;
  const createBackend = vi.fn((): OwnedOfficialBackend => {
    const index = generations.length;
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const connections: ReturnType<typeof connection>[] = [];
    const stop = vi.fn(async () => {
      events.push(`stop:${String(index)}`);
      for (const value of connections) value.close();
      exit.resolve({ code: 0, signal: null });
    });
    generations.push({ exit, connections, stop });
    return {
      closed: exit.promise,
      async start() {
        events.push(`start:${String(index)}`);
        if (failingStarts > 0) {
          failingStarts--;
          throw new Error("Synthetic official startup failure");
        }
      },
      async connect() {
        const value = connection();
        connections.push(value);
        return value;
      },
      stop,
    };
  });
  const generation = (index: number) => {
    const value = generations[index];
    if (!value) throw new Error(`Missing synthetic generation ${String(index)}`);
    return value;
  };
  return {
    events,
    createBackend,
    generation,
    failNextStarts: (count: number) => {
      failingStarts = count;
    },
  };
}

function scopeWith(recovery?: OfficialRuntimeRecoveryOptions) {
  const official = officialProcesses();
  const diagnostics: string[] = [];
  const scope = new OfficialRuntimeScope({
    permanentHome: "/synthetic/home",
    createBackend: official.createBackend,
    diagnosticOutput: new PassThrough().on("data", (chunk: Buffer) => {
      diagnostics.push(chunk.toString());
    }),
    ...(recovery ? { recovery } : {}),
  });
  const client = () => new OfficialRuntimeClient({ scope, output: async () => {} });
  return { ...official, scope, client, diagnostics };
}

const params = { clientInfo: { name: "codex_desktop", version: "synthetic" } };

describe("official Runtime Scope recovery", () => {
  it("replaces an unexpectedly exited generation and reattaches existing clients", async () => {
    const f = scopeWith({ delaysMs: [5] });
    const desktop = f.client();
    try {
      await f.scope.start();
      await desktop.initializeProtocol(params);
      await expect(desktop.request("model/list", {})).resolves.toBeDefined();

      f.generation(0).exit.resolve({ code: 1, signal: null });
      await vi.waitFor(() => expect(f.createBackend).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(f.scope.gate.phase).toBe("ready"));

      expect(f.events).toEqual(["start:0", "stop:0", "start:1"]);
      expect(f.scope.owner.generation).toBe(2);
      // The same native client reconnects and reinitializes on the replacement.
      await expect(desktop.request("model/list", {})).resolves.toBeDefined();
      expect(f.diagnostics.join("")).toContain("restarting in 5ms");
    } finally {
      await desktop.close();
      await f.scope.close();
    }
  });

  it("proves a live generation exited before replacing it after a transport failure", async () => {
    const f = scopeWith({ delaysMs: [5] });
    const first = f.client();
    const second = f.client();
    try {
      await f.scope.start();
      await first.initializeProtocol(params);
      await second.initializeProtocol(params);

      f.generation(0).connections[0]?.dropAbnormally();
      await vi.waitFor(() => expect(f.createBackend).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(f.scope.gate.phase).toBe("ready"));

      expect(f.generation(0).stop).toHaveBeenCalledOnce();
      expect(f.events).toEqual(["start:0", "stop:0", "start:1"]);
      await expect(first.request("model/list", {})).resolves.toBeDefined();
      await expect(second.request("model/list", {})).resolves.toBeDefined();
    } finally {
      await first.close();
      await second.close();
      await f.scope.close();
    }
  });

  it("starts the replacement immediately for a reconnecting client", async () => {
    const f = scopeWith({ delaysMs: [60_000] });
    try {
      await f.scope.start();
      f.generation(0).exit.resolve({ code: 1, signal: null });
      await vi.waitFor(() => expect(f.events).toContain("stop:0"));
      expect(f.createBackend).toHaveBeenCalledOnce();

      const reconnected = f.client();
      await reconnected.initialize();
      expect(f.createBackend).toHaveBeenCalledTimes(2);
      expect(f.scope.gate.phase).toBe("ready");
      await reconnected.initializeProtocol(params);
      await expect(reconnected.request("model/list", {})).resolves.toBeDefined();
      await reconnected.close();
    } finally {
      await f.scope.close();
    }
  });

  it("backs off across consecutive failed replacements", async () => {
    const f = scopeWith({ delaysMs: [5, 10, 20], stableMs: 60_000 });
    try {
      await f.scope.start();
      f.failNextStarts(3);
      f.generation(0).exit.resolve({ code: 1, signal: null });

      await vi.waitFor(() => expect(f.createBackend).toHaveBeenCalledTimes(5), {
        timeout: 2_000,
      });
      await vi.waitFor(() => expect(f.scope.gate.phase).toBe("ready"));
      const delays = [...f.diagnostics.join("").matchAll(/restarting in (\d+)ms/gu)].map((match) =>
        Number(match[1]),
      );
      expect(delays).toEqual([5, 10, 20, 20]);
      // Every failed start still proved its exit before the next generation.
      for (const index of [1, 2, 3]) expect(f.generation(index).stop).toHaveBeenCalledOnce();
    } finally {
      await f.scope.close();
    }
  });

  it("does not start a replacement after the Scope closes", async () => {
    const f = scopeWith({ delaysMs: [100] });
    await f.scope.start();
    f.generation(0).exit.resolve({ code: 1, signal: null });
    await vi.waitFor(() => expect(f.events).toContain("stop:0"), { interval: 5 });
    expect(f.diagnostics.join("")).toContain("restarting in 100ms");
    await f.scope.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(f.createBackend).toHaveBeenCalledOnce();
    await expect(f.scope.start()).rejects.toThrow("unavailable");
  });

  it("without recovery stops a failed live generation once and never replaces it", async () => {
    const f = scopeWith();
    const first = f.client();
    try {
      await f.scope.start();
      await first.initializeProtocol(params);
      f.generation(0).connections[0]?.dropAbnormally();
      await vi.waitFor(() => expect(f.generation(0).stop).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 30));

      await expect(f.scope.start()).resolves.toBeUndefined();
      expect(f.createBackend).toHaveBeenCalledOnce();
      expect(f.scope.gate.phase).toBe("unavailable");
      expect(f.diagnostics.join("")).not.toContain("restarting");
    } finally {
      await first.close();
      await f.scope.close();
    }
  });
});

describe("remote Host sessions during official recovery", () => {
  it("does not let a reconnecting Desktop session stop the replacement generation", async () => {
    const f = scopeWith({ delaysMs: [60_000] });
    await f.scope.start();
    const before = createFixture({ officialRuntimeScope: f.scope });
    let after: ReturnType<typeof createFixture> | undefined;
    try {
      writeRequest(before.desktopInput, { id: 901, method: "initialize", params });
      await before.collector.waitFor((message) => message.id === 901);
      writeRequest(before.desktopInput, { method: "initialized" });

      f.generation(0).exit.resolve({ code: 1, signal: null });
      await vi.waitFor(() => expect(f.events).toContain("stop:0"));
      expect(f.scope.gate.phase).toBe("unavailable");

      // Desktop reconnects: the new Host session starts the replacement at once.
      after = createFixture({ officialRuntimeScope: f.scope });
      writeRequest(after.desktopInput, { id: 902, method: "initialize", params });
      await after.collector.waitFor((message) => message.id === 902);
      writeRequest(after.desktopInput, { method: "initialized" });
      await vi.waitFor(() => expect(f.scope.gate.phase).toBe("ready"));

      writeRequest(after.desktopInput, { id: 903, method: "model/list", params: {} });
      await expect(after.collector.waitFor((message) => message.id === 903)).resolves.toMatchObject(
        { result: { data: [] } },
      );
      writeRequest(before.desktopInput, { id: 904, method: "model/list", params: {} });
      await expect(
        before.collector.waitFor((message) => message.id === 904),
      ).resolves.toMatchObject({ result: { data: [] } });

      expect(f.createBackend).toHaveBeenCalledTimes(2);
      expect(f.generation(1).stop).not.toHaveBeenCalled();
      expect(f.events).toEqual(["start:0", "stop:0", "start:1"]);
    } finally {
      for (const fixture of [before, after]) {
        if (!fixture) continue;
        fixture.host.close();
        await fixture.running;
        rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
      }
      await f.scope.close();
    }
  });
});
