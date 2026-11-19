import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  remoteSessionOperationSchema,
  remoteSessionRequestBytes,
  REMOTE_CONTROLLER_REQUEST_MAX_BYTES,
  type RemoteSessionOperation,
  type RemoteConnectionsReply,
} from "@codexhost/shared-contracts";
import { requestDesktopRemoteConnections } from "./remote-connections-control.js";
import { readRemoteProjectMetadata } from "./remote-project-metadata.js";

export class RemoteSessionError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteSessionError";
  }
}

function resultOf(reply: RemoteConnectionsReply): unknown {
  if ("error" in reply) throw new RemoteSessionError(reply.error.code, reply.error.message);
  return reply.result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Assemble bounded Controller pages without putting the complete history on one reply. */
async function readHistory(
  input: Extract<RemoteSessionOperation, { kind: "read" }>,
  request: (operation: RemoteSessionOperation) => Promise<RemoteConnectionsReply>,
): Promise<unknown> {
  const turns: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let epoch: string | undefined;
  let bytes = 0;
  for (let page = 0; page < 5000; page++) {
    const reply = await request({
      ...input,
      page: { cursor, ...(epoch === undefined ? {} : { epoch }) },
    });
    const snapshot = resultOf(reply);
    if (
      !record(snapshot) ||
      typeof snapshot.epoch !== "string" ||
      !snapshot.epoch ||
      !record(snapshot.result) ||
      !record(snapshot.result.thread) ||
      snapshot.result.thread.id !== input.threadId ||
      !Array.isArray(snapshot.result.thread.turns) ||
      (snapshot.nextCursor !== null &&
        (typeof snapshot.nextCursor !== "string" || snapshot.nextCursor.length === 0))
    )
      throw new RemoteSessionError(-32603, "Invalid remote history page; refresh and retry.");
    if (epoch !== undefined && snapshot.epoch !== epoch)
      throw new RemoteSessionError(
        -32095,
        "Remote connection changed during history pagination; refresh and retry.",
      );
    epoch = snapshot.epoch;
    bytes += Buffer.byteLength(JSON.stringify(snapshot.result.thread.turns));
    if (bytes > 128 * 1024 * 1024 || turns.length + snapshot.result.thread.turns.length > 5000)
      throw new RemoteSessionError(
        -32094,
        "Remote history exceeds the Web history limit (128 MiB or 5,000 Turns); open this chat in Codex Desktop.",
      );
    turns.push(...snapshot.result.thread.turns);
    cursor = snapshot.nextCursor;
    if (cursor === null) {
      const complete = { ...snapshot };
      delete complete.nextCursor;
      return {
        ...complete,
        result: { ...snapshot.result, thread: { ...snapshot.result.thread, turns } },
      };
    }
    if (snapshot.result.thread.turns.length === 0)
      throw new RemoteSessionError(
        -32603,
        "Remote history page did not advance; refresh and retry.",
      );
    if (cursors.has(cursor))
      throw new RemoteSessionError(-32603, "Remote history cursor repeated; refresh and retry.");
    cursors.add(cursor);
  }
  throw new RemoteSessionError(
    -32094,
    "Remote history exceeds the page limit; open this chat in Codex Desktop.",
  );
}

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
  const environment = {
    CODEXHOST_CONTROL_PORT: String(value.control_port),
    CODEXHOST_CONTROL_NONCE: value.nonce,
  };
  const request = (operation: RemoteSessionOperation) =>
    requestDesktopRemoteConnections(environment, { action: "session", operation });
  if (input.kind === "read" && input.page === undefined) return readHistory(input, request);
  const result = resultOf(await request(input));
  if (input.kind === "hosts" && Array.isArray(result)) {
    const projects = await readRemoteProjectMetadata().catch(() => []);
    return result.map((host) =>
      host && typeof host === "object" && !Array.isArray(host)
        ? { ...host, projects: projects.filter((p) => p.hostId === host.hostId) }
        : host,
    );
  }
  return result;
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
