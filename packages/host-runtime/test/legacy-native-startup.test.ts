import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { SyntheticPrivateFiles } from "./fixtures/native-account-state.js";

const native = vi.hoisted(() => ({
  files: null as SyntheticPrivateFiles | null,
  storage: "file",
  launches: [] as unknown[],
  live: 0,
  peak: 0,
  stopExternal: vi.fn(async () => {}),
}));
vi.mock("../src/native-process-stop.js", () => ({ stopNativeProcesses: native.stopExternal }));
vi.mock("../src/native-private-files.js", () => ({
  NativePrivateFiles: vi.fn(function () {
    if (!native.files) throw new Error("Missing synthetic files");
    return Object.assign(native.files, {
      withReadOnlyDirectoryAccess() {
        return this;
      },
    });
  }),
}));
vi.mock("../src/native-secret-keys.js", () => ({
  NativeSecretKeys: class {
    async read() {
      return Buffer.alloc(32, 0x51);
    }
  },
}));
vi.mock("../src/codex-runtime/official-cli-version.js", () => ({
  readOfficialCliVersion: async () => "0.154.0-alpha.6.2",
}));
vi.mock("../src/codex-runtime/official-process-record.js", () => ({
  OfficialProcessRecord: class {
    async reconcile() {}
    wrap(factory: (receipt: object) => unknown) {
      return factory({});
    }
  },
}));
vi.mock("../src/codex-runtime/owned-official-backends.js", () => ({
  createOwnedLoopbackBackend: (input: { environment: NodeJS.ProcessEnv }) => backend(input),
  createOwnedStdioBackend: (input: { environment: NodeJS.ProcessEnv }) => backend(input),
}));

import { prepareLocalCodex } from "../src/native-account-host.js";
import { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import {
  SyntheticPrivateFiles as MemoryFiles,
  credential,
} from "./fixtures/native-account-state.js";

const roots: string[] = [];
const timestamp = "2026-09-11T00:00:00.000Z";

// A synthetic native protocol peer: no network, real authentication or OS key calls.
function backend(input: { environment: NodeJS.ProcessEnv }) {
  const closed = Promise.withResolvers<{ code: number; signal: null }>();
  const connections: Array<{ close(): void }> = [];
  let started = false;
  return {
    closed: closed.promise,
    async start() {
      native.launches.push(input);
      started = true;
      native.peak = Math.max(native.peak, ++native.live);
    },
    async connect() {
      const stdin = new PassThrough(),
        stdout = new PassThrough(),
        stderr = new PassThrough();
      const exited = Promise.withResolvers<{ code: number; signal: null }>();
      let pending = "";
      stdin.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const request = JSON.parse(pending.slice(0, newline)) as JsonObject;
          pending = pending.slice(newline + 1);
          if (request.id === undefined) continue;
          let result: unknown = { userAgent: "synthetic-native" };
          if (request.method === "config/read")
            result = { config: { cli_auth_credentials_store: native.storage } };
          if (request.method === "account/read") {
            const raw = native.files?.peek(input.environment.CODEX_HOME ?? "", "auth.json");
            const current = raw ? NativeCodexCredentials.parse(raw.toString()) : null;
            result = {
              account: current
                ? { type: "chatgpt", email: current.email, planType: current.planType }
                : null,
              requiresOpenaiAuth: true,
            };
          }
          if (request.method === "account/rateLimits/read") result = { rateLimits: {} };
          if (["thread/list", "thread/loaded/list"].includes(String(request.method)))
            result = { data: [], nextCursor: null };
          stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
        }
      });
      const close = () => {
        stdin.end();
        stdout.end();
        stderr.end();
        exited.resolve({ code: 0, signal: null });
      };
      connections.push({ close });
      return { stdin, stdout, stderr, closed: exited.promise, close };
    },
    async stop() {
      for (const connection of connections) connection.close();
      if (started) {
        native.live--;
        started = false;
      }
      closed.resolve({ code: 0, signal: null });
    },
  };
}

async function fixture(storage = "file", selected = "current") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-legacy-startup-")));
  roots.push(root);
  const home = path.join(root, "official"),
    other = path.join(root, "other");
  const data = path.join(root, "data"),
    registry = path.join(data, "codex-accounts");
  await Promise.all([mkdir(home), mkdir(other), mkdir(registry, { recursive: true })]);
  const preserved = new Map([
    [path.join(home, "auth.json"), credential("a").serializeForNativeStore()],
    [path.join(other, "auth.json"), credential("b").serializeForNativeStore()],
    [path.join(home, "config.toml"), `cli_auth_credentials_store = "${storage}"\n`],
    [path.join(other, "state.sqlite"), "synthetic history"],
    [
      path.join(registry, "accounts.json"),
      JSON.stringify({
        formatVersion: 1,
        activeAccountId: selected,
        accounts: [
          ["current", home],
          ["other", other],
        ].map(([accountId, codexHome]) => ({
          accountId,
          codexHome,
          label: accountId,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      }),
    ],
    [
      path.join(registry, "thread-accounts.json"),
      JSON.stringify({ formatVersion: 1, bindings: { first: "current", second: "other" } }),
    ],
  ]);
  native.files = new MemoryFiles();
  native.storage = storage;
  for (const [file, bytes] of preserved) {
    await writeFile(file, bytes);
    native.files.seed(path.dirname(file), path.basename(file), bytes);
  }
  return {
    home,
    other,
    preserved,
    files: native.files,
    input: {
      stockCodexPath: path.join(root, "codex"),
      arguments: ["app-server"],
      environment: {
        CODEX_HOME: home,
        CODEXHOST_DATA_DIR: data,
        CODEXHOST_LAUNCHER_EXECUTABLE: path.join(root, "launcher"),
      },
      sharedListener: true,
      diagnosticOutput: new PassThrough(),
    },
  };
}

beforeEach(() => {
  native.stopExternal.mockReset().mockResolvedValue(undefined);
  native.launches.length = 0;
  native.live = 0;
  native.peak = 0;
});
afterEach(async () => {
  expect(native.live).toBe(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("legacy layout to native Account switching composition", () => {
  it("adopts A and B and switches A → B → A within one permanent home and one backend", async () => {
    const f = await fixture();
    const prepared = await prepareLocalCodex(f.input);
    const client = new OfficialRuntimeClient({
      scope: prepared.officialRuntimeScope,
      output: async () => {},
    });
    try {
      await client.initialize();
      await client.initializeProtocol({
        clientInfo: { name: "synthetic-desktop", version: "test" },
      });
      const initial = prepared.accountControl.snapshot();
      expect(initial).toMatchObject({
        phase: "ready",
        legacyHistoryPreserved: true,
        capabilities: { switch: true },
      });
      expect(initial.accounts).toHaveLength(2);
      const other = initial.accounts.find(
        (account) => account.accountId !== initial.currentAccountId,
      );
      if (!other || !initial.currentAccountId) throw new Error("Missing adopted identities");
      await prepared.accountControl.switch(other.accountId);
      expect(f.files.peek(f.home, "auth.json")?.toString()).toBe(
        credential("b").serializeForNativeStore(),
      );
      await expect(client.request("account/read", { refreshToken: false })).resolves.toMatchObject({
        result: { account: { email: credential("b").email } },
      });
      await prepared.accountControl.switch(initial.currentAccountId);
      expect(f.files.peek(f.home, "auth.json")?.toString()).toBe(
        credential("a").serializeForNativeStore(),
      );
      expect(native.stopExternal).toHaveBeenCalledTimes(2);
      expect(native.peak).toBe(1);
      for (const launch of native.launches)
        expect(launch).toMatchObject({ environment: { CODEX_HOME: f.home } });
      expect(f.files.peek(f.other, "auth.json")?.toString()).toBe(
        credential("b").serializeForNativeStore(),
      );
    } finally {
      await client.close();
      await prepared.close();
    }
    for (const [file, bytes] of f.preserved) expect(await readFile(file, "utf8")).toBe(bytes);
    // Existing managed state in the selected home is recovered, not mistaken for a foreign layout.
    const restarted = await prepareLocalCodex(f.input);
    try {
      expect(restarted.accountControl.snapshot().accounts).toHaveLength(2);
    } finally {
      await restarted.close();
    }
  });

  it("refuses replacement when external backend termination fails", async () => {
    const f = await fixture();
    const prepared = await prepareLocalCodex(f.input);
    try {
      const initial = prepared.accountControl.snapshot();
      const other = initial.accounts.find(
        (account) => account.accountId !== initial.currentAccountId,
      );
      if (!other) throw new Error("Missing saved Account");
      native.stopExternal.mockRejectedValue(new Error("exit unconfirmed"));
      await expect(prepared.accountControl.switch(other.accountId)).rejects.toThrow();
      expect(f.files.peek(f.home, "auth.json")?.toString()).toBe(
        credential("a").serializeForNativeStore(),
      );
      expect(prepared.accountControl.snapshot().currentAccountId).toBe(initial.currentAccountId);
    } finally {
      await prepared.close();
    }
  });

  it.each(["current", "other"])(
    "does not adopt through unresolved managed state in %s home",
    async (location) => {
      const f = await fixture();
      const directory = path.join(
        location === "current" ? f.home : f.other,
        ".codexhost-native-accounts",
      );
      await mkdir(directory);
      await writeFile(path.join(directory, "transaction.json"), "unresolved");
      f.files.seed(directory, "transaction.json", "unresolved");
      const prepared = await prepareLocalCodex(f.input);
      try {
        expect(prepared.accountControl.snapshot().capabilities.switch).toBe(false);
        expect(native.launches).toHaveLength(0);
        expect(await readFile(path.join(directory, "transaction.json"), "utf8")).toBe("unresolved");
      } finally {
        await prepared.close();
      }
    },
  );

  it.each(["auto", "keyring"])(
    "keeps native startup without rewriting unsupported %s storage",
    async (storage) => {
      const f = await fixture(storage);
      const prepared = await prepareLocalCodex(f.input);
      try {
        expect(prepared.allowNativeAuthPassthrough).toBe(true);
        expect(prepared.accountControl.snapshot().capabilities).toMatchObject({
          switch: false,
          reason: "unsupported-storage",
        });
        await prepared.officialRuntimeScope.start();
        expect(prepared.officialRuntimeScope.gate.phase).toBe("ready");
      } finally {
        await prepared.close();
      }
      for (const [file, bytes] of f.preserved) expect(await readFile(file, "utf8")).toBe(bytes);
    },
  );

  it("does not start or import when the selected Account uses another home", async () => {
    const f = await fixture("file", "other");
    const prepared = await prepareLocalCodex(f.input);
    try {
      expect(prepared.accountControl.snapshot().capabilities.switch).toBe(false);
      await expect(prepared.officialRuntimeScope.start()).rejects.toThrow();
      expect(native.launches).toHaveLength(0);
      expect(
        f.files.peek(path.join(f.home, ".codexhost-native-accounts"), "vault.json"),
      ).toBeNull();
    } finally {
      await prepared.close();
    }
  });
});
