import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "node:test";
import { officeEngineArtifacts } from "../src/pack-release.ts";

it("pins every Office engine to its official locked artifact, without downloading", () => {
  const lock = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../package-lock.json"), "utf8"),
  );
  const engines = officeEngineArtifacts(lock);
  assert.equal(
    engines.length,
    Object.keys(lock.packages["node_modules/@deepseek-ai/libreoffice-kit"].optionalDependencies)
      .length,
  );
  for (const engine of engines) {
    const pkg = lock.packages[`node_modules/${engine.name}`];
    assert.deepEqual(engine, {
      name: engine.name,
      version: pkg.version,
      url: pkg.resolved,
      integrity: pkg.integrity,
    });
    assert.match(engine.url, /^https:\/\/registry\.npmjs\.org\//u);
  }
  const first = engines[0];
  assert.ok(first);
  lock.packages[`node_modules/${first.name}`].resolved = "https://mirror.invalid/engine.tgz";
  assert.throws(() => officeEngineArtifacts(lock), /Invalid locked Office engine/);
});
