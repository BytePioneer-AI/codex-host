import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UPDATE_RUNTIME_ENV,
  parseDistributionMetadata,
  resolveInstalledUpdateContext,
} from "@codexhost/update-manager";

import { fixtureFile, windowsInstallerFixture, windowsNpmFixture } from "./windows-fixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function file(filePath: string, contents = "fixture"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  await chmod(filePath, 0o700);
}

function runtimeEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    HOME: path.join(root, "home"),
    [UPDATE_RUNTIME_ENV.launcherPid]: "4321",
    [UPDATE_RUNTIME_ENV.launcherStartedAtMicros]: "123456789",
    [UPDATE_RUNTIME_ENV.launcherExecutable]: path.join(root, "bin", "codexhost"),
    [UPDATE_RUNTIME_ENV.runtimeDescriptorPath]: path.join(
      root,
      "runtime",
      "desktop-runtime-v1.json",
    ),
    [UPDATE_RUNTIME_ENV.controllerPort]: "41234",
    [UPDATE_RUNTIME_ENV.controllerNonce]: "0123456789abcdef0123456789abcdef",
  };
}

describe("installed update context", () => {
  it("resolves a macOS installer from its App resource layout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-distribution-"));
    roots.push(root);
    const app = path.join(root, "codexhost.app");
    const host = path.join(app, "Contents", "Resources", "app", "host-runtime.mjs");
    await file(host);
    await file(path.join(app, "Contents", "Resources", "libexec", "codexhost-updater"));
    await file(path.join(root, "bin", "codexhost"));
    await file(
      path.join(app, "Contents", "Resources", "app", "codexhost-distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        distribution: "installer",
        target: "macos-arm64",
      }),
    );

    await expect(
      resolveInstalledUpdateContext({
        hostRuntimePath: host,
        environment: runtimeEnvironment(root),
        platform: "darwin",
        architecture: "arm64",
        stateDirectory: path.join(root, "state"),
      }),
    ).resolves.toMatchObject({
      metadata: { version: "1.2.3", target: "macos-arm64" },
      installation: { kind: "macos-dmg", options: { appPath: app } },
      controller: { port: 41234 },
    });
  });

  it("resolves npm only from explicit absolute npm runtime paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-distribution-"));
    roots.push(root);
    const packageRoot = path.join(root, "platform-package");
    const host = path.join(packageRoot, "app", "host-runtime.mjs");
    const environment = runtimeEnvironment(root);
    Object.assign(environment, {
      [UPDATE_RUNTIME_ENV.npmNodePath]: path.join(root, "node"),
      [UPDATE_RUNTIME_ENV.npmCliPath]: path.join(root, "npm-cli.js"),
      [UPDATE_RUNTIME_ENV.npmLauncherPath]: path.join(root, "codexhost.js"),
      [UPDATE_RUNTIME_ENV.npmPackageRoot]: packageRoot,
    });
    await Promise.all([
      file(host),
      file(path.join(packageRoot, "libexec", "codexhost-updater")),
      file(path.join(root, "bin", "codexhost")),
      file(path.join(root, "node")),
      file(path.join(root, "npm-cli.js")),
      file(path.join(root, "codexhost.js")),
      file(
        path.join(packageRoot, "app", "codexhost-distribution.json"),
        JSON.stringify({
          schemaVersion: 1,
          version: "1.2.3",
          distribution: "npm",
          target: "macos-arm64",
        }),
      ),
    ]);

    await expect(
      resolveInstalledUpdateContext({
        hostRuntimePath: host,
        environment,
        platform: "darwin",
        architecture: "arm64",
        stateDirectory: path.join(root, "state"),
      }),
    ).resolves.toMatchObject({ installation: { kind: "npm", options: { packageRoot } } });
  });

  it.each([
    ["linux-x64", "x64"],
    ["linux-arm64", "arm64"],
  ] as const)(
    "resolves a %s npm installation without enabling installer updates",
    async (target, architecture) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-linux-npm-distribution-"));
      roots.push(root);
      const packageRoot = path.join(root, "platform-package");
      const host = path.join(packageRoot, "app", "host-runtime.mjs");
      const environment = runtimeEnvironment(root);
      Object.assign(environment, {
        [UPDATE_RUNTIME_ENV.npmNodePath]: path.join(root, "node"),
        [UPDATE_RUNTIME_ENV.npmCliPath]: path.join(root, "npm-cli.js"),
        [UPDATE_RUNTIME_ENV.npmLauncherPath]: path.join(root, "codexhost.js"),
        [UPDATE_RUNTIME_ENV.npmPackageRoot]: packageRoot,
      });
      await Promise.all([
        file(host),
        file(path.join(packageRoot, "libexec", "codexhost-updater")),
        file(path.join(root, "bin", "codexhost")),
        file(path.join(root, "node")),
        file(path.join(root, "npm-cli.js")),
        file(path.join(root, "codexhost.js")),
        file(
          path.join(packageRoot, "app", "codexhost-distribution.json"),
          JSON.stringify({
            schemaVersion: 1,
            version: "1.2.3",
            distribution: "npm",
            target,
          }),
        ),
      ]);

      await expect(
        resolveInstalledUpdateContext({
          hostRuntimePath: host,
          environment,
          platform: "linux",
          architecture,
          stateDirectory: path.join(root, "state"),
        }),
      ).resolves.toMatchObject({
        metadata: { target },
        common: {
          runtimeDescriptorPath: environment[UPDATE_RUNTIME_ENV.runtimeDescriptorPath],
        },
        installation: { kind: "npm", options: { packageRoot } },
      });
    },
  );

  async function windowsContext(
    root: string,
    fixture: Awaited<ReturnType<typeof windowsNpmFixture>>,
  ) {
    return resolveInstalledUpdateContext({
      hostRuntimePath: path.join(fixture.paths.packageRoot, "app", "host-runtime.mjs"),
      platform: "win32",
      architecture: "x64",
      stateDirectory: path.join(root, "state"),
      environment: {
        ...runtimeEnvironment(root),
        CODEXHOST_LAUNCHER_EXECUTABLE: fixture.paths.launcherExecutable,
        CODEXHOST_NPM_NODE_PATH: fixture.paths.nodePath,
        CODEXHOST_NPM_CLI_PATH: fixture.paths.npmCliPath,
        CODEXHOST_NPM_LAUNCHER_PATH: fixture.paths.npmLauncherPath,
        CODEXHOST_NPM_PACKAGE_ROOT: fixture.paths.packageRoot,
        npm_config_prefix: path.join(root, "unrelated-prefix"),
      },
    });
  }

  it.each([false, true])(
    "verifies Windows npm ownership in the running prefix (nested: %s)",
    async (nested) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-win-ownership-"));
      roots.push(root);
      const fixture = await windowsNpmFixture(root, nested);
      const second = await windowsNpmFixture(path.join(root, "second-install"));
      await expect(windowsContext(root, fixture)).resolves.toMatchObject({
        installation: { kind: "npm" },
      });
      await expect(
        windowsContext(root, {
          ...fixture,
          paths: { ...fixture.paths, npmLauncherPath: second.paths.npmLauncherPath },
        }),
      ).rejects.toThrow("outside the CLI prefix");
    },
  );

  it("rejects Windows npm version drift, missing global shim and package links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-win-ownership-"));
    roots.push(root);
    const fixture = await windowsNpmFixture(root);
    const manifest = path.join(fixture.paths.packageRoot, "package.json");
    const original = await readFile(manifest, "utf8");
    await writeFile(manifest, original.replace("1.2.2", "1.2.1"));
    await expect(windowsContext(root, fixture)).rejects.toThrow("does not match");
    await writeFile(manifest, original);
    await rm(path.join(fixture.prefix, "codexhost.cmd"));
    await expect(windowsContext(root, fixture)).rejects.toThrow();
    await fixtureFile(
      path.join(fixture.prefix, "codexhost.cmd"),
      '"%dp0%\\node_modules\\@codexhost\\cli\\bin\\codexhost.js"',
    );
    const scope = path.join(fixture.prefix, "node_modules", "@codexhost");
    const external = path.join(root, "external-scope");
    await rename(scope, external);
    await symlink(external, scope, process.platform === "win32" ? "junction" : "dir");
    await expect(windowsContext(root, fixture)).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")(
    "accepts Windows case variations without changing the owned prefix",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-win-case-"));
      roots.push(root);
      const fixture = await windowsNpmFixture(root);
      fixture.paths.npmLauncherPath = fixture.paths.npmLauncherPath.toUpperCase();
      await expect(windowsContext(root, fixture)).resolves.toMatchObject({
        installation: { kind: "npm" },
      });
    },
  );

  it("pins Windows installer ownership to the current root and rejects another Launcher", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-win-installer-"));
    roots.push(root);
    const fixture = await windowsInstallerFixture(root);
    const options = {
      hostRuntimePath: path.join(fixture.installRoot, "app", "host-runtime.mjs"),
      platform: "win32" as const,
      architecture: "x64",
      stateDirectory: path.join(root, "state"),
      environment: {
        ...runtimeEnvironment(root),
        CODEXHOST_LAUNCHER_EXECUTABLE: fixture.launcherExecutable,
      },
    };
    await expect(resolveInstalledUpdateContext(options)).resolves.toMatchObject({
      installation: { kind: "windows-installer", options: { installRoot: fixture.installRoot } },
    });
    const unrelated = path.join(root, "other", "codexhost.exe");
    await fixtureFile(unrelated);
    await expect(
      resolveInstalledUpdateContext({
        ...options,
        environment: { ...options.environment, CODEXHOST_LAUNCHER_EXECUTABLE: unrelated },
      }),
    ).rejects.toThrow("outside");
  });

  it("rejects unknown metadata and target mismatch", async () => {
    expect(() =>
      parseDistributionMetadata({
        schemaVersion: 1,
        version: "1.2.3",
        distribution: "installer",
        target: "windows-x64",
        url: "https://example.com",
      }),
    ).toThrow("unknown fields");
  });
});
