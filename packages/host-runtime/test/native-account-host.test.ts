import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonObjectSchema, codexAccountListResultSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";
import { createOwnedLoopbackBackend } from "../src/codex-runtime/owned-official-backends.js";
import { prepareLocalCodex, type PreparedLocalCodex } from "../src/native-account-host.js";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";

vi.mock("../src/codex-runtime/owned-official-backends.js", () => ({
  createOwnedLoopbackBackend: vi.fn(),
}));

const prepared = new Set<PreparedLocalCodex>();
const temporaryDirectories = new Set<string>();
afterEach(async () => {
  for (const local of prepared) await local.close();
  prepared.clear();
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
  vi.clearAllMocks();
});

function nativeFixture() {
  const exit = Promise.withResolvers<OfficialAppServerExit>();
  const requests: JsonObject[] = [];
  const connections: Array<{ close(): void }> = [];
  let account: JsonObject | null = {
    type: "chatgpt",
    email: "current@example.com",
    planType: "pro",
  };
  const connect = vi.fn(async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const closed = Promise.withResolvers<OfficialAppServerExit>();
    let pending = "";
    let initialized = false;
    stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const request = jsonObjectSchema.parse(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        requests.push(request);
        if (request.method === "initialized") continue;
        let result: JsonObject;
        if (request.method === "initialize") {
          initialized = true;
          result = { userAgent: "synthetic" };
        } else {
          if (!initialized) throw new Error("Unexpected or uninitialized native request");
          if (request.method === "account/read") {
            result = { account, requiresOpenaiAuth: true };
          } else if (request.method === "thread/start" || request.method === "thread/resume") {
            result = { thread: { id: "voice-thread" } };
          } else if (request.method === "thread/realtime/start") {
            result = {};
          } else {
            throw new Error("Unexpected native request");
          }
        }
        stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
    const close = vi.fn(() => {
      stdin.end();
      stdout.end();
      stderr.end();
      closed.resolve({ code: 0, signal: null });
    });
    connections.push({ close });
    return { stdin, stdout, stderr, closed: closed.promise, close };
  });
  const stop = vi.fn(async () => {
    for (const connection of connections) connection.close();
    exit.resolve({ code: 0, signal: null });
  });
  const backend = {
    closed: exit.promise,
    start: vi.fn(async () => {}),
    connect,
    stop,
  };
  vi.mocked(createOwnedLoopbackBackend).mockReturnValue(backend);
  return {
    backend,
    requests,
    connect,
    stop,
    crash: () => exit.resolve({ code: 1, signal: null }),
    signOut: () => {
      account = null;
    },
  };
}

async function withUnhandledRejections<T>(run: () => Promise<T>): Promise<{
  value: T;
  rejections: string[];
}> {
  const rejections: string[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason instanceof Error ? reason.name : String(reason));
  };
  process.on("unhandledRejection", onRejection);
  try {
    const value = await run();
    await Promise.resolve();
    return { value, rejections };
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

async function startLocal(options?: { recoveryWaitMs?: number; delaysMs?: readonly number[] }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-native-account-host-"));
  temporaryDirectories.add(directory);
  const local = await prepareLocalCodex({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    environment: { CODEX_HOME: path.join(directory, "missing-codex-home") },
    diagnosticOutput: new PassThrough(),
    ...(options?.delaysMs ? { recovery: { delaysMs: options.delaysMs } } : {}),
    ...(options?.recoveryWaitMs !== undefined ? { recoveryWaitMs: options.recoveryWaitMs } : {}),
  });
  prepared.add(local);
  return local;
}

describe("local Codex read-only identity startup", () => {
  it("recovers the local backend so an existing client can explicitly retry voice startup", async () => {
    const first = nativeFixture();
    const local = await startLocal();
    await local.accountControl.refresh?.();
    const desktop = new OfficialRuntimeClient({
      scope: local.officialRuntimeScope,
      output: async () => {},
    });
    try {
      await desktop.initializeProtocol({
        clientInfo: { name: "codex_desktop", version: "synthetic" },
      });
      await desktop.request("thread/start", { cwd: "/synthetic" });
      const replacement = nativeFixture();
      first.crash();
      await vi.waitFor(() => expect(local.officialRuntimeScope.gate.phase).toBe("unavailable"));
      await expect(
        desktop.request("thread/realtime/start", { threadId: "voice-thread" }),
      ).rejects.toThrow("unavailable");
      await vi.waitFor(() => expect(local.officialRuntimeScope.gate.phase).toBe("ready"), {
        timeout: 3000,
      });
      expect(first.stop).toHaveBeenCalledOnce();
      expect(local.officialRuntimeScope.owner.generation).toBe(2);
      expect(
        replacement.requests.some((request) => request.method === "thread/realtime/start"),
      ).toBe(false);

      await expect(
        desktop.request("thread/realtime/start", { threadId: "voice-thread" }),
      ).resolves.toMatchObject({ result: {} });
      expect(replacement.requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "initialize",
        "initialized",
        "thread/resume",
        "thread/realtime/start",
      ]);
      expect(await local.accountControl.refresh?.()).toMatchObject({ phase: "ready" });
    } finally {
      await desktop.close();
    }
  });

  it("recovers a failed first official start without closing the Scope", async () => {
    const first = nativeFixture();
    first.connect.mockRejectedValueOnce(new Error("Synthetic connection failure"));
    const firstBackend = first.backend;
    let calls = 0;
    vi.mocked(createOwnedLoopbackBackend).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return firstBackend;
      return nativeFixture().backend;
    });
    const { value: local, rejections } = await withUnhandledRejections(() =>
      startLocal({ delaysMs: [0], recoveryWaitMs: 2_000 }),
    );
    expect(rejections).toEqual([]);
    expect(local.officialRuntimeScope.gate.phase).toBe("ready");
    expect(local.officialRuntimeScope.owner.generation).toBe(2);
    expect(first.stop).toHaveBeenCalled();
    await local.accountControl.refresh?.();
  });

  it("recovers a delayed second generation without unhandledRejection", async () => {
    const first = nativeFixture();
    first.connect.mockRejectedValueOnce(new Error("Synthetic connection failure"));
    const firstBackend = first.backend;
    let calls = 0;
    vi.mocked(createOwnedLoopbackBackend).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return firstBackend;
      const second = nativeFixture();
      second.backend.start = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      return second.backend;
    });
    const { value: local, rejections } = await withUnhandledRejections(() =>
      startLocal({ delaysMs: [20], recoveryWaitMs: 1_000 }),
    );
    expect(rejections).toEqual([]);
    expect(local.officialRuntimeScope.gate.phase).toBe("ready");
    expect(local.officialRuntimeScope.owner.generation).toBe(2);
  });

  it("closes the owned backend when first start and bounded recovery both fail", async () => {
    const f = nativeFixture();
    f.connect.mockRejectedValue(new Error("Synthetic connection failure"));
    const { rejections } = await withUnhandledRejections(async () => {
      await expect(startLocal({ delaysMs: [0], recoveryWaitMs: 30 })).rejects.toThrow(
        "unavailable",
      );
    });
    expect(rejections).toEqual([]);
    expect(f.stop).toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it("initializes the native read connection before projecting the current identity", async () => {
    const f = nativeFixture();
    const local = await startLocal();
    const result = codexAccountListResultSchema.parse(await local.accountControl.refresh?.());
    expect(result).toMatchObject({
      phase: "ready",
      currentAccountId: "current",
      accounts: [{ accountId: "current", email: "current@example.com", planType: "pro" }],
    });
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.requests.slice(0, 2).map((r) => r.method)).toEqual(["initialize", "initialized"]);
    expect(
      f.requests
        .filter((r) => r.method === "account/read")
        .every((r) => JSON.stringify(r.params) === JSON.stringify({ refreshToken: false })),
    ).toBe(true);
    await local.close();
    expect(f.stop).toHaveBeenCalledOnce();
    await expect(local.accountControl.refresh?.()).rejects.toThrow("unavailable");
  });

  it("projects native sign-out without restoring a saved identity or starting login", async () => {
    const f = nativeFixture();
    const local = await startLocal();
    await local.accountControl.refresh?.();
    f.signOut();
    expect(await local.accountControl.refresh?.()).toMatchObject({
      currentAccountId: null,
      accounts: [],
      phase: "ready",
    });
    expect(
      f.requests.every((r) =>
        ["initialize", "initialized", "account/read"].includes(String(r.method)),
      ),
    ).toBe(true);
    expect(f.connect).toHaveBeenCalledOnce();
  });
});
