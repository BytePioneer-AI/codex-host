import {
  defaultHarnessBrokerDescriptorPath,
  defaultHarnessBrokerSocketPath,
  startHarnessBrokerServer,
  type HarnessBrokerServer,
} from "@codexhost/harness-broker";

import { loadHarnessPlugins } from "./harness-plugin-loader.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import { harnessPluginIdSchema } from "@codexhost/shared-contracts";

export async function runClaudeAquaHarnessBroker(
  environment: NodeJS.ProcessEnv = process.env,
  requestedHarnessId = "claude-code",
): Promise<number> {
  const harnessId = harnessPluginIdSchema.parse(requestedHarnessId);
  if (process.platform !== "darwin") {
    throw new Error("Aqua Harness broker is available only on macOS");
  }
  // One authenticated socket/descriptor owns exactly one native plugin. Construction
  // runs in the login LaunchAgent; the factory must not recursively choose a Broker client.
  const { pluginRoots, pluginContext } = installedHarnessPluginOptions(environment);
  const plugins = await loadHarnessPlugins({
    roots: pluginRoots,
    context: pluginContext,
    onlyIds: new Set([harnessId]),
    warmup: false,
    diagnose: (diagnostic) =>
      process.stderr.write(`Harness plugin: ${JSON.stringify(diagnostic)}\n`),
  });
  const adapter = [...plugins.adapters.values()][0];
  if (!adapter) {
    await plugins.close();
    throw new Error("The installed Harness plugin required by the Aqua broker is unavailable");
  }
  let server: HarnessBrokerServer;
  try {
    server = await startHarnessBrokerServer({
      descriptorPath: defaultHarnessBrokerDescriptorPath(environment, harnessId),
      socketPath: defaultHarnessBrokerSocketPath(environment, harnessId),
      adapter,
    });
  } catch (error) {
    await adapter.close().catch(() => undefined);
    throw error;
  }
  process.title = `codexhost ${harnessId} Aqua harness broker`;
  process.stdout.write(
    `${JSON.stringify({
      method: "codexhost/harness-broker/ready",
      params: { protocolVersion: 1, harnessId },
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
