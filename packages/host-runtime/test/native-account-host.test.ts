import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const connections: Array<{ close(): void; stdout: PassThrough }> = [];
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
    connections.push({ close, stdout });
    return { stdin, stdout, stderr, closed: closed.promise, close };
  });
  const stop = vi.fn(async () => {
    for (const connection of connections) connection.close();
    exit.resolve({ code: 0, signal: null });
  });
  vi.mocked(createOwnedLoopbackBackend).mockReturnValue({
    closed: exit.promise,
    start: vi.fn(async () => {}),
    connect,
    stop,
  });
  return {
    requests,
    connect,
    stop,
    notify: (value: JsonObject) => {
      for (const connection of connections) connection.stdout.write(`${JSON.stringify(value)}\n`);
    },
    crash: () => exit.resolve({ code: 1, signal: null }),
    signOut: () => {
      account = null;
    },
  };
}

async function startLocal(
  deferStart = false,
  savedStartup?: { stockCodexPath: string; arguments: string[] },
  diagnosticOutput = new PassThrough(),
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-native-account-host-"));
  temporaryDirectories.add(directory);
  if (savedStartup)
    await writeFile(path.join(directory, "official-startup-v1.json"), JSON.stringify(savedStartup));
  const local = await prepareLocalCodex({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    environment: {
      CODEX_HOME: path.join(directory, "missing-codex-home"),
      CODEXHOST_DATA_DIR: directory,
    },
    diagnosticOutput,
    deferStart,
  });
  prepared.add(local);
  return local;
}

describe("local Codex read-only identity startup", () => {
  it("records the Desktop invocation for subsequent Web-first startup", async () => {
    const f = nativeFixture();
    const local = await startLocal(true);
    expect(createOwnedLoopbackBackend).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    const home = local.officialRuntimeScope.permanentHome;
    const arguments_ = [
      "-c",
      "features.synthetic=true",
      "app-server",
      "--analytics-default-enabled",
    ];
    await local.configureStartup({
      stockCodexPath: "/synthetic/desktop-codex",
      arguments: arguments_,
      environment: { CODEX_HOME: "/must-not-change-home", PATH: "/synthetic/path" },
    });
    arguments_.push("--must-not-leak");
    expect(
      JSON.parse(await readFile(path.join(path.dirname(home), "official-startup-v1.json"), "utf8")),
    ).toEqual({
      stockCodexPath: "/synthetic/desktop-codex",
      arguments: ["-c", "features.synthetic=true", "app-server", "--analytics-default-enabled"],
    });
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledOnce();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledWith({
      stockCodexPath: "/synthetic/desktop-codex",
      cwd: home,
      arguments: ["-c", "features.synthetic=true", "app-server", "--analytics-default-enabled"],
      environment: { CODEX_HOME: home, PATH: "/synthetic/path" },
    });
    await local.accountControl.refresh?.();
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it("uses recorded Desktop arguments when Web starts first", async () => {
    nativeFixture();
    const arguments_ = ["-c", "features.saved=true", "app-server"];
    const local = await startLocal(true, {
      stockCodexPath: "/synthetic/desktop-codex",
      arguments: arguments_,
    });
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: arguments_ }),
    );
  });

  it("uses baseline arguments without a startup record", async () => {
    nativeFixture();
    const local = await startLocal(true);
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: ["-c", "features.code_mode_host=true", "app-server"],
      }),
    );
  });

  it.each([false, true])(
    "preserves Remote Control startup without reading, writing or replacing recorded startup (configure first: %s)",
    async (configureFirst) => {
      const first = nativeFixture();
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-startup-"));
      temporaryDirectories.add(directory);
      const startupFile = path.join(directory, "official-startup-v1.json");
      const saved = JSON.stringify({
        stockCodexPath: "/synthetic/saved",
        arguments: ["-c", "features.saved=true", "app-server"],
      });
      await writeFile(startupFile, saved);
      const arguments_ = ["app-server", "--analytics-default-enabled"];
      const local = await prepareLocalCodex({
        stockCodexPath: "/synthetic/codex",
        arguments: arguments_,
        environment: { CODEX_HOME: path.join(directory, "home"), CODEXHOST_DATA_DIR: directory },
        diagnosticOutput: new PassThrough(),
        deferStart: true,
        remoteControl: true,
      });
      prepared.add(local);
      const configuration = {
        stockCodexPath: "/synthetic/desktop-codex",
        arguments: ["-c", "features.remote=true", "app-server"],
        environment: {},
      };
      if (configureFirst) {
        await local.configureStartup(configuration);
        await local.configureStartup({ ...configuration, arguments: ["app-server"] });
      }
      await local.officialRuntimeScope.start();
      expect(createOwnedLoopbackBackend).toHaveBeenCalledWith(
        expect.objectContaining({
          arguments: configureFirst ? configuration.arguments : arguments_,
        }),
      );
      await local.configureStartup({ ...configuration, arguments: ["app-server"] });
      expect(first.stop).not.toHaveBeenCalled();
      expect(createOwnedLoopbackBackend).toHaveBeenCalledOnce();
      expect(await readFile(startupFile, "utf8")).toBe(saved);
    },
  );

  it("uses Desktop arguments even when a request starts before idle retirement returns", async () => {
    const first = nativeFixture();
    const local = await startLocal(true);
    await local.officialRuntimeScope.start();
    nativeFixture();
    const stop = local.officialRuntimeScope.stop.bind(local.officialRuntimeScope);
    vi.spyOn(local.officialRuntimeScope, "stop").mockImplementationOnce(async () => {
      await stop();
      await local.officialRuntimeScope.start();
    });
    const configuration = {
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server", "--analytics-default-enabled"],
      environment: {},
    };
    await local.configureStartup(configuration);
    await local.configureStartup(configuration);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledTimes(2);
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledTimes(2);
    expect(createOwnedLoopbackBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({ arguments: configuration.arguments }),
    );
  });

  it("continues Desktop startup after recording its arguments fails", async () => {
    nativeFixture();
    const diagnostics = new PassThrough();
    const local = await startLocal(true, undefined, diagnostics);
    const startupFile = path.join(
      path.dirname(local.officialRuntimeScope.permanentHome),
      "official-startup-v1.json",
    );
    await mkdir(startupFile);
    const arguments_ = ["app-server", "--analytics-default-enabled"];
    await expect(
      local.configureStartup({
        stockCodexPath: "/synthetic/desktop-codex",
        arguments: arguments_,
        environment: {},
      }),
    ).resolves.toBeUndefined();
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: arguments_ }),
    );
    expect(diagnostics.read()?.toString()).toContain(
      "could not record official Codex startup arguments",
    );
  });

  it("preserves an active Turn when Desktop arguments differ", async () => {
    const first = nativeFixture();
    const diagnostics = new PassThrough();
    const local = await startLocal(true, undefined, diagnostics);
    await local.officialRuntimeScope.start();
    first.notify({
      method: "turn/started",
      params: { threadId: "active-thread", turn: { id: "active-turn", status: "inProgress" } },
    });
    await vi.waitFor(() => expect(local.officialRuntimeScope.owner.hasActiveWork).toBe(true));
    await local.configureStartup({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server", "--analytics-default-enabled"],
      environment: {},
    });
    expect(first.stop).not.toHaveBeenCalled();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledOnce();
    expect(local.officialRuntimeScope.owner.hasActiveWork).toBe(true);
    expect(diagnostics.read()?.toString()).toContain("preserving active official Codex work");
  });

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

  it("closes the owned backend when identity connection initialization fails", async () => {
    const f = nativeFixture();
    f.connect.mockRejectedValueOnce(new Error("Synthetic connection failure"));
    await expect(startLocal()).rejects.toThrow();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.requests).toEqual([]);
  });

  it("prepares the native connection without prefetching identity, then reads it on demand", async () => {
    const f = nativeFixture();
    const local = await startLocal();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.requests.map((r) => r.method)).toEqual(["initialize", "initialized"]);
    expect(local.accountControl.snapshot()).toMatchObject({
      phase: "ready",
      currentAccountId: null,
      accounts: [],
    });
    const result = codexAccountListResultSchema.parse(await local.accountControl.refresh?.());
    expect(result).toMatchObject({
      phase: "ready",
      currentAccountId: "current",
      accounts: [{ accountId: "current", email: "current@example.com", planType: "pro" }],
    });
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.requests.map((r) => r.method)).toEqual(["initialize", "initialized", "account/read"]);
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
