import { spawn } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runQuietWebBuild } from "./build.mjs";
import { restartDevelopmentHost } from "./host.mjs";
import { hostRestartMode } from "./host-restart.mjs";
import {
  windowsDesktopDetectionScript,
  macOsDesktopDetectionScript,
} from "./interface-processes.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const windowsDesktopCleanupScript = String.raw`
$ErrorActionPreference = 'Stop'

${windowsDesktopDetectionScript}

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

# The native Desktop Launcher owns cleanup of its process tree. Do not stop
# codexhost by name: an independent shared Host may own running Web tasks.

Write-Output "codexhost dev: stopped $($desktopProcessIds.Count) Codex Desktop process(es)"
`;

const macOsDesktopCleanupScript = String.raw`
set -eu

${macOsDesktopDetectionScript}

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

# The native Launcher cleans its Desktop tree while preserving transferred
# independent services. Only the verified Desktop Controller is ours to stop;
# never kill codexhost by name, since Web may already own a shared Host.
runtime_running() {
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
  return `usage: npm start [version] [-- --no-build]
       npm start web [-- --port 3181]

Stop any running Codex Desktop, then build and run the current codexhost worktree.
After building, reuse an unchanged shared Host; restart a changed Host unless the other interface is open.
If the other interface is open, ask whether to keep Host (default) or restart it, interrupting tasks.
Non-interactive prompts keep Host and warn; an absent Host is started by the interface.
The web subcommand replaces this worktree's Web preview on the selected port without stopping Desktop.

arguments:
  version            set the runtime version, e.g. npm start 0.12.0

options:
  --no-build          reuse existing development artifacts
  --restart-host      force restart of a running Host (mutually exclusive with --keep-host)
  --keep-host         keep the running Host without asking
  --version <semver>  alternative version syntax (npm start -- --version 0.12.0)
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
    if (argument === "--restart-host" || argument === "--keep-host") {
      options[argument.slice(2)] = true;
      hostRestartMode(options);
      continue;
    }
    if (argument === "--no-build") {
      if (buildProvided) throw new Error("--no-build may only be provided once");
      buildProvided = true;
      options.build = false;
      continue;
    }
    if (argument === "--version" || !argument.startsWith("-")) {
      if (options.version !== undefined) throw new Error("version may only be provided once");
      const version = argument === "--version" ? arguments_[++index] : argument;
      if (
        !version ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
          version,
        )
      )
        throw new Error("expected a semantic version, such as 0.12.0 or 0.13.0-rc.1");
      options.version = version;
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
  script = "build",
) {
  const npmExecPath = environment.npm_execpath;
  return npmExecPath
    ? { command: nodePath, arguments: [npmExecPath, "run", script] }
    : { command: platform === "win32" ? "npm.cmd" : "npm", arguments: ["run", script] };
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

function runChild(invocation, root, spawnImplementation = spawn, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(invocation.command, invocation.arguments, {
      cwd: root,
      stdio: "inherit",
      env: environment,
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
function runLauncher(invocation, root, spawnImplementation = spawn, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(invocation.command, invocation.arguments, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
      env: environment,
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

// Node 22.19+ and Node 24 are supported development runtimes. The published npm
// package also accepts newer host runtimes, but this repository keeps the local range bounded.
const supportedNodeMajors = [22, 24];

function nodeVersionSupported(version = process.versions.node) {
  const [majorText, minorText] = version.split(".");
  const major = Number.parseInt(majorText ?? "", 10);
  const minor = Number.parseInt(minorText ?? "", 10);
  return supportedNodeMajors.includes(major) && (major !== 22 || minor >= 19);
}

export async function runDevelopmentDesktop({
  arguments_ = process.argv.slice(2),
  root = repositoryRoot,
  environment = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  spawnImplementation = spawn,
} = {}) {
  if (arguments_[0] === "web") {
    const webArguments = arguments_.slice(1);
    hostRestartMode({
      "restart-host": webArguments.includes("--restart-host"),
      "keep-host": webArguments.includes("--keep-host"),
    });
    if (!webArguments.includes("--no-build")) {
      const buildResult = await runQuietWebBuild(
        npmBuildInvocation(environment, platform, nodePath, "build:web"),
        { root, spawnImplementation, environment },
      );
      if (buildResult.code !== 0) return buildResult.code ?? 1;
    }
    const result = await runChild(
      {
        command: nodePath,
        arguments: [
          "--import",
          "tsx",
          path.join(root, "packages/web-server/scripts/preview.ts"),
          "--restart",
          ...webArguments.filter((argument) => argument !== "--no-build"),
        ],
      },
      root,
      spawnImplementation,
      environment,
    );
    return result.code ?? 1;
  }

  const options = parseArguments(arguments_);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!nodeVersionSupported()) {
    throw new Error(
      `npm start requires Node.js ${supportedNodeMajors.join(" or ")}; current version is ${process.versions.node}`,
    );
  }

  // Keep environment proxy support enabled, but silence its experimental
  // warning in build/runtime children. Preserve all existing Node options.
  environment = {
    ...environment,
    NODE_OPTIONS: [environment.NODE_OPTIONS, "--disable-warning=UNDICI-EHPA"]
      .filter(Boolean)
      .join(" "),
  };

  const startedAt = performance.now();
  const logElapsed = (label, since) => {
    console.log(`codexhost dev: ${label}: ${((performance.now() - since) / 1000).toFixed(2)}s`);
  };
  const cleanupInvocation = runningDesktopCleanupInvocation(platform);
  if (cleanupInvocation) {
    console.log("codexhost dev: stopping any running Codex Desktop");
    const cleanupResult = await runChild(cleanupInvocation, root, spawnImplementation, environment);
    if (cleanupResult.code !== 0) {
      const reason = cleanupResult.signal
        ? `signal ${cleanupResult.signal}`
        : `status ${cleanupResult.code ?? "unknown"}`;
      throw new Error(`could not stop the running Codex Desktop: ${reason}`);
    }
  }

  if (cleanupInvocation) logElapsed("stop previous Desktop", startedAt);

  if (options.build) {
    const buildStartedAt = performance.now();
    console.log("codexhost dev: building workspace");
    const buildResult = await runChild(
      npmBuildInvocation(environment, platform, nodePath),
      root,
      spawnImplementation,
      environment,
    );
    logElapsed("build elapsed", buildStartedAt);
    if (buildResult.code !== 0) {
      logElapsed("total elapsed (build failed)", startedAt);
      return buildResult.code ?? 1;
    }
  } else {
    console.log("codexhost dev: build skipped (--no-build)");
  }

  const artifacts = developmentArtifacts(root, platform, nodePath);
  validateDevelopmentArtifacts(artifacts);
  const piPath = findPathExecutable("pi", { environment, platform });
  if (piPath) console.log(`codexhost dev: using Pi at ${piPath}`);
  else console.warn("codexhost dev: Pi was not found on PATH and will be unavailable");

  const launchEnvironment = { ...environment };
  // A Harness launched by an npm installation may inherit its update routing. The Shim
  // prefers that routing over --host-runtime; a source launch must use this worktree instead.
  for (const name of [
    "CODEXHOST_NPM_NODE_PATH",
    "CODEXHOST_NPM_CLI_PATH",
    "CODEXHOST_NPM_LAUNCHER_PATH",
    "CODEXHOST_NPM_PACKAGE_ROOT",
  ]) {
    delete launchEnvironment[name];
  }
  delete launchEnvironment.CODEXHOST_DEV_VERSION;
  if (options.version) {
    launchEnvironment.CODEXHOST_DEV_VERSION = options.version;
    console.log(`codexhost dev: source runtime version is ${options.version}`);
  }
  await restartDevelopmentHost({
    root,
    mode: hostRestartMode(options),
    artifacts,
    environment: launchEnvironment,
    run: (invocation, env) => runChild(invocation, root, spawnImplementation, env),
  });
  const launchStartedAt = performance.now();
  const launchResult = await runLauncher(
    launcherInvocation(artifacts, piPath),
    root,
    spawnImplementation,
    launchEnvironment,
  );
  logElapsed(
    launchResult.ready ? "Launcher ready" : "Launcher exited before ready",
    launchStartedAt,
  );
  logElapsed("total elapsed (including cleanup and build)", startedAt);
  if (launchResult.ready) {
    console.log(
      "codexhost dev: Launcher readiness does not mean Renderer installation is complete",
    );
  }
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
