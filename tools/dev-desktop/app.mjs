import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { runQuietWebBuild } from "./build.mjs";
import { restartDevelopmentHost } from "./host.mjs";
import { hostRestartMode } from "./host-restart.mjs";
import { isDesktopRunning } from "./interface-processes.mjs";
import { identifyStopTarget, listUserProcesses, stopProcess } from "./stop-processes.mjs";

export function appUsage() {
  return `usage: npm start app [-- --no-build | --shell-only] [--no-onboarding] [--restart-host | --keep-host]
       npm run start:app [-- --no-build | --shell-only] [--no-onboarding]

Build the current worktree and open the native CodexHost desktop shell on the
launch-mode onboarding page (CodexHost Desktop, Codex Desktop, and Web Browser).
Existing desktop shell and Web instances are stopped first so the shell launches
this worktree's artifacts without hitting the single-instance lock or port conflicts.

options:
  --no-build          reuse existing Web and desktop shell build artifacts
  --shell-only        rebuild only the desktop shell (skip build:web)
  --onboarding        open on the launch-mode selection page (default)
  --no-onboarding     open directly into the CodexHost desktop window
  --restart-host      force restart of a running Host (mutually exclusive with --keep-host)
  --keep-host         keep the running Host without asking
  --help              show this help`;
}

export function parseAppArguments(arguments_) {
  const options = {
    buildWeb: true,
    buildShell: true,
    onboarding: true,
    help: false,
  };
  let buildMode = null;
  let onboardingProvided = false;

  for (const argument of arguments_) {
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
      if (buildMode === "no-build") throw new Error("--no-build may only be provided once");
      if (buildMode === "shell-only") {
        throw new Error("--no-build and --shell-only are mutually exclusive");
      }
      buildMode = "no-build";
      options.buildWeb = false;
      options.buildShell = false;
      continue;
    }
    if (argument === "--shell-only") {
      if (buildMode === "shell-only") throw new Error("--shell-only may only be provided once");
      if (buildMode === "no-build") {
        throw new Error("--no-build and --shell-only are mutually exclusive");
      }
      buildMode = "shell-only";
      options.buildWeb = false;
      options.buildShell = true;
      continue;
    }
    if (argument === "--onboarding" || argument === "--no-onboarding") {
      if (onboardingProvided) {
        throw new Error("--onboarding and --no-onboarding may only be provided once");
      }
      onboardingProvided = true;
      options.onboarding = argument === "--onboarding";
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  return options;
}

export function developmentAppArtifacts(
  root,
  platform = process.platform,
  nodePath = process.execPath,
  stat = statSync,
) {
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const packedWeb = path.join(
    root,
    "packages",
    "web-server",
    "dist",
    "codexhost-web",
    "app",
    "server.mjs",
  );
  let webRuntime = packedWeb;
  try {
    if (!stat(packedWeb).isFile()) {
      webRuntime = path.join(root, "packages", "web-server", "dist", "main.js");
    }
  } catch {
    webRuntime = path.join(root, "packages", "web-server", "dist", "main.js");
  }
  return {
    launcher: path.join(root, "target", "debug", `codexhost${executableSuffix}`),
    shim: path.join(root, "target", "debug", `codexhost-shim${executableSuffix}`),
    shell: path.join(
      root,
      "apps",
      "desktop-shell",
      "src-tauri",
      "target",
      "debug",
      `codexhost-shell${executableSuffix}`,
    ),
    node: nodePath,
    hostRuntime: path.join(root, "packages", "host-runtime", "dist", "main.js"),
    webRuntime,
    desktopController: path.join(root, "packages", "desktop-control", "dist", "release-main.js"),
    renderer: path.join(root, "packages", "renderer-extension", "dist", "production.js"),
  };
}

export function appLauncherEnvironment(environment, artifacts) {
  const launchEnvironment = {
    ...environment,
    NODE_OPTIONS: [environment.NODE_OPTIONS, "--disable-warning=UNDICI-EHPA"]
      .filter(Boolean)
      .join(" "),
    // Source checkouts default installed.node to bare "node", while web-service and
    // host-service require an absolute executable path. Pin runtime paths to this worktree.
    CODEXHOST_HOST_NODE_PATH: artifacts.node,
    CODEXHOST_HOST_RUNTIME_PATH: artifacts.hostRuntime,
    CODEXHOST_DESKTOP_SHELL_PATH: artifacts.shell,
  };
  for (const name of [
    "CODEXHOST_NPM_NODE_PATH",
    "CODEXHOST_NPM_CLI_PATH",
    "CODEXHOST_NPM_LAUNCHER_PATH",
    "CODEXHOST_NPM_PACKAGE_ROOT",
    "CODEXHOST_DEV_VERSION",
    "CODEXHOST_WEB_SERVICE",
  ]) {
    delete launchEnvironment[name];
  }
  return launchEnvironment;
}

export function appLauncherInvocation(artifacts, onboarding = true) {
  return {
    command: artifacts.launcher,
    arguments: onboarding ? ["app", "--onboarding"] : ["app"],
  };
}

export async function stopRunningShellAndWeb({
  platform = process.platform,
  list = () => listUserProcesses({ platform }),
  identify = identifyStopTarget,
  stop = (target, options) => stopProcess(target, { ...options, platform }),
  log = console.log,
} = {}) {
  const processes = await list();
  const targets = (await Promise.all(processes.map((candidate) => identify(candidate)))).filter(
    Boolean,
  );
  // Stop the shell first to avoid the single-instance lock and reconnect flicker,
  // then stop any Web watcher/supervisor/server so the new worktree build takes effect.
  for (const kind of ["shell", "watch", "web-supervisor", "web"]) {
    for (const target of targets.filter((candidate) => candidate.kind === kind)) {
      log(`codexhost app: stopping running ${kind} (PID ${target.pid})`);
      await stop(target, { list });
    }
  }
}

export async function runDevelopmentApp({
  arguments_ = [],
  root,
  environment = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  spawnImplementation = spawn,
  npmBuildInvocation,
  validateArtifacts,
  nodeVersionSupported,
  runChild,
  stopExisting = stopRunningShellAndWeb,
  desktopRunning = () => isDesktopRunning(platform),
  restartHost = restartDevelopmentHost,
} = {}) {
  const options = parseAppArguments(arguments_);
  if (options.help) {
    console.log(appUsage());
    return 0;
  }
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(
      "npm start app is supported only on macOS and Windows (Linux has no native desktop shell; use npm start web instead)",
    );
  }
  if (!nodeVersionSupported()) {
    throw new Error(
      `npm start app requires Node.js 22 or 24; current version is ${process.versions.node}`,
    );
  }

  const buildEnvironment = {
    ...environment,
    NODE_OPTIONS: [environment.NODE_OPTIONS, "--disable-warning=UNDICI-EHPA"]
      .filter(Boolean)
      .join(" "),
  };

  if (options.buildWeb) {
    const webBuild = await runQuietWebBuild(
      npmBuildInvocation(buildEnvironment, platform, nodePath, "build:web"),
      { root, spawnImplementation, environment: buildEnvironment },
    );
    if (webBuild.code !== 0) return webBuild.code ?? 1;
  }
  if (options.buildShell) {
    console.log("codexhost app: building native desktop shell");
    const shellBuild = await runChild(
      npmBuildInvocation(buildEnvironment, platform, nodePath, "build:shell"),
      root,
      spawnImplementation,
      buildEnvironment,
    );
    if (shellBuild.code !== 0) return shellBuild.code ?? 1;
  } else if (!options.buildWeb) {
    console.log("codexhost app: build skipped (--no-build)");
  }

  const artifacts = developmentAppArtifacts(root, platform, nodePath);
  validateArtifacts(artifacts);

  const launchEnvironment = appLauncherEnvironment(environment, artifacts);

  await restartHost({
    root,
    mode: hostRestartMode(options),
    artifacts,
    environment: launchEnvironment,
    webRunning: desktopRunning,
    otherInterface: "Codex Desktop",
    run: (invocation, env) => runChild(invocation, root, spawnImplementation, env),
  });

  await stopExisting({ platform });

  const launchResult = await runChild(
    appLauncherInvocation(artifacts, options.onboarding),
    root,
    spawnImplementation,
    launchEnvironment,
  );
  if (launchResult.code === 0) {
    console.log(
      options.onboarding
        ? "codexhost app: desktop shell launched (onboarding page)"
        : "codexhost app: desktop shell launched",
    );
    console.log("codexhost app: use `npm stop` or the tray menu to stop local services");
  }
  return launchResult.code ?? 1;
}
