import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isolatedRpcArgs, nativeEnvironment } from "./scenario-helpers.mjs";
import { createGateWorkspace } from "./workspace.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Gate C real profile isolation", () => {
  it("uses dedicated cwd/session roots and disables project resources", () => {
    const workspace = createGateWorkspace(repositoryRoot, "isolated", {
      runId: "hermetic-profile-test",
    });
    try {
      const args = isolatedRpcArgs(workspace);
      expect(args).toContain("--session-dir");
      expect(args).toContain("--no-extensions");
      expect(args).toContain("--no-skills");
      expect(args).toContain("--no-prompt-templates");
      expect(args).toContain("--no-themes");
      expect(args).toContain("--no-approve");
      expect(workspace.cwd).not.toBe(repositoryRoot);
      expect(workspace.sessions).not.toBe(workspace.cwd);
    } finally {
      fs.rmSync(workspace.root, { recursive: true, force: true });
    }
  });

  it("disables startup network operations without replacing user provider configuration", () => {
    expect(nativeEnvironment({ CUSTOM: "1" })).toMatchObject({
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      CUSTOM: "1",
    });
  });
});
