import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type * as OfficialConnection from "../src/official-app-server-connection.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  inventory: vi.fn(async (): Promise<number[]> => []),
  managed: vi.fn(() => {
    throw new Error("Compatibility must not initialize managed storage");
  }),
}));
vi.mock("../src/official-app-server-connection.js", async (original) => ({
  ...(await original<typeof OfficialConnection>()),
  spawnOfficialAppServerConnection: native.spawn,
}));
vi.mock("../src/native-process-inventory.js", () => ({ readNativeProcessIds: native.inventory }));
vi.mock("../src/native-private-files.js", () => ({ NativePrivateFiles: native.managed }));
vi.mock("../src/native-secret-keys.js", () => ({ NativeSecretKeys: native.managed }));

import { prepareLocalCodex } from "../src/native-account-host.js";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";

const roots: string[] = [];
const timestamp = "2026-09-11T00:00:00.000Z";
const identity = { type: "chatgpt", email: "existing@example.test", planType: "plus" };

// A synthetic native protocol peer: no network, real authentication or OS key calls.
function connection() {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const closed = Promise.withResolvers<{ code: number; signal: null }>();
  let pending = "";
  stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const request = JSON.parse(pending.slice(0, newline)) as JsonObject;
      pending = pending.slice(newline + 1);
      if (request.id === undefined) continue;
      const result =
        request.method === "account/read"
          ? { account: identity, requiresOpenaiAuth: true }
          : { userAgent: "synthetic-native" };
      stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  const close = () => {
    stdin.end();
    stdout.end();
    stderr.end();
    closed.resolve({ code: 0, signal: null });
  };
  return { stdin, stdout, stderr, closed: closed.promise, close, stopProcess: async () => close() };
}

async function fixture(storage = "auto", selected = "current") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-legacy-startup-")));
  roots.push(root);
  const home = path.join(root, "official"),
    other = path.join(root, "other");
  const data = path.join(root, "data"),
    registry = path.join(data, "codex-accounts");
  await Promise.all([mkdir(home), mkdir(other), mkdir(registry, { recursive: true })]);
  const preserved = new Map([
    [path.join(home, "auth.json"), "synthetic opaque credential bytes\n"],
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
      JSON.stringify({
        formatVersion: 1,
        bindings: { first: "current", second: "other" },
      }),
    ],
  ]);
  for (const [file, bytes] of preserved) await writeFile(file, bytes);
  return {
    home,
    other,
    preserved,
    input: {
      stockCodexPath: path.join(root, "codex"),
      arguments: ["app-server"],
      environment: {
        CODEX_HOME: home,
        CODEXHOST_DATA_DIR: data,
        CODEXHOST_LAUNCHER_EXECUTABLE: path.join(root, "launcher"),
      },
      sharedListener: false,
      diagnosticOutput: new PassThrough(),
    },
  };
}

beforeEach(() => {
  native.spawn.mockReset().mockImplementation(connection);
  native.inventory.mockReset().mockResolvedValue([]);
  native.managed.mockClear();
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("legacy layout to native Desktop protocol compatibility", () => {
  it.each(["file", "auto", "keyring"])(
    "retains native account/read without rewriting %s storage or historical data",
    async (storage) => {
      const f = await fixture(storage);
      const prepared = await prepareLocalCodex(f.input);
      const client = new OfficialRuntimeClient({
        scope: prepared.officialRuntimeScope,
        output: async () => {},
      });
      try {
        await client.initialize();
        await expect(
          client.initializeProtocol({ clientInfo: { name: "synthetic-desktop", version: "test" } }),
        ).resolves.toMatchObject({ result: { userAgent: "synthetic-native" } });
        await expect(
          client.request("account/read", { refreshToken: false }),
        ).resolves.toMatchObject({ result: { account: identity } });
        expect(native.spawn).toHaveBeenCalledOnce();
        expect(native.spawn).toHaveBeenCalledWith(
          expect.objectContaining({ environment: expect.objectContaining({ CODEX_HOME: f.home }) }),
        );
        expect(native.managed).not.toHaveBeenCalled();
        expect(prepared.accountControl.snapshot()).toMatchObject({
          phase: "ready",
          capabilities: { manage: false, reason: "migration-required" },
        });
        await expect(prepared.accountControl.switch("other")).rejects.toMatchObject({
          code: "unavailable",
        });
      } finally {
        await client.close();
        await prepared.close();
      }
      for (const [file, bytes] of f.preserved) expect(await readFile(file, "utf8")).toBe(bytes);
      expect(await readdir(f.home)).not.toContain(".codexhost-native-accounts");
    },
  );

  it("rechecks writer admission after a proven backend retirement", async () => {
    const f = await fixture();
    const prepared = await prepareLocalCodex(f.input);
    try {
      await prepared.officialRuntimeScope.start();
      await prepared.officialRuntimeScope.owner.stop();
      native.inventory.mockResolvedValue([424242]);
      await expect(prepared.officialRuntimeScope.owner.start({ mode: "task" })).rejects.toThrow();
      expect(native.spawn).toHaveBeenCalledOnce();
      expect(native.managed).not.toHaveBeenCalled();
    } finally {
      await prepared.close();
    }
  });

  it("does not silently replace a selected non-default legacy home", async () => {
    const f = await fixture("auto", "other");
    const prepared = await prepareLocalCodex(f.input);
    try {
      await expect(prepared.officialRuntimeScope.start()).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(prepared.allowNativeAuthPassthrough).toBe(false);
      expect(native.spawn).not.toHaveBeenCalled();
      expect(native.managed).not.toHaveBeenCalled();
    } finally {
      await prepared.close();
    }
  });

  it.each(["official", "other"])(
    "rejects a pending transaction appearing in %s home after preparation",
    async (location) => {
      const f = await fixture();
      const prepared = await prepareLocalCodex(f.input);
      const directory = path.join(
        location === "official" ? f.home : f.other,
        ".codexhost-native-accounts",
      );
      await mkdir(directory);
      await writeFile(path.join(directory, "transaction.json"), "synthetic unresolved transaction");
      try {
        await expect(prepared.officialRuntimeScope.start()).rejects.toThrow();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(native.managed).not.toHaveBeenCalled();
        expect(await readFile(path.join(directory, "transaction.json"), "utf8")).toBe(
          "synthetic unresolved transaction",
        );
      } finally {
        await prepared.close();
      }
    },
  );
});
