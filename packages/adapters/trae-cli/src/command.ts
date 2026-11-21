import {
  commandInvocation,
  resolveHarnessExecutable,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";
import { TraeCliError } from "./common.js";

export const traeDiscovery: HarnessDiscoverySpec = {
  id: "trae-cli",
  command: "traecli",
  commandEnvironmentVariable: "CODEXHOST_TRAE_CLI_COMMAND",
  installRoots: {
    posix: ["~/.local/bin", "~/.trae/bin", "/usr/local/bin", "/opt/homebrew/bin"],
    windows: ["~/.local/bin", "~/.trae/bin"],
  },
};
export function resolveTraeExecutable(environment: NodeJS.ProcessEnv, command?: string) {
  const found = resolveHarnessExecutable(traeDiscovery, {
    environment,
    ...(command ? { command } : {}),
  });
  if (!found)
    throw new TraeCliError(
      "notInstalled",
      "TRAE CLI is not installed; install traecli or set CODEXHOST_TRAE_CLI_COMMAND",
    );
  return found.executable;
}
export function traeInvocation(
  environment: NodeJS.ProcessEnv,
  command?: string,
  args = ["acp", "serve"],
) {
  return commandInvocation(resolveTraeExecutable(environment, command), args, environment);
}
