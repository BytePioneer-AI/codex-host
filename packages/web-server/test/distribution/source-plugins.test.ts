/** Default packaging must consume plugins built from the same checkout. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const serverRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(serverRoot, "../..");

it(
  "copies current checkout artifacts without an installed Desktop plugin input",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "codexhost-source-pack-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = join(root, "web");
    // No --adapters override: this exercises the same default as build:web.
    await exec(
      process.execPath,
      ["--import", "tsx", "scripts/pack.ts", output, "--harness", "claude-code,pi"],
      { cwd: serverRoot },
    );
    assert.deepEqual(readdirSync(join(output, "adapters")).sort(), ["claude-code", "codex", "pi"]);
    for (const id of ["claude-code", "pi"]) {
      const source = join(repoRoot, "packages/host-runtime/dist/plugins", id);
      const copied = join(output, "adapters", id);
      assert.deepEqual(
        readFileSync(join(copied, "manifest.json")),
        readFileSync(join(source, "manifest.json")),
      );
      const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as {
        entry: string;
      };
      assert.deepEqual(
        readFileSync(join(copied, manifest.entry)),
        readFileSync(join(source, manifest.entry)),
      );
    }
    assert.deepEqual(
      readFileSync(join(output, "LICENSE")),
      readFileSync(join(repoRoot, "LICENSE")),
    );
    assert.deepEqual(
      readFileSync(join(output, "licenses/DSH-MIT.txt")),
      readFileSync(join(repoRoot, "apps/web-ui/LICENSE")),
    );
    assert.ok(readFileSync(join(output, "licenses/THIRD_PARTY_NOTICES.md")).length > 0);
  },
);
