/** Distribution selection accepts relocatable plugins, not development source packages. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";

import { readPackagedAdapters } from "../src/packaged-adapters.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codexhost-pack-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function plugin(directory: string, id = directory, entry = "./plugin.mjs"): string {
  const path = join(root, directory);
  mkdirSync(join(path, "assets"), { recursive: true });
  writeFileSync(
    join(path, "manifest.json"),
    JSON.stringify({ id, name: id, entry, icon: "assets/icon.svg" }),
  );
  writeFileSync(join(path, "plugin.mjs"), "export function createHarnessAdapter() {}\n");
  writeFileSync(join(path, "assets/icon.svg"), "<svg/>");
  return path;
}

it("excludes usage-only plugins from conversations and rejects explicit selection", () => {
  const session = plugin("session");
  const usage = plugin("usage");
  writeFileSync(
    join(usage, "manifest.json"),
    JSON.stringify({ id: "usage", name: "Usage", kind: "usage", entry: "./plugin.mjs" }),
  );
  assert.deepEqual(readPackagedAdapters(root), [{ id: "session", directory: session }]);
  assert.throws(() => readPackagedAdapters(root, new Set(["usage"])), /not found: usage/u);
});

it("selects only requested plugins and retains their resource directory", () => {
  const directory = plugin("one");
  plugin("two");
  writeFileSync(join(root, "enabled.json"), "{}");
  assert.deepEqual(readPackagedAdapters(root, new Set(["one"])), [{ id: "one", directory }]);
});

it("rejects a missing requested Harness instead of emitting an incomplete distribution", () => {
  plugin("one");
  assert.throws(() => readPackagedAdapters(root, new Set(["missing"])), /not found: missing/u);
});

it("rejects source entries and missing resources before packing", () => {
  const directory = plugin("one", "one", "./plugin.ts");
  assert.throws(() => readPackagedAdapters(root), /prebuilt plugin/u);
  plugin("one");
  rmSync(join(directory, "assets/icon.svg"));
  assert.throws(() => readPackagedAdapters(root), /ENOENT/u);
});

it("rejects duplicate ids and collision with the bundled Codex adapter", () => {
  plugin("one");
  plugin("two", "one");
  assert.throws(() => readPackagedAdapters(root), /Duplicate Harness id/u);
  rmSync(join(root, "two"), { recursive: true });
  plugin("codex");
  assert.throws(() => readPackagedAdapters(root), /codex is bundled separately/u);
});

it("rejects ids and entry paths that escape the plugin directory", () => {
  plugin("one", "../escape");
  assert.throws(() => readPackagedAdapters(root), /Cannot include Harness id/u);
  writeFileSync(join(root, "outside.mjs"), "");
  plugin("one", "one", "../outside.mjs");
  assert.throws(() => readPackagedAdapters(root), /inside its directory/u);
});
