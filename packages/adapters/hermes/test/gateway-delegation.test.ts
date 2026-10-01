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
    expect(prepared.bootstrap.startsWith("import hermes_bootstrap\n")).toBe(true);
    const serverImport = prepared.bootstrap.indexOf("from tui_gateway import server");
    expect(serverImport).toBeGreaterThan("import hermes_bootstrap".length);
    expect(prepared.bootstrap).toContain("register_skill");
    // The registered Skill file exists while the delegation is live.
    const match = /Path\("([^"]+)"\)/.exec(prepared.bootstrap);
    expect(match).not.toBeNull();
    const skillFile = match ? match[1] : "";
    expect(skillFile).not.toBe("");
    directories.push(path.dirname(skillFile));
    const skill = await readFile(skillFile, "utf8");
    expect(skill).toContain("name: delegation");
    await prepared.dispose();
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
