import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import {
  defaultHarnessBrokerDescriptorPath,
  defaultHarnessBrokerSocketPath,
  startHarnessBrokerServer,
  type HarnessBrokerServer,
} from "@codexhost/harness-broker";

import { CLAUDE_CODE_COMMAND_ENV } from "./adapter-composition.js";

export async function runClaudeAquaHarnessBroker(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (process.platform !== "darwin") {
    throw new Error("Claude Aqua Harness broker is available only on macOS");
  }
  const adapter = new ClaudeCodeAdapter({
    ...(environment[CLAUDE_CODE_COMMAND_ENV]
      ? { command: environment[CLAUDE_CODE_COMMAND_ENV] }
      : {}),
    environment,
  });
  let server: HarnessBrokerServer;
  try {
    server = await startHarnessBrokerServer({
      descriptorPath: defaultHarnessBrokerDescriptorPath(environment),
      socketPath: defaultHarnessBrokerSocketPath(environment),
      adapter,
    });
  } catch (error) {
    await adapter.close().catch(() => undefined);
    throw error;
  }
  process.title = "codexhost claude-code Aqua harness broker";
  process.stdout.write(
    `${JSON.stringify({
      method: "codexhost/harness-broker/ready",
      params: { protocolVersion: 1, harnessId: "claude-code" },
    })}\n`,
  );
  let stop: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      stop = resolve;
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    return 0;
  } finally {
    if (stop) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    await server.close();
  }
}
