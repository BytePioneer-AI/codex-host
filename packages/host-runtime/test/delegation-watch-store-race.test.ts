import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
  beforeLink: undefined as ((from: string, to: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      await hooks.beforeLink?.(from, to);
      return actual.link(from, to);
    },
    rename: async (from: string, to: string) => {
      await hooks.beforeRename?.(from, to);
      return actual.rename(from, to);
    },
  };
});

const { FileDelegationWatchStore } = await import("../src/delegation-watch-store.js");

const bootSeconds = () => Math.round(Date.now() / 1_000 - os.uptime());

describe("FileDelegationWatchStore adoption race", () => {
  let directory: string;

  beforeEach(async () => {
    directory = path.join(await mkdtemp(path.join(os.tmpdir(), "codexhost-watch-")), "watches");
  });
  afterEach(async () => {
    hooks.beforeRename = undefined;
    hooks.beforeLink = undefined;
    await rm(path.dirname(directory), { recursive: true, force: true });
  });

  it.each([undefined, "EEXIST", "EIO"])(
    "preserves another adopter's record when returning a claim encounters %s",
    async (linkError) => {
      await mkdir(directory, { recursive: true });
      const dead = spawnSync(process.execPath, ["-e", ""]).pid;
      const record = {
        id: "race",
        threadId: "child",
        notifyThreadId: "parent",
        state: "watching",
        registeredAt: "2026-11-03T00:00:00.000Z",
        timeoutMs: 60_000,
        deadline: 1_000,
      };
      await writeFile(
        path.join(directory, "race.json"),
        `${JSON.stringify({ formatVersion: 1, owner: { pid: dead, boot: bootSeconds() }, watch: record })}\n`,
      );
      const first = new FileDelegationWatchStore(directory);
      let firstAdopted: unknown[] = [];
      // The late adopter has read the exited owner's record. Before its claim
      // rename runs, another adopter takes the record and saves it as its own.
      hooks.beforeRename = async (_from, to) => {
        if (!to.includes(".claim-")) return;
        hooks.beforeRename = undefined;
        firstAdopted = await first.adopt();
      };
      hooks.beforeLink = async (from, to) => {
        if (linkError === "EEXIST") await writeFile(to, await readFile(from));
        if (linkError === "EIO") throw Object.assign(new Error("link failed"), { code: "EIO" });
      };
      const diagnose = vi.fn();
      const late = await new FileDelegationWatchStore(directory, diagnose).adopt();

      expect(firstAdopted).toEqual([record]);
      expect(late).toEqual([]);
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      if (linkError === "EIO") {
        expect(files[0]).toMatch(/^race\.json\.claim-/u);
        expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ code: "EIO" }));
      } else {
        expect(files).toEqual(["race.json"]);
        expect(diagnose).not.toHaveBeenCalled();
      }
      const filename = files[0];
      if (!filename) throw new Error("Watch record was lost");
      const saved = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
      expect(saved).toMatchObject({ owner: { pid: process.pid }, watch: record });
    },
  );
});
