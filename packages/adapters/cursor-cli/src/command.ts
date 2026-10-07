import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  commandInvocation,
  resolveHarnessExecutable,
  type HarnessDiscoverySpec,
  type HarnessResolution,
} from "@codexhost/harness-discovery";

// Adapted from liki-0814/codex-host commit 93f45d18 (LGPL-3.0).
const PINNED_VERSION_AGENT =
  /[/\\]cursor-agent[/\\]versions[/\\][^/\\]+[/\\]cursor-agent(?:\.exe)?$/iu;

function cursorDiscoverySpec(skipPinnedVersions: boolean): HarnessDiscoverySpec {
  return {
    id: "cursor-cli",
    command: "cursor-agent",
    commandEnvironmentVariable: "CODEXHOST_CURSOR_COMMAND",
    installRoots: {
      posix: ["~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"],
      windows: ["${LOCALAPPDATA}/cursor-agent"],
    },
    ...(skipPinnedVersions
      ? {
          runnableCandidate: (candidate) =>
            PINNED_VERSION_AGENT.test(candidate) ? undefined : candidate,
        }
      : {}),
  };
}

/** Prefer the rolling launcher; an explicit executable remains authoritative. */
/** The Cursor CLI was not found; other discovery failures are reported as is. */
export class CursorNotInstalledError extends Error {}

export function resolveCursorExecutable(
  environment: NodeJS.ProcessEnv,
  command?: string,
): HarnessResolution {
  const input = { environment, ...(command ? { command } : {}) };
  const pinned = resolveHarnessExecutable(cursorDiscoverySpec(false), input);
  if (!pinned)
    throw new CursorNotInstalledError(
      "Cursor CLI is not installed; install cursor-agent or set CODEXHOST_CURSOR_COMMAND",
    );
  const explicit = command?.trim() || environment.CODEXHOST_CURSOR_COMMAND?.trim();
  if (explicit || !PINNED_VERSION_AGENT.test(pinned.executable)) return pinned;
  return resolveHarnessExecutable(cursorDiscoverySpec(true), input) ?? pinned;
}

export function cursorInvocation(
  environment: NodeJS.ProcessEnv,
  command: string | undefined,
  args: string[],
) {
  const resolution = resolveCursorExecutable(environment, command);
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
          arguments: [path.join(versions, version, "index.js"), ...args],
          windowsVerbatimArguments: false,
        };
    }
    throw new Error(
      "Cursor Windows launcher has no supported native bundle; configure a native executable",
    );
  }
  return commandInvocation(resolution.executable, args, environment);
}
