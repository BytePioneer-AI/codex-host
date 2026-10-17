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
    const sourceRoot = join(repoRoot, "packages/host-runtime/dist/plugins");
    const usageIds = readdirSync(sourceRoot).filter((id) => {
      try {
        return (
          JSON.parse(readFileSync(join(sourceRoot, id, "manifest.json"), "utf8")).kind === "usage"
        );
      } catch {
        return false;
      }
    });
    assert.deepEqual(
      readdirSync(join(output, "adapters")).sort(),
      ["claude-code", "codex", "pi", "enabled.json", ...usageIds].sort(),
    );
    assert.deepEqual(JSON.parse(readFileSync(join(output, "adapters/enabled.json"), "utf8")), {
      version: 1,
      enabled: ["claude-code", "pi", ...usageIds],
    });
    assert.match(
      readFileSync(join(output, "host-runtime.mjs"), "utf8"),
      /--codexhost-shared-host/u,
    );
    const executable = process.platform === "win32" ? "codexhost.exe" : "codexhost";
    assert.deepEqual(
      readFileSync(join(output, "native", executable)),
      readFileSync(join(repoRoot, "target/debug", executable)),
    );
    const metadata = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
    assert.deepEqual(metadata.os, [process.platform]);
    assert.deepEqual(metadata.cpu, [process.arch]);
    for (const id of ["claude-code", "pi", ...usageIds]) {
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
    assert.match(
      readFileSync(join(output, "licenses/image-size-MIT.txt"), "utf8"),
      /Aditya Yadav/u,
    );
  },
);
