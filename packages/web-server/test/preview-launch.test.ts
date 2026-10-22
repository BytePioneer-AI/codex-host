/** Preview process isolation without executing any real Harness or Desktop entry point. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

import { previewLaunch } from "../src/preview-launch.ts";

const exec = promisify(execFile);

it("removes inherited Host routing and Node injection without changing the parent environment", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    ANTHROPIC_API_KEY: "test-credential",
    CODEXHOST_RUNTIME_TOKEN: "host-token",
    CODEXHOST_CODEX_COMMAND: "/unsafe/codex",
    CODEX_CLI_PATH: "/unsafe/shim",
    CODEXHOST_LAUNCHER_EXECUTABLE: "/unsafe/launcher",
    CODEXHOST_IMPORT_RECENT: "10",
    CODEXHOST_WEB_DATA: "/desktop/data",
    CODEXHOST_FUTURE_OPTION: "unsafe",
    NODE_OPTIONS: "--import=/unsafe/hook.mjs",
    NODE_PATH: "/unsafe/modules",
  };
  const original = { ...parent };
  const bundle = resolve("packed");
  const { env, args } = previewLaunch(bundle, {}, parent);
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    ANTHROPIC_API_KEY: "test-credential",
  });
  assert.deepEqual(parent, original);
  assert.equal(args[args.indexOf("--harness") + 1], "all");
  assert.equal(args[args.indexOf("--adapters") + 1], join(bundle, "adapters"));
  assert.equal(args[args.indexOf("--host") + 1], "0.0.0.0");
  assert.equal(args[args.indexOf("--port") + 1], "4400");
  assert.equal(args[args.indexOf("--data") + 1], join(homedir(), ".codexhost", "web"));
  assert.match(
    args[args.indexOf("--workspace") + 1] as string,
    /codexhost-web-preview-workspace$/u,
  );
  assert.equal(args.includes("--no-auth"), false);
  assert.equal(args.includes("--import-recent"), false);
});

it("keeps Web data under the selected Host unless explicitly overridden", () => {
  for (const options of [
    { "ch-data": resolve("custom-host") },
    { "ch-control-directory": resolve("custom-host", "client-hosts") },
  ]) {
    const launch = previewLaunch("/packed", options, {});
    assert.equal(launch.args[launch.args.indexOf("--data") + 1], resolve("custom-host", "web"));
    const explicit = previewLaunch("/packed", { ...options, data: resolve("separate-web") }, {});
    assert.equal(explicit.args[explicit.args.indexOf("--data") + 1], resolve("separate-web"));
  }
});

it("allows an explicit loopback or interface binding without disabling authentication", () => {
  for (const host of ["127.0.0.1", "100.64.0.1"]) {
    const { args } = previewLaunch("/packed", { host }, {});
    assert.equal(args[args.indexOf("--host") + 1], host);
    assert.equal(args.includes("--no-auth"), false);
  }
});

it("accepts an explicit port instead of the default", () => {
  const { args } = previewLaunch("/packed", { port: "4401" }, {});
  assert.equal(args[args.indexOf("--port") + 1], "4401");
});

it("accepts explicit Harness ids without relaxing isolation", () => {
  const launch = previewLaunch(
    "/packed",
    { harness: "claude-code, opencode,claude-code" },
    { CODEXHOST_IMPORT_RECENT: "10", NODE_PATH: "/unsafe" },
  );
  assert.equal(launch.args[launch.args.indexOf("--harness") + 1], "claude-code,opencode");
  assert.deepEqual(launch.env, {});
  assert.equal(launch.args.includes("--no-auth"), false);
  assert.equal(launch.args.includes("--import-recent"), false);
});

it("selects Codex CLI like every other external Harness without inheriting Desktop routing", () => {
  const launch = previewLaunch(
    "/packed",
    { harness: "codex-cli,claude-code" },
    { CODEXHOST_CODEX_COMMAND: "/unsafe/codex", CODEX_CLI_PATH: "/unsafe/shim" },
  );
  assert.equal(launch.args[launch.args.indexOf("--harness") + 1], "codex-cli,claude-code");
  assert.equal(launch.args.includes("--codex-command"), false);
  assert.equal(launch.args.includes("--codex-home"), false);
  assert.deepEqual(launch.env, {});
});

it("allows Pi like every other session Harness", () => {
  const { args } = previewLaunch("/packed", { harness: "pi,codex-cli" }, {});
  assert.equal(args[args.indexOf("--harness") + 1], "pi,codex-cli");
});

it("rejects empty ids and unsafe selection syntax before spawning", () => {
  for (const harness of ["", "claude-code,", "../other", "--no-auth", "PI"]) {
    assert.throws(() => previewLaunch("/packed", { harness }, {}), /not allowed/u);
  }
});

it("rejects standalone at both Web entry points before creating a profile", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-no-standalone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ["src/main.ts", "scripts/preview.ts"]) {
    await assert.rejects(
      exec(
        process.execPath,
        [
          "--import",
          "tsx",
          entry,
          "--session-source",
          "standalone",
          "--data",
          join(root, "profile"),
        ],
        {
          cwd: resolve(import.meta.dirname, ".."),
          timeout: 10_000,
        },
      ),
      /Unknown.*session-source/u,
    );
  }
  assert.equal(existsSync(join(root, "profile")), false);
});

it("passes only isolated settings to the actual child process", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-preview-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "app"));
  writeFileSync(
    join(root, "app/server.mjs"),
    "console.log(JSON.stringify({args:process.argv.slice(2),env:process.env}))\n",
  );
  const launch = previewLaunch(
    root,
    {
      port: "0",
      data: join(root, "data"),
      workspace: join(root, "workspace"),
      harness: "claude-code,opencode",
    },
    {
      PATH: process.env.PATH,
      HOME: root,
      CODEXHOST_LAUNCHER_PID: "123",
      CODEXHOST_RUNTIME_ENDPOINT: "unsafe",
      CODEXHOST_RUNTIME_TOKEN: "test-host-token",
      CODEXHOST_CODEX_COMMAND: "/unsafe/proxy",
      NODE_OPTIONS: "--import=/missing-hook.mjs",
    },
  );
  const { stdout } = await exec(process.execPath, launch.args, { env: launch.env });
  const received = JSON.parse(stdout) as { args: string[]; env: NodeJS.ProcessEnv };
  assert.deepEqual(received.args, launch.args.slice(1));
  for (const [key, value] of Object.entries(launch.env)) assert.equal(received.env[key], value);
  assert.equal(
    Object.keys(received.env).some((key) => key.startsWith("CODEXHOST_")),
    false,
  );
  assert.equal(received.env.NODE_OPTIONS, undefined);
  assert.equal(received.env.NODE_PATH, undefined);
  assert.equal(received.args[received.args.indexOf("--harness") + 1], "claude-code,opencode");
  assert.equal(received.args[received.args.indexOf("--data") + 1], join(root, "data"));
});
