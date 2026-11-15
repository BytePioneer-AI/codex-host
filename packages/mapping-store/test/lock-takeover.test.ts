import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MappingStore } from "../src/index.js";
import { createLockFile, removeStaleLock } from "../src/lock-file.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rm: vi.fn(actual.rm),
    stat: vi.fn(actual.stat),
  };
});

const actual = await vi.importActual<typeof fs>("node:fs/promises");
const stale = `${JSON.stringify({ pid: 99999999, instanceId: "dead" })}\n`;

describe("Mapping Store stale lock takeover", () => {
  let directory: string;
  let lock: string;
  let first: MappingStore;
  let second: MappingStore;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexhost-lock-takeover-"));
    lock = path.join(directory, "store.lock");
    first = new MappingStore({ directory, instanceId: "first" });
    second = new MappingStore({ directory, instanceId: "second" });
    await fs.writeFile(lock, stale);
  });

  afterEach(async () => {
    vi.mocked(fs.open).mockImplementation(actual.open);
    vi.mocked(fs.readFile).mockImplementation(actual.readFile);
    vi.mocked(fs.rm).mockImplementation(actual.rm);
    vi.mocked(fs.stat).mockImplementation(actual.stat);
    await first.close();
    await second.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("rejects an earlier stale inspection after another contender has acquired the lock", async () => {
    let intercepted = false;
    vi.mocked(fs.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const content = await actual.readFile(...args);
      if (!intercepted && args[0] === lock && content === stale) {
        intercepted = true;
        await first.initialize();
      }
      return content;
    });

    await expect(second.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(intercepted).toBe(true);
    expect(JSON.parse(await fs.readFile(lock, "utf8"))).toMatchObject({ instanceId: "first" });
    await first.close();
    await second.initialize();
  });

  it.each(["claim", "publish"])(
    "recovers a %s link left by a dead contender without retaining a blocking lock",
    async (kind) => {
      const abandoned = `${lock}.${kind}-99999999-1000-abandoned`;
      await fs.link(lock, abandoned);
      await first.initialize();
      await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
      await first.close();
      await second.initialize();
    },
  );

  it("keeps a live contender's snapshot until its removal of the stale inode completes", async () => {
    const start = Math.round(Date.now() - process.uptime() * 1_000);
    const competing = `${lock}.claim-${process.pid}-${start}-competing`;
    await fs.link(lock, competing);
    await expect(first.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await fs.readFile(lock, "utf8")).toBe(stale);
    await fs.rm(competing);
    await second.initialize();
  });

  it.each(["claim", "publish"])(
    "preserves a generated live %s link when the clock jumps before and after creation",
    async (kind) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform");
      if (!platform) throw new Error("Missing process.platform descriptor");
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      let competing = "";
      vi.mocked(fs.rm).mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
        if (String(args[0]).startsWith(`${lock}.${kind}-`)) {
          competing = String(args[0]);
          return;
        }
        return actual.rm(...args);
      });
      try {
        if (kind === "publish") {
          await actual.rm(lock);
          await createLockFile(lock, stale);
        } else {
          await actual.link(lock, `${lock}.claim-unknown`);
          await expect(removeStaleLock(lock, stale)).rejects.toThrow();
          await actual.rm(`${lock}.claim-unknown`);
        }
        expect(competing).not.toBe("");
        vi.mocked(fs.rm).mockImplementation(actual.rm);
        clock.mockReturnValue(Date.now() - 120_000);
        await expect(first.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
        expect(await fs.readFile(competing, "utf8")).toBe(stale);
        expect(await fs.readFile(lock, "utf8")).toBe(stale);
      } finally {
        clock.mockRestore();
        Object.defineProperty(process, "platform", platform);
      }
    },
  );

  it("does not mistake two remaining snapshots for a snapshot and the canonical stale lock", async () => {
    let intercepted = false;
    vi.mocked(fs.stat).mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (!intercepted && String(args[0]).startsWith(`${lock}.claim-`)) {
        intercepted = true;
        // The winner already passed nlink === 2 before this contender linked its snapshot.
        await actual.link(lock, `${lock}.claim-${process.pid}-${Date.now()}-winner`);
        await actual.rm(lock);
        await fs.writeFile(lock, JSON.stringify({ pid: process.pid, instanceId: "winner" }));
      }
      return actual.stat(...args);
    });
    await expect(first.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(intercepted).toBe(true);
    expect(JSON.parse(await fs.readFile(lock, "utf8"))).toMatchObject({ instanceId: "winner" });
  });

  it("compares inode identities without rounding large inode numbers", async () => {
    const inode = 2n ** 60n;
    vi.mocked(fs.stat).mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const identity = inode + (args[0] === lock ? 1n : 0n);
      if (args[1]?.bigint) {
        const info = await actual.stat(args[0], { bigint: true });
        info.ino = identity;
        return info;
      }
      const info = await actual.stat(args[0]);
      info.ino = Number(identity);
      return info;
    });
    await expect(first.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await fs.readFile(lock, "utf8")).toBe(stale);
  });

  it("never publishes an empty record that another contender can reap", async () => {
    await fs.rm(lock);
    let intercepted = false;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      if (!intercepted && args[1] === "wx") {
        intercepted = true;
        await second.initialize();
      }
      return handle;
    });
    await expect(first.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(intercepted).toBe(true);
    expect(JSON.parse(await fs.readFile(lock, "utf8"))).toMatchObject({ instanceId: "second" });
    await second.close();
    await first.initialize();
  });

  it("keeps a published lock acquired if removing the temporary link fails", async () => {
    await fs.rm(lock);
    vi.mocked(fs.rm).mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).startsWith(`${lock}.publish-`)) {
        throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      }
      return actual.rm(...args);
    });
    await first.initialize();
    await expect(second.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    await first.close();
    await second.initialize();
  });
});
