/** Pack and relocate the distribution away from the source and plugin input directories. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
        manifestVersion: 1,
        adapterApiVersion: 1,
        version: "0.0.0",
        id: "fake",
        name: "Fake Harness",
        entry: "./plugin.mjs",
        icon: "./assets/icon.png",
      }),
    );
    const icon = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(join(plugin, "assets/icon.png"), icon);
    const output = join(root, "output");
    await exec(
      process.execPath,
      ["--import", "tsx", "scripts/pack.ts", output, "--adapters", input, "--harness", "fake"],
      { cwd: serverRoot },
    );
    const moved = join(root, "relocated");
    renameSync(output, moved);
    rmSync(input, { recursive: true });
    assert.deepEqual(JSON.parse(readFileSync(join(moved, "adapters/enabled.json"), "utf8")), {
      version: 1,
      enabled: ["fake"],
    });
    // Exercise the installed CLI's own resource resolution, without a runtime-path override.
    const cliEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("CODEXHOST_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key),
      ),
    );
    const { stdout: help } = await exec(
      join(moved, "native", process.platform === "win32" ? "codexhost.exe" : "codexhost"),
      ["delegate", "--help"],
      {
        cwd: root,
        env: { ...cliEnvironment, CODEXHOST_CLI_NODE_PATH: process.execPath },
        timeout: 10_000,
      },
    );
    assert.match(help, /codexhost thread read/u);
    assert.equal(
      JSON.parse(readFileSync(join(moved, "package.json"), "utf8")).bin["codexhost-web"],
      "./app/server.mjs",
    );
    const hostData = join(root, "host-data");
    const environment = { ...cliEnvironment, HOME: root, USERPROFILE: root };
    const stopHost = async () => {
      await exec(
        join(moved, "native", process.platform === "win32" ? "codexhost.exe" : "codexhost"),
        [
          "host",
          "stop",
          "--node",
          process.execPath,
          "--host-runtime",
          join(moved, "app/host-runtime.mjs"),
          "--data",
          hostData,
        ],
        { env: environment, timeout: 15_000 },
      );
    };
    await t.test("the relocated Web gateway uses its bundled shared Host", async (viewer) => {
      const url = await startServer(
        viewer,
        root,
        [join(moved, "app/server.mjs")],
        [
          "--harness",
          "fake",
          "--adapters",
          join(moved, "adapters"),
          "--ch-data",
          hostData,
          "--ch-codex-home",
          join(root, "gui-home"),
        ],
        { environment },
      );
      viewer.after(stopHost);
      assert.match(
        readFileSync(join(moved, "README.md"), "utf8"),
        /Included Harness plugins: fake/u,
      );
      const index = await fetch(url);
      assert.equal(index.status, 200);
      assert.match(await index.text(), /CodexHost/u);
      const iconResponse = await fetch(new URL("harness-icons/fake", url));
      assert.equal(iconResponse.status, 200);
      assert.equal(iconResponse.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await iconResponse.arrayBuffer()), icon);
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
      const owner = JSON.parse(readFileSync(join(hostData, "shared-host-ready.json"), "utf8"));
      assert.ok(owner.runtime.startsWith(join(hostData, "host-builds") + sep));
      assert.equal(existsSync(owner.runtime), true);

      // Acceptance for the right Sidebar's packaged runtime pieces: the
      // terminal runner, node-pty, the Office engine, and the four client tabs.
      assert.equal(existsSync(join(moved, "app/subprocess-runner.mjs")), true);
      assert.equal(existsSync(join(moved, "node_modules/node-pty")), true);
      const acceptanceWorkspace = join(root, "acceptance-workspace");
      mkdirSync(acceptanceWorkspace, { recursive: true });
      copyFileSync(
        join(serverRoot, "test/fixtures/office/sample.docx"),
        join(acceptanceWorkspace, "sample.docx"),
      );
      const officeCheck = join(moved, "app/acceptance-office.mjs");
      writeFileSync(
        officeCheck,
        `import { statSync } from "node:fs";
` +
          `import { createConverter } from "@deepseek-ai/libreoffice-kit";
` +
          `const converter = await createConverter({ timeoutMs: 120_000 });
` +
          `try { await converter.render({ inputPath: process.argv[2], outputPath: process.argv[3] }); }
` +
          `finally { await converter.dispose(); }
` +
          `console.log(statSync(process.argv[3]).size);
`,
      );
      try {
        const { stdout: officeBytes } = await exec(
          process.execPath,
          [
            officeCheck,
            join(acceptanceWorkspace, "sample.docx"),
            join(acceptanceWorkspace, "sample.pdf"),
          ],
          { cwd: join(moved, "app"), timeout: 120_000 },
        );
        assert.ok(Number(officeBytes.trim()) > 0);
      } finally {
        rmSync(officeCheck, { force: true });
      }
      const { stdout: ptyType } = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/x.js"); console.log(typeof require("node-pty").spawn);`,
        ],
        { cwd: join(moved, "app"), timeout: 60_000 },
      );
      assert.equal(ptyType.trim(), "function");

      const packaged = JSON.parse(readFileSync(join(moved, "web/plugins.json"), "utf8")) as Array<{
        id: string;
      }>;
      const ids = packaged.map((plugin) => plugin.id);
      for (const id of [
        "@deepseek-ai/dsh-client-ui-sidebar-files",
        "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
        "@deepseek-ai/dsh-client-ui-sidebar-terminal",
        "@deepseek-ai/dsh-client-ui-sidebar-browser",
      ])
        assert.ok(ids.includes(id), `missing packed client plugin ${id}`);
    });

    // Exercise the shipped launcher with a fake server; never invoke Desktop or a real Harness.
    const preview = join(root, "preview-fixture");
    mkdirSync(join(preview, "adapters/claude-code"), { recursive: true });
    copyFileSync(join(moved, "preview.mjs"), join(preview, "preview.mjs"));
    writeFileSync(
      join(preview, "adapters/claude-code/manifest.json"),
      JSON.stringify({ id: "claude-code" }),
    );
    mkdirSync(join(preview, "app"));
    writeFileSync(
      join(preview, "app/server.mjs"),
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

    for (const [id, kind] of [
      ["pi", "session"],
      ["codex-cli", "session"],
      ["opencode", "session"],
      ["usage", "usage"],
    ] as const) {
      mkdirSync(join(preview, "adapters", id), { recursive: true });
      writeFileSync(join(preview, "adapters", id, "manifest.json"), JSON.stringify({ id, kind }));
    }
    const previewEnv = {
      PATH: process.env.PATH,
      HOME: root,
      CODEXHOST_RUNTIME_TOKEN: "test-host-token",
    };
    const { stdout: allStdout } = await exec(
      process.execPath,
      [join(preview, "preview.mjs"), "--harness", "all"],
      { cwd: root, env: previewEnv },
    );
    const all = JSON.parse(allStdout) as { args: string[]; env: NodeJS.ProcessEnv };
    assert.equal(all.args[all.args.indexOf("--harness") + 1], "claude-code,codex-cli,opencode,pi");
    const { stdout: defaultStdout } = await exec(process.execPath, [join(preview, "preview.mjs")], {
      cwd: root,
      env: previewEnv,
    });
    assert.deepEqual(JSON.parse(defaultStdout).args, all.args);
    assert.equal(all.args[all.args.indexOf("--host") + 1], "0.0.0.0");
    assert.equal(all.env.CODEXHOST_RUNTIME_TOKEN, undefined);
    assert.equal(all.args.includes("--no-auth"), false);
    assert.equal(all.args.includes("--import-recent"), false);
    const { stdout: codexStdout } = await exec(
      process.execPath,
      [join(preview, "preview.mjs"), "--harness", "codex-cli"],
      { cwd: root, env: previewEnv },
    );
    const codex = JSON.parse(codexStdout) as { args: string[]; env: NodeJS.ProcessEnv };
    assert.equal(codex.args[codex.args.indexOf("--harness") + 1], "codex-cli");
    assert.equal(codex.args.includes("--codex-command"), false);
    assert.equal(codex.args.includes("--codex-home"), false);
    for (const id of ["missing", "usage"]) {
      await assert.rejects(
        exec(process.execPath, [join(preview, "preview.mjs"), "--harness", id], {
          cwd: root,
          env: previewEnv,
        }),
        /bundled session Adapter/u,
      );
    }
  },
);
