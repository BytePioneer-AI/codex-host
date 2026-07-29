import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveClaudeCommand, sanitizedAuthStatus } from "./command.mjs";

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fakeExecutable() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-claude-command-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "claude");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { directory, executable };
}

describe("Claude Code command resolution", () => {
  it("resolves an environment override without exposing it in the source", () => {
    const { executable } = fakeExecutable();
    expect(
      resolveClaudeCommand({ env: { CODEXHOST_CLAUDE_COMMAND: executable }, platform: "darwin" }),
    ).toEqual({ executable, source: "environment" });
  });

  it("resolves from PATH", () => {
    const { directory, executable } = fakeExecutable();
    expect(resolveClaudeCommand({ env: { PATH: directory }, platform: "linux" })).toEqual({
      executable,
      source: "path",
    });
  });

  it("does not silently substitute a bundled executable", () => {
    expect(() => resolveClaudeCommand({ env: { PATH: "" }, platform: "linux" })).toThrow(
      "not available",
    );
  });

  it("allowlists authentication structure", () => {
    expect(
      sanitizedAuthStatus({
        loggedIn: true,
        authMethod: "oauth",
        apiProvider: "firstParty",
        email: "must-not-leak@example.test",
        organizationId: "must-not-leak",
      }),
    ).toEqual({ loggedIn: true, authMethod: "oauth", apiProvider: "firstParty" });
  });
});
