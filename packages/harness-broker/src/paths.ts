import os from "node:os";
import path from "node:path";
import { harnessPluginIdSchema } from "@codexhost/shared-contracts";

export const HARNESS_BROKER_DESCRIPTOR_ENV = "CODEXHOST_CLAUDE_BROKER_DESCRIPTOR";
export const HARNESS_BROKER_DESCRIPTOR_FILE = "claude-code-broker-v1.json";
export const HARNESS_BROKER_SOCKET_FILE = "claude-code-broker-v1.sock";

export function defaultHarnessBrokerDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const home = environment.HOME || os.homedir();
  return path.join(home, ".codexhost", "harness-broker");
}

export function defaultHarnessBrokerDescriptorPath(
  environment: NodeJS.ProcessEnv = process.env,
  harnessId = "claude-code",
): string {
  harnessPluginIdSchema.parse(harnessId);
  if (harnessId !== "claude-code")
    return path.join(defaultHarnessBrokerDirectory(environment), `${harnessId}-broker-v1.json`);
  return (
    environment[HARNESS_BROKER_DESCRIPTOR_ENV] ??
    path.join(defaultHarnessBrokerDirectory(environment), HARNESS_BROKER_DESCRIPTOR_FILE)
  );
}

export function defaultHarnessBrokerSocketPath(
  environment: NodeJS.ProcessEnv = process.env,
  harnessId = "claude-code",
): string {
  harnessPluginIdSchema.parse(harnessId);
  if (harnessId !== "claude-code")
    return path.join(defaultHarnessBrokerDirectory(environment), `${harnessId}-broker-v1.sock`);
  return path.join(defaultHarnessBrokerDirectory(environment), HARNESS_BROKER_SOCKET_FILE);
}
