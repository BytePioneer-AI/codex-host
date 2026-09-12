import {
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const files = await importOriginal<typeof FileSystem>();
  return { ...files, opendir: vi.fn(files.opendir) };
});

import { inspectNativeAccountLayout } from "../src/account/native-account-layout.js";

const temporaryRoots: string[] = [];
const createdAt = "2026-09-11T00:00:00.000Z";

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "codexhost-native-account-layout-")),
  );
  temporaryRoots.push(root);
  const data = path.join(root, "data");
  const home = path.join(root, "home");
  const legacy = path.join(data, "codex-accounts");
  await mkdir(data);
  await mkdir(home);
  return { root, data, home, legacy };
}

function account(accountId: string, codexHome: string, label = accountId) {
  return {
    accountId,
    codexHome,
    label,
    createdAt,
    updatedAt: createdAt,
  };
}

async function writeRegistry(
  legacy: string,
  accounts: ReturnType<typeof account>[],
  bindings: Record<string, string> = {},
): Promise<Buffer> {
  await mkdir(legacy, { recursive: true });
  const registry = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      activeAccountId: accounts[0]?.accountId,
      accounts,
    }),
  );
  await writeFile(path.join(legacy, "accounts.json"), registry);
  if (Object.keys(bindings).length) {
    await writeFile(
      path.join(legacy, "thread-accounts.json"),
      JSON.stringify({ formatVersion: 1, bindings }),
    );
  }
  return registry;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(opendir)
    .mockReset()
    .mockImplementation((await vi.importActual<typeof FileSystem>("node:fs/promises")).opendir);
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("native Account legacy layout inspection", () => {
  it("recognizes both absent and empty legacy metadata as a new layout", async () => {
    const absent = await fixture();
    await expect(inspectNativeAccountLayout(absent.data, absent.home)).resolves.toEqual({
      kind: "new",
    });

    const empty = await fixture();
    await mkdir(empty.legacy);
    await expect(inspectNativeAccountLayout(empty.data, empty.home)).resolves.toEqual({
      kind: "new",
    });
  });

  it("supports only a single in-place home without moving its data", async () => {
    const f = await fixture();
    await writeFile(path.join(f.home, "state.sqlite"), "database");
    const registry = await writeRegistry(f.legacy, [account("local", f.home, "Local")], {
      thread: "local",
    });
    const before = await readFile(path.join(f.home, "state.sqlite"));

    await expect(inspectNativeAccountLayout(f.data, f.home)).resolves.toMatchObject({
      kind: "in-place",
      accountId: "local",
      label: "Local",
      registryDigest: expect.any(String),
    });
    expect(await readFile(path.join(f.legacy, "accounts.json"))).toEqual(registry);
    expect(await readFile(path.join(f.home, "state.sqlite"))).toEqual(before);
  });

  it("inventories every top-level entry and leaves multiple homes unchanged as a release gate", async () => {
    const f = await fixture();
    const second = path.join(f.root, "second-home");
    await mkdir(second);
    const firstEntries = [
      "attachments",
      "memory",
      "projects",
      "queue",
      "state.sqlite",
      "state.sqlite-wal",
    ];
    const secondEntries = ["auth.json", "sessions", "threads.sqlite"];
    for (const entry of firstEntries) {
      const target = path.join(f.home, entry);
      if (path.extname(entry)) await writeFile(target, entry);
      else await mkdir(target);
    }
    for (const entry of secondEntries) {
      const target = path.join(second, entry);
      if (path.extname(entry)) await writeFile(target, entry);
      else await mkdir(target);
    }
    const registry = await writeRegistry(
      f.legacy,
      [account("first", f.home), account("second", second)],
      { one: "first", two: "second" },
    );

    const result = await inspectNativeAccountLayout(f.data, f.home);
    expect(result).toEqual({
      kind: "migration-required",
      reason: "multiple-homes",
      nativeCompatibility: { accountId: "first", registryDigest: expect.any(String) },
      homes: [
        { accountId: "first", home: f.home, entries: firstEntries },
        { accountId: "second", home: second, entries: secondEntries },
      ],
    });
    expect(await readFile(path.join(f.legacy, "accounts.json"))).toEqual(registry);
    expect(await readdir(f.home)).toEqual(expect.arrayContaining(firstEntries));
    expect(await readdir(second)).toEqual(expect.arrayContaining(secondEntries));
  });

  it.each([
    ["entry count across homes", 4, [50_000, 50_002], 100_001],
    ["entry byte budget", 255, [20_000], 16_449],
  ] as const)(
    "bounds streaming inventory by %s and closes the directories",
    async (_, width, counts, expectedReads) => {
      const f = await fixture();
      const files = await vi.importActual<typeof FileSystem>("node:fs/promises");
      const rows: ReturnType<typeof account>[] = [];
      const closed: string[] = [];
      let reads = 0;
      for (const [index, count] of counts.entries()) {
        const home = index === 0 ? f.home : path.join(f.root, `home-${index}`);
        if (index) await mkdir(home);
        await writeFile(path.join(home, "entry"), "synthetic");
        rows.push(account(`account-${index}`, home));
        const directory = await files.opendir(home);
        const template = await directory.read();
        if (!template) throw new Error("missing synthetic directory entry");
        vi.spyOn(directory, Symbol.asyncIterator).mockImplementation(async function* () {
          try {
            for (let entry = 0; entry < count; entry++) {
              reads++;
              template.name = String(entry).padStart(width, "x");
              yield template;
            }
            return undefined;
          } finally {
            await directory.close();
            closed.push(home);
          }
        });
        vi.mocked(opendir).mockResolvedValueOnce(directory);
      }
      await writeRegistry(f.legacy, rows);
      await expect(inspectNativeAccountLayout(f.data, f.home)).resolves.toMatchObject({
        kind: "migration-required",
        reason: "invalid-metadata",
      });
      expect(reads).toBe(expectedReads);
      expect(closed).toEqual(rows.map((row) => row.codexHome));
      expect(await readFile(path.join(f.home, "entry"), "utf8")).toBe("synthetic");
    },
  );

  it("reports a valid single foreign home instead of silently treating it as new", async () => {
    const f = await fixture();
    const foreign = path.join(f.root, "foreign-home");
    await mkdir(foreign);
    await writeFile(path.join(foreign, "state.sqlite"), "database");
    await writeRegistry(f.legacy, [account("foreign", foreign)]);

    await expect(inspectNativeAccountLayout(f.data, f.home)).resolves.toEqual({
      kind: "migration-required",
      reason: "foreign-home",
      homes: [{ accountId: "foreign", home: foreign, entries: ["state.sqlite"] }],
    });
  });

  it("does not substitute the official home for a different selected legacy account", async () => {
    const f = await fixture();
    const second = path.join(f.root, "second-home");
    await mkdir(second);
    await writeRegistry(f.legacy, [account("selected", second), account("default", f.home)]);
    const result = await inspectNativeAccountLayout(f.data, f.home);
    expect(result).toMatchObject({ kind: "migration-required", reason: "multiple-homes" });
    expect(result).not.toHaveProperty("nativeCompatibility");
  });

  it.each([".codexhost-native-accounts", ".codexhost-process.json"])(
    "does not offer native compatibility when any legacy home contains %s",
    async (entry) => {
      const f = await fixture();
      const second = path.join(f.root, "second-home");
      await mkdir(second);
      await writeRegistry(f.legacy, [account("selected", f.home), account("other", second)]);
      await writeFile(path.join(second, entry), "unresolved managed state");
      const result = await inspectNativeAccountLayout(f.data, f.home);
      expect(result).toMatchObject({ kind: "migration-required", reason: "multiple-homes" });
      expect(result).not.toHaveProperty("nativeCompatibility");
    },
  );

  it.each([
    [
      "malformed registry",
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await mkdir(f.legacy);
        await writeFile(path.join(f.legacy, "accounts.json"), "{not-json");
      },
    ],
    [
      "oversized registry",
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await mkdir(f.legacy);
        await writeFile(path.join(f.legacy, "accounts.json"), Buffer.alloc(4 * 1024 * 1024 + 1));
      },
    ],
    [
      "orphan bindings",
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await mkdir(f.legacy);
        await writeFile(
          path.join(f.legacy, "thread-accounts.json"),
          JSON.stringify({ formatVersion: 1, bindings: { thread: "missing" } }),
        );
      },
    ],
  ])("classifies %s as invalid metadata rather than an empty layout", async (_label, arrange) => {
    const f = await fixture();
    await arrange(f);
    await expect(inspectNativeAccountLayout(f.data, f.home)).resolves.toEqual({
      kind: "migration-required",
      reason: "invalid-metadata",
      homes: [],
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects linked metadata and linked account homes",
    async () => {
      const metadataLink = await fixture();
      await mkdir(metadataLink.legacy);
      const source = path.join(metadataLink.root, "accounts-source.json");
      await writeFile(
        source,
        JSON.stringify({
          formatVersion: 1,
          activeAccountId: "local",
          accounts: [account("local", metadataLink.home)],
        }),
      );
      await symlink(source, path.join(metadataLink.legacy, "accounts.json"));
      await expect(
        inspectNativeAccountLayout(metadataLink.data, metadataLink.home),
      ).resolves.toMatchObject({ kind: "migration-required", reason: "invalid-metadata" });

      const homeLink = await fixture();
      const realHome = path.join(homeLink.root, "real-home");
      const linkedHome = path.join(homeLink.root, "linked-home");
      await mkdir(realHome);
      await symlink(realHome, linkedHome);
      await writeRegistry(homeLink.legacy, [account("linked", linkedHome)]);
      await expect(inspectNativeAccountLayout(homeLink.data, homeLink.home)).resolves.toMatchObject(
        { kind: "migration-required", reason: "invalid-metadata" },
      );
    },
  );
});
