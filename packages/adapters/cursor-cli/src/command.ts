import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { commandInvocation, resolveHarnessExecutable } from "@codexhost/harness-discovery";

export function cursorInvocation(environment: NodeJS.ProcessEnv, command?: string) {
  const resolution = resolveHarnessExecutable(
    {
      id: "cursor-cli",
      command: "cursor-agent",
      commandEnvironmentVariable: "CODEXHOST_CURSOR_COMMAND",
      installRoots: {
        posix: ["~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"],
        windows: ["${LOCALAPPDATA}/cursor-agent"],
      },
    },
    { environment, ...(command ? { command } : {}) },
  );
  if (!resolution)
    throw new Error(
      "Cursor CLI is not installed; install cursor-agent or set CODEXHOST_CURSOR_COMMAND",
    );
  // Launch the official Windows bundle directly, avoiding an intermediate cmd/PowerShell
  // owner whose death could leave the ACP process alive. No user command is interpreted.
  if (process.platform === "win32" && /\.(cmd|ps1)$/iu.test(resolution.executable)) {
    const root = path.dirname(resolution.executable);
    const versions = path.join(root, "versions");
    if (existsSync(versions)) {
      const version = readdirSync(versions)
        .filter((name) => /^\d{4}\.\d{2}\.\d{2}-(?:\d{2}-\d{2}-\d{2}-)?[a-f0-9]+$/u.test(name))
        .sort()
        .reverse()
        .find(
          (name) =>
            existsSync(path.join(versions, name, "node.exe")) &&
            existsSync(path.join(versions, name, "index.js")),
        );
      if (version)
        return {
          command: path.join(versions, version, "node.exe"),
          arguments: [path.join(versions, version, "index.js"), "acp"],
          windowsVerbatimArguments: false,
        };
    }
    throw new Error(
      "Cursor Windows launcher has no supported native bundle; configure a native executable",
    );
  }
  return commandInvocation(resolution.executable, ["acp"], environment);
}
