import {
  commandInvocation,
  resolveHarnessExecutable,
  VERSION_MANAGER_ROOTS,
  withNodeRuntimeOnPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";
import { CodeBuddyError } from "./common.js";

export const codeBuddyDiscoverySpec: HarnessDiscoverySpec = {
  id: "codebuddy",
  command: "codebuddy",
  commandEnvironmentVariable: "CODEXHOST_CODEBUDDY_COMMAND",
  installRoots: {
    windows: ["${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
    posix: [
      "~/.local/bin",
      "~/.npm-global/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
  },
};

export function codeBuddyInvocation(
  environment: NodeJS.ProcessEnv,
  ephemeral: boolean,
  argumentsOverride?: string[],
) {
  const resolved = resolveHarnessExecutable(codeBuddyDiscoverySpec, { environment });
  if (!resolved)
    throw new CodeBuddyError(
      "notInstalled",
      "CLI is not installed; run codebuddy and sign in first",
    );
  const env = withNodeRuntimeOnPath(environment);
  return {
    ...commandInvocation(
      resolved.executable,
      argumentsOverride ?? [
        "--acp",
        ...(ephemeral ? ["--no-session-persistence"] : []),
        ...(!ephemeral &&
        [
          "CODEXHOST_CLI_PATH",
          "CODEXHOST_RUNTIME_ENDPOINT",
          "CODEXHOST_RUNTIME_TOKEN",
          "CODEXHOST_THREAD_ID",
        ].every((key) => environment[key])
          ? ["--append-system-prompt", CODEBUDDY_DELEGATION_INSTRUCTIONS]
          : []),
      ],
      env,
    ),
    environment: env,
  };
}

// The CLI applies this native option to ACP's agent system prompt. Runtime secrets
// remain in the per-Session environment and never enter arguments or prompt text.
export const CODEBUDDY_DELEGATION_INSTRUCTIONS = `This Session runs inside codexhost.
When the user requests cross-Harness agent delegation, use the executable at the CODEXHOST_CLI_PATH environment variable through your native shell tool. Start with its --help and harness list commands, then use delegate start and thread send/read/wait/cancel as documented by the CLI. Pass --format compact when reporting results. Keep the inherited CODEXHOST_RUNTIME_ENDPOINT, CODEXHOST_RUNTIME_TOKEN and CODEXHOST_THREAD_ID environment variables for all such calls; they identify this Runtime and parent Thread. Do not print or expose their values, replace the configured executable, or start delegation unless the user's request authorizes it. Native CodeBuddy Agent subagents remain available for CodeBuddy-only work.`;
