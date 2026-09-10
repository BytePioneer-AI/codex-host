import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { CodexCredentialFiles } from "../src/account/codex-credential-files.js";
import {
  adoptLegacyAccountLayout,
  inspectLegacyAccountLayout,
} from "../src/account/legacy-account-layout.js";
import { SavedCodexAccounts } from "../src/account/saved-codex-accounts.js";
import { syntheticNativeCredentials } from "./fixtures/codex-account-fixtures.js";
import { MemoryCredentialFiles } from "./fixtures/memory-credential-files.js";

const account = (accountId: string, codexHome: string) => ({
  accountId,
  codexHome,
  label: accountId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("legacy Codex Account layout inventory", () => {
  it("distinguishes a credential-only second home from native history and config conflicts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-legacy-layout-"));
    const shared = path.join(root, "shared");
    const second = path.join(root, "second");
    const metadata = path.join(root, "codex-accounts");
    await Promise.all([mkdir(shared), mkdir(second), mkdir(metadata)]);
    await writeFile(path.join(shared, "config.toml"), "model = 'synthetic'\n");
    await writeFile(path.join(second, "config.toml"), "model = 'synthetic'\n");
    await writeFile(path.join(second, "auth.json"), "synthetic-not-read");
    await writeFile(
      path.join(metadata, "accounts.json"),
      JSON.stringify({
        formatVersion: 1,
        activeAccountId: "b",
        accounts: [account("default", shared), account("b", second)],
      }),
    );
    try {
      await expect(inspectLegacyAccountLayout(root, shared)).resolves.toMatchObject({
        kind: "legacy",
        activeAccountId: "b",
        sharedAccountId: "default",
        credentialOnlyAccountIds: ["b"],
        blockers: [],
      });
      await mkdir(path.join(second, "sessions"));
      await writeFile(path.join(second, "sessions", "rollout.jsonl"), '{"thread":"fixture"}\n');
      await expect(inspectLegacyAccountLayout(root, shared)).resolves.toMatchObject({
        rolloutAccountIds: ["b"],
        blockers: [],
      });
      await mkdir(path.join(second, "attachments"));
      await writeFile(path.join(second, "attachments", "fixture"), "attachment");
      await expect(inspectLegacyAccountLayout(root, shared)).resolves.toMatchObject({
        blockers: ["secondary-native-data"],
      });
      await rm(path.join(second, "attachments"), { recursive: true });
      await writeFile(path.join(second, "state_5.sqlite"), "not sqlite");
      await expect(inspectLegacyAccountLayout(root, shared)).resolves.toMatchObject({
        blockers: ["secondary-native-data"],
      });
      await rm(path.join(second, "state_5.sqlite"));
      await writeFile(path.join(second, "config.toml"), "model = 'different'\n");
      await expect(inspectLegacyAccountLayout(root, shared)).resolves.toMatchObject({
        blockers: ["configuration-difference"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports credential-only Accounts idempotently while retaining both source homes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-legacy-adopt-"));
    const shared = path.join(root, "shared");
    const second = path.join(root, "second");
    const metadata = path.join(root, "codex-accounts");
    await Promise.all([mkdir(shared), mkdir(second), mkdir(metadata)]);
    await mkdir(path.join(second, "sessions", "2026"), { recursive: true });
    await writeFile(path.join(second, "sessions", "2026", "thread.jsonl"), '{"id":"thread"}\n');
    await writeFile(
      path.join(metadata, "accounts.json"),
      JSON.stringify({
        formatVersion: 1,
        activeAccountId: "b",
        accounts: [account("default", shared), account("b", second)],
      }),
    );
    const files = new MemoryCredentialFiles();
    const sourceA = syntheticNativeCredentials({ subject: "legacy-a" });
    const sourceB = syntheticNativeCredentials({ subject: "legacy-b" });
    files.nativeWrite(shared, "auth.json", sourceA);
    files.nativeWrite(second, "auth.json", sourceB);
    const credentials = new CodexCredentialFiles({
      files,
      directory: path.join(root, "slots"),
      sharedCodexHome: shared,
    });
    const lease = await credentials.initialize();
    const accounts = new SavedCodexAccounts({
      directory: path.join(root, "v2"),
      sharedCodexHome: shared,
    });
    try {
      const inventory = await inspectLegacyAccountLayout(root, shared);
      await expect(
        adoptLegacyAccountLayout({
          inventory,
          files,
          migrationDirectory: path.join(root, "slots"),
          accounts,
          credentials,
          oldOfficialBackendsExited: false,
        }),
      ).rejects.toThrow("process-tree exit is unconfirmed");
      await mkdir(path.join(shared, "sessions", "2026"), { recursive: true });
      await writeFile(path.join(shared, "sessions", "2026", "thread.jsonl"), "conflict\n");
      await expect(
        adoptLegacyAccountLayout({
          inventory,
          files,
          migrationDirectory: path.join(root, "slots"),
          accounts,
          credentials,
          oldOfficialBackendsExited: true,
        }),
      ).rejects.toThrow("Legacy rollout collision");
      await rm(path.join(shared, "sessions"), { recursive: true });
      await adoptLegacyAccountLayout({
        inventory,
        files,
        migrationDirectory: path.join(root, "slots"),
        accounts,
        credentials,
        oldOfficialBackendsExited: true,
      });
      await adoptLegacyAccountLayout({
        inventory,
        files,
        migrationDirectory: path.join(root, "slots"),
        accounts,
        credentials,
        oldOfficialBackendsExited: true,
      });
      expect(accounts.list()).toHaveLength(2);
      expect(accounts.getCurrentAccountId()).toBe(
        accounts.list().find((saved) => saved.identity.subject === "legacy-b")?.accountId,
      );
      expect(files.contents.get(`${shared}/auth.json`)?.toString()).toBe(sourceB);
      expect(files.contents.get(`${second}/auth.json`)?.toString()).toBe(sourceB);
      expect(
        files.contents.get(`${path.join(root, "slots")}/legacy-shared-auth.backup`)?.toString(),
      ).toBe(sourceA);
      await expect(
        readFile(path.join(shared, "sessions", "2026", "thread.jsonl"), "utf8"),
      ).resolves.toBe('{"id":"thread"}\n');
      await expect(
        readFile(path.join(second, "sessions", "2026", "thread.jsonl"), "utf8"),
      ).resolves.toBe('{"id":"thread"}\n');
      expect(
        files.contents.get(`${path.join(root, "slots")}/legacy-migration.json`)?.toString(),
      ).toContain('"stage":"committed"');
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
