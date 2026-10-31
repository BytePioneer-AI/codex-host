import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Enumerate only the current user's processes, including native lifecycle supervisors. */
export async function listUserProcesses({
  platform = process.platform,
  uid = process.getuid?.(),
  run = exec,
} = {}) {
  if (platform === "win32") {
    const { stdout } = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      String.raw`$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'codexhost.exe' OR Name = 'codexhost-shim.exe'" |
  Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid } |
  Select-Object @{n='pid';e={$_.ProcessId}},@{n='parentPid';e={$_.ParentProcessId}},@{n='created';e={$_.CreationDate.ToString('o')}},@{n='command';e={$_.CommandLine}} |
  ConvertTo-Json -Compress`,
    ]);
    const result = stdout.trim() ? JSON.parse(stdout) : [];
    return Array.isArray(result) ? result : [result];
  }
  if (uid === undefined) throw new Error("Cannot identify the development user");
  const { stdout } = await run("ps", [
    "-ww",
    "-u",
    String(uid),
    "-o",
    "pid=,ppid=,lstart=,command=",
  ]);
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/u.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            created: match[3],
            command: match[4],
          },
        ]
      : [];
  });
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error instanceof SyntaxError)
      return null;
    throw error;
  }
}

// Match an executable at the start, not a path mentioned in another program's arguments.
function executable(command, name) {
  const match = new RegExp(
    `^(?:"([^"\\r\\n]*[\\\\/]${name}(?:\\.exe)?)"|((?:(?:(?!\\s-)[^"\\r\\n])*?[\\\\/])?${name}(?:\\.exe)?))(?:\\s+|$)`,
    "iu",
  ).exec(command);
  if (!match) return null;
  const file = match[1] ?? match[2];
  // ps omits argument quoting. A space-containing executable must be a real path,
  // not e.g. `python /some/node` mistaken for one executable.
  if (!match[1] && /\s/u.test(file) && !existsSync(file)) return null;
  return { file, rest: command.slice(match[0].length) };
}

export function launcherProcess(candidate) {
  return typeof candidate?.command === "string" ? executable(candidate.command, "codexhost") : null;
}

const sourceEntries = [
  ["watch", "apps/web-ui/scripts/build.ts"],
  ["web", "packages/web-server/scripts/preview.ts"],
  ["web", "packages/web-server/src/main.ts"],
  ["desktop", "packages/desktop-control/dist/release-main.js"],
  ["host", "packages/host-runtime/dist/main.js"],
  ["console", "packages/console-server/dist/main.js"],
];
const packedEntries = [
  ["web", "app/server.mjs"],
  ["web", "preview.mjs"],
  ["desktop", "app/desktop-controller.mjs"],
  ["host", "app/host-runtime.mjs"],
  ["console", "app/console-server.mjs"],
];

/** Only entrypoints launched by codexhost; arbitrary Node CLI flags are not interpreted. */
export async function identifyStopTarget(candidate, { json = readJson } = {}) {
  if (typeof candidate.command !== "string") return null;
  const node = executable(candidate.command, "node");
  if (!node) return null;
  let args = node.rest;
  for (;;) {
    const option = /^(?:--disable-warning=\S+|--import\s+tsx)\s+/u.exec(args);
    if (!option) break;
    args = args.slice(option[0].length);
  }
  for (const [entries, source] of [
    [sourceEntries, true],
    [packedEntries, false],
  ]) {
    for (const [kind, suffix] of entries) {
      const escaped = suffix.replaceAll(".", "\\.").replaceAll("/", "[\\\\/]");
      const match = new RegExp(
        `^(?:"((?:[A-Za-z]:[\\\\/]|/)[^"\\r\\n]*?[\\\\/]${escaped})"|((?:[A-Za-z]:[\\\\/]|/)(?:(?!\\s-)[^"\\r\\n])*?[\\\\/]${escaped}))(?:\\s+|$)`,
        "u",
      ).exec(args);
      if (!match) continue;
      const entry = match[1] ?? match[2];
      const rest = args.slice(match[0].length);
      const root = entry.slice(0, -suffix.length - 1);
      if (kind === "watch" && !/(?:^|\s)--watch(?:\s|$)/u.test(rest)) return null;
      if (kind === "console" && rest !== "serve") return null;
      const shared = kind === "host" && /(?:^|\s)--codexhost-shared-host(?:\s|$)/u.test(rest);
      // A shared Host's native supervisor is verified by the stop orchestrator.
      if (!shared) {
        const manifest = await json(`${root}/package.json`);
        const distribution = !source ? await json(`${root}/app/codexhost-distribution.json`) : null;
        if (
          source
            ? manifest?.name !== "codexhost"
            : manifest?.name !== "codexhost-web" &&
              !(
                distribution?.schemaVersion === 1 &&
                ["npm", "installer"].includes(distribution.distribution)
              )
        )
          continue;
      }
      return {
        ...candidate,
        kind: shared ? "shared-host" : kind,
        node: node.file,
        entry,
        args: rest,
      };
    }
  }
  return null;
}

export function sameProcess(left, right) {
  return left.pid === right.pid && left.created === right.created && left.command === right.command;
}

export async function waitForExit(target, { list = listUserProcesses, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while ((await list()).some((current) => sameProcess(current, target))) {
    if (Date.now() >= deadline)
      throw new Error(`PID ${target.pid} did not exit; stop was not completed`);
    await sleep(50);
  }
}

/** Recheck identity immediately before signalling, then wait rather than assuming success. */
export async function stopProcess(
  target,
  {
    list = listUserProcesses,
    platform = process.platform,
    run = exec,
    signal = (pid) => process.kill(pid, "SIGTERM"),
    timeoutMs = 10_000,
  } = {},
) {
  if (!(await list()).some((current) => sameProcess(current, target))) return;
  try {
    if (platform === "win32") {
      // Windows has no catchable SIGTERM. Include owned children (watchers, terminals).
      await run("taskkill.exe", ["/PID", String(target.pid), "/T", "/F"]);
    } else {
      signal(target.pid);
    }
  } catch (error) {
    if ((await list()).some((current) => sameProcess(current, target))) throw error;
  }
  await waitForExit(target, { list, timeoutMs });
}
