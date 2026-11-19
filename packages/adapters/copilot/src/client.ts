import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";
import { resolveCopilotExecutable } from "./command.js";

export interface CopilotClientInput {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionEnvironment?: NodeJS.ProcessEnv;
  command?: string;
}

export function copilotEnvironment(
  base: NodeJS.ProcessEnv,
  override: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    for (const existing of Object.keys(merged)) {
      if (
        existing === key ||
        (platform === "win32" && existing.toLowerCase() === key.toLowerCase())
      )
        Reflect.deleteProperty(merged, existing);
    }
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** Each client owns one explicit local CLI and its complete child environment. */
export function createCopilotClient(input: CopilotClientInput): CopilotClient {
  const merged = copilotEnvironment(input.environment, input.sessionEnvironment);
  const environment = Object.fromEntries(
    Object.entries(withNodeRuntimeOnPath(merged)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const executable = resolveCopilotExecutable({
    environment,
    ...(input.command === undefined ? {} : { command: input.command }),
  });
  return new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: executable, env: environment }),
    workingDirectory: input.cwd,
    mode: "copilot-cli",
    useLoggedInUser: true,
    logLevel: "none",
  });
}
