import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  remoteSessionOperationSchema,
  type RemoteSessionOperation,
} from "@codexhost/shared-contracts";
import { requestDesktopRemoteConnections } from "./remote-connections-control.js";

function descriptorPath(): string {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_RUNTIME_DIR ??
          process.env.XDG_STATE_HOME ??
          join(homedir(), ".local", "state"));
  if (!base) throw new Error("Desktop runtime directory is unavailable");
  return join(base, "codexhost", "desktop-runtime-v1.json");
}

/** Reads the existing local Launcher's capability; never starts or repairs Desktop. */
export async function requestRemoteSession(
  operation: RemoteSessionOperation,
  path = descriptorPath(),
): Promise<unknown> {
  const input = remoteSessionOperationSchema.parse(operation);
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.size > 4096 ||
    (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
  )
    throw new Error("Desktop runtime descriptor is not a private owned file");
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (
    value.schema_version !== 1 ||
    !Number.isInteger(value.launcher_pid) ||
    Number(value.launcher_pid) <= 0 ||
    !Number.isInteger(value.control_port) ||
    Number(value.control_port) < 1 ||
    Number(value.control_port) > 65535 ||
    typeof value.nonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.nonce)
  )
    throw new Error("Desktop runtime descriptor is invalid");
  process.kill(Number(value.launcher_pid), 0);
  const reply = await requestDesktopRemoteConnections(
    {
      CODEXHOST_CONTROL_PORT: String(value.control_port),
      CODEXHOST_CONTROL_NONCE: value.nonce,
    },
    { action: "session", operation: input },
  );
  if ("error" in reply) throw new Error(reply.error.message);
  return reply.result;
}
