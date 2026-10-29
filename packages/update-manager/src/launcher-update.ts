import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sameWindowsPath } from "./windows-installation.js";
import {
  readWindowsProcessIdentity,
  type WindowsProcessIdentity,
} from "./windows-process-identity.js";

export interface LauncherRequest {
  wait_pid: number;
  wait_executable: string;
  wait_started_at_micros?: string;
}

/** Publish intent only. The Launcher outside the Desktop Job owns spawn,
 * failure reporting, and the existing native lock/readiness handshake. */
export async function requestLauncherUpdate(
  requestPath: string,
  expected: LauncherRequest,
  readIdentity: (pid: number) => Promise<WindowsProcessIdentity> = readWindowsProcessIdentity,
): Promise<void> {
  const identity = await readIdentity(expected.wait_pid);
  if (
    identity.startedAtMicros !== expected.wait_started_at_micros ||
    !sameWindowsPath(identity.executable, expected.wait_executable)
  )
    throw new Error("Launcher identity changed before requesting update startup");
  const request = JSON.parse(await readFile(requestPath, "utf8")) as LauncherRequest;
  if (
    request.wait_pid !== expected.wait_pid ||
    request.wait_started_at_micros !== expected.wait_started_at_micros ||
    request.wait_executable !== expected.wait_executable
  )
    throw new Error("Prepared update owner changed before Launcher delegation");
  const temporary = path.join(path.dirname(requestPath), `.launcher-update-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ ...request, launch_via_launcher: true })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, requestPath);
  } finally {
    await rm(temporary, { force: true });
  }
}
