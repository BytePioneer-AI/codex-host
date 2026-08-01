import { spawn } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export function usage() {
  return `usage: npm start -- [--agent <codex|pi>] [--no-build]

Build and run the current codexhost worktree through the native Launcher.

options:
  --agent <codex|pi>  process-level default Agent (default: pi)
  --no-build          reuse existing development artifacts
  --help              show this help`;
}

export function parseArguments(arguments_) {
  const options = { agent: "pi", build: true, help: false };
  let agentProvided = false;
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
    if (argument === "--agent" || argument.startsWith("--agent=")) {
      if (agentProvided) throw new Error("--agent may only be provided once");
      agentProvided = true;
      const value =
        argument === "--agent" ? arguments_[++index] : argument.slice("--agent=".length);
      if (value !== "codex" && value !== "pi") {
        throw new Error(`--agent must be 'codex' or 'pi', got '${value ?? ""}'`);
      }
      options.agent = value;
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

export function launcherInvocation(artifacts, agent, piPath = null) {
  const arguments_ = [
    "launch",
    "--agent",
    agent,
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

  if (options.build) {
    console.log("codexhost dev: building workspace");
    const buildResult = await runChild(
      npmBuildInvocation(environment, platform, nodePath),
      root,
      spawnImplementation,
    );
    if (buildResult.code !== 0) {
      if (platform === "win32") {
        console.error(
          "codexhost dev: build failed; close a running codexhost Desktop before rebuilding, or use --no-build to activate existing artifacts",
        );
      }
      return buildResult.code ?? 1;
    }
  }

  const artifacts = developmentArtifacts(root, platform, nodePath);
  validateDevelopmentArtifacts(artifacts);
  const piPath = findPathExecutable("pi", { environment, platform });
  if (piPath) console.log(`codexhost dev: using Pi at ${piPath}`);
  else console.warn("codexhost dev: Pi was not found on PATH and will be unavailable");

  console.log(`codexhost dev: launching with default Agent '${options.agent}'`);
  const launchResult = await runChild(
    launcherInvocation(artifacts, options.agent, piPath),
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
