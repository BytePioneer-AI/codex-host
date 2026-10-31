import { describe, expect, it } from "vitest";

import { prepareGatewayDelegation } from "../src/gateway-delegation.js";

const required = {
  CODEXHOST_CLI_PATH: "/usr/local/bin/codexhost",
  CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
  CODEXHOST_RUNTIME_TOKEN: "token",
  CODEXHOST_THREAD_ID: "thread-1",
};

describe("prepareGatewayDelegation bootstrap", () => {
  it("returns an empty bootstrap when delegation env vars are missing", async () => {
    const prepared = await prepareGatewayDelegation({ CODEXHOST_CLI_PATH: "/x" });
    expect(prepared.bootstrap).toBe("");
    expect(prepared.guidance).toBeNull();
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
    // No skill file is written anymore: the guidance reaches the gateway-side
    // agent through the first prompt.submit's api_text, not the skill roots.
    const guidance = prepared.guidance ?? "";
    expect(guidance).toContain("CODEXHOST_CLI_PATH: /usr/local/bin/codexhost");
    expect(guidance).toContain(required.CODEXHOST_RUNTIME_ENDPOINT);
    expect(guidance).toContain(required.CODEXHOST_RUNTIME_TOKEN);
    expect(guidance).toContain(required.CODEXHOST_THREAD_ID);
    expect(guidance.endsWith("the user's message follows)")).toBe(true);
    await prepared.dispose();
  });
});
