import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
