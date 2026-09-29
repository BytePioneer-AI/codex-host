import os from "node:os";
import path from "node:path";

export const DEFAULT_CONSOLE_PORT = 26339;
export const CONSOLE_PORT_ENV = "CODEXHOST_CONSOLE_PORT";
export const LAUNCHER_EXECUTABLE_ENV = "CODEXHOST_LAUNCHER_EXECUTABLE";

/** Same rule as the Host Runtime log and the Launcher startup record. */
export function dataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
}

export interface ConsolePaths {
  dataDirectory: string;
  startupRecordFile: string;
  controllerStatusFile: string;
  logsDirectory: string;
  /** Local Hosts publish their console channel here. */
  hostDescriptorDirectory: string;
}

export function consolePaths(environment: NodeJS.ProcessEnv = process.env): ConsolePaths {
  const root = dataDirectory(environment);
  return {
    dataDirectory: root,
    startupRecordFile: path.join(root, "diagnostics", "launcher-startup-v1.json"),
    controllerStatusFile: path.join(root, "diagnostics", "desktop-controller-v1.json"),
    logsDirectory: path.join(root, "logs"),
    hostDescriptorDirectory: path.join(root, "console", "hosts"),
  };
}

export function consolePort(environment: NodeJS.ProcessEnv = process.env): number {
  const value = environment[CONSOLE_PORT_ENV];
  if (value === undefined || value === "") return DEFAULT_CONSOLE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${CONSOLE_PORT_ENV} must be an integer between 1024 and 65535`);
  }
  return port;
}
