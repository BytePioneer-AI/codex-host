import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface WindowsProcessIdentity {
  executable: string;
  /** FILETIME microseconds, serialized as decimal text to avoid JS integer truncation. */
  startedAtMicros: string;
}

export async function readWindowsProcessIdentity(pid: number): Promise<WindowsProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Windows process ID");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot))
    throw new Error("Windows system directory is unavailable");
  // PowerShell 5.1 must encode stdout as UTF-8; Node's encoding only decodes it.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    `$p = Get-Process -Id ${pid}`,
    "$micros = [decimal]::Truncate(([decimal]$p.StartTime.ToFileTimeUtc()) / 10)",
    "[pscustomobject]@{ executable = $p.Path; startedAtMicros = $micros.ToString([Globalization.CultureInfo]::InvariantCulture) } | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execute(
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 4096 },
  );
  const value = JSON.parse(stdout.trim()) as Partial<WindowsProcessIdentity>;
  if (
    typeof value.executable !== "string" ||
    !path.isAbsolute(value.executable) ||
    typeof value.startedAtMicros !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value.startedAtMicros)
  ) {
    throw new Error("Cannot verify Windows process creation time and executable");
  }
  return value as WindowsProcessIdentity;
}
