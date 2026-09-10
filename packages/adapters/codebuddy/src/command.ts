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

export function codeBuddyInvocation(environment: NodeJS.ProcessEnv, ephemeral: boolean) {
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
      ["--acp", ...(ephemeral ? ["--no-session-persistence"] : [])],
      env,
    ),
    environment: env,
  };
}
