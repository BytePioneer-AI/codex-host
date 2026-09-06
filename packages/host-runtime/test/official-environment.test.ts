import { describe, expect, it } from "vitest";

import { officialEnvironment } from "../src/app-server-host.js";

describe("official tool runtime discovery", () => {
  it("replaces the shim with the bundled CLI while stripping Host routing", () => {
    expect(
      officialEnvironment({
        CODEX_CLI_PATH: "/host/shim",
        CODEXHOST_STOCK_CODEX_PATH: "/Applications/Codex.app/Contents/Resources/codex",
        CODEXHOST_HOST_NODE_PATH: "/opt/homebrew/bin/node",
        CODEX_APP_TOOLS_PIPE_PATH: "/tmp/desktop-tools.sock",
      }),
    ).toEqual({
      CODEX_CLI_PATH: "/Applications/Codex.app/Contents/Resources/codex",
      CODEX_APP_TOOLS_PIPE_PATH: "/tmp/desktop-tools.sock",
    });
  });

  it("does not retain a shim override without an official CLI path", () => {
    expect(officialEnvironment({ CODEX_CLI_PATH: "/host/shim" })).toEqual({});
  });
});
