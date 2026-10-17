import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSourceOwnerLock,
  migrateLegacyWebSource,
  rollbackSessionMigration,
  recoverSessionMigration,
  LocalSessionOrganization,
} from "../src/index.js";
import type { SessionOwnership } from "../src/index.js";

const roots: string[] = [],
  owners: SessionOwnership[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function json(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-migration-")));
  roots.push(root);
  const source = join(root, "web"),
    target = join(root, "host", "web-codex"),
    home = join(root, "web", "codex-home");
  mkdirSync(home, { recursive: true });
  const meta = {
    sessionId: "one",
    cwd: root,
    createdAt: 100,
    updatedAt: 200,
    blank: false,
    harnessId: "codex",
    nativeRef: { harnessId: "codex", nativeSessionId: "native-one", locator: { codexHome: home } },
    checkpoints: { "1": { nativeTurnKey: "turn-one" } },
    backfill: "done",
  };
  json(join(source, "codex-sessions", "sessions", "index.json"), { one: meta });
  json(join(source, "codex-sessions", "sessions", "one", "projections.json"), { title: "Kept" });
  writeFileSync(
    join(source, "codex-sessions", "sessions", "one", "events.jsonl"),
    JSON.stringify({ seq: 0, type: "session/title", time: 100, data: { title: "Kept" } }) + "\n",
  );
  json(join(source, "workspaces.json"), {
    items: [
      {
        workspaceId: "workspace",
        path: root,
        title: "Work",
        sessionIds: ["one", "external-thread"],
        createdAt: new Date(100).toISOString(),
        updatedAt: new Date(200).toISOString(),
        origin: "web",
      },
      {
        workspaceId: "reference",
        path: root,
        title: "Automatic",
        sessionIds: ["external-thread"],
        createdAt: new Date(100).toISOString(),
        updatedAt: new Date(200).toISOString(),
        origin: "codexhost",
      },
    ],
    pinnedSessionIds: ["one", "external-thread"],
    archivedSessionIds: ["one"],
  });
  const owner = await acquireSourceOwnerLock({ root: target, home });
  owners.push(owner);
  const options = {
    sourceDataRoot: source,
    targetRoot: target,
    codexHome: home,
    legacyWriterStopped: true,
    ownership: owner,
  };
  return { root, source, target, home, owner, options, meta };
}

describe("single-source migration", () => {
  it("does not trust an invalid commit or a committed target missing its journal", async () => {
    const f = await fixture();
    const commit = await migrateLegacyWebSource(f.options);
    json(join(f.target, "migration-commit-v1.json"), { ...commit, state: "invalid" });
    expect(() => recoverSessionMigration(f.owner)).toThrow("migration-commit-invalid");
    json(join(f.target, "migration-commit-v1.json"), commit);
    rmSync(join(f.target, "sessions", "one", "events.jsonl"));
    expect(() => recoverSessionMigration(f.owner)).toThrow("migration-installed-invalid");
  });
  it("preserves byte journals, references and source; excludes external organization and commits idempotently", async () => {
    const f = await fixture(),
      before = readFileSync(join(f.source, "codex-sessions", "sessions", "one", "events.jsonl"));
    const commit = await migrateLegacyWebSource(f.options);
    expect(commit.sessionIds).toEqual(["one"]);
    expect(commit.excludedExternalReferences).toEqual(["external-thread"]);
    expect(commit.excludedReferenceWorkspaceIds).toEqual(["reference"]);
    expect(readFileSync(join(f.target, "sessions", "one", "events.jsonl"))).toEqual(before);
    expect(f.owner.data.readJson("sessions/index.json", {})).toEqual({ one: f.meta });
    expect(
      readFileSync(join(f.source, "codex-sessions", "sessions", "one", "events.jsonl")),
    ).toEqual(before);
    expect(await migrateLegacyWebSource(f.options)).toEqual(commit);
    const organization = new LocalSessionOrganization(f.owner.data, (id) => id === "one");
    expect(organization.pinnedSessionIds()).toEqual(["one"]);
    expect(organization.ownerOf("one")?.workspaceId).toBe("workspace");
    expect(() => organization.setPinned("external-thread", true)).toThrow("session-not-found");
  });
  it.each(["queuedPrompts", "activeTurns", "interactions", "submissions", "uploads"])(
    "defers an active source with %s without mutation",
    async (key) => {
      const f = await fixture();
      await expect(
        migrateLegacyWebSource({
          ...f.options,
          activity: {
            activeTurns: 0,
            queuedPrompts: 0,
            interactions: 0,
            submissions: 0,
            uploads: 0,
            [key]: 1,
          },
        }),
      ).rejects.toThrow("migration-source-active");
      expect(existsSync(join(f.target, "sessions"))).toBe(false);
    },
  );
  it("requires explicit legacy quiescence and rejects a live newer source writer", async () => {
    const f = await fixture();
    await expect(
      migrateLegacyWebSource({ ...f.options, legacyWriterStopped: false }),
    ).rejects.toThrow("quiescence-unconfirmed");
    json(join(f.source, "codex-sessions", "source-owner-v1.lock"), {
      pid: process.pid,
      instanceId: "old-live",
    });
    await expect(migrateLegacyWebSource(f.options)).rejects.toThrow("source-owner-live");
  });
  it.each(["torn", "sequence", "unknown", "home", "parent", "target"])(
    "rejects %s without publishing or altering source",
    async (kind) => {
      const f = await fixture(),
        index = join(f.source, "codex-sessions", "sessions", "index.json"),
        journal = join(f.source, "codex-sessions", "sessions", "one", "events.jsonl");
      if (kind === "torn") writeFileSync(journal, "{bad");
      if (kind === "sequence")
        writeFileSync(journal, JSON.stringify({ seq: 3, type: "x", time: 1, data: {} }) + "\n");
      if (kind === "unknown") json(index, { one: { ...f.meta, formatVersion: 42 } });
      if (kind === "home")
        json(index, {
          one: {
            ...f.meta,
            nativeRef: { ...f.meta.nativeRef, locator: { codexHome: join(f.root, "other-home") } },
          },
        });
      if (kind === "parent")
        json(index, {
          one: {
            ...f.meta,
            origin: "subagent",
            parentSessionId: "missing",
            nativeSubagentId: "child",
          },
        });
      if (kind === "target") mkdirSync(join(f.target, "sessions"));
      const original = readFileSync(index);
      await expect(migrateLegacyWebSource(f.options)).rejects.toThrow();
      expect(existsSync(join(f.target, "migration-commit-v1.json"))).toBe(false);
      expect(readFileSync(index)).toEqual(original);
    },
  );
  it("cleans an uncommitted install after failure, then retries without sending anything", async () => {
    const f = await fixture();
    await expect(
      migrateLegacyWebSource({
        ...f.options,
        beforeCommit: () => {
          throw new Error("injected");
        },
      }),
    ).rejects.toThrow("injected");
    expect(existsSync(join(f.target, "sessions"))).toBe(false);
    await migrateLegacyWebSource(f.options);
    expect(existsSync(join(f.target, "sessions", "index.json"))).toBe(true);
  });
  it("allows rollback only before new writes and after confirmed native exit", async () => {
    const f = await fixture();
    await migrateLegacyWebSource(f.options);
    expect(() => rollbackSessionMigration(f.owner, false)).toThrow("release-unconfirmed");
    rollbackSessionMigration(f.owner, true);
    expect(existsSync(join(f.target, "sessions"))).toBe(false);
    await migrateLegacyWebSource(f.options);
    f.owner.data.appendLine("sessions/one/events.jsonl", { seq: 1, type: "x", time: 1, data: {} });
    expect(() => rollbackSessionMigration(f.owner, true)).toThrow("has-mutations");
  });
  it("preserves confirmed organization when persistence fails", async () => {
    const f = await fixture();
    await migrateLegacyWebSource(f.options);
    const organization = new LocalSessionOrganization(
      {
        readJson: (name, fallback) => f.owner.data.readJson(name, fallback),
        writeJson: () => {
          throw new Error("disk failure");
        },
      },
      (id) => id === "one",
    );
    expect(() => organization.setPinned("one", false)).toThrow("disk failure");
    expect(organization.pinnedSessionIds()).toEqual(["one"]);
  });
  it("preserves the core's tilde child identity and its parent/checkpoint links", async () => {
    const f = await fixture(),
      childId = "one~sub-0123456789";
    json(join(f.source, "codex-sessions", "sessions", "index.json"), {
      one: f.meta,
      [childId]: {
        ...f.meta,
        sessionId: childId,
        origin: "subagent",
        parentSessionId: "one",
        nativeSubagentId: "native-child",
        nativeRef: f.meta.nativeRef,
      },
    });
    json(join(f.source, "codex-sessions", "sessions", childId, "projections.json"), {
      subagent: { parentSessionId: "one" },
    });
    writeFileSync(join(f.source, "codex-sessions", "sessions", childId, "events.jsonl"), "");
    await migrateLegacyWebSource(f.options);
    const index = f.owner.data.readJson<
      Record<string, { parentSessionId?: string; checkpoints: unknown }>
    >("sessions/index.json", {});
    expect(index[childId]?.parentSessionId).toBe("one");
    expect(index[childId]?.checkpoints).toEqual(f.meta.checkpoints);
  });
  it("does not mark composition configuration as mutation and writes the business marker only once", async () => {
    const f = await fixture();
    await migrateLegacyWebSource(f.options);
    f.owner.data.writeConfiguration("service-config-v1.json", { home: f.home });
    const marker = join(f.target, "migration-mutated-v1.json");
    expect(existsSync(marker)).toBe(false);
    f.owner.data.writeJson("sessions/one/projections.json", { title: "new" });
    const first = statSync(marker);
    f.owner.data.appendLine("sessions/one/events.jsonl", { seq: 1 });
    expect(statSync(marker).ino).toBe(first.ino);
    expect(statSync(marker).mtimeMs).toBe(first.mtimeMs);
  });
  it("refuses publication if a legacy writer changes bytes before commit", async () => {
    const f = await fixture();
    await expect(
      migrateLegacyWebSource({
        ...f.options,
        beforeCommit: () => {
          writeFileSync(
            join(f.source, "codex-sessions", "sessions", "one", "events.jsonl"),
            "changed by writer",
          );
        },
      }),
    ).rejects.toThrow("source-changed");
    expect(existsSync(join(f.target, "sessions"))).toBe(false);
    expect(existsSync(join(f.target, "migration-commit-v1.json"))).toBe(false);
  });
  it.each(["sessions", "organization"] as const)(
    "recovers an interrupted rollback after %s removal",
    async (step) => {
      const f = await fixture();
      await migrateLegacyWebSource(f.options);
      expect(() =>
        rollbackSessionMigration(f.owner, true, (at) => {
          if (at === step) throw new Error("crash");
        }),
      ).toThrow("crash");
      recoverSessionMigration(f.owner);
      expect(existsSync(join(f.target, "migration-commit-v1.json"))).toBe(false);
      expect(existsSync(join(f.target, "sessions"))).toBe(false);
      expect(existsSync(join(f.target, "organization-v1.json"))).toBe(false);
    },
  );
});

describe("source ownership", () => {
  it("persists the profile home binding and refuses a later different home before touching it", async () => {
    const f = await fixture();
    await f.owner.release();
    const otherHome = join(f.root, "another-home");
    await expect(acquireSourceOwnerLock({ root: f.target, home: otherHome })).rejects.toThrow(
      "source-home-conflict",
    );
    expect(existsSync(otherHome)).toBe(false);
    await expect(
      acquireSourceOwnerLock({ root: join(f.source, "codex-sessions"), home: otherHome }),
    ).rejects.toThrow("source-home-conflict");
    expect(existsSync(otherHome)).toBe(false);
  });
  it("seals the legacy writer even after target shutdown, and unseals only a successful rollback", async () => {
    const f = await fixture();
    await migrateLegacyWebSource(f.options);
    await f.owner.release();
    await expect(
      acquireSourceOwnerLock({ root: join(f.source, "codex-sessions"), home: f.home }),
    ).rejects.toThrow("source-migrated");
    const target = await acquireSourceOwnerLock({ root: f.target, home: f.home });
    owners.push(target);
    target.data.writeConfiguration("service-config-v1.json", { home: f.home });
    rollbackSessionMigration(target, true);
    await target.release();
    expect(existsSync(join(f.target, "service-config-v1.json"))).toBe(false);
    expect(recoverSessionMigration(target)).toBe("rolled-back");
    const legacy = await acquireSourceOwnerLock({
      root: join(f.source, "codex-sessions"),
      home: f.home,
    });
    owners.push(legacy);
  });
  it("rejects a second root using the same canonical native home", async () => {
    const f = await fixture();
    await expect(
      acquireSourceOwnerLock({ root: join(f.root, "other-root"), home: f.home }),
    ).rejects.toThrow("source-owner-live");
  });
  it("does not infer native exit from a dead owner PID", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-stale-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    json(join(home, ".codexhost-source-owner-v1.lock"), { pid: 2147483647, instanceId: "dead" });
    await expect(acquireSourceOwnerLock({ root: join(root, "data"), home })).rejects.toThrow(
      "release-unconfirmed",
    );
  });
  it("does not apply one profile's native-exit proof to another profile's stale home", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "session-other-profile-")));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    json(join(home, ".codexhost-source-owner-v1.lock"), {
      pid: 2147483647,
      instanceId: "dead",
      ownerRoot: join(root, "other-data"),
      generation: "old",
    });
    await expect(
      acquireSourceOwnerLock({
        root: join(root, "data"),
        home,
        nativeExitProof: { pid: 2147483647, generation: "old", ownerRoot: join(root, "data") },
      }),
    ).rejects.toThrow("release-unconfirmed");
  });
  it("admits at most one contender recovering the same stale profile/home", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-stale-race-"));
    roots.push(root);
    const home = join(root, "home"),
      data = join(root, "data");
    mkdirSync(home);
    mkdirSync(data);
    json(join(data, "source-owner-v1.lock"), { pid: 2147483647, instanceId: "dead" });
    json(join(home, ".codexhost-source-owner-v1.lock"), {
      pid: 2147483647,
      instanceId: "dead",
      ownerRoot: realpathSync(data),
      generation: "old",
    });
    const outcomes = await Promise.allSettled([
      acquireSourceOwnerLock({
        root: data,
        home,
        nativeExitProof: { pid: 2147483647, generation: "old", ownerRoot: realpathSync(data) },
      }),
      acquireSourceOwnerLock({
        root: data,
        home,
        nativeExitProof: { pid: 2147483647, generation: "old", ownerRoot: realpathSync(data) },
      }),
    ]);
    const winners = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<SessionOwnership> =>
        outcome.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner) throw new Error("No recovery winner");
    owners.push(winner.value);
    expect(JSON.parse(readFileSync(join(data, "source-owner-v1.lock"), "utf8")).pid).toBe(
      process.pid,
    );
  });
});
