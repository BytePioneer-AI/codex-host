import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkbenchStore } from "../src/workbench-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-store-"));
  directories.push(directory);
  return {
    directory,
    file: path.join(directory, "workbench.json"),
    store: new WorkbenchStore({ CODEXHOST_DATA_DIR: directory }),
  };
}
const config = {
  version: 1 as const,
  entries: [
    {
      id: "docs",
      category: "knowledge" as const,
      name: "Project reference",
      icon: "📚",
      url: "https://example.com/docs",
    },
  ],
};
it("starts empty without creating files and persists a private configuration across instances", async () => {
  const { store, directory, file } = await fixture();
  expect(await store.get()).toEqual({ version: 1, entries: [] });
  expect(await readdir(directory)).toEqual([]);
  expect(await store.set(config)).toEqual(config);
  expect(await new WorkbenchStore({ CODEXHOST_DATA_DIR: directory }).get()).toEqual(config);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(config);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readdir(directory)).toEqual(["workbench.json"]);
});
it("keeps existing configuration when a new input fails validation", async () => {
  const { store, file } = await fixture();
  await store.set(config);
  await expect(
    store.set({ version: 1, entries: [{ ...config.entries[0], url: "javascript:alert(1)" }] }),
  ).rejects.toThrow();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(config);
  await store.set({ version: 1, entries: [] });
  expect(await store.get()).toEqual({ version: 1, entries: [] });
});
it("reports malformed files without silently returning an empty configuration or altering the file", async () => {
  const { store, file } = await fixture();
  for (const contents of ["{broken", '{"version":9,"entries":[]}']) {
    await writeFile(file, contents);
    await expect(store.get()).rejects.toThrow("configuration could not be read");
    expect(await readFile(file, "utf8")).toBe(contents);
  }
});
