import type { HarnessSession } from "@codexhost/harness-adapter";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

import { createHarnessAdapter } from "../src/plugin.ts";

function delegationEnvironment(id: string) {
  return {
    CODEXHOST_CLI_PATH: `/synthetic/${id}/codexhost`,
    CODEXHOST_CLI_NODE_PATH: `/synthetic/${id}/node`,
    CODEXHOST_RUNTIME_ENDPOINT: `http://127.0.0.1:43123/${id}`,
    CODEXHOST_RUNTIME_TOKEN: `synthetic-token-${id}`,
    CODEXHOST_THREAD_ID: id,
  };
}

it("passes per-session Host connections through create and resume without sharing identities", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-cli-delegation-")));
  const home = join(root, ".codex");
  mkdirSync(home);
  const command = join(root, "codex");
  // Only synthetic, explicitly supplied values are captured; no ambient credentials are logged.
  const probe = `JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key.startsWith('CODEXHOST_') || key.startsWith('CODEX_INTERNAL_') ||
    ['CODEX_CLI_PATH', 'CODEX_THREAD_ID', 'NODE_OPTIONS', 'NODE_PATH', 'SESSION_TOOL_SETTING'].includes(key)
  )))`;
  writeFileSync(
    command,
    `#!${process.execPath}
require('node:fs').writeFileSync(
  require('node:path').join(process.env.CODEX_HOME, 'environment-' + process.pid + '.json'),
  require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(`process.stdout.write(${probe})`)}])
);
${readFileSync(resolve("tests/fixtures/codex-auth-peer.cjs"), "utf8")}`,
  );
  chmodSync(command, 0o700);
  const base = delegationEnvironment("adapter-default");
  const adapter = createHarnessAdapter({
    platform: process.platform,
    managedRemoteHost: false,
    launchCommand: command,
    environment: {
      ...base,
      HOME: root,
      CODEX_HOME: home,
      SESSION_TOOL_SETTING: "base",
    },
  });
  const sessions: HarnessSession[] = [];
  const first = delegationEnvironment("first-thread");
  const second = delegationEnvironment("second-thread");
  const restored = { ...delegationEnvironment("first-thread"), CODEXHOST_RUNTIME_TOKEN: "rotated" };
  const routing = {
    CODEXHOST_HOST_RUNTIME_PATH: "/do-not-execute-host",
    CODEXHOST_UNKNOWN_SETTING: "not-for-native-tools",
    CODEX_CLI_PATH: "/do-not-execute-shim",
    CODEX_THREAD_ID: "desktop-thread",
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    NODE_OPTIONS: "--import=/do-not-execute-hook",
    NODE_PATH: "/do-not-execute-node",
  };
  try {
    const created = await adapter.open({
      kind: "create",
      cwd: root,
      environment: { ...first, ...routing, SESSION_TOOL_SETTING: "first" },
    });
    if (!created.ok) throw new Error(created.error.message);
    sessions.push(created.value);
    const nativeRef = created.value.initialState.nativeRef;
    if (!nativeRef) throw new Error("Missing native reference");

    const sibling = await adapter.open({
      kind: "create",
      cwd: root,
      environment: { ...second, ...routing, SESSION_TOOL_SETTING: "second" },
    });
    if (!sibling.ok) throw new Error(sibling.error.message);
    sessions.push(sibling.value);
    await created.value.close();

    const resumed = await adapter.open({
      kind: "resume",
      cwd: root,
      nativeRef,
      environment: { ...restored, ...routing, SESSION_TOOL_SETTING: "resumed" },
    });
    if (!resumed.ok) throw new Error(resumed.error.message);
    sessions.push(resumed.value);
    expect(resumed.value.initialState.nativeRef).toEqual(nativeRef);

    // Omitting session overrides must not reuse a previous Thread's connection.
    const fallback = await adapter.open({ kind: "create", cwd: root });
    if (!fallback.ok) throw new Error(fallback.error.message);
    sessions.push(fallback.value);
    expect((await adapter.inspect()).status).toBe("ready");

    const environments = readdirSync(home)
      .filter((name) => name.startsWith("environment-"))
      .map((name) => JSON.parse(readFileSync(join(home, name), "utf8")));
    expect(environments).toHaveLength(5);
    expect(environments).toEqual(
      expect.arrayContaining([
        { ...first, SESSION_TOOL_SETTING: "first" },
        { ...second, SESSION_TOOL_SETTING: "second" },
        { ...restored, SESSION_TOOL_SETTING: "resumed" },
      ]),
    );
    expect(
      environments.filter((env) => env.CODEXHOST_THREAD_ID === base.CODEXHOST_THREAD_ID),
    ).toEqual([
      { ...base, SESSION_TOOL_SETTING: "base" },
      { ...base, SESSION_TOOL_SETTING: "base" },
    ]);
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    await adapter.close();
    rmSync(root, { recursive: true, force: true });
  }
});
