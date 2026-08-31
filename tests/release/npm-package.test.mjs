import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NPM_PACKAGE_NAME,
  NPM_PLATFORM_PACKAGE_NAMES,
  createNpmBinLauncherSource,
  createNpmPackageManifest,
  expectedNpmPackagePaths,
  npmPackageCpu,
  npmPackageOs,
  npmPackCommand,
  npmPlatformPackageName,
  npmReleaseBuildCommands,
  npmTarballFileName,
  parseNpmReleaseArguments,
  validateNpmPackage,
} from "../../scripts/release/prepare-npm.mjs";
import {
  createNpmMetaReadme,
  createNpmMetaPackageManifest,
  expectedNpmMetaPackagePaths,
  validateNpmMetaPackage,
} from "../../scripts/release/prepare-npm-meta.mjs";
import { hostReleaseTargetId, releaseTarget } from "../../scripts/release/targets.mjs";

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "codexhost-npm-package-"));
}

async function createNpmPackageFixture(root, target) {
  for (const relative of expectedNpmPackagePaths(target)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    if (relative === "package.json") {
      await writeFile(
        absolute,
        `${JSON.stringify(createNpmPackageManifest({ version: "0.1.0", target }), null, 2)}\n`,
      );
      continue;
    }
    await writeFile(absolute, `npm-package:${relative}\n`);
  }
}

async function writeExecutable(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  await chmod(filePath, 0o755);
}

async function createHomebrewNodeLayout(root) {
  const brewPrefix = path.join(root, "opt", "homebrew");
  const cellarNode = path.join(brewPrefix, "Cellar", "node", "26.7.0", "bin", "node");
  const prefixNpm = path.join(brewPrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const libexecNpm = path.join(
    brewPrefix,
    "Cellar",
    "node",
    "26.7.0",
    "libexec",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  await mkdir(path.dirname(cellarNode), { recursive: true });
  try {
    await link(process.execPath, cellarNode);
  } catch {
    await copyFile(process.execPath, cellarNode);
    await chmod(cellarNode, 0o755);
  }
  await writeExecutable(prefixNpm, '#!/usr/bin/env node\nconsole.log("homebrew-prefix-npm");\n');
  await writeExecutable(libexecNpm, '#!/usr/bin/env node\nconsole.log("homebrew-libexec-npm");\n');
  await mkdir(path.join(brewPrefix, "bin"), { recursive: true });
  await symlink(
    path.relative(path.join(brewPrefix, "bin"), cellarNode),
    path.join(brewPrefix, "bin", "node"),
  );
  await symlink(
    path.relative(path.join(brewPrefix, "bin"), prefixNpm),
    path.join(brewPrefix, "bin", "npm"),
  );
  return { brewPrefix, cellarNode, prefixNpm, libexecNpm };
}

async function createGlobalCodexhostInstall(prefix) {
  const platformPackage =
    process.platform === "win32"
      ? `@codexhost/cli-win32-${process.arch}`
      : `@codexhost/cli-darwin-${process.arch}`;
  const packageRoot = path.join(prefix, "lib", "node_modules", platformPackage);
  const launcherPath = path.join(
    prefix,
    "lib",
    "node_modules",
    "@codexhost",
    "cli",
    "bin",
    "codexhost.js",
  );
  const userBin = path.join(prefix, "bin", "codexhost");
  await writeExecutable(launcherPath, createNpmBinLauncherSource({ version: "0.1.5" }));
  await mkdir(path.dirname(userBin), { recursive: true });
  await symlink(path.relative(path.dirname(userBin), launcherPath), userBin);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: platformPackage, version: "0.1.5" })}\n`,
  );
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  for (const relative of [
    path.join("bin", `codexhost${executableSuffix}`),
    path.join("libexec", `codexhost-shim${executableSuffix}`),
    path.join("app", "host-runtime.mjs"),
    path.join("app", "desktop-controller.mjs"),
    path.join("app", "renderer-extension.js"),
  ]) {
    await writeExecutable(path.join(packageRoot, relative), `fixture:${relative}\n`);
  }
  return { launcherPath, userBin, packageRoot };
}

function spawnCodexhost(nodePath, launcherPath, args, extraEnv = {}) {
  const environment = { ...process.env, ...extraEnv };
  delete environment.npm_execpath;
  delete environment.HOMEBREW_PREFIX;
  if (extraEnv.PATH === undefined) environment.PATH = path.dirname(nodePath);
  return spawnSync(nodePath, [launcherPath, ...args], {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
}

async function createNpmMetaPackageFixture(root) {
  for (const relative of expectedNpmMetaPackagePaths()) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    if (relative === "package.json") {
      await writeFile(
        absolute,
        `${JSON.stringify(createNpmMetaPackageManifest({ version: "0.1.0" }), null, 2)}\n`,
      );
    } else if (relative === "bin/codexhost.js") {
      await writeFile(absolute, createNpmBinLauncherSource({ version: "0.1.0" }));
    } else {
      await writeFile(absolute, `npm-meta-package:${relative}\n`);
    }
  }
}

async function createLauncherLifecycleFixture(root, platform) {
  const launcherPath = path.join(root, "node_modules", "@codexhost", "cli", "bin", "codexhost.js");
  const platformPackage = `@codexhost/cli-${platform}-x64`;
  const platformRoot = path.join(root, "node_modules", ...platformPackage.split("/"));
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const npmCliPath = path.join(root, "npm-cli.js");
  const preloadPath = path.join(root, "launcher-child-preload.mjs");

  await writeExecutable(launcherPath, createNpmBinLauncherSource({ version: "0.1.0" }));
  await mkdir(platformRoot, { recursive: true });
  await writeFile(
    path.join(platformRoot, "package.json"),
    `${JSON.stringify({ name: platformPackage, version: "0.1.0" })}\n`,
  );
  for (const relative of [
    path.join("bin", `codexhost${executableSuffix}`),
    path.join("libexec", `codexhost-shim${executableSuffix}`),
    path.join("app", "host-runtime.mjs"),
    path.join("app", "desktop-controller.mjs"),
    path.join("app", "renderer-extension.js"),
  ]) {
    await writeExecutable(path.join(platformRoot, relative), `fixture:${relative}\n`);
  }
  await writeFile(npmCliPath, "// fixture npm CLI\n");
  await writeFile(
    preloadPath,
    `import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";

Object.defineProperty(process, "platform", {
  configurable: true,
  value: process.env.CODEXHOST_TEST_PLATFORM,
});
Object.defineProperty(process, "arch", {
  configurable: true,
  value: "x64",
});

childProcess.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  setTimeout(() => child.stdout.write("startup:" + "x".repeat(1024 * 1024) + "rea"), 10);
  setTimeout(() => child.stdout.write("dy\\n"), 20);
  setTimeout(() => child.emit("exit", 7, null), 80);
  return child;
};
syncBuiltinESMExports();
`,
  );

  return { launcherPath, npmCliPath, preloadPath };
}

async function runLauncherLifecycle(platform) {
  const root = await temporaryDirectory();
  try {
    const { launcherPath, npmCliPath, preloadPath } = await createLauncherLifecycleFixture(
      root,
      platform,
    );
    return spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preloadPath).href, launcherPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEXHOST_STARTUP_TRACE: "1",
          CODEXHOST_TEST_PLATFORM: platform,
          npm_execpath: npmCliPath,
        },
        timeout: 2_000,
        windowsHide: true,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("npm package release", () => {
  it("maps the current host to a release target id", () => {
    expect(hostReleaseTargetId("darwin", "arm64")).toBe("macos-arm64");
    expect(hostReleaseTargetId("darwin", "x64")).toBe("macos-x64");
    expect(hostReleaseTargetId("win32", "x64")).toBe("windows-x64");
    expect(hostReleaseTargetId("win32", "arm64")).toBe("windows-arm64");
    expect(hostReleaseTargetId("linux", "x64")).toBe("linux-x64");
    expect(hostReleaseTargetId("linux", "arm64")).toBe("linux-arm64");
  });

  it("defaults the npm release target to the current host", () => {
    const parsed = parseNpmReleaseArguments([], {
      hostPlatform: "darwin",
      hostArch: "arm64",
    });
    expect(parsed.help).toBe(false);
    expect(parsed.target.id).toBe("macos-arm64");
    expect(parsed.pack).toBe(false);
    expect(parsed.skipBuild).toBe(false);
    expect(parsed.version).toBeUndefined();
  });

  it("parses npm release options", () => {
    const parsed = parseNpmReleaseArguments(
      ["--target", "macos-arm64", "--version", "0.1.0", "--pack", "--skip-build"],
      { hostPlatform: "darwin", hostArch: "arm64" },
    );
    expect(parsed.target.id).toBe("macos-arm64");
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.pack).toBe(true);
    expect(parsed.skipBuild).toBe(true);
  });

  it("rejects cross-operating-system npm targets", () => {
    expect(() =>
      parseNpmReleaseArguments(["--target", "windows-x64"], {
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
    ).toThrow("requires host platform");
  });

  it("builds the same Rust and TypeScript inputs as the installer channel", () => {
    const commands = npmReleaseBuildCommands(releaseTarget("macos-arm64"));
    expect(commands.map((command) => command.label)).toEqual([
      "TypeScript build",
      "Renderer build",
      "Rust release build",
    ]);
    expect(commands.at(-1).args).toContain("codexhost-launcher");
    expect(commands.at(-1).args).toContain("codexhost-shim");
    expect(commands.at(-1).args).toContain("codexhost-updater");
    expect(commands.at(-1).args).not.toContain("codexhost-platform");
  });

  it("runs npm pack through npm_execpath on Windows", () => {
    expect(
      npmPackCommand("win32", { npm_execpath: "C:\\npm\\npm-cli.js" }, "C:\\node.exe"),
    ).toEqual({
      command: "C:\\node.exe",
      args: ["C:\\npm\\npm-cli.js", "pack"],
    });
    expect(npmPackCommand("darwin", {}, "/usr/bin/node")).toEqual({
      command: "npm",
      args: ["pack"],
    });
  });

  it("publishes a scoped platform package with platform constraints", () => {
    const target = releaseTarget("macos-arm64");
    const manifest = createNpmPackageManifest({ version: "0.1.0", target });
    expect(manifest.name).toBe("@codexhost/cli-darwin-arm64");
    expect(npmPlatformPackageName(target)).toBe(manifest.name);
    expect(manifest.private).toBeUndefined();
    expect(manifest.bin).toBeUndefined();
    expect(manifest.os).toEqual(npmPackageOs(target));
    expect(manifest.cpu).toEqual(npmPackageCpu(target));
    expect(manifest.engines.node).toBe(">=22");
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.files).toEqual([
      "bin/**",
      "libexec/**",
      "app/**",
      "licenses/**",
      "README.md",
      "THIRD_PARTY_NOTICES.txt",
    ]);
  });

  it("publishes one meta package with exact optional platform dependencies", () => {
    const manifest = createNpmMetaPackageManifest({ version: "0.1.0" });
    expect(manifest.name).toBe(NPM_PACKAGE_NAME);
    expect(manifest.bin.codexhost).toBe("bin/codexhost.js");
    expect(manifest.os).toBeUndefined();
    expect(manifest.cpu).toBeUndefined();
    expect(manifest.optionalDependencies).toEqual(
      Object.fromEntries(Object.values(NPM_PLATFORM_PACKAGE_NAMES).map((name) => [name, "0.1.0"])),
    );
  });

  it("injects package resources when the user runs codexhost with no args", () => {
    const source = createNpmBinLauncherSource({ version: "0.1.0" });
    expect(source).toContain('"darwin-arm64": "@codexhost/cli-darwin-arm64"');
    expect(source).toContain('"linux-x64": "@codexhost/cli-linux-x64"');
    expect(source).toContain('"linux-arm64": "@codexhost/cli-linux-arm64"');
    expect(source).toContain("require.resolve");
    expect(source).toContain("--omit=optional");
    expect(source).toContain('launchArguments = ["launch"]');
    expect(source).toContain('extras.push("--node", process.execPath)');
    expect(source).toContain('extras.push("--shim", shim)');
    expect(source).toContain('extras.push("--host-runtime", hostRuntime)');
    expect(source).toContain('extras.push("--desktop-controller", desktopController)');
    expect(source).toContain('extras.push("--renderer", rendererExtension)');
    expect(source).toContain('if (launchArguments?.[0] === "launch")');
    expect(source).toContain('userArguments[0] === "remote"');
    expect(source).toContain('userArguments[0] === "delegate"');
    expect(source).toContain('userArguments[0] === "thread"');
    expect(source).toContain('"--codexhost-delegation-cli"');
    expect(source).toContain("CODEXHOST_CLI_PATH");
    expect(source).toContain('"--codexhost-remote"');
    expect(source).toContain('"--host-runtime", hostRuntime');
    expect(source).toContain('stdio: ["ignore", "pipe", "inherit"]');
    expect(source).toContain('const readyMarker = "ready\\n"');
    expect(source).toContain("path.dirname(path.dirname(path.resolve(process.argv[1])))");
    expect(source).not.toContain("runtime/node");
  });

  it("keeps Windows launcher supervision alive after the ready handshake", async () => {
    const result = await runLauncherLifecycle("win32");
    const readme = createNpmMetaReadme({ version: "0.1.0" });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(7);
    expect(result.stderr).toContain("received Launcher ready");
    expect(result.stderr).toContain("Launcher exited after ready");
    expect(readme).toContain("On Windows, the command remains attached until Codex Desktop exits");
    expect(readme).toContain("process trees of completed commands");
  });

  it.each(["darwin", "linux"])("returns after the ready handshake on %s", async (platform) => {
    const result = await runLauncherLifecycle(platform);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("received Launcher ready");
    expect(result.stderr).not.toContain("Launcher exited after ready");
  });

  it("does not forward remote SSH bootstrap variables into a local Desktop launch", () => {
    const source = createNpmBinLauncherSource({ version: "0.1.0" });
    expect(source).toContain('import { homedir } from "node:os"');
    expect(source).toContain('if (updateEnvironment.CODEXHOST_REMOTE_SSH_MANAGED === "1")');
    expect(source).toContain("delete updateEnvironment[name]");
    expect(source).toContain(
      'updateEnvironment.CODEXHOST_DATA_DIR = path.join(homedir(), ".codexhost")',
    );
    const listStart = source.indexOf("const remoteSshBootstrapEnvironment = [");
    const listEnd = source.indexOf("];", listStart);
    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(listEnd).toBeGreaterThan(listStart);
    const sanitizationSource = source.slice(listStart, listEnd);
    for (const name of [
      "CODEX_INSTALL_DIR",
      "CODEXHOST_DATA_DIR",
      "CODEXHOST_DEFAULT_AGENT",
      "CODEXHOST_HOST_NODE_PATH",
      "CODEXHOST_HOST_RUNTIME_PATH",
      "CODEXHOST_REMOTE_SSH_MANAGED",
      "CODEXHOST_STOCK_CODEX_PATH",
    ]) {
      expect(sanitizationSource).toContain(JSON.stringify(name));
    }
    expect(sanitizationSource).not.toContain("CODEXHOST_CLAUDE_COMMAND");
  });

  it.runIf(process.platform === "darwin")(
    "locates Homebrew npm when Node and npm do not share an official prefix",
    async () => {
      const root = await temporaryDirectory();
      try {
        const { brewPrefix, cellarNode } = await createHomebrewNodeLayout(root);
        const { userBin } = await createGlobalCodexhostInstall(brewPrefix);
        const result = spawnCodexhost(cellarNode, userBin, ["--help"]);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("usage:");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["--version", "-v"])("prints the npm package version for %s", async (option) => {
    const root = await temporaryDirectory();
    const launcherPath = path.join(root, "codexhost.mjs");
    try {
      await writeFile(launcherPath, createNpmBinLauncherSource({ version: "1.2.3" }));
      const result = spawnSync(process.execPath, [launcherPath, option], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("1.2.3\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates the npm package allowlist without an embedded Node runtime", async () => {
    const root = await temporaryDirectory();
    const target = releaseTarget("macos-arm64");
    try {
      await createNpmPackageFixture(root, target);
      const paths = await validateNpmPackage({
        packageRoot: root,
        target,
        root: "/repo/source",
      });
      expect(paths).toEqual(expectedNpmPackagePaths(target));
      expect(paths).toContain("licenses/OpenCode-SDK-LICENSE.txt");
      expect(paths).not.toContain("runtime/node");
      expect(paths).toContain("bin/codexhost");
      expect(paths).toContain("libexec/codexhost-shim");
      expect(paths).toContain("libexec/codexhost-updater");
      expect(paths).toContain("app/codexhost-distribution.json");
      await mkdir(path.join(root, "runtime"), { recursive: true });
      await writeFile(path.join(root, "runtime/node"), "unexpected");
      await expect(
        validateNpmPackage({ packageRoot: root, target, root: "/repo/source" }),
      ).rejects.toThrow("non-allowlist files: runtime/node");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates the architecture-neutral meta package", async () => {
    const root = await temporaryDirectory();
    try {
      await createNpmMetaPackageFixture(root);
      expect(await validateNpmMetaPackage({ packageRoot: root })).toEqual(
        expectedNpmMetaPackagePaths(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects npm packages that still point at a private Node runtime", async () => {
    const root = await temporaryDirectory();
    const target = releaseTarget("macos-arm64");
    try {
      await createNpmPackageFixture(root, target);
      await writeFile(path.join(root, "README.md"), "uses runtime/node for the private runtime\n");
      await expect(
        validateNpmPackage({ packageRoot: root, target, root: "/repo/source" }),
      ).rejects.toThrow("must not embed a private Node runtime");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps all published package names under the codexhost npm org", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../../scripts/release/prepare-npm.mjs"),
      "utf8",
    );
    expect(source).toContain('NPM_PACKAGE_NAME = "@codexhost/cli"');
    expect(Object.values(NPM_PLATFORM_PACKAGE_NAMES)).toEqual([
      "@codexhost/cli-darwin-arm64",
      "@codexhost/cli-darwin-x64",
      "@codexhost/cli-win32-x64",
      "@codexhost/cli-win32-arm64",
      "@codexhost/cli-linux-x64",
      "@codexhost/cli-linux-arm64",
    ]);
    expect(source).toContain("publishConfig");
    expect(source).toContain('access: "public"');
  });

  it("names npm tarballs with the release target so four matrix jobs do not collide", () => {
    expect(npmTarballFileName({ version: "0.1.0", target: releaseTarget("macos-arm64") })).toBe(
      "codexhost-cli-0.1.0-macos-arm64.tgz",
    );
    expect(npmTarballFileName({ version: "0.1.0", target: releaseTarget("windows-x64") })).toBe(
      "codexhost-cli-0.1.0-windows-x64.tgz",
    );
    expect(npmTarballFileName({ version: "0.1.0", target: releaseTarget("linux-x64") })).toBe(
      "codexhost-cli-0.1.0-linux-x64.tgz",
    );
    expect(npmTarballFileName({ version: "0.1.0", target: releaseTarget("linux-arm64") })).toBe(
      "codexhost-cli-0.1.0-linux-arm64.tgz",
    );
  });
});
