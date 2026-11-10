import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { buildCompanion } from "../../packages/adapters/trae-cn/scripts/build-companion.mjs";

const packageRoot = new URL("../../packages/adapters/trae-cn/", import.meta.url);
const { openPromise } = createRequire(new URL("package.json", packageRoot))("yauzl");

// Real vsce packaging plus archive reads can exceed Vitest's 5s default under CI disk contention.
test("TRAE CN Companion VSIX contains the complete source resources and license", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-trae-vsix-test-"));
  let archive;
  try {
    const result = await buildCompanion(path.join(directory, "companion.vsix"));
    assert.equal(result.id, "codexhost.trae-cn-bridge");
    archive = await openPromise(result.path);
    const files = new Map();
    for await (const entry of archive.eachEntry()) {
      assert.ok(entry.uncompressedSize < 128 * 1024);
      const stream = await archive.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      files.set(entry.fileName.toLowerCase(), Buffer.concat(chunks));
    }
    assert.deepEqual(
      [...files.keys()].sort(),
      [
        "[content_types].xml",
        "extension.vsixmanifest",
        "extension/package.json",
        "extension/readme.md",
        "extension/license.txt",
        ...[
          "extension",
          "interactions",
          "models",
          "native",
          "mcp",
          "server",
          "service",
          "settings",
          "diffs",
          "history",
          "reasoning",
          "permissions",
          "commands",
        ].map((name) => `extension/${name}.cjs`),
      ].sort(),
    );
    const manifest = JSON.parse(files.get("extension/package.json").toString("utf8"));
    assert.equal(`${manifest.publisher}.${manifest.name}`, result.id);
    assert.equal(manifest.version, result.version);
    assert.equal(manifest.main, "./extension.cjs");
    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
    assert.match(files.get("extension.vsixmanifest").toString("utf8"), /Publisher="codexhost"/u);
    for (const file of result.files.filter((file) => file.endsWith(".cjs")))
      assert.deepEqual(
        files.get(`extension/${file}`),
        await readFile(new URL(`assets/companion/${file}`, packageRoot)),
      );
    assert.deepEqual(
      files.get("extension/license.txt"),
      await readFile(new URL("../../LICENSE", import.meta.url)),
    );
  } finally {
    archive?.close();
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith("codexhost-trae-vsix-test-") && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
