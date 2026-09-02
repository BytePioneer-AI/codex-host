import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AccountRepository,
  CodexRuntimePool,
  ThreadAccountStore,
  type CodexAccount,
} from "../src/index.js";
import type { OfficialAppServerConnection } from "../src/official-app-server-connection.js";
import { PassThrough } from "node:stream";

describe("Codex Account routing persistence", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("persists account metadata and Thread ownership without credential fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-account-store-test-"));
    directories.push(directory);
    const firstAccounts = new AccountRepository({
      directory,
      defaultAccount: {
        accountId: "account-a",
        codexHome: path.join(directory, "home-a"),
      },
    });
    const firstThreads = new ThreadAccountStore({ directory });
    await Promise.all([firstAccounts.initialize(), firstThreads.initialize()]);
    await firstAccounts.upsert({
      accountId: "account-b",
      codexHome: path.join(directory, "home-b"),
      email: "second@example.com",
      label: "Second Account",
    });
    await firstAccounts.setActiveAccountId("account-b");
    await firstThreads.bind("thread-b", "account-b");

    const restoredAccounts = new AccountRepository({
      directory,
      defaultAccount: {
        accountId: "unused-default",
        codexHome: path.join(directory, "unused-home"),
      },
    });
    const restoredThreads = new ThreadAccountStore({ directory });
    await Promise.all([restoredAccounts.initialize(), restoredThreads.initialize()]);

    await expect(restoredAccounts.getActiveAccountId()).resolves.toBe("account-b");
    await expect(restoredAccounts.get("account-b")).resolves.toMatchObject({
      codexHome: path.join(directory, "home-b"),
      email: "second@example.com",
      label: "Second Account",
    });
    await expect(restoredThreads.getAccountId("thread-b")).resolves.toBe("account-b");
    const serialized = await readFile(path.join(directory, "accounts.json"), "utf8");
    expect(serialized).not.toMatch(/access[_-]?token|refresh[_-]?token|auth\.json/iu);
  });

  it("creates an isolated CODEX_HOME before lazily spawning an Account runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-runtime-home-test-"));
    directories.push(directory);
    const codexHome = path.join(directory, "homes", "account-a");
    const accounts = new AccountRepository({
      directory: path.join(directory, "metadata"),
      defaultAccount: { accountId: "account-a", codexHome },
    });
    const threadAccounts = new ThreadAccountStore({ directory: path.join(directory, "metadata") });
    const createConnection = async (
      account: CodexAccount,
    ): Promise<OfficialAppServerConnection> => {
      expect(account.codexHome).toBe(codexHome);
      await expect(stat(codexHome)).resolves.toMatchObject({ mode: expect.any(Number) });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        stdin,
        stdout,
        stderr,
        closed: Promise.resolve({ code: 0, signal: null }),
        close() {
          stdin.end();
          stdout.end();
          stderr.end();
        },
      };
    };
    const pool = new CodexRuntimePool({
      accounts,
      threadAccounts,
      createConnection,
      diagnosticOutput: new PassThrough(),
      onOutput: async () => undefined,
      diagnose: () => undefined,
    });

    await pool.initialize();
    await pool.active();
    expect((await stat(codexHome)).mode & 0o777).toBe(0o700);
    await pool.close();
  });

  it("serializes concurrent Account activation mutations and persistence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-account-activation-test-"));
    directories.push(directory);
    const accounts = new AccountRepository({
      directory,
      defaultAccount: { accountId: "account-a", codexHome: path.join(directory, "home-a") },
    });
    await accounts.initialize();
    await accounts.upsert({
      accountId: "account-b",
      codexHome: path.join(directory, "home-b"),
    });

    await Promise.all([
      accounts.setActiveAccountId("account-a"),
      accounts.setActiveAccountId("account-b"),
    ]);

    await expect(accounts.getActiveAccountId()).resolves.toBe("account-b");
    expect(JSON.parse(await readFile(path.join(directory, "accounts.json"), "utf8"))).toMatchObject(
      { activeAccountId: "account-b" },
    );
  });

  it("discovers a historical Thread in an unloaded non-active Account runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-history-discovery-test-"));
    directories.push(directory);
    const metadata = path.join(directory, "metadata");
    const accounts = new AccountRepository({
      directory: metadata,
      defaultAccount: { accountId: "account-a", codexHome: path.join(directory, "home-a") },
    });
    await accounts.initialize();
    await accounts.upsert({
      accountId: "account-b",
      codexHome: path.join(directory, "home-b"),
    });
    const threadAccounts = new ThreadAccountStore({ directory: metadata });
    const spawned: string[] = [];
    const createConnection = async (
      account: CodexAccount,
    ): Promise<OfficialAppServerConnection> => {
      spawned.push(account.accountId);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const closed = Promise.withResolvers<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>();
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as { id?: string; method?: string };
          if (request.method !== "thread/read" || !request.id) continue;
          stdout.write(
            `${JSON.stringify(
              account.accountId === "account-b"
                ? { id: request.id, result: { thread: { id: "historical-thread-b" } } }
                : { id: request.id, error: { code: -32000, message: "not found" } },
            )}\n`,
          );
        }
      });
      return {
        stdin,
        stdout,
        stderr,
        closed: closed.promise,
        close() {
          stdin.end();
          stdout.end();
          stderr.end();
          closed.resolve({ code: 0, signal: null });
        },
      };
    };
    const pool = new CodexRuntimePool({
      accounts,
      threadAccounts,
      createConnection,
      diagnosticOutput: new PassThrough(),
      onOutput: async () => undefined,
      diagnose: () => undefined,
    });

    await pool.initialize();
    await pool.active();
    expect(spawned).toEqual(["account-a"]);
    await expect(pool.forThread("historical-thread-b")).resolves.toMatchObject({
      account: { accountId: "account-b" },
    });
    expect(spawned).toEqual(["account-a", "account-b"]);
    await expect(threadAccounts.getAccountId("historical-thread-b")).resolves.toBe("account-b");
    await pool.close();
  });
});
