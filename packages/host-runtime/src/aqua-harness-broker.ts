import {
  defaultHarnessBrokerDescriptorPath,
  defaultHarnessBrokerSocketPath,
  startHarnessBrokerServer,
  type HarnessBrokerServer,
} from "@codexhost/harness-broker";

import { loadHarnessPlugins } from "./harness-plugin-loader.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";

export async function runClaudeAquaHarnessBroker(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (process.platform !== "darwin") {
    throw new Error("Claude Aqua Harness broker is available only on macOS");
  }
  // The legacy Broker protocol still targets Claude Code, but construction and
  // dependencies belong to its installed plugin. Do not recursively use a Broker client here.
  const { pluginRoots, pluginContext } = installedHarnessPluginOptions(environment);
  const plugins = await loadHarnessPlugins({
    roots: pluginRoots,
    context: pluginContext,
    onlyIds: new Set(["claude-code"]),
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
