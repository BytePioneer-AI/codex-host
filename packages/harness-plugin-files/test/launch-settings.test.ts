import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessLaunchSettingsStore } from "../src/launch-settings.js";

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
  const id = "sample-agent";
  it("persists paths, reports restart requirements, and clears without changing the active snapshot", async () => {
    const { store, root, environment, file } = await setup();
    expect(await store.initialCommand(id)).toBeUndefined();
    expect(await store.set(id, file)).toEqual({ path: file, restartRequired: true });
    expect(await store.initialCommand(id)).toBeUndefined();
    expect(
      JSON.parse(await readFile(path.join(root, "harness-launch-settings", `${id}.json`), "utf8")),
    ).toBe(file);
    const restarted = new HarnessLaunchSettingsStore(environment);
    expect(await restarted.initialCommand(id)).toBe(file);
    expect(await restarted.get(id)).toEqual({ path: file, restartRequired: false });
    expect(await restarted.set(id, null)).toEqual({ path: null, restartRequired: true });
    expect(await store.get(id)).toEqual({ path: null, restartRequired: false });
    expect(await restarted.initialCommand(id)).toBe(file);
  });

  it("keeps separate plugins and Host data roots isolated", async () => {
    const first = await setup(),
      other = await setup();
    await Promise.all([first.store.set(id, first.file), first.store.set("workbuddy", other.file)]);
    expect((await first.store.get(id)).path).toBe(first.file);
    expect((await first.store.get("workbuddy")).path).toBe(other.file);
    expect((await other.store.get(id)).path).toBeNull();
  });

  it("persists installation directories without requiring an executable path", async () => {
    const { store, root, environment } = await setup();
    expect(await store.set(id, root)).toEqual({ path: root, restartRequired: true });
    expect(await new HarnessLaunchSettingsStore(environment).initialCommand(id)).toBe(root);
    expect(
      JSON.parse(await readFile(path.join(root, "harness-launch-settings", `${id}.json`), "utf8")),
    ).toBe(root);
  });

  it("rejects missing paths, relative paths, arguments and traversal without overwriting settings", async () => {
    const { store, root, file } = await setup();
    await store.set(id, file);
    for (const invalid of [
      path.join(root, "missing"),
      "relative.cjs",
      `${file} --stdio`,
      `\"${file}\"`,
      `${file}\n--stdio`,
    ]) {
      await expect(store.set(id, invalid)).rejects.toThrow();
    }
    await expect(store.set("../escape", file)).rejects.toThrow();
    expect((await store.get(id)).path).toBe(file);
  });

  it.each([
    ["invalid JSON", "{not json\n"],
    ["a non-string value", "42\n"],
    ["a relative path", `${JSON.stringify("relative/entry")}\n`],
  ])("reports %s with the file path and lets set replace or reset it", async (_label, content) => {
    const { store, root, environment, file } = await setup();
    const settings = path.join(root, "harness-launch-settings", `${id}.json`);
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, content);

    await expect(store.get(id)).rejects.toThrow(settings);
    await expect(store.initialCommand(id)).rejects.toThrow(settings);
    // The Adapter was not built from a readable setting, so any saved value needs a restart.
    expect(await store.set(id, file)).toEqual({ path: file, restartRequired: true });
    expect(JSON.parse(await readFile(settings, "utf8"))).toBe(file);
    expect(await store.get(id)).toEqual({ path: file, restartRequired: true });

    await writeFile(settings, content);
    const reset = new HarnessLaunchSettingsStore(environment);
    expect(await reset.set(id, null)).toEqual({ path: null, restartRequired: true });
    await expect(readFile(settings, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await reset.get(id)).toEqual({ path: null, restartRequired: true });
  });

  it("reads an unreadable initial value again instead of caching the failure", async () => {
    const { store, root, file } = await setup();
    const settings = path.join(root, "harness-launch-settings", `${id}.json`);
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, "{not json\n");
    await expect(store.initialCommand(id)).rejects.toThrow(
      "Could not read Harness launch settings",
    );
    await writeFile(settings, `${JSON.stringify(file)}\n`);
    expect(await store.initialCommand(id)).toBe(file);
    expect(await store.get(id)).toEqual({ path: file, restartRequired: false });
  });
});
