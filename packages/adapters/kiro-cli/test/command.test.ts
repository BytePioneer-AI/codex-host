import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  kiroDiscoverySpec,
  kiroInvocation,
  KiroExecutableError,
  resolveKiroExecutable,
} from "../src/command.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fakeExecutable(name = "kiro-cli"): { directory: string; executable: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-kiro-adapter-"));
  directories.push(directory);
  const binaryName = process.platform === "win32" ? `${name}.exe` : name;
  const executable = path.join(directory, binaryName);
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { directory, executable };
}

describe("kiro command discovery and invocation", () => {
  it("defines discovery spec with expected id, command, and env override", () => {
    expect(kiroDiscoverySpec.id).toBe("kiro-cli");
    expect(kiroDiscoverySpec.command).toBe("kiro-cli");
    expect(kiroDiscoverySpec.commandEnvironmentVariable).toBe("CODEXHOST_KIRO_COMMAND");
    expect(kiroDiscoverySpec.installRoots.windows).toContain("${LOCALAPPDATA}/Kiro-Cli");
    expect(kiroDiscoverySpec.installRoots.windows).toContain("~/.kiro/bin");
    expect(kiroDiscoverySpec.installRoots.posix).toContain("~/.kiro/bin");
    expect(kiroDiscoverySpec.installRoots.posix).toContain("~/.local/bin");
  });

  it("resolves explicit command override when provided", () => {
    const { executable } = fakeExecutable("custom-kiro");
    const resolved = resolveKiroExecutable({
      command: executable,
      platform: process.platform,
    });
    expect(resolved).toBe(executable);
  });

  it("resolves explicit command with mock dependency isExecutable", () => {
    const customBin = "/opt/custom/kiro-cli";
    const resolved = resolveKiroExecutable(
      {
        command: customBin,
        platform: "linux",
      },
      {
        isExecutable: (candidate) => candidate === customBin,
      },
    );
    expect(resolved).toBe(customBin);
  });

  it("resolves from environment variable override", () => {
    const { executable } = fakeExecutable("env-kiro");
    const resolved = resolveKiroExecutable({
      environment: {
        CODEXHOST_KIRO_COMMAND: executable,
      },
      platform: process.platform,
    });
    expect(resolved).toBe(executable);
  });

  it("resolves from PATH when present", () => {
    const { directory, executable } = fakeExecutable("kiro-cli");
    const resolved = resolveKiroExecutable({
      environment: {
        PATH: directory,
        PATHEXT: ".exe;.cmd",
      },
      platform: process.platform,
    });
    expect(resolved).toBe(executable);
  });

  it("throws KiroExecutableError when executable is not found", () => {
    expect(() =>
      resolveKiroExecutable(
        {
          command: undefined,
          environment: {
            PATH: "",
            LOCALAPPDATA: "C:\\NonExistent",
          },
          homeDirectory: "/nonexistent-home",
          platform: "linux",
        },
        { isExecutable: () => false },
      ),
    ).toThrow(KiroExecutableError);
  });

  it("builds invocation with acp v3 engine and cli auth method", () => {
    const invocation = kiroInvocation("/usr/bin/kiro-cli", "linux");
    expect(invocation.command).toBe("/usr/bin/kiro-cli");
    expect(invocation.arguments).toEqual(["acp", "--agent-engine", "v3", "--auth-method", "cli"]);
  });

  it("never includes rejected --model or --trust-all-tools in invocation arguments", () => {
    const invocation = kiroInvocation("C:\\Kiro\\kiro-cli.exe", "win32");
    expect(invocation.arguments).not.toContain("--model");
    expect(invocation.arguments).not.toContain("--trust-all-tools");
    expect(invocation.arguments).toContain("--agent-engine");
    expect(invocation.arguments).toContain("v3");
    expect(invocation.arguments).toContain("--auth-method");
    expect(invocation.arguments).toContain("cli");
  });
});
