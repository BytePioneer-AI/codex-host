import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildPlugin } from "../../packages/adapters/trae-cn/scripts/build-plugin.mjs";
import { loadHarnessPlugins } from "../../packages/host-runtime/dist/index.js";

test("TRAE CN plugin relocates and loads through the public registry without starting Desktop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-trae-plugin-"));
  const built = path.join(directory, "built");
  const root = path.join(directory, "isolated", "plugins");
  const plugin = path.join(root, "trae-cn");
  let first;
  let second;
  try {
    await assert.rejects(
      buildPlugin(path.resolve("packages/adapters/trae-cn")),
      /must not overlap/u,
    );
    await assert.rejects(
      buildPlugin(path.resolve("packages/adapters/trae-cn/assets")),
      /must not overlap/u,
    );
    const audit = await buildPlugin(built);
    assert.equal(audit.id, "trae-cn");
    await cp(built, plugin, { recursive: true });
    await writeFile(
      path.join(root, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["trae-cn"] }),
    );
    const diagnostics = [];
    const options = {
      roots: [root],
      context: {
        environment: {
          PATH: "",
          CODEXHOST_TRAE_CN_BRIDGE_DIR: path.join(directory, "no-companion"),
        },
        platform: process.platform,
        managedRemoteHost: false,
      },
      warmup: false,
      diagnose: (d) => diagnostics.push(d),
    };
    first = await loadHarnessPlugins(options);
    second = await loadHarnessPlugins(options);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      first.list().map((p) => p.id),
      ["trae-cn"],
    );
    assert.equal(first.list()[0].name, "TRAE CN");
    const one = first.adapters.get("trae-cn"),
      two = second.adapters.get("trae-cn");
    assert.ok(one && two && one !== two);
    assert.equal(one.harnessId, "trae-cn");
    const unavailable = await one.inspect({ cwd: directory });
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.error.code, "configurationRequired");
    await first.close();
    first = undefined;
    assert.equal((await one.inspect()).error.code, "invalidState");
    assert.equal((await two.inspect({ cwd: directory })).error.code, "configurationRequired");

    // A new process starts outside the repository, with no NODE_PATH. The
    // plugin Bundle must carry its dependencies, not borrow workspace imports.
    const source = `import { createHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.join(plugin, "plugin.mjs")).href)}; const adapter=createHarnessAdapter({environment:{PATH:""},platform:process.platform,managedRemoteHost:false}); console.log(adapter.harnessId); await adapter.close();`;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { cwd: directory, env: { ...process.env, NODE_PATH: "" }, timeout: 10000, windowsHide: true },
    );
    assert.equal(stdout.trim(), "trae-cn");
  } finally {
    await first?.close();
    await second?.close();
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith("codexhost-trae-plugin-") && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
