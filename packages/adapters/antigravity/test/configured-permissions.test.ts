import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  configuredPermissionDecision,
  parseAntigravityConfiguredPermissions,
} from "../src/configured-permissions.js";

const workspaceRoot = path.win32.resolve("C:/workspace/project");
const policy = {
  workspaceRoot,
  permissions: {
    allow: ["command(Get-Location)"],
    ask: ["command(npm test*)"],
    deny: ["command(Remove-Item*)"],
  },
};

describe("Antigravity configured permissions", () => {
  it("parses permissions from the CLI config command", () => {
    expect(
      parseAntigravityConfiguredPermissions(
        [
          "diagnostic line",
          JSON.stringify({
            event: "command_result",
            command: {
              name: "config",
              data: {
                config: {
                  permissions: {
                    allow: ["command(Get-Location)"],
                    ask: ["command(npm test*)"],
                    deny: ["command(Remove-Item*)"],
                  },
                },
              },
            },
          }),
        ].join("\n"),
      ),
    ).toEqual(policy.permissions);
  });

  it("allows configured and workspace-safe tools, prompts unknown calls, and preserves deny rules", () => {
    expect(
      configuredPermissionDecision("run_command", { CommandLine: "Get-Location" }, policy),
    ).toMatchObject({ decision: "allow" });
    expect(
      configuredPermissionDecision("run_command", { CommandLine: "npm test -- --run" }, policy),
    ).toMatchObject({ decision: "prompt", reason: expect.stringContaining("npm test*") });
    expect(
      configuredPermissionDecision(
        "view_file",
        {
          AbsolutePath: path.join(workspaceRoot, "README.md"),
        },
        policy,
      ),
    ).toMatchObject({ decision: "allow" });
    expect(
      configuredPermissionDecision(
        "write_to_file",
        {
          TargetFile: path.join(workspaceRoot, "src", "new.ts"),
        },
        policy,
      ),
    ).toMatchObject({ decision: "allow" });
    expect(
      configuredPermissionDecision("write_to_file", { TargetFile: "C:/outside/new.ts" }, policy),
    ).toMatchObject({ decision: "prompt" });
    expect(
      configuredPermissionDecision("run_command", { CommandLine: "git status" }, policy),
    ).toMatchObject({ decision: "prompt" });
    expect(
      configuredPermissionDecision("run_command", { CommandLine: "Remove-Item x" }, policy),
    ).toMatchObject({ decision: "deny", reason: expect.stringContaining("Remove-Item*") });
  });
});
