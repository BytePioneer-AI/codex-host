/** Pack and relocate the distribution away from the source and plugin input directories. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

import { build } from "esbuild";

import { startServer } from "../support/server.ts";

const exec = promisify(execFile);
const serverRoot = resolve(import.meta.dirname, "../..");

it(
  "runs bundled plugins after relocation without Desktop or workspace module resolution",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "codexhost-distribution-"));
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const input = join(root, "input");
    const plugin = join(input, "fake");
    mkdirSync(join(plugin, "assets"), { recursive: true });
    await build({
      entryPoints: [join(serverRoot, "test/fake-harness/fake/plugin.ts")],
      outfile: join(plugin, "plugin.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
    });
    writeFileSync(
      join(plugin, "manifest.json"),
      JSON.stringify({
        id: "fake",
        name: "Fake Harness",
        entry: "./plugin.mjs",
        icon: "./assets/icon.svg",
      }),
    );
    writeFileSync(join(plugin, "assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const output = join(root, "output");
    await exec(
      process.execPath,
      ["--import", "tsx", "scripts/pack.ts", output, "--adapters", input, "--harness", "fake"],
      { cwd: serverRoot },
    );
    const moved = join(root, "relocated");
    renameSync(output, moved);
    rmSync(input, { recursive: true });
    const url = await startServer(t, root, [join(moved, "server.mjs")], ["--harness", "fake"]);
    assert.match(
      readFileSync(join(moved, "README.md"), "utf8"),
      /Included Harness plugins: codex, fake/u,
    );
    const index = await fetch(url);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /CodexHost/u);
    assert.equal((await fetch(new URL("harness-icons/fake", url))).status, 200);
    const catalog = await fetch(new URL("api/session/modelCatalog", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "test",
        method: "session/modelCatalog",
        payload: { args: {} },
      }),
    });
    const response = (await catalog.json()) as {
      result: { ok: boolean; value: { groups: Array<{ id: string }> } };
    };
    assert.equal(response.result.ok, true);
    assert.deepEqual(
      response.result.value.groups.map((group) => group.id),
      ["fake"],
    );

    // Exercise the shipped launcher with a fake server; never invoke Desktop or a real Harness.
    const preview = join(root, "preview-fixture");
    mkdirSync(join(preview, "adapters/claude-code"), { recursive: true });
    copyFileSync(join(moved, "preview.mjs"), join(preview, "preview.mjs"));
    writeFileSync(
      join(preview, "adapters/claude-code/manifest.json"),
      JSON.stringify({ id: "claude-code" }),
    );
    writeFileSync(
      join(preview, "server.mjs"),
      "console.log(JSON.stringify({args:process.argv.slice(2),env:process.env}))\n",
    );
    const { stdout } = await exec(
      process.execPath,
      [join(preview, "preview.mjs"), "--port", "0", "--data", join(preview, "data")],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CODEXHOST_CODEX_COMMAND: "/unsafe/codex",
          CODEXHOST_RUNTIME_TOKEN: "test-host-token",
          CODEXHOST_WEB_DATA: "/desktop/data",
          CODEXHOST_IMPORT_RECENT: "10",
          NODE_OPTIONS: "--no-warnings",
          NODE_PATH: "/unsafe/modules",
        },
      },
    );
    const received = JSON.parse(stdout) as { args: string[]; env: NodeJS.ProcessEnv };
    assert.equal(
      Object.keys(received.env).some((key) => key.startsWith("CODEXHOST_")),
      false,
    );
    assert.equal(received.env.NODE_OPTIONS, undefined);
    assert.equal(received.env.NODE_PATH, undefined);
    assert.equal(received.args[received.args.indexOf("--harness") + 1], "claude-code");
    assert.equal(
      received.args[received.args.indexOf("--adapters") + 1],
      realpathSync(join(preview, "adapters")),
    );
    assert.equal(received.args[received.args.indexOf("--data") + 1], join(preview, "data"));
    assert.equal(received.args.includes("--no-auth"), false);
  },
);
