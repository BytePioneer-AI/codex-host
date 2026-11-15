import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, readFileSync, readlinkSync } from "node:fs";
import { link, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

export interface LockRecord {
  pid: number;
  instanceId: string;
  startedAt: string;
  executablePath?: string;
  processStartedAt?: string;
  processStartTicks?: string;
}

interface ProcessIdentity {
  executablePath: string | null;
  startedAt: number | null;
  startTicks?: string | null;
}

// Node captures this epoch at process startup, independent of subsequent clock changes or sleep.
const processStartedAt = Math.round(performance.timeOrigin);

function linuxIdentity(pid: number): ProcessIdentity | null {
  let startTicks: string | null = null;
  let executablePath: string | null = null;
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(")");
    const fields =
      end < 0
        ? []
        : text
            .slice(end + 1)
            .trim()
            .split(/\s+/);
    if (fields[0] === "Z") return null;
    if (fields[19] && /^\d+$/.test(fields[19])) startTicks = fields[19];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if (!(
          probeError &&
          typeof probeError === "object" &&
          "code" in probeError &&
          probeError.code === "EPERM"
        ))
          return null;
      }
    }
    // Unreadable metadata cannot disprove the PID's identity.
  }
  try {
    executablePath = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
  } catch {
    // Executable paths can be restricted even when the PID exists.
  }
  return { executablePath, startedAt: null, startTicks };
}

export function currentLockIdentity(): Pick<LockRecord, "processStartedAt" | "processStartTicks"> {
  const ticks = process.platform === "linux" ? linuxIdentity(process.pid)?.startTicks : null;
  return {
    processStartedAt: new Date(processStartedAt).toISOString(),
    ...(ticks ? { processStartTicks: ticks } : {}),
  };
}

function processIdentity(pid: number): ProcessIdentity | null {
  if (pid === process.pid && process.platform !== "linux") {
    return { executablePath: process.execPath, startedAt: processStartedAt };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM"))
      return null;
  }

  if (process.platform === "linux") return linuxIdentity(pid);
  if (process.platform !== "win32" && process.platform !== "darwin") {
    return { executablePath: null, startedAt: null };
  }

  try {
    if (process.platform === "darwin") {
      // lstart has second precision, covered by the start-time tolerance.
      const result = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C" },
        timeout: 1_000,
      }).trim();
      const startedAt = Date.parse(result);
      return { executablePath: null, startedAt: Number.isFinite(startedAt) ? startedAt : null };
    }
    // CIM can expose CreationDate for a reused system PID even when Get-Process cannot
    // read its Path/StartTime. Serialize UTC explicitly: Windows PowerShell's default
    // DateTime JSON representation is not an ISO timestamp that Date.parse can read.
    const query = [
      "$ErrorActionPreference = 'Stop'",
      `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'`,
      "if ($null -ne $process) { [pscustomobject]@{ " +
        "Path = $process.ExecutablePath; " +
        "StartTime = $(if ($null -ne $process.CreationDate) { " +
        "$process.CreationDate.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) " +
        "} else { $null }) } | ConvertTo-Json -Compress }",
    ].join("; ");
    const result = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", query],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 5_000,
      },
    ).trim();
    if (!result) return { executablePath: null, startedAt: null };
    const parsed = JSON.parse(result) as { Path?: unknown; StartTime?: unknown };
    const executablePath = typeof parsed.Path === "string" ? parsed.Path : null;
    const startedAt = typeof parsed.StartTime === "string" ? Date.parse(parsed.StartTime) : NaN;
    return { executablePath, startedAt: Number.isFinite(startedAt) ? startedAt : null };
  } catch {
    // If process metadata cannot be queried, preserve the live-lock failure mode.
    return { executablePath: null, startedAt: null };
  }
}

function normalizeExecutablePath(value: string): string {
  return process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
}

function isNodeExecutable(value: string): boolean {
  const normalized = normalizeExecutablePath(value);
  return normalized.endsWith("\\node.exe") || normalized.endsWith("/node");
}

export function lockOwnerIsLive(lock: Partial<LockRecord>): boolean {
  if (typeof lock.pid !== "number") return false;
  const identity = processIdentity(lock.pid);
  if (!identity) return false;

  if (
    process.platform === "linux" &&
    typeof lock.processStartTicks === "string" &&
    /^\d+$/.test(lock.processStartTicks) &&
    identity.startTicks
  ) {
    // Monotonic start ticks identify the process even when its executable is replaced.
    return lock.processStartTicks === identity.startTicks;
  }

  if (identity.executablePath && lock.executablePath) {
    if (
      normalizeExecutablePath(identity.executablePath) !==
      normalizeExecutablePath(lock.executablePath)
    ) {
      return false;
    }
  } else if (
    lock.pid !== process.pid &&
    process.platform !== "linux" &&
    identity.executablePath &&
    !lock.executablePath &&
    !isNodeExecutable(identity.executablePath)
  ) {
    // Legacy Windows locks without executable identity cannot belong to a non-Node process.
    return false;
  }

  if (process.platform === "linux") {
    // ISO-only locks have no comparable monotonic identity; wall time cannot disprove them.
    return true;
  }
  if (lock.processStartedAt && identity.startedAt !== null) {
    const expected = Date.parse(lock.processStartedAt);
    if (Number.isFinite(expected) && Math.abs(identity.startedAt - expected) > 5_000) {
      return false;
    }
  }
  return true;
}

function contenderStart(): string {
  const ticks = process.platform === "linux" ? linuxIdentity(process.pid)?.startTicks : null;
  return ticks ? `ticks${ticks}` : String(processStartedAt);
}

/** Link names carry a tagged Linux tick count or an epoch in milliseconds. */
function contenderIsLive(pid: number, start: string): boolean {
  const identity = processIdentity(pid);
  if (!identity) return false;
  if (process.platform === "linux") {
    const ticks = /^ticks(\d+)$/.exec(start)?.[1];
    return !ticks || !identity.startTicks || ticks === identity.startTicks;
  }
  if (!/^\d+$/.test(start)) return true;
  const expected = Number(start);
  return (
    !Number.isSafeInteger(expected) ||
    identity.startedAt === null ||
    Math.abs(identity.startedAt - expected) <= 5_000
  );
}

/** Publish a complete record without replacing an existing lock, including on Windows. */
export async function createLockFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.publish-${process.pid}-${contenderStart()}-${randomUUID()}`;
  const handle = await open(temporary, "wx", constants.S_IRUSR | constants.S_IWUSR);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, file);
  } finally {
    // Publication commits ownership; a leftover link is reclaimed when its process dies.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * A hard link pins the inspected inode. Only a snapshot with exactly two links
 * (the canonical lock and itself) may remove it, after checking the canonical
 * path still names that inode. Keep the snapshot until removal completes.
 */
export async function removeStaleLock(file: string, inspected: string): Promise<void> {
  const prefix = `${path.basename(file)}.`;
  for (const name of await readdir(path.dirname(file))) {
    if (!name.startsWith(`${prefix}claim-`) && !name.startsWith(`${prefix}publish-`)) continue;
    const [, pidText, startText] = name.slice(prefix.length).split("-");
    const pid = Number(pidText);
    if (
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      startText !== undefined &&
      !contenderIsLive(pid, startText)
    ) {
      await rm(path.join(path.dirname(file), name), { force: true });
    }
  }
  const snapshot = `${file}.claim-${process.pid}-${contenderStart()}-${randomUUID()}`;
  try {
    await link(file, snapshot);
    if ((await readFile(snapshot, "utf8")) !== inspected) throw new Error("Lock changed");
    const pinned = await stat(snapshot, { bigint: true });
    if (pinned.nlink !== 2n) throw new Error("Concurrent lock takeover");
    const current = await stat(file, { bigint: true });
    if (current.dev !== pinned.dev || current.ino !== pinned.ino) throw new Error("Lock changed");
    await rm(file);
  } finally {
    await rm(snapshot, { force: true });
  }
}
