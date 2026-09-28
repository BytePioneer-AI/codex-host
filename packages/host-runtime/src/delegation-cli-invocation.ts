import { DELEGATION_CLI_NODE_PATH_ENV, DELEGATION_CLI_PATH_ENV } from "./delegation-types.js";

/** Select the entry point belonging to this Host, without searching PATH. */
export function delegationCliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (environment[DELEGATION_CLI_PATH_ENV]) {
    return {
      [DELEGATION_CLI_PATH_ENV]: environment[DELEGATION_CLI_PATH_ENV],
      [DELEGATION_CLI_NODE_PATH_ENV]: environment[DELEGATION_CLI_NODE_PATH_ENV],
    };
  }
  const npmLauncher = environment.CODEXHOST_NPM_LAUNCHER_PATH;
  return {
    [DELEGATION_CLI_PATH_ENV]: npmLauncher ?? environment.CODEXHOST_LAUNCHER_EXECUTABLE,
    // A .js entry point is not a native executable on Windows. An explicit
    // Node path also avoids a shebang resolving a different Node through PATH.
    [DELEGATION_CLI_NODE_PATH_ENV]: npmLauncher
      ? (environment.CODEXHOST_NPM_NODE_PATH ?? process.execPath)
      : undefined,
  };
}

function quote(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Render at the CLI boundary: a remote Runtime's executable is not local. */
export function delegationNextCommands(
  environment: NodeJS.ProcessEnv,
  threadId: string,
  platform: NodeJS.Platform = process.platform,
): { read: string; wait: string } {
  const cliPath = environment[DELEGATION_CLI_PATH_ENV];
  const nodePath = environment[DELEGATION_CLI_NODE_PATH_ENV];
  const cli = cliPath
    ? quote(cliPath, platform)
    : platform === "win32"
      ? "$env:CODEXHOST_CLI_PATH"
      : '"$CODEXHOST_CLI_PATH"';
  const invocation = `${platform === "win32" ? "& " : ""}${nodePath ? `${quote(nodePath, platform)} ` : ""}${cli}`;
  const thread = quote(threadId, platform);
  return {
    read: `${invocation} thread read ${thread}`,
    wait: `${invocation} thread wait ${thread} --timeout-ms 30000`,
  };
}
