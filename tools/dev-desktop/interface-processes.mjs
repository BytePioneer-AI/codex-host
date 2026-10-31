import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const windowsDesktopDetectionScript = String.raw`
function Test-CodexDesktopProcess($process) {
  if ($null -eq $process) {
    return $false
  }

  $executablePath = ([string]$process.ExecutablePath).Replace([char]47, [char]92).ToLowerInvariant()
  return (
    $process.Name -ieq 'ChatGPT.exe' -and
    $executablePath.Contains('\windowsapps\openai.codex_') -and
    $executablePath.EndsWith('\app\chatgpt.exe')
  )
}
`;

export const macOsDesktopDetectionScript = String.raw`
# Bundled CLI and node_repl processes can belong to an independent Web Host.
# Only the Desktop application executable is owned by this cleanup.
system_desktop_pattern='^/Applications/(ChatGPT|Codex)\.app/Contents/MacOS/(ChatGPT|Codex)( |$)'
user_desktop_pattern="^$HOME/Applications/(ChatGPT|Codex)\.app/Contents/MacOS/(ChatGPT|Codex)( |$)"
desktop_running() {
  /usr/bin/pgrep -f "$system_desktop_pattern" >/dev/null 2>&1 ||
    /usr/bin/pgrep -f "$user_desktop_pattern" >/dev/null 2>&1
}
`;

export async function isDesktopRunning(platform = process.platform, run = exec) {
  let result;
  if (platform === "win32") {
    result = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'\n${windowsDesktopDetectionScript}\nWrite-Output (@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { Test-CodexDesktopProcess $_ }).Count -gt 0)`,
    ]);
  } else if (platform === "darwin") {
    result = await run("/bin/sh", [
      "-c",
      `${macOsDesktopDetectionScript}\nif desktop_running; then echo true; else echo false; fi`,
    ]);
  } else {
    return false;
  }
  return result.stdout.trim().toLowerCase() === "true";
}

export async function previewProcesses() {
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object @{n='pid';e={$_.ProcessId}},@{n='created';e={$_.CreationDate.ToString('o')}},@{n='command';e={$_.CommandLine}} | ConvertTo-Json -Compress",
    ]);
    const result = stdout.trim() ? JSON.parse(stdout) : [];
    return Array.isArray(result) ? result : [result];
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Cannot identify the development user");
  const { stdout } = await exec("ps", ["-ww", "-u", String(uid), "-o", "pid=,lstart=,command="]);
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    return [{ pid: Number(match[1]), created: match[2], command: match[3] }];
  });
}

/** Detect any packed Web entry, regardless of worktree, port or Node installation. */
export function isAnyDevelopmentWeb(candidate) {
  return (
    typeof candidate.command === "string" &&
    /^(?:"[^"\r\n]*[\\/]node(?:\.exe)?"|(?:(?:(?!\s-)[^"\r\n])*[\\/])?node(?:\.exe)?)\s+(?:"[^"\r\n]*[\\/]app[\\/]server\.mjs"|(?:(?!\s-)[^"\r\n])*[\\/]app[\\/]server\.mjs)(?:\s|$)/iu.test(
      candidate.command,
    )
  );
}

export async function isWebRunning(list = previewProcesses) {
  return (await list()).some(isAnyDevelopmentWeb);
}
