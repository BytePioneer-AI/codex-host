import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareGatewayDelegation } from "../src/gateway-delegation.js";

const required = {
  CODEXHOST_CLI_PATH: "/usr/local/bin/codexhost",
  CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
  CODEXHOST_RUNTIME_TOKEN: "token",
  CODEXHOST_THREAD_ID: "thread-1",
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prepareGatewayDelegation bootstrap", () => {
  it("returns an empty bootstrap when delegation env vars are missing", async () => {
    const prepared = await prepareGatewayDelegation({ CODEXHOST_CLI_PATH: "/x" });
    expect(prepared.bootstrap).toBe("");
    await prepared.dispose();
  });

  it("activates hermes_bootstrap before importing tui_gateway.server", async () => {
    const prepared = await prepareGatewayDelegation({ ...required });
    // The gateway transport spawns `python -I -c <bootstrap> + GATEWAY_LAUNCH`.
    // `-I` strips PYTHONPATH, so the bootstrap itself must mirror what Hermes's
    // own entry point (tui_gateway/entry.py) does first: import hermes_bootstrap
    // to put the selected dependency environment on sys.path. Without it, bare
    // third-party imports (hermes_yaml -> ruamel) fail on interpreters whose
    // site-packages do not carry Hermes's dependencies.
    const bootstrapImport = prepared.bootstrap.indexOf("import hermes_bootstrap\n");
    expect(bootstrapImport).toBeGreaterThanOrEqual(0);
    const serverImport = prepared.bootstrap.indexOf("from tui_gateway import server");
    expect(serverImport).toBeGreaterThan(bootstrapImport);
    // tui_gateway.server redirects sys.stdout to sys.stderr at import (stdio-entry
    // protection); this bridge owns stdout as its RPC channel to the host, so the
    // bootstrap must restore the saved stdout right after that import.
    const stdoutRestore = prepared.bootstrap.indexOf("sys.stdout = _stdout");
    expect(stdoutRestore).toBeGreaterThan(serverImport);
    // The bridge process no longer registers the skill itself: the executing
    // agent lives in the GATEWAY process, which receives the preload through
    // canonical create's `skills` parameter instead.
    expect(prepared.bootstrap).not.toContain("register_skill");
    // The preload SKILL.md exists while the delegation is live and carries this
    // Thread's real identities (the gateway process never sees the bridge env).
    expect(typeof prepared.skillPath).toBe("string");
    const skillFile = prepared.skillPath ?? "";
    expect(skillFile).not.toBe("");
    directories.push(path.dirname(skillFile));
    const skill = await readFile(skillFile, "utf8");
    expect(skill).toContain("name: delegation");
    expect(skill).toContain(required.CODEXHOST_RUNTIME_ENDPOINT);
    expect(skill).toContain(required.CODEXHOST_THREAD_ID);
    await prepared.dispose();
  });

  it("scopes the preload file per Thread and removes it on dispose", async () => {
    const first = await prepareGatewayDelegation({ ...required });
    const second = await prepareGatewayDelegation({ ...required, CODEXHOST_THREAD_ID: "thread-2" });
    expect(first.skillPath).not.toBe(second.skillPath);
    await readFile(second.skillPath ?? "", "utf8");
    await second.dispose();
    await expect(readFile(second.skillPath ?? "", "utf8")).rejects.toThrow();
    await first.dispose();
  });

  it("appends the delegation skill to HERMES_TUI_SKILLS without clobbering", async () => {
    const prepared = await prepareGatewayDelegation({
      ...required,
      HERMES_TUI_SKILLS: "existing:skill",
    });
    expect(prepared.environment.HERMES_TUI_SKILLS).toBe(
      "existing:skill,codexhost-runtime:delegation",
    );
    await prepared.dispose();
  });
});
