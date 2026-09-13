import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  interface FixtureFiles {
    contents: Map<string, Buffer>;
    activeLeases: number;
    ensureDirectory(directory: string): Promise<void>;
    read(directory: string, name: string): Promise<Buffer | null>;
    replace(
      directory: string,
      name: string,
      content: Uint8Array,
      expected: string | null,
    ): Promise<void>;
    remove(directory: string, name: string, expected: string): Promise<void>;
    lock(
      directory: string,
      name: string,
    ): Promise<{
      closed: Promise<{ code: number; signal: null }>;
      release(): Promise<void>;
    }>;
  }
  interface Fixture {
    layout: object;
    files: FixtureFiles;
    key: Buffer | null;
    keyReadError?: Error;
    initializationError?: Error;
    startBeforeInitializationError: boolean;
    reconcileError?: Error;
    version: string;
    events: string[];
    managedSnapshot: {
      version: 2;
      currentAccountId: string | null;
      phase: "ready" | "changing" | "unavailable";
      revision: number;
      capabilities: {
        manage: boolean;
        switch: boolean;
        login: boolean;
        delete: boolean;
        recover: boolean;
        logout: boolean;
        reason?: "recovery-required";
      };
      accounts: [];
    };
  }
  const state = {
    current: null as Fixture | null,
    fileConstructions: 0,
    keyConstructions: 0,
    recordConstructions: 0,
    runtimeConstructions: 0,
    accountConstructions: 0,
    accountInstances: [] as object[],
    nativeLaunches: [] as unknown[],
    externalStop: undefined as (() => Promise<void>) | undefined,
  };
  const current = (): Fixture => {
    if (!state.current) throw new Error("native account host fixture is unavailable");
    return state.current;
  };
  class NativePrivateFiles {
    constructor(input: unknown) {
      void input;
      state.fileConstructions++;
    }
    withReadOnlyDirectoryAccess(): this {
      return this;
    }
    ensureDirectory(directory: string): Promise<void> {
      return current().files.ensureDirectory(directory);
    }
    read(directory: string, name: string): Promise<Buffer | null> {
      return current().files.read(directory, name);
    }
    replace(
      directory: string,
      name: string,
      content: Uint8Array,
      expected: string | null,
    ): Promise<void> {
      return current().files.replace(directory, name, content, expected);
    }
    remove(directory: string, name: string, expected: string): Promise<void> {
      return current().files.remove(directory, name, expected);
    }
    lock(directory: string, name: string) {
      return current().files.lock(directory, name);
    }
  }
  class NativeSecretKeys {
    constructor(input: unknown) {
      void input;
      state.keyConstructions++;
    }
    async read(): Promise<Buffer | null> {
      const fixture = current();
      if (fixture.keyReadError) throw fixture.keyReadError;
      return fixture.key ? Buffer.from(fixture.key) : null;
    }
  }
  class OfficialProcessRecord {
    constructor(input: unknown) {
      void input;
      state.recordConstructions++;
    }
    async reconcile(): Promise<void> {
      if (current().reconcileError) throw current().reconcileError;
    }
    wrap(factory: (receipt: { directory: string; name: string; tag: string }) => object): object {
      return factory({ directory: "/synthetic", name: "process.json", tag: "fixture" });
    }
  }
  class OfficialAccountRuntime {
    readonly owner: {
      gate: { initialized(): void; unavailable(): void };
      start(input: { mode: "management-only" }): Promise<void>;
      stop(): Promise<void>;
    };
    readonly nativeVersion: () => Promise<string>;
    readonly reconcilePreviousWriter: () => Promise<void>;
    constructor(input: {
      owner: OfficialAccountRuntime["owner"];
      nativeVersion(): Promise<string>;
      reconcilePreviousWriter(): Promise<void>;
      stopExternalProcesses?(): Promise<void>;
    }) {
      state.runtimeConstructions++;
      state.externalStop = input.stopExternalProcesses;
      this.owner = input.owner;
      this.nativeVersion = input.nativeVersion;
      this.reconcilePreviousWriter = input.reconcilePreviousWriter;
    }
    async initializeFixture(): Promise<void> {
      await this.nativeVersion();
      await this.reconcilePreviousWriter();
      const fixture = current();
      if (fixture.initializationError) {
        if (fixture.startBeforeInitializationError) {
          await this.owner.start({ mode: "management-only" });
          this.owner.gate.unavailable();
        }
        throw fixture.initializationError;
      }
      await this.owner.start({ mode: "management-only" });
      this.owner.gate.initialized();
    }
    stop(): Promise<void> {
      current().events.push("runtime-stop");
      return this.owner.stop();
    }
  }
  class NativeCodexAccounts {
    constructor(
      private readonly input: {
        runtime: OfficialAccountRuntime;
      },
    ) {
      state.accountConstructions++;
      state.accountInstances.push(this);
    }
    initialize(): Promise<void> {
      return this.input.runtime.initializeFixture();
    }
    async close(): Promise<void> {
      current().events.push("accounts-close");
    }
    snapshot() {
      return structuredClone(current().managedSnapshot);
    }
    currentAccountId(): string | null {
      return this.snapshot().currentAccountId;
    }
    switch(): Promise<void> {
      return Promise.reject(new Error("fixture account operation unavailable"));
    }
    remove(): Promise<void> {
      return Promise.reject(new Error("fixture account operation unavailable"));
    }
    startLogin(): Promise<never> {
      return Promise.reject(new Error("fixture account operation unavailable"));
    }
    cancelLogin(): Promise<boolean> {
      return Promise.resolve(false);
    }
    logout(): Promise<void> {
      return Promise.reject(new Error("fixture account operation unavailable"));
    }
    recover(): Promise<void> {
      return Promise.reject(new Error("fixture account recovery unavailable"));
    }
    observe(): void {}
    subscribeLogin(): () => void {
      return () => undefined;
    }
  }
  return {
    state,
    current,
    NativePrivateFiles,
    NativeSecretKeys,
    OfficialProcessRecord,
    OfficialAccountRuntime,
    NativeCodexAccounts,
  };
});

vi.mock("../src/account/native-account-layout.js", () => ({
  canonicalCodexHome: async (home: string) => path.resolve(home),
  inspectNativeAccountLayout: async () => native.current().layout,
}));
vi.mock("../src/native-private-files.js", () => ({
  NativePrivateFiles: native.NativePrivateFiles,
}));
vi.mock("../src/native-secret-keys.js", () => ({ NativeSecretKeys: native.NativeSecretKeys }));
vi.mock("../src/codex-runtime/official-process-record.js", () => ({
  OfficialProcessRecord: native.OfficialProcessRecord,
}));
vi.mock("../src/account/official-account-runtime.js", () => ({
  OfficialAccountRuntime: native.OfficialAccountRuntime,
}));
vi.mock("../src/account/native-codex-accounts.js", () => ({
  NativeCodexAccounts: native.NativeCodexAccounts,
}));
vi.mock("../src/codex-runtime/official-cli-version.js", () => ({
  readOfficialCliVersion: async () => native.current().version,
}));
vi.mock("../src/native-process-identity.js", () => ({
  readNativeProcessIdentity: async () => null,
}));
vi.mock("../src/native-process-stop.js", () => ({
  stopNativeProcesses: vi.fn(async () => undefined),
}));
vi.mock("../src/codex-runtime/owned-official-backends.js", () => ({
  createOwnedLoopbackBackend: () => createBackend(),
  createOwnedStdioBackend: () => createBackend(),
}));

vi.mock("../src/remote-official-app-server.js", () => ({
  createLoopbackOfficialAppServerListener: (input: unknown) => {
    native.state.nativeLaunches.push(input);
    const backend = createBackend();
    return {
      closed: backend.closed,
      processId: backend.processId,
      async listen() {
        await backend.start();
        return "ws://127.0.0.1:43210";
      },
      close: () => backend.stop(),
    };
  },
}));

import { prepareLocalCodex } from "../src/native-account-host.js";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import { stopNativeProcesses } from "../src/native-process-stop.js";

interface HostFixture {
  root: string;
  home: string;
  data: string;
  launcher: string;
  files: ReturnType<typeof createFiles>;
  input(overrides?: { launcher?: string; sharedListener?: boolean }): {
    stockCodexPath: string;
    arguments: string[];
    environment: NodeJS.ProcessEnv;
    sharedListener: boolean;
    diagnosticOutput: Writable;
  };
}

const temporaryRoots: string[] = [];

function fileKey(directory: string, name: string): string {
  return path.join(directory, name);
}

function createFiles(events: string[]) {
  const contents = new Map<string, Buffer>();
  return {
    contents,
    activeLeases: 0,
    ensureDirectory: vi.fn(async () => {}),
    read: vi.fn(async (directory: string, name: string) => {
      const value = contents.get(fileKey(directory, name));
      return value ? Buffer.from(value) : null;
    }),
    replace: vi.fn(
      async (directory: string, name: string, content: Uint8Array, expected: string | null) => {
        void expected;
        contents.set(fileKey(directory, name), Buffer.from(content));
      },
    ),
    remove: vi.fn(async (directory: string, name: string, expected: string) => {
      void expected;
      contents.delete(fileKey(directory, name));
    }),
    lock: vi.fn(async () => {
      const closed = Promise.withResolvers<{ code: number; signal: null }>();
      const files = native.current().files;
      files.activeLeases++;
      let released = false;
      return {
        closed: closed.promise,
        release: async () => {
          if (released) return;
          released = true;
          events.push("lease-release");
          files.activeLeases--;
          closed.resolve({ code: 0, signal: null });
        },
      };
    }),
  };
}

function createBackend() {
  const fixture = native.current();
  const closed = Promise.withResolvers<{ code: number; signal: null }>();
  return {
    closed: closed.promise,
    processId: 41,
    async start() {
      fixture.events.push("backend-start");
    },
    async connect() {
      throw new Error("fixture backend has no protocol connection");
    },
    async stop() {
      fixture.events.push("backend-stop");
      closed.resolve({ code: 0, signal: null });
    },
  };
}

async function fixture(
  options: {
    keyAvailable?: boolean;
    initializationError?: Error;
    startBeforeInitializationError?: boolean;
    reconcileError?: Error;
    layout?: object;
  } = {},
): Promise<HostFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "codexhost-native-account-host-"));
  temporaryRoots.push(root);
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  const events: string[] = [];
  const files = createFiles(events);
  native.state.current = {
    layout: options.layout ?? { kind: "new" },
    files,
    key: options.keyAvailable === false ? null : Buffer.alloc(32, 0x5a),
    ...(options.initializationError ? { initializationError: options.initializationError } : {}),
    startBeforeInitializationError: options.startBeforeInitializationError ?? false,
    ...(options.reconcileError ? { reconcileError: options.reconcileError } : {}),
    version: "0.153.4",
    events,
    managedSnapshot: {
      version: 2,
      currentAccountId: null,
      phase: options.initializationError ? "unavailable" : "ready",
      revision: 1,
      capabilities: {
        manage: true,
        switch: true,
        login: true,
        delete: true,
        recover: true,
        logout: true,
        ...(options.initializationError ? { reason: "recovery-required" as const } : {}),
      },
      accounts: [],
    },
  };
  const launcher = path.join(root, "codexhost-launcher");
  return {
    root,
    home,
    data,
    launcher,
    files,
    input(overrides = {}) {
      return {
        stockCodexPath: path.join(root, "codex"),
        arguments: ["app-server"],
        environment: {
          CODEX_HOME: home,
          CODEXHOST_DATA_DIR: data,
          ...(overrides.launcher === undefined
            ? { CODEXHOST_LAUNCHER_EXECUTABLE: launcher }
            : overrides.launcher
              ? { CODEXHOST_LAUNCHER_EXECUTABLE: overrides.launcher }
              : {}),
        },
        sharedListener: overrides.sharedListener ?? false,
        diagnosticOutput: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      };
    },
  };
}

beforeEach(() => {
  vi.mocked(stopNativeProcesses).mockClear();
  native.state.externalStop = undefined;
  native.state.current = null;
  native.state.fileConstructions = 0;
  native.state.keyConstructions = 0;
  native.state.recordConstructions = 0;
  native.state.runtimeConstructions = 0;
  native.state.accountConstructions = 0;
  native.state.accountInstances.length = 0;
  native.state.nativeLaunches.length = 0;
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("local native Account composition", () => {
  it("allows native authentication pass-through with no launcher and no managed state", async () => {
    const f = await fixture();
    const prepared = await prepareLocalCodex(f.input({ launcher: "" }));
    expect(prepared.allowNativeAuthPassthrough).toBe(true);
    expect(prepared.accountControl.snapshot().capabilities.reason).toBe("unsupported-storage");
    expect(native.state.fileConstructions).toBe(0);
    await prepared.close();
  });

  it("blocks a missing launcher when a managed directory already exists", async () => {
    const f = await fixture();
    await mkdir(path.join(f.home, ".codexhost-native-accounts"));
    const prepared = await prepareLocalCodex(f.input({ launcher: "" }));
    expect(prepared.allowNativeAuthPassthrough).toBe(false);
    expect(prepared.accountControl.snapshot().capabilities.reason).toBe("recovery-required");
    expect(native.state.fileConstructions).toBe(0);
    await expect(prepared.officialRuntimeScope.start()).rejects.toMatchObject({
      code: "unavailable",
    });
    await prepared.close();
  });

  it("blocks multiple legacy homes before constructing keys, files, or a backend", async () => {
    const f = await fixture({
      layout: { kind: "migration-required", reason: "multiple-homes", homes: [] },
    });
    const input = f.input();
    const diagnostic = vi.spyOn(input.diagnosticOutput, "write");
    const prepared = await prepareLocalCodex(input);
    expect(diagnostic).toHaveBeenCalledWith(
      "codexhost: Codex Account startup blocked (migration-required)\n",
    );
    expect(prepared.accountControl.snapshot().capabilities.reason).toBe("migration-required");
    expect(native.state.fileConstructions).toBe(0);
    expect(native.state.keyConstructions).toBe(0);
    expect(native.state.recordConstructions).toBe(0);
    expect(native.current().events).toEqual([]);
    await prepared.close();
  });

  it("preserves native startup for an eligible legacy layout without initializing account management", async () => {
    const f = await fixture({
      layout: {
        kind: "migration-required",
        reason: "multiple-homes",
        homes: [],
        nativeCompatibility: { accountId: "legacy-current", registryDigest: "original" },
      },
    });
    const input = f.input({ sharedListener: true });
    const prepared = await prepareLocalCodex(input);
    try {
      expect(prepared.allowNativeAuthPassthrough).toBe(true);
      expect(prepared.accountControl.snapshot().capabilities).toMatchObject({
        manage: false,
        switch: false,
        login: false,
        delete: false,
        reason: "migration-required",
      });
      expect(native.state.fileConstructions).toBe(0);
      expect(native.state.keyConstructions).toBe(0);
      expect(native.state.accountConstructions).toBe(0);
      await prepared.officialRuntimeScope.start();
      await prepared.officialRuntimeScope.start();
      expect(native.current().events).toEqual(["backend-start"]);
      expect(native.state.nativeLaunches).toHaveLength(1);
      expect(native.state.nativeLaunches[0]).toMatchObject({
        stockCodexPath: input.stockCodexPath,
        environment: { CODEX_HOME: f.home },
      });
      expect(prepared.officialRuntimeScope.gate.phase).toBe("ready");
    } finally {
      await prepared.close();
    }
    expect(native.current().events).toEqual(["backend-start", "backend-stop"]);
    expect(f.files.replace).not.toHaveBeenCalled();
  });

  it("retains legacy native startup and authentication without account management", async () => {
    const f = await fixture({
      layout: {
        kind: "migration-required",
        reason: "multiple-homes",
        homes: [],
        nativeCompatibility: { accountId: "legacy-current", registryDigest: "original" },
      },
    });
    const prepared = await prepareLocalCodex(f.input({ sharedListener: true }));
    try {
      expect(prepared.allowNativeAuthPassthrough).toBe(true);
      expect(prepared.accountControl.snapshot().capabilities).toMatchObject({
        manage: false,
        switch: false,
        login: false,
        logout: false,
        reason: "migration-required",
      });
      await prepared.officialRuntimeScope.start();
      expect(prepared.officialRuntimeScope.gate.phase).toBe("ready");
      expect(native.state.keyConstructions).toBe(0);
      expect(native.state.fileConstructions).toBe(0);
      await expect(prepared.accountControl.switch("other")).rejects.toThrow();
      await expect(prepared.accountControl.startLogin()).rejects.toThrow();
      await expect(prepared.accountControl.logout()).rejects.toThrow();
    } finally {
      await prepared.close();
    }
  });

  it("refuses legacy compatibility without a native helper, without creating keys or starting a backend", async () => {
    const f = await fixture({
      layout: {
        kind: "migration-required",
        reason: "multiple-homes",
        homes: [],
        nativeCompatibility: { accountId: "legacy-current", registryDigest: "original" },
      },
    });
    const prepared = await prepareLocalCodex(
      f.input({
        sharedListener: true,
        launcher: "",
      }),
    );
    expect(prepared.allowNativeAuthPassthrough).toBe(false);
    await expect(prepared.officialRuntimeScope.start()).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(native.state.keyConstructions).toBe(0);
    expect(native.current().events).toEqual([]);
    await prepared.close();
  });

  it.each(["layout-changed", "managed-state-appeared"])(
    "rechecks legacy admission at backend start: %s",
    async (failure) => {
      const f = await fixture({
        layout: {
          kind: "migration-required",
          reason: "multiple-homes",
          homes: [],
          nativeCompatibility: { accountId: "legacy-current", registryDigest: "original" },
        },
      });
      const prepared = await prepareLocalCodex(f.input({ sharedListener: true }));
      expect(prepared.allowNativeAuthPassthrough).toBe(true);
      native.current().layout = {
        kind: "migration-required",
        reason: "multiple-homes",
        homes: [],
        ...(failure === "layout-changed"
          ? {
              nativeCompatibility: { accountId: "other", registryDigest: "changed" },
            }
          : {}),
      };
      await expect(prepared.officialRuntimeScope.start()).rejects.toThrow();
      expect(native.current().events).not.toContain("backend-start");
      await prepared.close();
    },
  );

  it("initializes normal account management without an available keyring", async () => {
    const f = await fixture({ keyAvailable: false });
    const prepared = await prepareLocalCodex(f.input());
    expect(prepared.allowNativeAuthPassthrough).toBe(false);
    expect(prepared.accountControl.snapshot().capabilities.manage).toBe(true);
    expect(f.files.activeLeases).toBe(1);

    await prepared.officialRuntimeScope.start();
    await prepared.close();
    expect(native.current().events).toContain("backend-stop");
    expect(native.current().events.at(-1)).toBe("lease-release");
    expect(f.files.activeLeases).toBe(0);
  });

  it.each(["transaction.json", "login.json"])(
    "does not start a competing backend when a locked store has pending %s state",
    async (name) => {
      const f = await fixture({ keyAvailable: false });
      f.files.contents.set(
        fileKey(path.join(f.home, ".codexhost-native-accounts"), name),
        Buffer.from("pending"),
      );
      const prepared = await prepareLocalCodex(f.input());
      expect(prepared.allowNativeAuthPassthrough).toBe(false);
      expect(prepared.accountControl.snapshot().capabilities.reason).toBe("recovery-required");
      expect(native.current().events).toEqual(["lease-release"]);
      expect(f.files.activeLeases).toBe(0);
      await prepared.close();
    },
  );

  it("does not start a competing backend when previous-writer reconciliation is unconfirmed", async () => {
    const f = await fixture({ keyAvailable: false, reconcileError: new Error("writer active") });
    const prepared = await prepareLocalCodex(f.input());
    expect(prepared.allowNativeAuthPassthrough).toBe(false);
    expect(prepared.officialRuntimeScope.gate.phase).toBe("unavailable");
    expect(native.current().events).not.toContain("backend-start");
    await prepared.close();
  });

  it.each(["unsupported-version", "unsupported-storage"])(
    "falls back for clean %s initialization without abandoning the lease",
    async (code) => {
      const error = Object.assign(new Error(code), { code });
      const f = await fixture({ initializationError: error });
      const prepared = await prepareLocalCodex(f.input());
      expect(prepared.allowNativeAuthPassthrough).toBe(true);
      expect(prepared.accountControl.snapshot().capabilities.reason).toBe(code);
      expect(f.files.activeLeases).toBe(1);
      expect(native.current().events).toEqual(["runtime-stop", "accounts-close"]);
      await prepared.close();
      expect(native.current().events.at(-1)).toBe("lease-release");
    },
  );

  it("keeps failed recovery managed and prevents Scope from implicitly starting it", async () => {
    const f = await fixture({
      initializationError: new Error("recovery failed"),
      startBeforeInitializationError: true,
    });
    const prepared = await prepareLocalCodex(f.input());
    expect(prepared.allowNativeAuthPassthrough).toBe(false);
    expect(prepared.accountControl.snapshot()).toMatchObject({
      phase: "unavailable",
      capabilities: { reason: "recovery-required", recover: true },
    });
    expect(prepared.officialRuntimeScope.owner.running).toBe(true);
    await expect(prepared.officialRuntimeScope.start()).rejects.toMatchObject({
      code: "unavailable",
    });
    const appServerClient = new OfficialRuntimeClient({
      scope: prepared.officialRuntimeScope,
      output: async () => {},
    });
    await expect(appServerClient.initialize()).rejects.toMatchObject({ code: "unavailable" });
    await appServerClient.close();
    expect(native.current().events.filter((event) => event === "backend-start")).toHaveLength(1);
    await prepared.close();
    expect(native.current().events.indexOf("backend-stop")).toBeLessThan(
      native.current().events.indexOf("lease-release"),
    );
  });

  it.each(["fresh", "managed", "legacy"] as const)(
    "starts and closes %s mode without terminating external backends",
    async (mode) => {
      const f = await fixture(
        mode === "legacy"
          ? {
              layout: {
                kind: "migration-required",
                reason: "multiple-homes",
                homes: [],
                nativeCompatibility: { accountId: "legacy-current", registryDigest: "original" },
              },
            }
          : {},
      );
      if (mode === "managed")
        await mkdir(path.join(f.home, ".codexhost-native-accounts"), { recursive: true });
      const prepared = await prepareLocalCodex(f.input({ sharedListener: true }));
      try {
        await prepared.officialRuntimeScope.start();
        expect(prepared.officialRuntimeScope.gate.phase).toBe("ready");
        expect(stopNativeProcesses).not.toHaveBeenCalled();
      } finally {
        await prepared.close();
      }
      expect(stopNativeProcesses).not.toHaveBeenCalled();
    },
  );

  it("allows external backends at startup and always wires a switch-only stop", async () => {
    const f = await fixture();
    const input = f.input();
    const prepared = await prepareLocalCodex(input);
    try {
      expect(prepared.officialRuntimeScope.owner.running).toBe(true);
      expect(prepared.officialRuntimeScope.gate.phase).toBe("ready");
      expect(stopNativeProcesses).not.toHaveBeenCalled();
      expect(native.state.externalStop).toBeTypeOf("function");
      await native.state.externalStop?.();
      expect(stopNativeProcesses).toHaveBeenCalledWith({
        launcher: f.launcher,
        executableNames: ["codex", "codex", "codex.exe"],
        environment: input.environment,
      });
    } finally {
      await prepared.close();
    }
    expect(stopNativeProcesses).toHaveBeenCalledOnce();
  });

  it("returns exactly one shared Scope and one Account control", async () => {
    const f = await fixture();
    const prepared = await prepareLocalCodex(f.input());
    expect(native.state.runtimeConstructions).toBe(1);
    expect(native.state.accountConstructions).toBe(1);
    expect(native.state.accountInstances).toEqual([prepared.accountControl]);
    expect(prepared.officialRuntimeScope.owner.running).toBe(true);
    await prepared.officialRuntimeScope.start();
    expect(native.current().events.filter((event) => event === "backend-start")).toHaveLength(1);
    await prepared.close();
  });
});
