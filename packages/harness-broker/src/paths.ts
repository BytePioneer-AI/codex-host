import os from "node:os";
import path from "node:path";

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
): string {
  return (
    environment[HARNESS_BROKER_DESCRIPTOR_ENV] ??
    path.join(defaultHarnessBrokerDirectory(environment), HARNESS_BROKER_DESCRIPTOR_FILE)
  );
}

export function defaultHarnessBrokerSocketPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(defaultHarnessBrokerDirectory(environment), HARNESS_BROKER_SOCKET_FILE);
}
