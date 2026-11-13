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
  const start = vi.fn(async () => {});
  vi.mocked(createOwnedLoopbackBackend).mockReturnValue({
    closed: exit.promise,
    start,
    connect,
    stop,
  });
  return {
    requests,
    start,
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
  stockCodexPath = "/synthetic/codex",
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-native-account-host-"));
  temporaryDirectories.add(directory);
  if (savedStartup)
    await writeFile(path.join(directory, "official-startup-v1.json"), JSON.stringify(savedStartup));
  const local = await prepareLocalCodex({
    stockCodexPath,
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
  async function runtimeFiles(name: string, companion = true) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `native-runtime-${name}-`));
    temporaryDirectories.add(directory);
    const executable = path.join(directory, "codex.exe");
    const tool = path.join(directory, "codex-code-mode-host.exe");
    await writeFile(executable, "backend fixture");
    if (companion) await writeFile(tool, "tool fixture");
    return { executable, tool };
  }

  it("rejects a retained generation whose executable was removed without stopping active work", async () => {
    const files = await runtimeFiles("active");
    const first = nativeFixture();
    const local = await startLocal(true, undefined, new PassThrough(), files.executable);
    await local.officialRuntimeScope.start();
    first.notify({
      method: "turn/started",
      params: { threadId: "active", turn: { id: "turn", status: "inProgress" } },
    });
    await vi.waitFor(() => expect(local.officialRuntimeScope.owner.hasActiveWork).toBe(true));
    await rm(files.executable);
    for (const executable of [files.executable, (await runtimeFiles("proposed")).executable]) {
      await expect(
        local.configureStartup({
          stockCodexPath: executable,
          arguments: ["-c", "features.code_mode_host=true", "app-server"],
          environment: {},
        }),
      ).rejects.toThrow("codexhost stop");
    }
    expect(first.stop).not.toHaveBeenCalled();
    expect(local.officialRuntimeScope.owner.hasActiveWork).toBe(true);
    expect(createOwnedLoopbackBackend).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === "win32")(
    "tracks the current generation's companion after an idle runtime replacement",
    async () => {
      const a = await runtimeFiles("a");
      const b = await runtimeFiles("b");
      const first = nativeFixture();
      const local = await startLocal(true, undefined, new PassThrough(), a.executable);
      await local.officialRuntimeScope.start();
      await rm(a.executable);
      nativeFixture();
      const configuration = {
        stockCodexPath: b.executable,
        arguments: ["app-server"],
        environment: {},
      };
      await local.configureStartup(configuration);
      expect(first.stop).toHaveBeenCalledOnce();
      await local.officialRuntimeScope.start();
      await expect(local.configureStartup(configuration)).resolves.toBeUndefined();
      await rm(b.tool);
      await expect(local.configureStartup(configuration)).rejects.toThrow("codexhost stop");
    },
  );

  it("keeps a companion optional when it was absent at generation creation", async () => {
    const files = await runtimeFiles("custom", false);
    const first = nativeFixture();
    const local = await startLocal(true, undefined, new PassThrough(), files.executable);
    await local.officialRuntimeScope.start();
    await local.configureStartup({
      stockCodexPath: files.executable,
      arguments: ["-c", "features.code_mode_host=true", "app-server"],
      environment: {},
    });
    expect(first.stop).not.toHaveBeenCalled();
  });

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

  it("accepts Desktop's valid configuration after a failed startup generation", async () => {
    nativeFixture();
    vi.mocked(createOwnedLoopbackBackend).mockImplementationOnce(
      () =>
        ({
          closed: Promise.resolve({ code: 1, signal: null }),
          start: vi.fn(async () => {
            throw new Error("Synthetic spawn failure");
          }),
          connect: vi.fn(async () => {
            throw new Error("Synthetic connection failure");
          }),
          stop: vi.fn(async () => {}),
        }) as unknown as ReturnType<typeof createOwnedLoopbackBackend>,
    );
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-recovery-startup-"));
    temporaryDirectories.add(directory);
    const local = await prepareLocalCodex({
      stockCodexPath: "/synthetic/broken",
      arguments: ["app-server"],
      environment: { CODEX_HOME: path.join(directory, "home"), CODEXHOST_DATA_DIR: directory },
      diagnosticOutput: new PassThrough(),
      deferStart: true,
      remoteControl: true,
    });
    prepared.add(local);
    await expect(local.officialRuntimeScope.start()).rejects.toThrow("unavailable");
    const configuration = {
      stockCodexPath: "/synthetic/desktop-codex",
      arguments: ["-c", "features.recovered=true", "app-server"],
      environment: {},
    };
    await local.configureStartup(configuration);
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledTimes(2);
    expect(createOwnedLoopbackBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stockCodexPath: configuration.stockCodexPath,
        arguments: configuration.arguments,
      }),
    );
  });

  it.each([false, true])(
    "recovers from a backend factory failure without a generation (factory throws: %s)",
    async (factoryThrows) => {
      nativeFixture();
      if (factoryThrows)
        vi.mocked(createOwnedLoopbackBackend).mockImplementationOnce(() => {
          throw new Error("Synthetic factory failure");
        });
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-factory-recovery-"));
      temporaryDirectories.add(directory);
      const local = await prepareLocalCodex({
        stockCodexPath: factoryThrows ? "/synthetic/broken" : path.resolve("codexhost-shim"),
        arguments: ["app-server"],
        environment: { CODEX_HOME: path.join(directory, "home") },
        diagnosticOutput: new PassThrough(),
        deferStart: true,
        remoteControl: true,
      });
      prepared.add(local);
      await expect(local.officialRuntimeScope.start()).rejects.toThrow("unavailable");
      expect(local.officialRuntimeScope.owner.generation).toBe(0);
      const configuration = {
        stockCodexPath: "/synthetic/desktop-codex",
        arguments: ["-c", "features.recovered=true", "app-server"],
        environment: {},
      };
      await local.configureStartup(configuration);
      await local.officialRuntimeScope.start();
      expect(createOwnedLoopbackBackend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          stockCodexPath: configuration.stockCodexPath,
          arguments: configuration.arguments,
        }),
      );
      expect(local.officialRuntimeScope.owner.running).toBe(true);
      await expect(local.accountControl.refresh?.()).resolves.toMatchObject({ phase: "ready" });
    },
  );

  it("preserves Remote Control configuration while its backend is starting", async () => {
    const first = nativeFixture();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    first.start.mockImplementationOnce(async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-starting-config-"));
    temporaryDirectories.add(directory);
    const local = await prepareLocalCodex({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server"],
      environment: { CODEX_HOME: path.join(directory, "home") },
      diagnosticOutput: new PassThrough(),
      deferStart: true,
      remoteControl: true,
    });
    prepared.add(local);
    const starting = local.officialRuntimeScope.start();
    try {
      await entered.promise;
      expect(local.officialRuntimeScope.owner.running).toBe(false);
      await local.configureStartup({
        stockCodexPath: "/synthetic/replacement",
        arguments: ["app-server", "--analytics-default-enabled"],
        environment: {},
      });
      expect(first.stop).not.toHaveBeenCalled();
    } finally {
      release.resolve(undefined);
      await starting;
    }
    await local.officialRuntimeScope.stop();
    nativeFixture();
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({ stockCodexPath: "/synthetic/codex", arguments: ["app-server"] }),
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

  it("replaces an idle backend when only Desktop's app tools pipe changes", async () => {
    const first = nativeFixture();
    const local = await startLocal(true);
    const configuration = {
      stockCodexPath: "/synthetic/codex",
      arguments: ["-c", "features.code_mode_host=true", "app-server"],
      environment: { CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-1" },
    };
    await local.configureStartup(configuration);
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-1",
        }),
      }),
    );
    nativeFixture();
    // A reopened Desktop creates a new pipe; the idle backend must not keep the stale one.
    await local.configureStartup({
      ...configuration,
      environment: { CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-2" },
    });
    expect(first.stop).toHaveBeenCalledOnce();
    await local.officialRuntimeScope.start();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledTimes(2);
    expect(createOwnedLoopbackBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-2",
        }),
      }),
    );
  });

  it("preserves an active Turn when only Desktop's app tools pipe changes", async () => {
    const first = nativeFixture();
    const diagnostics = new PassThrough();
    const local = await startLocal(true, undefined, diagnostics);
    const configuration = {
      stockCodexPath: "/synthetic/codex",
      arguments: ["-c", "features.code_mode_host=true", "app-server"],
      environment: { CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-1" },
    };
    await local.configureStartup(configuration);
    await local.officialRuntimeScope.start();
    first.notify({
      method: "turn/started",
      params: { threadId: "active-thread", turn: { id: "active-turn", status: "inProgress" } },
    });
    await vi.waitFor(() => expect(local.officialRuntimeScope.owner.hasActiveWork).toBe(true));
    await local.configureStartup({
      ...configuration,
      environment: { CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-2" },
    });
    expect(first.stop).not.toHaveBeenCalled();
    expect(createOwnedLoopbackBackend).toHaveBeenCalledOnce();
    expect(diagnostics.read()?.toString()).toContain("preserving active official Codex work");
  });

  it("starts the next backend on the app tools pipe that arrived during a preserved Turn", async () => {
    const first = nativeFixture();
    const local = await startLocal(true);
    const configuration = {
      stockCodexPath: "/synthetic/codex",
      arguments: ["-c", "features.code_mode_host=true", "app-server"],
      environment: { CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-1" },
    };
    await local.configureStartup(configuration);
    await local.officialRuntimeScope.start();
    first.notify({
      method: "turn/started",
      params: { threadId: "active-thread", turn: { id: "active-turn", status: "inProgress" } },
    });
    await vi.waitFor(() => expect(local.officialRuntimeScope.owner.hasActiveWork).toBe(true));
    await local.configureStartup({
      ...configuration,
      environment: { CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-2" },
    });
    expect(first.stop).not.toHaveBeenCalled();
    // The preserved generation ends on its own; its replacement must use the new pipe.
    nativeFixture();
    first.crash();
    await vi.waitFor(() => expect(createOwnedLoopbackBackend).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    expect(createOwnedLoopbackBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          CODEX_APP_TOOLS_PIPE_PATH: "/synthetic/app-tools-2",
        }),
      }),
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
