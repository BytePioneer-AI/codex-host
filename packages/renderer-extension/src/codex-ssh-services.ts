import { loadCodexNativeServices } from "./codex-native-services.js";

/** Native SSH service signatures consumed by the SSH Adapter. */
export interface CodexSshServices {
  sshConnections: {
    refresh(): Promise<unknown>;
    save(params: unknown): Promise<unknown>;
  };
  remoteConnections: {
    setAutoConnect(params: unknown): Promise<unknown>;
    getState(hostId: string): Promise<unknown>;
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isSshServices(value: unknown): value is CodexSshServices {
  if (
    !record(value) ||
    !Object.hasOwn(value, "sshConnections") ||
    !Object.hasOwn(value, "remoteConnections")
  )
    return false;
  const ssh = value.sshConnections;
  const remote = value.remoteConnections;
  // Native RPC stubs are callable proxies, so they need not be plain objects.
  return (
    ssh != null &&
    remote != null &&
    typeof (ssh as CodexSshServices["sshConnections"]).refresh === "function" &&
    typeof (ssh as CodexSshServices["sshConnections"]).save === "function" &&
    typeof (remote as CodexSshServices["remoteConnections"]).getState === "function" &&
    typeof (remote as CodexSshServices["remoteConnections"]).setAutoConnect === "function"
  );
}

export async function loadCodexSshServices(
  ownerWindow: Window,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
): Promise<CodexSshServices | null> {
  return loadCodexNativeServices(ownerWindow, isSshServices, importModule);
}
