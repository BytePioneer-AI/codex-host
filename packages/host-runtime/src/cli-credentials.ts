import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";
import { codexhostDataDirectory } from "./external-clients.js";

export interface CliCredentials {
  schemaVersion: 1;
  endpoint: string;
  token: string;
  pid: number;
  startedAt: string;
}

export function cliCredentialsPath(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "cli-credentials.json");
}

/** Read only a bounded private file owned by this user, never a symlink or a remote endpoint. */
export async function readCliCredentials(filePath: string): Promise<CliCredentials | undefined> {
  const invalid = () =>
    new DelegationControlError("UNAUTHORIZED", "Local CLI credentials are invalid or not private");
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid();
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 4096 ||
      (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      throw invalid();
    let value: Partial<CliCredentials> | null;
    try {
      value = JSON.parse(await handle.readFile("utf8")) as Partial<CliCredentials> | null;
    } catch {
      throw invalid();
    }
    if (
      value?.schemaVersion !== 1 ||
      typeof value.endpoint !== "string" ||
      typeof value.token !== "string" ||
      !/^chc_[A-Za-z0-9_-]{43}$/u.test(value.token) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.startedAt !== "string"
    )
      throw invalid();
    let endpoint: URL;
    try {
      endpoint = new URL(value.endpoint);
    } catch {
      throw invalid();
    }
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    )
      throw invalid();
    try {
      process.kill(value.pid as number, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
      throw invalid();
    }
    return value as CliCredentials;
  } finally {
    await handle.close();
  }
}
