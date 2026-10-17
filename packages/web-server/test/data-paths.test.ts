import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { assertDefaultWebDataReady, defaultWebDataDirectory } from "../src/data-paths.ts";

it("defaults to the Web subdirectory of the Host data root", () => {
  assert.equal(defaultWebDataDirectory(), join(homedir(), ".codexhost", "web"));
  assert.equal(defaultWebDataDirectory("custom-host"), resolve("custom-host", "web"));
});

it("allows a fresh home without creating directories", (t) => {
  const home = mkdtempSync(join(tmpdir(), "web-data-paths-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, ".codexhost", "web");
  assertDefaultWebDataReady(target, home);
  assert.equal(existsSync(target), false);
});

for (const name of [".codexhost-web-preview", ".codexhost-web"]) {
  it(`refuses to silently replace legacy data in ${name}`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "web-data-paths-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const source = join(home, name);
    const target = join(home, ".codexhost", "web");
    mkdirSync(source);
    writeFileSync(join(source, "auth.json"), "fixture");
    assert.throws(() => assertDefaultWebDataReady(target, home), /migrate.*offline/u);
    assert.equal(existsSync(join(source, "auth.json")), true);
    assert.equal(existsSync(target), false);
  });
}

it("uses an existing destination without merging legacy profiles", (t) => {
  const home = mkdtempSync(join(tmpdir(), "web-data-paths-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, ".codexhost", "web");
  mkdirSync(target, { recursive: true });
  mkdirSync(join(home, ".codexhost-web-preview"));
  assertDefaultWebDataReady(target, home);
  assert.equal(existsSync(join(target, "auth.json")), false);
});
