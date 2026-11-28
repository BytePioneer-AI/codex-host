import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UPDATE_RUNTIME_ENV,
  parseDistributionMetadata,
  resolveInstalledUpdateContext,
} from "@codexhost/update-manager";

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
    });
  });

  it("resolves a Linux archive installation from its extracted directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-distribution-"));
    roots.push(root);
    const installRoot = path.join(root, "codexhost");
    const host = path.join(installRoot, "app", "host-runtime.mjs");
    await file(host);
    await file(path.join(installRoot, "libexec", "codexhost-updater"));
    await file(
      path.join(installRoot, "app", "codexhost-distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        distribution: "installer",
        target: "linux-arm64",
      }),
    );

    await expect(
      resolveInstalledUpdateContext({
        hostRuntimePath: host,
        environment: runtimeEnvironment(root),
        platform: "linux",
        architecture: "arm64",
        stateDirectory: path.join(root, "state"),
      }),
    ).resolves.toMatchObject({
      metadata: { version: "1.2.3", target: "linux-arm64" },
      installation: {
        kind: "linux-archive",
        options: {
          installRoot,
          updaterExecutable: path.join(installRoot, "libexec", "codexhost-updater"),
        },
      },
    });
  });

  it("resolves npm only from explicit absolute npm runtime paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-distribution-"));
    roots.push(root);
    const packageRoot = path.join(root, "platform-package");
    const host = path.join(packageRoot, "app", "host-runtime.mjs");
    const environment = runtimeEnvironment(root);
    delete environment.CODEXHOST_CONTROL_PORT;
    delete environment.CODEXHOST_CONTROL_NONCE;
    environment[UPDATE_RUNTIME_ENV.serviceManaged] = "1";
    environment.CODEXHOST_DATA_DIR = path.join(root, "host-data");
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
    ).resolves.toMatchObject({
      common: {
        serviceManaged: true,
        restartTarget: "web",
        dataDirectory: environment.CODEXHOST_DATA_DIR,
      },
      installation: { kind: "npm", options: { packageRoot } },
    });
    await expect(
      resolveInstalledUpdateContext({
        hostRuntimePath: host,
        environment: {
          ...environment,
          [UPDATE_RUNTIME_ENV.npmPackageRoot]: path.join(root, "other"),
        },
        platform: "darwin",
        architecture: "arm64",
      }),
    ).rejects.toThrow("does not own the Host Runtime");
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

  it.each([
    ["sibling", ["lib", "node_modules", "@codexhost", "cli-darwin-arm64"]],
    [
      "nested",
      [
        "lib",
        "node_modules",
        "@codexhost",
        "cli",
        "node_modules",
        "@codexhost",
        "cli-darwin-arm64",
      ],
    ],
  ] as const)(
    "discovers npm runtime paths from a %s global layout when CODEXHOST_NPM_* env vars are unset",
    async (_layout, packageSegments) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-discovery-"));
      roots.push(root);
      const prefix = path.join(root, "prefix");
      const packageRoot = path.join(prefix, ...packageSegments);
      const host = path.join(packageRoot, "app", "host-runtime.mjs");
      const realNode = path.join(prefix, "Cellar", "node", "22.14.0", "bin", "node");
      const binNode = path.join(prefix, "bin", "node");
      const npmCli = path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
      const launcher = path.join(
        prefix,
        "lib",
        "node_modules",
        "@codexhost",
        "cli",
        "bin",
        "codexhost.js",
      );
      await Promise.all([
        file(host),
        file(path.join(packageRoot, "libexec", "codexhost-updater")),
        file(realNode),
        file(npmCli),
        file(launcher),
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
      await mkdir(path.dirname(binNode), { recursive: true });
      await symlink(realNode, binNode);

      const resolved = await resolveInstalledUpdateContext({
        hostRuntimePath: host,
        environment: runtimeEnvironment(root),
        platform: "darwin",
        architecture: "arm64",
        stateDirectory: path.join(root, "state"),
      });

      expect(resolved).toMatchObject({
        metadata: { version: "1.2.3", distribution: "npm", target: "macos-arm64" },
        installation: {
          kind: "npm",
          options: {
            packageRoot,
            nodePath: await realpath(realNode),
            npmCliPath: await realpath(npmCli),
            npmLauncherPath: await realpath(launcher),
          },
        },
      });
    },
  );

  it("derives node and npm-cli from nodeExecutable when the global prefix has no bundled node or npm", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-custom-prefix-"));
    roots.push(root);
    const customPrefix = path.join(root, "npm-global");
    const packageRoot = path.join(
      customPrefix,
      "lib",
      "node_modules",
      "@codexhost",
      "cli-darwin-arm64",
    );
    const host = path.join(packageRoot, "app", "host-runtime.mjs");
    const launcher = path.join(
      customPrefix,
      "lib",
      "node_modules",
      "@codexhost",
      "cli",
      "bin",
      "codexhost.js",
    );
    const nodePrefix = path.join(root, "node-install");
    const nodeExecutable = path.join(nodePrefix, "bin", "node");
    const npmCli = path.join(nodePrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    await Promise.all([
      file(host),
      file(path.join(packageRoot, "libexec", "codexhost-updater")),
      file(launcher),
      file(nodeExecutable),
      file(npmCli),
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

    const resolved = await resolveInstalledUpdateContext({
      hostRuntimePath: host,
      environment: runtimeEnvironment(root),
      platform: "darwin",
      architecture: "arm64",
      stateDirectory: path.join(root, "state"),
      nodeExecutable,
    });

    expect(resolved).toMatchObject({
      metadata: { version: "1.2.3", distribution: "npm", target: "macos-arm64" },
      installation: {
        kind: "npm",
        options: {
          packageRoot,
          nodePath: await realpath(nodeExecutable),
          npmCliPath: await realpath(npmCli),
          npmLauncherPath: await realpath(launcher),
        },
      },
    });
  });

  it.each([
    [UPDATE_RUNTIME_ENV.npmNodePath, "node", "CODEXHOST_NPM_NODE_PATH must be an absolute path"],
    [UPDATE_RUNTIME_ENV.npmNodePath, "", "CODEXHOST_NPM_NODE_PATH must be an absolute path"],
    [
      UPDATE_RUNTIME_ENV.npmCliPath,
      "npm-cli.js",
      "CODEXHOST_NPM_CLI_PATH must be an absolute path",
    ],
    [
      UPDATE_RUNTIME_ENV.npmLauncherPath,
      "bin/codexhost.js",
      "CODEXHOST_NPM_LAUNCHER_PATH must be an absolute path",
    ],
    [
      UPDATE_RUNTIME_ENV.npmPackageRoot,
      "relative-root",
      "CODEXHOST_NPM_PACKAGE_ROOT must be an absolute path",
    ],
  ] as const)(
    "still rejects an explicitly set invalid %s (%j) even in a valid npm layout",
    async (envName, badValue, expectedError) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-npm-invalid-env-"));
      roots.push(root);
      const prefix = path.join(root, "prefix");
      const packageRoot = path.join(
        prefix,
        "lib",
        "node_modules",
        "@codexhost",
        "cli-darwin-arm64",
      );
      const host = path.join(packageRoot, "app", "host-runtime.mjs");
      await Promise.all([
        file(host),
        file(path.join(packageRoot, "libexec", "codexhost-updater")),
        file(path.join(prefix, "bin", "node")),
        file(path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js")),
        file(path.join(prefix, "lib", "node_modules", "@codexhost", "cli", "bin", "codexhost.js")),
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
          environment: { ...runtimeEnvironment(root), [envName]: badValue },
          platform: "darwin",
          architecture: "arm64",
          stateDirectory: path.join(root, "state"),
        }),
      ).rejects.toThrow(expectedError);
    },
  );
});
