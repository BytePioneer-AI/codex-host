import { spawn } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const windowsDesktopCleanupScript = String.raw`
$ErrorActionPreference = 'Stop'

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

$desktopProcesses = @(
  Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object { Test-CodexDesktopProcess $_ }
)
if ($desktopProcesses.Count -eq 0) {
  exit 0
}

$desktopProcessIds = @($desktopProcesses | ForEach-Object { [int]$_.ProcessId })
foreach ($processId in $desktopProcessIds) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -eq $current) {
    continue
  }
  if (-not (Test-CodexDesktopProcess $current)) {
    throw "Refusing to terminate PID $processId because its executable identity changed."
  }
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Wait-Process -Id $desktopProcessIds -Timeout 10 -ErrorAction SilentlyContinue

$remainingDesktopProcesses = @(
  Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object { Test-CodexDesktopProcess $_ }
)
if ($remainingDesktopProcesses.Count -ne 0) {
  throw 'Codex Desktop did not exit before timeout.'
}

$graceDeadline = [DateTime]::UtcNow.AddSeconds(2)
do {
  $runtimeProcesses = @(Get-Process -Name 'codexhost', 'codexhost-shim' -ErrorAction SilentlyContinue)
  if ($runtimeProcesses.Count -eq 0) {
    break
  }
  if ([DateTime]::UtcNow -ge $graceDeadline) {
    $runtimeProcessIds = @($runtimeProcesses | ForEach-Object { [int]$_.Id })
    Stop-Process -Id $runtimeProcessIds -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $runtimeProcessIds -Timeout 10 -ErrorAction SilentlyContinue
    break
  }
  Start-Sleep -Milliseconds 50
} while ($true)

$remainingRuntimeProcesses = @(
  Get-Process -Name 'codexhost', 'codexhost-shim' -ErrorAction SilentlyContinue
)
if ($remainingRuntimeProcesses.Count -ne 0) {
  throw 'The previous codexhost runtime did not exit before timeout.'
}

Write-Output "codexhost dev: stopped $($desktopProcessIds.Count) Codex Desktop process(es)"
`;

const macOsDesktopCleanupScript = String.raw`
set -eu

system_desktop_pattern='^/Applications/(ChatGPT|Codex)\.app/Contents/'
user_desktop_pattern="^$HOME/Applications/(ChatGPT|Codex)\.app/Contents/"
desktop_running() {
  /usr/bin/pgrep -f "$system_desktop_pattern" >/dev/null 2>&1 ||
    /usr/bin/pgrep -f "$user_desktop_pattern" >/dev/null 2>&1
}

if desktop_running; then
  /usr/bin/pkill -KILL -f "$system_desktop_pattern" >/dev/null 2>&1 || true
  /usr/bin/pkill -KILL -f "$user_desktop_pattern" >/dev/null 2>&1 || true
  attempt=0
  while desktop_running; do
    if [ "$attempt" -ge 200 ]; then
      echo 'Codex Desktop did not exit before timeout.' >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    /bin/sleep 0.05
  done
fi

runtime_descriptor="$HOME/Library/Application Support/codexhost/desktop-runtime-v1.json"
descriptor_value() {
  if [ ! -f "$runtime_descriptor" ]; then
    return 0
  fi
  /usr/bin/sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p" "$runtime_descriptor" |
    /usr/bin/head -n 1
}

controller_pid() {
  control_port="$(descriptor_value control_port)"
  if [ -z "$control_port" ]; then
    return 0
  fi
  candidate="$(
    /usr/sbin/lsof -nP -t -iTCP:"$control_port" -sTCP:LISTEN 2>/dev/null |
      /usr/bin/head -n 1
  )"
  if [ -z "$candidate" ]; then
    return 0
  fi
  command_line="$(/bin/ps -p "$candidate" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"packages/desktop-control/dist/release-main.js"*)
      printf '%s\n' "$candidate"
      ;;
  esac
}

runtime_running() {
  /usr/bin/pgrep -x codexhost >/dev/null 2>&1 ||
    /usr/bin/pgrep -x codexhost-shim >/dev/null 2>&1 ||
    [ -n "$(controller_pid)" ]
}

controller="$(controller_pid)"
if [ -n "$controller" ]; then
  /bin/kill -TERM "$controller" >/dev/null 2>&1 || true
fi

attempt=0
while runtime_running && [ "$attempt" -lt 40 ]; do
  attempt=$((attempt + 1))
  /bin/sleep 0.05
done
if runtime_running; then
  controller="$(controller_pid)"
  if [ -n "$controller" ]; then
    /bin/kill -KILL "$controller" >/dev/null 2>&1 || true
  fi
  /usr/bin/pkill -KILL -x codexhost >/dev/null 2>&1 || true
  /usr/bin/pkill -KILL -x codexhost-shim >/dev/null 2>&1 || true
fi

attempt=0
while runtime_running; do
  if [ "$attempt" -ge 200 ]; then
    echo 'The previous codexhost runtime did not exit before timeout.' >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  /bin/sleep 0.05
done

echo 'codexhost dev: stopped the running Codex Desktop'
`;

export function usage() {
  return `usage: npm start -- [--no-build]

Stop any running Codex Desktop, then build and run the current codexhost worktree.

options:
  --no-build          reuse existing development artifacts
  --help              show this help`;
}

export function parseArguments(arguments_) {
  const options = { build: true, help: false };
  let buildProvided = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--no-build") {
      if (buildProvided) throw new Error("--no-build may only be provided once");
      buildProvided = true;
      options.build = false;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  return options;
}

export function developmentArtifacts(
  root,
  platform = process.platform,
  nodePath = process.execPath,
) {
  const executableSuffix = platform === "win32" ? ".exe" : "";
  return {
    launcher: path.join(root, "target", "debug", `codexhost${executableSuffix}`),
    shim: path.join(root, "target", "debug", `codexhost-shim${executableSuffix}`),
    node: nodePath,
    hostRuntime: path.join(root, "packages", "host-runtime", "dist", "main.js"),
    desktopController: path.join(root, "packages", "desktop-control", "dist", "release-main.js"),
    renderer: path.join(root, "packages", "renderer-extension", "dist", "production.js"),
  };
}

function environmentValue(environment, name) {
  const entry = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

function executableNames(command, platform, environment) {
  if (platform !== "win32") return [command];
  const pathExtensions = environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return pathExtensions
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .map((extension) => `${command}${extension.startsWith(".") ? extension : `.${extension}`}`);
}

export function findPathExecutable(
  command,
  {
    environment = process.env,
    platform = process.platform,
    access = accessSync,
    stat = statSync,
  } = {},
) {
  const pathValue = environmentValue(environment, "PATH");
  if (!pathValue) return null;
  const delimiter = platform === "win32" ? ";" : ":";
  const accessMode = platform === "win32" ? constants.F_OK : constants.X_OK;
  const names = executableNames(command, platform, environment);

  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, "");
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      try {
        access(candidate, accessMode);
        if (stat(candidate).isFile()) return candidate;
      } catch {
        // Continue through PATH just like native executable discovery.
      }
    }
  }
  return null;
}

export function validateDevelopmentArtifacts(artifacts, stat = statSync) {
  for (const [label, filePath] of Object.entries(artifacts)) {
    let metadata;
    try {
      metadata = stat(filePath);
    } catch (error) {
      throw new Error(`${label} artifact is unavailable at '${filePath}': ${error.message}`, {
        cause: error,
      });
    }
    if (!metadata.isFile()) throw new Error(`${label} artifact is not a file: ${filePath}`);
  }
}

export function npmBuildInvocation(
  environment = process.env,
  platform = process.platform,
  nodePath = process.execPath,
) {
  const npmExecPath = environment.npm_execpath;
  return npmExecPath
    ? { command: nodePath, arguments: [npmExecPath, "run", "build"] }
    : { command: platform === "win32" ? "npm.cmd" : "npm", arguments: ["run", "build"] };
}

export function runningDesktopCleanupInvocation(platform = process.platform) {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        windowsDesktopCleanupScript,
      ],
    };
  }
  if (platform === "darwin") {
    return { command: "/bin/sh", arguments: ["-c", macOsDesktopCleanupScript] };
  }
  return null;
}

export function launcherInvocation(artifacts, piPath = null) {
  const arguments_ = [
    "launch",
    "--shim",
    artifacts.shim,
    "--node",
    artifacts.node,
    "--host-runtime",
    artifacts.hostRuntime,
    "--desktop-controller",
    artifacts.desktopController,
    "--renderer",
    artifacts.renderer,
  ];
  if (piPath) arguments_.push("--pi", piPath);
  return { command: artifacts.launcher, arguments: arguments_ };
}

function runChild(invocation, root, spawnImplementation = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(invocation.command, invocation.arguments, {
      cwd: root,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

// The Launcher prints a single "ready\n" line once the Desktop, Controller,
// and Host chain are up, then detaches from the terminal to keep supervising.
// Resolve on that signal so `npm start` returns instead of holding the terminal
// open, while still propagating a real failure (exit without "ready").
function runLauncher(invocation, root, spawnImplementation = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(invocation.command, invocation.arguments, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: false,
    });
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      // The Launcher keeps running as a detached supervisor; do not let its
      // live child handle keep the `npm start` process alive after ready.
      if (result.ready) child.unref?.();
      resolve(result);
    };
    child.once("error", reject);
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("ready\n")) settle({ code: 0, signal: null, ready: true });
      });
    }
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
}

function nodeMajorVersion(version = process.versions.node) {
  return Number.parseInt(version.split(".")[0] ?? "", 10);
}

export async function runDevelopmentDesktop({
  arguments_ = process.argv.slice(2),
  root = repositoryRoot,
  environment = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  spawnImplementation = spawn,
} = {}) {
  const options = parseArguments(arguments_);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (nodeMajorVersion() !== 24) {
    throw new Error(`npm start requires Node.js 24; current version is ${process.versions.node}`);
  }

  const cleanupInvocation = runningDesktopCleanupInvocation(platform);
  if (cleanupInvocation) {
    console.log("codexhost dev: stopping any running Codex Desktop");
    const cleanupResult = await runChild(cleanupInvocation, root, spawnImplementation);
    if (cleanupResult.code !== 0) {
      const reason = cleanupResult.signal
        ? `signal ${cleanupResult.signal}`
        : `status ${cleanupResult.code ?? "unknown"}`;
      throw new Error(`could not stop the running Codex Desktop: ${reason}`);
    }
  }

  if (options.build) {
    console.log("codexhost dev: building workspace");
    const buildResult = await runChild(
      npmBuildInvocation(environment, platform, nodePath),
      root,
      spawnImplementation,
    );
    if (buildResult.code !== 0) {
      return buildResult.code ?? 1;
    }
  }

  const artifacts = developmentArtifacts(root, platform, nodePath);
  validateDevelopmentArtifacts(artifacts);
  const piPath = findPathExecutable("pi", { environment, platform });
  if (piPath) console.log(`codexhost dev: using Pi at ${piPath}`);
  else console.warn("codexhost dev: Pi was not found on PATH and will be unavailable");

  const launchResult = await runLauncher(
    launcherInvocation(artifacts, piPath),
    root,
    spawnImplementation,
  );
  if (launchResult.signal) {
    console.error(`codexhost dev: Launcher exited from signal ${launchResult.signal}`);
  }
  return launchResult.code ?? 1;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runDevelopmentDesktop()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`codexhost dev: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
