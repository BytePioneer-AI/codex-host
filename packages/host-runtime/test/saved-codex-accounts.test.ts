import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SavedCodexAccounts,
  CodexAccountMigrationRequiredError,
} from "../src/account/saved-codex-accounts.js";
import {
  syntheticCodexIdentity,
  syntheticLegacyAccounts,
} from "./fixtures/codex-account-fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-saved-accounts-"));
  directories.push(directory);
  const sharedCodexHome = path.join(directory, "home");
  const create = () => new SavedCodexAccounts({ directory, sharedCodexHome });
  const accounts = create();
  return {
    directory,
    sharedCodexHome,
    file: path.join(directory, "accounts.json"),
    create,
    accounts,
  };
}

describe("saved Codex Accounts v2", () => {
  it("starts signed out without inventing a default Account or per-Account homes", async () => {
    const f = await fixture();
    await Promise.all([f.accounts.initialize(), f.accounts.initialize()]);
    expect(f.accounts.list()).toEqual([]);
    expect(f.accounts.getCurrentAccountId()).toBeNull();
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({
      formatVersion: 2,
      sharedCodexHome: f.sharedCodexHome,
      currentAccountId: null,
      accounts: [],
    });
  });

  it("keeps two users of the same Team distinct and updates repeat login in place", async () => {
    const f = await fixture();
    await f.accounts.initialize();
    const a = await f.accounts.saveVerifiedAccount({
      identity: syntheticCodexIdentity("user-a"),
      email: "a@example.com",
    });
    const b = await f.accounts.saveVerifiedAccount({
      identity: syntheticCodexIdentity("user-b"),
      email: "b@example.com",
    });
    const again = await f.accounts.saveVerifiedAccount({
      identity: syntheticCodexIdentity("user-a"),
      email: "updated@example.com",
      planType: "team",
    });
    expect(a.accountId).not.toBe(b.accountId);
    expect(again.accountId).toBe(a.accountId);
    expect(again.email).toBe("updated@example.com");
    expect(f.accounts.list()).toHaveLength(2);
    expect(f.accounts.getCurrentAccountId()).toBeNull();
    await f.accounts.setCurrentAccountId(b.accountId);
    const restored = f.create();
    await restored.initialize();
    expect(restored.getCurrentAccountId()).toBe(b.accountId);
    expect(restored.list()).toEqual(f.accounts.list());
  });

  it("serializes concurrent login saves and returns isolated snapshots", async () => {
    const f = await fixture();
    await f.accounts.initialize();
    const input = { identity: syntheticCodexIdentity("user-a"), label: "Original" };
    const results = await Promise.all([
      f.accounts.saveVerifiedAccount(input),
      f.accounts.saveVerifiedAccount(input),
    ]);
    expect(results[0]?.accountId).toBe(results[1]?.accountId);
    expect(f.accounts.list()).toHaveLength(1);
    const returned = results[0];
    const listed = f.accounts.list()[0];
    if (!returned || !listed) throw new Error("Missing saved Account");
    returned.identity.subject = "mutated";
    listed.label = "mutated";
    expect(f.accounts.list()[0]).toMatchObject({
      label: "Original",
      identity: { subject: "user-a" },
    });
  });

  it("forbids current deletion and never deletes a shared home", async () => {
    const f = await fixture();
    await f.accounts.initialize();
    await mkdir(f.sharedCodexHome);
    const history = path.join(f.sharedCodexHome, "keep-history.jsonl");
    await writeFile(history, "synthetic-history");
    const a = await f.accounts.saveVerifiedAccount({ identity: syntheticCodexIdentity("a") });
    const b = await f.accounts.saveVerifiedAccount({ identity: syntheticCodexIdentity("b") });
    await f.accounts.setCurrentAccountId(a.accountId);
    await expect(f.accounts.remove(a.accountId)).rejects.toThrow("Current Codex Account");
    await f.accounts.remove(b.accountId);
    expect(f.accounts.getCurrentAccountId()).toBe(a.accountId);
    expect(await readFile(history, "utf8")).toBe("synthetic-history");
    await f.accounts.setCurrentAccountId(null);
    await f.accounts.remove(a.accountId);
    expect(f.accounts.list()).toEqual([]);
    expect(await readFile(history, "utf8")).toBe("synthetic-history");
  });

  it("does not mutate memory on persistence failure or leak temporary files", async () => {
    const f = await fixture();
    await f.accounts.initialize();
    const before = await readFile(f.file, "utf8");
    // A directory at the destination makes atomic replacement fail on Windows and POSIX.
    await rm(f.file);
    await mkdir(f.file);
    await expect(
      f.accounts.saveVerifiedAccount({ identity: syntheticCodexIdentity("a") }),
    ).rejects.toThrow();
    expect(f.accounts.list()).toEqual([]);
    expect((await readdir(f.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await rm(f.file, { recursive: true });
    await writeFile(f.file, before);
    await f.accounts.saveVerifiedAccount({ identity: syntheticCodexIdentity("b") });
    expect(f.accounts.list()).toHaveLength(1);
  });

  it("fails closed on v1 without rewriting legacy metadata", async () => {
    const f = await fixture();
    const original = JSON.stringify(
      syntheticLegacyAccounts(f.sharedCodexHome, path.join(f.directory, "home-b")),
    );
    await writeFile(f.file, original);
    await expect(f.accounts.initialize()).rejects.toBeInstanceOf(
      CodexAccountMigrationRequiredError,
    );
    expect(await readFile(f.file, "utf8")).toBe(original);
    expect(() => f.accounts.list()).toThrow("not initialized");
  });

  it("rejects a current pointer absent from the registry", async () => {
    const f = await fixture();
    await writeFile(
      f.file,
      JSON.stringify({
        formatVersion: 2,
        sharedCodexHome: f.sharedCodexHome,
        currentAccountId: "11111111-1111-4111-8111-111111111111",
        accounts: [],
      }),
    );
    await expect(f.accounts.initialize()).rejects.toThrow("not present");
  });

  it("rejects shared-home changes instead of moving ownership implicitly", async () => {
    const f = await fixture();
    await f.accounts.initialize();
    const changed = new SavedCodexAccounts({
      directory: f.directory,
      sharedCodexHome: path.join(f.directory, "different"),
    });
    await expect(changed.initialize()).rejects.toThrow("does not match");
  });

  it("validates untrusted metadata without leaking credential-like input", async () => {
    const f = await fixture();
    await writeFile(f.file, '{"tokens":"synthetic-secret",');
    await expect(f.accounts.initialize()).rejects.toThrow(
      "Stored Codex Account metadata is invalid",
    );
    await writeFile(
      f.file,
      JSON.stringify({
        formatVersion: 2,
        sharedCodexHome: f.sharedCodexHome,
        currentAccountId: null,
        accounts: [],
        token: "synthetic-secret",
      }),
    );
    await expect(f.accounts.initialize()).rejects.toThrow(
      "Stored Codex Account metadata is invalid",
    );
  });
});
