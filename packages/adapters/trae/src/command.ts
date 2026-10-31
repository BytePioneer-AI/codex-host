import { resolveHarnessExecutable, type HarnessDiscoverySpec } from "@codexhost/harness-discovery";
import { TraeError } from "./protocol.js";

export const traeDiscoverySpec: HarnessDiscoverySpec = {
  id: "trae",
  command: "traecli",
  commandEnvironmentVariable: "CODEXHOST_TRAE_COMMAND",
  installRoots: {
    windows: ["${LOCALAPPDATA}/Programs/TraeCLI/bin", "~/.local/bin"],
    posix: ["~/.local/bin", "~/.trae/bin", "/usr/local/bin", "/opt/homebrew/bin"],
  },
};
export function resolveTrae(environment: NodeJS.ProcessEnv, command?: string): string {
  const result = resolveHarnessExecutable(traeDiscoverySpec, {
    environment,
    ...(command ? { command } : {}),
  });
  if (!result)
    throw new TraeError(
      "notInstalled",
      "Trae CLI is not installed; install Trae CLI 2.0 and run traecli login",
    );
  return result.executable;
}
