import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  remoteSessionOperationSchema,
  remoteSessionRequestBytes,
  REMOTE_CONTROLLER_REQUEST_MAX_BYTES,
  type RemoteSessionOperation,
} from "@codexhost/shared-contracts";
import { requestDesktopRemoteConnections } from "./remote-connections-control.js";
import { readRemoteProjectMetadata } from "./remote-project-metadata.js";

export function remoteSessionDescriptorPaths(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  uid = process.getuid?.(),
): string[] {
  const explicit = environment.CODEXHOST_DESKTOP_RUNTIME_DESCRIPTOR;
  if (explicit) {
    if (!isAbsolute(explicit))
      throw new Error("CODEXHOST_DESKTOP_RUNTIME_DESCRIPTOR must be absolute");
    return [explicit];
  }
  const bases =
    platform === "win32"
      ? [environment.LOCALAPPDATA]
      : platform === "darwin"
        ? [join(home, "Library", "Application Support")]
        : [
            environment.XDG_RUNTIME_DIR,
            uid === undefined ? undefined : `/run/user/${uid}`,
            environment.XDG_STATE_HOME,
            join(home, ".local", "state"),
          ];
  return [
    ...new Set(
      bases
        .filter((base): base is string => !!base && isAbsolute(base))
        .map((base) => join(base, "codexhost", "desktop-runtime-v1.json")),
    ),
  ];
}

/** Reads the existing local Launcher's capability; never starts or repairs Desktop. */
export async function requestRemoteSession(
  operation: RemoteSessionOperation,
  path: string | readonly string[] = remoteSessionDescriptorPaths(),
): Promise<unknown> {
  const input = remoteSessionOperationSchema.parse(operation);
  if (remoteSessionRequestBytes(input) > REMOTE_CONTROLLER_REQUEST_MAX_BYTES)
    throw new Error("Remote request is too large; shorten the message before sending");
  const paths = typeof path === "string" ? [path] : path;
  const candidates = [];
  for (const candidate of paths) {
    try {
      candidates.push(await readDescriptor(candidate));
    } catch (error) {
      if (paths.length === 1 && typeof path === "string") throw error;
    }
  }
  const unique = new Map(
    candidates.map((value) => [
      JSON.stringify([value.launcher_pid, value.control_port, value.nonce]),
      value,
    ]),
  );
  if (unique.size !== 1)
    throw new Error(
      "Desktop descriptor unavailable or ambiguous. Start codexhost Desktop, or set CODEXHOST_DESKTOP_RUNTIME_DESCRIPTOR to its private desktop-runtime-v1.json path.",
    );
  const value = [...unique.values()][0];
  if (!value) throw new Error("Desktop descriptor unavailable");
  // Discovery finishes before dispatch. Never try another descriptor after a lost reply.
  const reply = await requestDesktopRemoteConnections(
    {
      CODEXHOST_CONTROL_PORT: String(value.control_port),
      CODEXHOST_CONTROL_NONCE: value.nonce,
    },
    { action: "session", operation: input },
  );
  if ("error" in reply) throw new Error(reply.error.message);
  if (input.kind === "hosts" && Array.isArray(reply.result)) {
    const projects = await readRemoteProjectMetadata().catch(() => []);
    return reply.result.map((host) =>
      host && typeof host === "object" && !Array.isArray(host)
        ? { ...host, projects: projects.filter((p) => p.hostId === host.hostId) }
        : host,
    );
  }
  return reply.result;
}

async function readDescriptor(
  path: string,
): Promise<{ launcher_pid: number; control_port: number; nonce: string }> {
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
  return {
    launcher_pid: Number(value.launcher_pid),
    control_port: Number(value.control_port),
    nonce: value.nonce,
  };
}
