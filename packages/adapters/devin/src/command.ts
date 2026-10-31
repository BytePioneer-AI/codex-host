import { commandInvocation, resolveHarnessExecutable } from "@codexhost/harness-discovery";

export function devinInvocation(environment: NodeJS.ProcessEnv, command?: string) {
  const resolution = resolveHarnessExecutable(
    {
      id: "devin",
      command: "devin",
      commandEnvironmentVariable: "CODEXHOST_DEVIN_COMMAND",
      installRoots: {
        posix: ["~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"],
      },
    },
    { environment, ...(command ? { command } : {}) },
  );
  if (!resolution)
    throw new Error("Devin CLI is not installed; install devin or set CODEXHOST_DEVIN_COMMAND");
  return commandInvocation(resolution.executable, ["acp"], environment);
}
