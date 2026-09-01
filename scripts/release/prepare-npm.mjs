import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeDistributionMetadata } from "./distribution-metadata.mjs";
import { hostReleaseTarget, npmReleaseUsage, releaseTargetForHost } from "./targets.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export const NPM_PACKAGE_NAME = "@codexhost/cli";
export const NPM_PLATFORM_PACKAGE_NAMES = Object.freeze({
  "macos-arm64": "@codexhost/cli-darwin-arm64",
  "macos-x64": "@codexhost/cli-darwin-x64",
  "windows-x64": "@codexhost/cli-win32-x64",
  "windows-arm64": "@codexhost/cli-win32-arm64",
  "linux-x64": "@codexhost/cli-linux-x64",
  "linux-arm64": "@codexhost/cli-linux-arm64",
});
export const NPM_RUNTIME_PLATFORM_PACKAGES = Object.freeze({
  "darwin-arm64": NPM_PLATFORM_PACKAGE_NAMES["macos-arm64"],
  "darwin-x64": NPM_PLATFORM_PACKAGE_NAMES["macos-x64"],
  "win32-x64": NPM_PLATFORM_PACKAGE_NAMES["windows-x64"],
  "win32-arm64": NPM_PLATFORM_PACKAGE_NAMES["windows-arm64"],
  "linux-x64": NPM_PLATFORM_PACKAGE_NAMES["linux-x64"],
  "linux-arm64": NPM_PLATFORM_PACKAGE_NAMES["linux-arm64"],
});
export const NPM_PACKAGE_DESCRIPTION =
  "Run external Agent Harnesses as first-class Threads inside Codex Desktop.";

export function npmPlatformPackageName(target) {
  const packageName = NPM_PLATFORM_PACKAGE_NAMES[target.id];
  if (!packageName) throw new Error(`unsupported npm package target: ${target.id}`);
  return packageName;
}

const runtimeLicenses = [
  {
    packageName: "@anthropic-ai/claude-agent-sdk",
    license: "SEE LICENSE IN README.md",
    source: "LICENSE.md",
    output: "Claude-Agent-SDK-LICENSE.md",
  },
  {
    packageName: "@anthropic-ai/sdk",
    license: "MIT",
    source: "LICENSE",
    output: "Anthropic-SDK-LICENSE.txt",
  },
  {
    packageName: "@modelcontextprotocol/sdk",
    license: "MIT",
    source: "LICENSE",
    output: "MCP-SDK-LICENSE.txt",
  },
  { packageName: "diff", license: "BSD-3-Clause", source: "LICENSE", output: "diff-LICENSE.txt" },
  { packageName: "lucide", license: "ISC", source: "LICENSE", output: "lucide-LICENSE.txt" },
  { packageName: "ws", license: "MIT", source: "LICENSE", output: "ws-LICENSE.txt" },
  { packageName: "zod", license: "MIT", source: "LICENSE", output: "zod-LICENSE.txt" },
];

export function npmReleaseCommand(
  args,
  platform = process.platform,
  environment = process.env,
  nodePath = process.execPath,
) {
  if (platform !== "win32") return { command: "npm", args };
  const npmExecPath = environment.npm_execpath;
  if (!npmExecPath) {
    throw new Error("Windows release builds must be started through npm so npm_execpath is set");
  }
  return { command: nodePath, args: [npmExecPath, ...args] };
}

export function npmReleaseBuildCommands(
  target,
  platform = process.platform,
  environment = process.env,
  nodePath = process.execPath,
) {
  return [
    {
      label: "TypeScript build",
      ...npmReleaseCommand(["run", "build:typescript"], platform, environment, nodePath),
    },
    {
      label: "Renderer build",
      ...npmReleaseCommand(["run", "build:renderer"], platform, environment, nodePath),
    },
    {
      label: "Rust release build",
      command: "cargo",
      args: [
        "build",
        "--release",
        "--locked",
        "--target",
        target.rustTarget,
        "--package",
        "codexhost-launcher",
        "--package",
        "codexhost-shim",
        "--package",
        "codexhost-updater",
      ],
    },
  ];
}

export function npmPackCommand(
  platform = process.platform,
  environment = process.env,
  nodePath = process.execPath,
) {
  return npmReleaseCommand(["pack"], platform, environment, nodePath);
}

async function runCommand({ label, command, args }, cwd = repositoryRoot) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `status ${code}`}`));
    });
  });
}

async function requireRegularFile(filePath, label) {
  const metadata = await lstat(filePath).catch((error) => {
    throw new Error(`${label} is unavailable: ${error.message}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  return metadata;
}

async function copyReleaseFile(source, destination, label, executable = false) {
  await requireRegularFile(source, label);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (executable && process.platform !== "win32") await chmod(destination, 0o755);
}

function packageManifest(value, packageName) {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.license !== "string" ||
    typeof value.version !== "string"
  ) {
    throw new Error(`runtime package '${packageName}' has invalid license metadata`);
  }
  return value;
}

export function npmPackageOs(target) {
  if (target.hostPlatform === "darwin") return ["darwin"];
  if (target.hostPlatform === "win32") return ["win32"];
  if (target.hostPlatform === "linux") return ["linux"];
  throw new Error(`unsupported npm package platform: ${target.hostPlatform}`);
}

export function npmPackageCpu(target) {
  const architecture = target.packageArchitecture ?? target.installerArchitecture;
  if (architecture === "arm64") return ["arm64"];
  if (architecture === "x64") return ["x64"];
  throw new Error(`unsupported npm package architecture: ${architecture}`);
}

export function expectedNpmPackagePaths(target) {
  return [
    "package.json",
    "README.md",
    `bin/codexhost${target.executableSuffix}`,
    `libexec/codexhost-shim${target.executableSuffix}`,
    `libexec/codexhost-updater${target.executableSuffix}`,
    "app/codexhost-distribution.json",
    "app/desktop-controller.mjs",
    "app/host-runtime.mjs",
    "app/renderer-extension.js",
    "licenses/Anthropic-SDK-LICENSE.txt",
    "licenses/Claude-Agent-SDK-LICENSE.md",
    "licenses/MCP-SDK-LICENSE.txt",
    "licenses/diff-LICENSE.txt",
    "licenses/lucide-LICENSE.txt",
    "licenses/ws-LICENSE.txt",
    "licenses/zod-LICENSE.txt",
    "THIRD_PARTY_NOTICES.txt",
  ].sort();
}

export function createNpmPackageManifest({ version, target }) {
  return {
    name: npmPlatformPackageName(target),
    version,
    description: NPM_PACKAGE_DESCRIPTION,
    type: "module",
    files: [
      "bin/**",
      "libexec/**",
      "app/**",
      "licenses/**",
      "README.md",
      "THIRD_PARTY_NOTICES.txt",
    ],
    engines: {
      node: ">=22",
    },
    os: npmPackageOs(target),
    cpu: npmPackageCpu(target),
    keywords: ["codex", "codexhost", "pi", "claude-code", "cursor", "agent", "harness"],
    repository: {
      type: "git",
      url: "git+https://github.com/BytePioneer-AI/codex-host.git",
    },
    bugs: {
      url: "https://github.com/BytePioneer-AI/codex-host/issues",
    },
    homepage: "https://github.com/BytePioneer-AI/codex-host#readme",
    publishConfig: {
      access: "public",
    },
  };
}

export function createNpmBinLauncherSource({ version }) {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = ${JSON.stringify(version)};
const userArguments = process.argv.slice(2);
const startupTraceStartedAt = Date.now();
function startupTrace(stage) {
  if (process.env.CODEXHOST_STARTUP_TRACE !== "1") return;
  console.error(
    "[codexhost startup +" + (Date.now() - startupTraceStartedAt) + "ms] npm: " + stage,
  );
}
if (
  userArguments.length === 1 &&
  (userArguments[0] === "--version" || userArguments[0] === "-v")
) {
  console.log(version);
  process.exit(0);
}
startupTrace("entry");

const platformPackages = ${JSON.stringify(NPM_RUNTIME_PLATFORM_PACKAGES, null, 2)};
const platformKey = \`\${process.platform}-\${process.arch}\`;
const platformPackage = platformPackages[platformKey];
if (!platformPackage) fail(\`unsupported platform '\${platformKey}'\`);

const require = createRequire(import.meta.url);
let packageRoot;
try {
  packageRoot = path.dirname(require.resolve(\`\${platformPackage}/package.json\`));
} catch {
  // Local folder installs symlink packages into the source tree; Node realpaths
  // the entry script, so the sibling platform package drops off the resolution
  // chain. Fall back to the npm global layout derived from the bin symlink.
  packageRoot = null;
  if (process.platform !== "win32" && process.argv[1]) {
    const prefix = path.dirname(path.dirname(path.resolve(process.argv[1])));
    const globalPackage = path.join(
      prefix,
      "lib",
      "node_modules",
      platformPackage,
      "package.json",
    );
    if (existsSync(globalPackage)) packageRoot = path.dirname(globalPackage);
  }
  if (!packageRoot) {
    fail(
      \`missing optional platform package '\${platformPackage}'. Reinstall ${NPM_PACKAGE_NAME} without --omit=optional.\`,
    );
  }
}

startupTrace("platform package resolved");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const launcher = path.join(packageRoot, "bin", \`codexhost\${executableSuffix}\`);
const shim = path.join(packageRoot, "libexec", \`codexhost-shim\${executableSuffix}\`);
const hostRuntime = path.join(packageRoot, "app", "host-runtime.mjs");
const desktopController = path.join(packageRoot, "app", "desktop-controller.mjs");
const rendererExtension = path.join(packageRoot, "app", "renderer-extension.js");

function fail(message) {
  console.error(\`codexhost: \${message}\`);
  process.exit(1);
}

for (const [label, filePath] of [
  ["launcher", launcher],
  ["shim", shim],
  ["host runtime", hostRuntime],
  ["desktop controller", desktopController],
  ["renderer extension", rendererExtension],
]) {
  if (!existsSync(filePath)) fail(\`missing \${label}: \${filePath}\`);
}

function existingFile(filePath) {
  return typeof filePath === "string" && filePath.length > 0 && existsSync(filePath)
    ? filePath
    : undefined;
}
function officialNpmCliPath(nodePath) {
  return process.platform === "win32"
    ? path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js")
    : path.join(
        path.dirname(path.dirname(nodePath)),
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
}
function homebrewNpmCliPath(nodePath) {
  if (process.platform === "win32") return undefined;
  const segments = nodePath.split(path.sep);
  const cellarIndex = segments.lastIndexOf("Cellar");
  if (
    cellarIndex >= 1 &&
    segments[cellarIndex + 1] === "node" &&
    segments.at(-2) === "bin" &&
    segments.at(-1) === "node"
  ) {
    const brewPrefix = segments.slice(0, cellarIndex).join(path.sep);
    return (
      existingFile(
        path.join(brewPrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      ) ??
      existingFile(
        path.join(
          path.dirname(path.dirname(nodePath)),
          "libexec",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      )
    );
  }
  const brewPrefix = process.env.HOMEBREW_PREFIX;
  if (typeof brewPrefix === "string" && brewPrefix.length > 0) {
    return existingFile(
      path.join(brewPrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
  }
  return undefined;
}
function pathNpmCliPath() {
  const pathValue = process.env.PATH;
  if (typeof pathValue !== "string" || pathValue.length === 0) return undefined;
  const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, npmName);
    if (!existsSync(candidate)) continue;
    try {
      const resolved = realpathSync(candidate);
      if (path.basename(resolved) === "npm-cli.js") return resolved;
    } catch {
      continue;
    }
  }
  return undefined;
}
const npmCliPath =
  existingFile(process.env.npm_execpath) ??
  existingFile(officialNpmCliPath(process.execPath)) ??
  homebrewNpmCliPath(process.execPath) ??
  pathNpmCliPath();
if (!npmCliPath) fail("could not locate the npm CLI used to update this global installation");
const updateEnvironment = {
  ...process.env,
  CODEXHOST_NPM_NODE_PATH: process.execPath,
  CODEXHOST_NPM_CLI_PATH: path.resolve(npmCliPath),
  CODEXHOST_NPM_LAUNCHER_PATH: fileURLToPath(import.meta.url),
  CODEXHOST_NPM_PACKAGE_ROOT: packageRoot,
};
// A managed SSH installation deliberately exports these variables from the
// remote login profile so stock Codex can enter the remote Host. When this npm
// command starts the local Desktop on that same machine, replace the remote
// bootstrap with a local data root. CODEXHOST_CLAUDE_COMMAND is intentionally
// shared and therefore preserved.
const remoteSshBootstrapEnvironment = [
  "CODEX_INSTALL_DIR",
  "CODEXHOST_DATA_DIR",
  "CODEXHOST_DEFAULT_AGENT",
  "CODEXHOST_HOST_NODE_PATH",
  "CODEXHOST_HOST_RUNTIME_PATH",
  "CODEXHOST_REMOTE_SSH_MANAGED",
  "CODEXHOST_STOCK_CODEX_PATH",
];
if (updateEnvironment.CODEXHOST_REMOTE_SSH_MANAGED === "1") {
  for (const name of remoteSshBootstrapEnvironment) delete updateEnvironment[name];
  updateEnvironment.CODEXHOST_DATA_DIR = path.join(homedir(), ".codexhost");
}

let launchArguments;
let remoteArguments = null;
let delegationArguments = null;
if (userArguments.length === 0) {
  launchArguments = ["launch"];
} else if (userArguments[0] === "launch") {
  launchArguments = userArguments;
} else if (userArguments[0] === "inspect") {
  launchArguments = userArguments;
} else if (userArguments[0] === "remote") {
  launchArguments = null;
  remoteArguments = userArguments.slice(1);
} else if (
  userArguments[0] === "harness" ||
  userArguments[0] === "delegate" ||
  userArguments[0] === "thread"
) {
  launchArguments = null;
  delegationArguments = userArguments;
} else if (userArguments[0] === "--help" || userArguments[0] === "-h") {
  console.log(
    [
      "usage:",
      "  codexhost",
      "  codexhost --version",
      "  codexhost inspect",
      "  codexhost launch [launcher options]",
      "  codexhost remote install|start|stop|status|uninstall",
      "  codexhost delegate --help",
      "  codexhost harness inspect ...",
      "  codexhost delegate start ...",
      "  codexhost thread send|cancel|read|wait|list ...",
      "",
      "This npm package uses the current Node.js runtime and the packaged",
      "Rust launcher/shim. Codex Desktop must already be installed.",
    ].join("\\n"),
  );
  process.exit(0);
} else {
  fail(
    \`unknown command '\${userArguments[0]}'. Run 'codexhost --help' for usage.\`,
  );
}

if (launchArguments?.[0] === "launch") {
  const injected = new Set();
  for (let index = 1; index < launchArguments.length; index += 1) {
    const argument = launchArguments[index];
    if (
      argument === "--node" ||
      argument === "--shim" ||
      argument === "--host-runtime" ||
      argument === "--desktop-controller" ||
      argument === "--renderer"
    ) {
      injected.add(argument);
      index += 1;
    }
  }
  const extras = [];
  if (!injected.has("--node")) extras.push("--node", process.execPath);
  if (!injected.has("--shim")) extras.push("--shim", shim);
  if (!injected.has("--host-runtime")) extras.push("--host-runtime", hostRuntime);
  if (!injected.has("--desktop-controller")) {
    extras.push("--desktop-controller", desktopController);
  }
  if (!injected.has("--renderer")) extras.push("--renderer", rendererExtension);
  launchArguments = ["launch", ...extras, ...launchArguments.slice(1)];
}

if (delegationArguments !== null) {
  const child = spawn(
    process.execPath,
    [hostRuntime, "--codexhost-delegation-cli", ...delegationArguments],
    {
      env: {
        ...updateEnvironment,
        CODEXHOST_CLI_PATH: fileURLToPath(import.meta.url),
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  child.on("error", (error) => fail(error.message));
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
} else if (remoteArguments !== null) {
  const child = spawn(
    process.execPath,
    [
      hostRuntime,
      "--codexhost-remote",
      ...remoteArguments,
      "--node",
      process.execPath,
      "--shim",
      shim,
      "--host-runtime",
      hostRuntime,
    ],
    {
      env: updateEnvironment,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  child.on("error", (error) => fail(error.message));
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
} else if (launchArguments?.[0] === "launch") {
  // The Launcher prints "ready" once the Desktop, Controller, and Host chain
  // are up, then detaches from the terminal to keep supervising. Windows
  // command hosts may clean up a completed command's process tree, so keep the
  // npm parent alive there until the managed Desktop exits. Other platforms
  // return immediately after startup as before.
  startupTrace("spawning Launcher");
  const keepLauncherForeground = process.platform === "win32";
  const child = spawn(launcher, launchArguments, {
    env: updateEnvironment,
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    startupTrace("Launcher finished startup with code " + code);
    process.exit(code);
  };
  child.stdout.setEncoding("utf8");
  let ready = false;
  let launcherOutput = "";
  const readyMarker = "ready\\n";
  child.stdout.on("data", (chunk) => {
    if (ready) return;
    const output = launcherOutput + chunk;
    if (output.includes(readyMarker)) {
      ready = true;
      launcherOutput = "";
      startupTrace("received Launcher ready");
      if (!keepLauncherForeground) finish(0);
      return;
    }
    // Only retain the tail needed to recognize a marker split across chunks.
    launcherOutput = output.slice(1 - readyMarker.length);
  });
  child.on("error", (error) => {
    startupTrace("Launcher spawn failed: " + error.message);
    fail(error.message);
  });
  child.on("exit", (code, signal) => {
    startupTrace(ready ? "Launcher exited after ready" : "Launcher exited before ready");
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    finish(code ?? 1);
  });
} else {
  const child = spawn(launcher, launchArguments, {
    env: updateEnvironment,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => fail(error.message));
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
`;
}

export function createNpmReadme({ version, target }) {
  const packageName = npmPlatformPackageName(target);
  return `# ${packageName}

${NPM_PACKAGE_DESCRIPTION}

> Internal platform package for \`${NPM_PACKAGE_NAME}\`, built for \`${target.id}\`.

## Install

\`\`\`bash
npm install -g ${NPM_PACKAGE_NAME}@${version}
\`\`\`

Do not install this package directly. npm selects it through the optional dependencies of \`${NPM_PACKAGE_NAME}\`.

This package is platform-specific (\`os=${npmPackageOs(target).join(",")}\`, \`cpu=${npmPackageCpu(target).join(",")}\`).

## Usage

\`\`\`bash
codexhost
codexhost --version
codexhost inspect
codexhost launch
codexhost remote install
codexhost remote start
codexhost remote stop
codexhost remote status
codexhost remote uninstall
\`\`\`

The \`codexhost\` command launches the packaged Rust launcher with:

- the current Node.js executable as Host Runtime
- packaged \`host-runtime\`, Desktop Controller, Renderer, and Shim binaries

## Requirements

- Node.js 22 or 24 (Node 20 and older are not supported)
- Official ChatGPT/Codex Desktop for macOS, Windows, or Linux
- Pi on \`PATH\` when using the Pi agent
- Claude Code installed when using the Claude Code adapter

## Notes

- This npm package does **not** embed a private Node.js runtime.
- Installer packages (DMG/EXE) remain the zero-dependency desktop distribution path.
- Prefer \`npm install -g ${NPM_PACKAGE_NAME}\` over installing the monorepo root.
`;
}

async function writeThirdPartyNotices(root, packageRoot) {
  const licensesDirectory = path.join(packageRoot, "licenses");
  await mkdir(licensesDirectory, { recursive: true });
  const notices = ["codexhost npm package third-party notices", ""];
  for (const dependency of runtimeLicenses) {
    const dependencyRoot = path.join(root, "node_modules", dependency.packageName);
    const manifest = packageManifest(
      JSON.parse(await readFile(path.join(dependencyRoot, "package.json"), "utf8")),
      dependency.packageName,
    );
    if (manifest.license !== dependency.license) {
      throw new Error(
        `unexpected license metadata for runtime package '${dependency.packageName}'`,
      );
    }
    await copyReleaseFile(
      path.join(dependencyRoot, dependency.source),
      path.join(licensesDirectory, dependency.output),
      `${dependency.packageName} license`,
    );
    notices.push(
      `${dependency.packageName} ${manifest.version}`,
      `License: ${dependency.license}`,
      `License text: licenses/${dependency.output}`,
      "",
    );
  }
  await writeFile(
    path.join(packageRoot, "THIRD_PARTY_NOTICES.txt"),
    `${notices.join("\n").trimEnd()}\n`,
    "utf8",
  );
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`npm package contains a symbolic link: ${relative}`);
    }
    if (metadata.isDirectory()) files.push(...(await walkFiles(root, absolute)));
    else if (metadata.isFile()) files.push({ absolute, relative });
    else throw new Error(`npm package contains a non-file: ${relative}`);
  }
  return files;
}

export async function validateNpmPackage({ packageRoot, target, root }) {
  const expected = expectedNpmPackagePaths(target);
  const files = await walkFiles(packageRoot);
  const actual = files.map((file) => file.relative).sort();
  const missing = expected.filter((relative) => !actual.includes(relative));
  const extra = actual.filter((relative) => !expected.includes(relative));
  if (missing.length > 0) {
    throw new Error(`npm package is missing files: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new Error(`npm package contains non-allowlist files: ${extra.join(", ")}`);
  }

  for (const file of files.filter((entry) => /\.(?:js|md|mjs|txt)$/u.test(entry.relative))) {
    const text = await readFile(file.absolute, "utf8");
    const forbiddenReferences = [root];
    if (["app/desktop-controller.mjs", "app/renderer-extension.js"].includes(file.relative)) {
      forbiddenReferences.push("@anthropic-ai/", "@codexhost/adapter-claude-code");
    }
    if (file.relative !== "package.json" && text.includes("runtime/node")) {
      throw new Error(`npm package must not embed a private Node runtime: ${file.relative}`);
    }
    if (forbiddenReferences.some((reference) => text.includes(reference))) {
      throw new Error(`npm package file contains a forbidden reference: ${file.relative}`);
    }
  }

  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const expectedName = npmPlatformPackageName(target);
  if (manifest.name !== expectedName) {
    throw new Error(`npm package name must be ${expectedName}`);
  }
  if (manifest.bin !== undefined) {
    throw new Error("npm platform package must not expose a bin entry");
  }
  if (manifest.private === true) {
    throw new Error("npm package must not be private");
  }
  return actual;
}

export function parseNpmReleaseArguments(
  arguments_,
  { hostPlatform = process.platform, hostArch = process.arch } = {},
) {
  let targetName;
  let version;
  let pack = false;
  let skipBuild = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--pack") {
      pack = true;
      continue;
    }
    if (argument === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (argument === "--target") {
      if (targetName !== undefined) throw new Error("--target may only be provided once");
      targetName = arguments_[index + 1];
      if (!targetName) throw new Error("--target requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      if (targetName !== undefined) throw new Error("--target may only be provided once");
      targetName = argument.slice("--target=".length);
      if (!targetName) throw new Error("--target requires a value");
      continue;
    }
    if (argument === "--version") {
      if (version !== undefined) throw new Error("--version may only be provided once");
      version = arguments_[index + 1];
      if (!version) throw new Error("--version requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--version=")) {
      if (version !== undefined) throw new Error("--version may only be provided once");
      version = argument.slice("--version=".length);
      if (!version) throw new Error("--version requires a value");
      continue;
    }
    throw new Error(`unknown npm release option: ${argument}`);
  }

  const target =
    targetName === undefined
      ? hostReleaseTarget(hostPlatform, hostArch)
      : releaseTargetForHost(targetName, hostPlatform);
  return { help: false, target, version, pack, skipBuild };
}

export async function resolveNpmPackageVersion(root, explicitVersion) {
  if (explicitVersion) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(explicitVersion)) {
      throw new Error(`npm package version '${explicitVersion}' is not valid semver`);
    }
    return explicitVersion;
  }
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("root package.json must define a release version");
  }
  if (manifest.version === "0.0.0") {
    throw new Error(
      "root package.json is still 0.0.0; pass --version <semver> for the npm package channel",
    );
  }
  return manifest.version;
}

export async function prepareNpmPackage({
  target,
  version,
  root = repositoryRoot,
  skipBuild = false,
}) {
  if (target.hostPlatform !== process.platform) {
    throw new Error(
      `npm release target '${target.id}' requires host platform '${target.hostPlatform}', current host is '${process.platform}'`,
    );
  }

  if (!skipBuild) {
    for (const command of npmReleaseBuildCommands(target)) await runCommand(command, root);
  }

  const packageVersion = await resolveNpmPackageVersion(root, version);
  const outputRoot = path.join(root, "build", "npm", packageVersion, target.id);
  const packageRoot = path.join(outputRoot, "package");
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });

  const rustOutput = path.join(root, "target", target.rustTarget, "release");
  await copyReleaseFile(
    path.join(rustOutput, `codexhost${target.executableSuffix}`),
    path.join(packageRoot, "bin", `codexhost${target.executableSuffix}`),
    "npm Launcher",
    true,
  );
  await copyReleaseFile(
    path.join(rustOutput, `codexhost-shim${target.executableSuffix}`),
    path.join(packageRoot, "libexec", `codexhost-shim${target.executableSuffix}`),
    "npm Shim",
    true,
  );
  await copyReleaseFile(
    path.join(rustOutput, `codexhost-updater${target.executableSuffix}`),
    path.join(packageRoot, "libexec", `codexhost-updater${target.executableSuffix}`),
    "npm Updater",
    true,
  );

  await runCommand(
    {
      label: "production Host Bundle build",
      command: process.execPath,
      args: [
        "packages/host-runtime/scripts/build-release.mjs",
        "--output",
        path.join(packageRoot, "app", "host-runtime.mjs"),
      ],
    },
    root,
  );
  await runCommand(
    {
      label: "Desktop Controller Bundle build",
      command: process.execPath,
      args: [
        "packages/desktop-control/scripts/build-release.mjs",
        "--output",
        path.join(packageRoot, "app", "desktop-controller.mjs"),
      ],
    },
    root,
  );
  await copyReleaseFile(
    path.join(root, "packages", "renderer-extension", "dist", "production.js"),
    path.join(packageRoot, "app", "renderer-extension.js"),
    "production Renderer Bundle",
  );
  await writeDistributionMetadata(path.join(packageRoot, "app", "codexhost-distribution.json"), {
    version: packageVersion,
    distribution: "npm",
    target: target.id,
  });

  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(createNpmPackageManifest({ version: packageVersion, target }), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "README.md"),
    createNpmReadme({ version: packageVersion, target }),
    "utf8",
  );
  await writeThirdPartyNotices(root, packageRoot);
  await validateNpmPackage({ packageRoot, target, root });

  return { version: packageVersion, outputRoot, packageRoot, target };
}

export function npmTarballFileName({ version, target }) {
  return `codexhost-cli-${version}-${target.id}.tgz`;
}

export async function packNpmPackage({ packageRoot, outputRoot, version, target }) {
  const packCommand = npmPackCommand();
  const result = spawnSync(
    packCommand.command,
    [...packCommand.args, "--pack-destination", outputRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed with status ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  const packedName = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!packedName) throw new Error("npm pack did not report an output tarball");
  const packedPath = path.join(outputRoot, packedName);
  if (version === undefined || target === undefined) return packedPath;

  const renamedPath = path.join(outputRoot, npmTarballFileName({ version, target }));
  if (path.resolve(packedPath) !== path.resolve(renamedPath)) {
    await rm(renamedPath, { force: true });
    await rename(packedPath, renamedPath);
  }
  return renamedPath;
}

export async function runNpmReleaseCli(arguments_) {
  const parsed = parseNpmReleaseArguments(arguments_);
  if (parsed.help) {
    console.log(npmReleaseUsage());
    return;
  }
  const prepared = await prepareNpmPackage({
    target: parsed.target,
    version: parsed.version,
    skipBuild: parsed.skipBuild,
  });
  console.log(`package=${prepared.packageRoot}`);
  console.log(`version=${prepared.version}`);
  console.log(`target=${prepared.target.id}`);
  if (parsed.pack) {
    const tarball = await packNpmPackage({
      packageRoot: prepared.packageRoot,
      outputRoot: prepared.outputRoot,
      version: prepared.version,
      target: prepared.target,
    });
    console.log(`tarball=${tarball}`);
  } else {
    console.log(
      [
        "next:",
        `  npm run release:npm -- --version ${prepared.version} --pack`,
        "or:",
        "  build every platform plus the meta package, then run release:npm:publish",
      ].join("\n"),
    );
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runNpmReleaseCli(process.argv.slice(2)).catch((error) => {
    console.error(`codexhost npm release: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
