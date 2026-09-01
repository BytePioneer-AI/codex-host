import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  commandInvocation,
  harnessCandidates,
  isExecutableFile,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  withNodeRuntimeOnPath,
  type HarnessCandidateSource,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export { withNodeRuntimeOnPath };

export const CURSOR_COMMAND_ENV = "CODEXHOST_CURSOR_COMMAND";
export const CURSOR_PREFERRED_COMMAND = "cursor-agent";
export const CURSOR_FALLBACK_COMMAND = "agent";

export type CursorExecutableFault =
  "notInstalled" | "notExecutable" | "wrongIdentity" | "versionUnreadable";

export class CursorExecutableError extends Error {
  readonly diagnostic: string | undefined;

  constructor(
    readonly kind: CursorExecutableFault,
    message: string,
    options?: ErrorOptions & { diagnostic?: string },
  ) {
    super(message, options);
    this.diagnostic = options?.diagnostic;
    this.name = "CursorExecutableError";
  }
}

export interface CursorResolution {
  readonly executable: string;
  readonly source: HarnessCandidateSource;
  readonly version: string;
}

export const cursorAgentDiscoverySpec: HarnessDiscoverySpec = {
  id: "cursor",
  command: CURSOR_PREFERRED_COMMAND,
  commandEnvironmentVariable: CURSOR_COMMAND_ENV,
  installRoots: {
    posix: ["~/.local/bin", VERSION_MANAGER_ROOTS, "/opt/homebrew/bin", "/usr/local/bin"],
    windows: [
      "${LOCALAPPDATA}/cursor-agent",
      "${APPDATA}/npm",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
    ],
  },
};

export const cursorFallbackDiscoverySpec: HarnessDiscoverySpec = {
  ...cursorAgentDiscoverySpec,
  command: CURSOR_FALLBACK_COMMAND,
};

const IDENTITY_TIMEOUT_MS = 3_000;
const CURSOR_HELP_MARKERS = ["start the cursor agent", "cursor agent as an acp"];
const GROK_HELP_MARKERS = ["grok build tui", "grok --worktree"];
const CURSOR_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/iu;

function runCli(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { status: number | null; stdout: string; stderr: string } {
  const spawnEnvironment = withNodeRuntimeOnPath(environment, process.execPath, platform);
  const invocation = commandInvocation(executable, arguments_, spawnEnvironment, platform);
  const result = spawnSync(invocation.command, invocation.arguments, {
    encoding: "utf8",
    env: spawnEnvironment,
    timeout: IDENTITY_TIMEOUT_MS,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function classifyCursorCliText(text: string): "cursor" | "grok" | "unknown" {
  const normalized = text.toLowerCase();
  if (
    GROK_HELP_MARKERS.some((marker) => normalized.includes(marker)) ||
    /^\s*grok\s+\d/imu.test(text)
  ) {
    return "grok";
  }
  if (
    CURSOR_HELP_MARKERS.some((marker) => normalized.includes(marker)) ||
    CURSOR_VERSION_PATTERN.test(text.trim().split(/\s+/u)[0] ?? "")
  ) {
    return "cursor";
  }
  return "unknown";
}

export function identifyCursorExecutable(
  executable: string,
  input: {
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): { identity: "cursor"; version: string } {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? process.env;
  if (!fs.existsSync(executable)) {
    throw new CursorExecutableError("notInstalled", "Cursor CLI is not installed");
  }
  if (!isExecutableFile(executable, platform)) {
    throw new CursorExecutableError("notExecutable", `Cursor CLI is not executable: ${executable}`);
  }
  const help = runCli(executable, ["--help"], environment, platform);
  const helpText = `${help.stdout}\n${help.stderr}`;
  const identity = classifyCursorCliText(helpText);
  if (identity === "grok") {
    throw new CursorExecutableError(
      "wrongIdentity",
      "PATH `agent` is Grok, not Cursor CLI; install `cursor-agent` or set CODEXHOST_CURSOR_COMMAND",
      { diagnostic: helpText.slice(0, 500) },
    );
  }
  if (identity !== "cursor") {
    throw new CursorExecutableError(
      "wrongIdentity",
      `Executable is not Cursor CLI: ${executable}`,
      { diagnostic: helpText.slice(0, 500) },
    );
  }
  const versionResult = runCli(executable, ["--version"], environment, platform);
  const version = versionResult.stdout.trim().split(/\s+/u)[0] ?? "";
  if (version.length === 0) {
    throw new CursorExecutableError("versionUnreadable", "Cursor CLI did not report a version", {
      diagnostic: `${versionResult.stdout}\n${versionResult.stderr}`.slice(0, 500),
    });
  }
  return { identity: "cursor", version };
}

function absoluteExecutable(executable: string, platform: NodeJS.Platform): string {
  return targetPath(platform).isAbsolute(executable) ? executable : path.resolve(executable);
}

function configuredCommand(input: {
  command?: string;
  environment?: NodeJS.ProcessEnv;
}): string | undefined {
  return input.command ?? input.environment?.[CURSOR_COMMAND_ENV];
}

export function resolveCursorExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
    identify?: typeof identifyCursorExecutable;
  } = {},
): CursorResolution {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? process.env;
  const identify = input.identify ?? identifyCursorExecutable;
  const configured = configuredCommand(input);
  const discoveryInput = {
    ...(configured ? { command: configured } : {}),
    environment,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  };

  if (configured !== undefined) {
    const resolution = resolveHarnessExecutable(cursorAgentDiscoverySpec, discoveryInput);
    if (!resolution) {
      const candidate = harnessCandidates(cursorAgentDiscoverySpec, discoveryInput)[0]?.candidate;
      if (candidate && fs.existsSync(candidate) && !isExecutableFile(candidate, platform)) {
        throw new CursorExecutableError(
          "notExecutable",
          `Cursor CLI is not executable: ${candidate}`,
        );
      }
      throw new CursorExecutableError("notInstalled", "Configured Cursor CLI is not installed");
    }
    const identified = identify(resolution.executable, { environment, platform });
    return {
      executable: absoluteExecutable(resolution.executable, platform),
      source: resolution.source,
      version: identified.version,
    };
  }

  const preferred = resolveHarnessExecutable(cursorAgentDiscoverySpec, discoveryInput);
  if (preferred) {
    try {
      const identified = identify(preferred.executable, { environment, platform });
      return {
        executable: absoluteExecutable(preferred.executable, platform),
        source: preferred.source,
        version: identified.version,
      };
    } catch (error) {
      if (!(error instanceof CursorExecutableError)) throw error;
      if (error.kind !== "wrongIdentity" && error.kind !== "notExecutable") throw error;
    }
  }

  let seenNotExecutable: string | undefined;
  let seenWrongIdentity = false;
  for (const { candidate, source } of harnessCandidates(
    cursorFallbackDiscoverySpec,
    discoveryInput,
  )) {
    if (!fs.existsSync(candidate)) continue;
    if (!isExecutableFile(candidate, platform)) {
      seenNotExecutable ??= candidate;
      continue;
    }
    try {
      const identified = identify(candidate, { environment, platform });
      return {
        executable: absoluteExecutable(candidate, platform),
        source,
        version: identified.version,
      };
    } catch (error) {
      if (error instanceof CursorExecutableError && error.kind === "wrongIdentity") {
        seenWrongIdentity = true;
        continue;
      }
      if (error instanceof CursorExecutableError && error.kind === "notExecutable") {
        seenNotExecutable ??= candidate;
        continue;
      }
      throw error;
    }
  }

  if (seenWrongIdentity) {
    throw new CursorExecutableError(
      "wrongIdentity",
      "PATH `agent` is not Cursor CLI; install `cursor-agent` or set CODEXHOST_CURSOR_COMMAND",
    );
  }
  if (seenNotExecutable) {
    throw new CursorExecutableError(
      "notExecutable",
      `Cursor CLI is not executable: ${seenNotExecutable}`,
    );
  }
  throw new CursorExecutableError("notInstalled", "Cursor CLI is not installed");
}

export function cursorInvocation(
  command: string,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): {
  command: string;
  arguments: string[];
  windowsVerbatimArguments: boolean;
} {
  return commandInvocation(command, ["acp"], environment, platform);
}
