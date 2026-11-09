import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HarnessDisplaySettingsStore } from "../src/harness-display-settings.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
});
afterEach(() => vi.mocked(rename).mockClear());

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "display-replace-"));
  const file = path.join(directory, "harness-display-settings-v1.json");
  const previous = JSON.stringify([{ agent: "pi", section: "more" }]);
  await writeFile(file, previous);
  return {
    directory,
    file,
    previous,
    store: new HarnessDisplaySettingsStore({ CODEXHOST_DATA_DIR: directory }),
  };
}
it.runIf(process.platform === "win32")(
  "retries only a rejected rename, preserving the old snapshot until replacement",
  async () => {
    const f = await fixture();
    try {
      vi.mocked(rename).mockImplementationOnce(async (_source, target) => {
        expect(await readFile(target, "utf8")).toBe(f.previous);
        throw Object.assign(new Error("Windows sharing violation"), { code: "EPERM" });
      });
      expect(await f.store.set({ entries: [] })).toEqual({ entries: [] });
      expect(rename).toHaveBeenCalledTimes(2);
      expect(vi.mocked(rename).mock.calls[0]).toEqual(vi.mocked(rename).mock.calls[1]);
      expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual([]);
    } finally {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === "win32")(
  "bounds sharing-violation retries without deleting the previous snapshot",
  async () => {
    const f = await fixture();
    try {
      vi.mocked(rename).mockRejectedValue(
        Object.assign(new Error("Still locked"), { code: "EACCES" }),
      );
      await expect(f.store.set({ entries: [] })).rejects.toThrow("Still locked");
      expect(rename).toHaveBeenCalledTimes(6);
      expect(await readFile(f.file, "utf8")).toBe(f.previous);
      expect(await readdir(f.directory)).toEqual([path.basename(f.file)]);
    } finally {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
it("does not retry an unrelated filesystem error", async () => {
  const f = await fixture();
  try {
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error("Disk failure"), { code: "EIO" }));
    await expect(f.store.set({ entries: [] })).rejects.toThrow("Disk failure");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await readFile(f.file, "utf8")).toBe(f.previous);
  } finally {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
