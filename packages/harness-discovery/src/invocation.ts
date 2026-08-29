import path from "node:path";

import { environmentValue } from "./environment.js";

export interface CommandInvocation {
  readonly command: string;
  readonly arguments: string[];
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Windows cannot execute a `.cmd`/`.bat` shim directly, so it is wrapped in
 * `cmd.exe` with verbatim arguments and manual quoting.
 */
export function commandInvocation(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): CommandInvocation {
  const extension = path.win32.extname(command).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extension)) {
    return { command, arguments: [...arguments_], windowsVerbatimArguments: false };
  }
  const quote = (value: string): string => `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
  const commandLine = [command, ...arguments_].map(quote).join(" ");
  return {
    command: environmentValue(environment, "ComSpec") ?? "cmd.exe",
    arguments: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
