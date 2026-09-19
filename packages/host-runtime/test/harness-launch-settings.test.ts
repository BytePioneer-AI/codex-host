import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessLaunchSettingsStore } from "../src/harness-launch-settings.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "launch-settings-"));
  roots.push(root);
  const environment = { CODEXHOST_DATA_DIR: root };
  const file = path.join(root, "custom entry.cjs");
  await writeFile(file, "// fixture");
  return { root, environment, file, store: new HarnessLaunchSettingsStore(environment) };
}

describe("Host-owned Harness launch settings", () => {
  it("persists paths, reports restart requirements, and clears without changing the active snapshot", async () => {
    const { store, root, environment, file } = await setup();
    expect(await store.initialCommand("zcode")).toBeUndefined();
    expect(await store.set("zcode", file)).toEqual({ path: file, restartRequired: true });
    expect(await store.initialCommand("zcode")).toBeUndefined();
    expect(
      JSON.parse(await readFile(path.join(root, "harness-launch-settings", "zcode.json"), "utf8")),
    ).toBe(file);
    const restarted = new HarnessLaunchSettingsStore(environment);
    expect(await restarted.initialCommand("zcode")).toBe(file);
    expect(await restarted.get("zcode")).toEqual({ path: file, restartRequired: false });
    expect(await restarted.set("zcode", null)).toEqual({ path: null, restartRequired: true });
    expect(await store.get("zcode")).toEqual({ path: null, restartRequired: false });
    expect(await restarted.initialCommand("zcode")).toBe(file);
  });

  it("keeps separate plugins and Host data roots isolated", async () => {
    const first = await setup(),
      other = await setup();
    await Promise.all([
      first.store.set("zcode", first.file),
      first.store.set("workbuddy", other.file),
    ]);
    expect((await first.store.get("zcode")).path).toBe(first.file);
    expect((await first.store.get("workbuddy")).path).toBe(other.file);
    expect((await other.store.get("zcode")).path).toBeNull();
  });

  it("persists installation directories without requiring an executable path", async () => {
    const { store, root, environment } = await setup();
    expect(await store.set("zcode", root)).toEqual({ path: root, restartRequired: true });
    expect(await new HarnessLaunchSettingsStore(environment).initialCommand("zcode")).toBe(root);
    expect(
      JSON.parse(await readFile(path.join(root, "harness-launch-settings", "zcode.json"), "utf8")),
    ).toBe(root);
  });

  it("rejects missing paths, relative paths, arguments and traversal without overwriting settings", async () => {
    const { store, root, file } = await setup();
    await store.set("zcode", file);
    for (const invalid of [
      path.join(root, "missing"),
      "relative.cjs",
      `${file} --stdio`,
      `\"${file}\"`,
      `${file}\n--stdio`,
    ]) {
      await expect(store.set("zcode", invalid)).rejects.toThrow();
    }
    await expect(store.set("../escape", file)).rejects.toThrow();
    expect((await store.get("zcode")).path).toBe(file);
  });
});
