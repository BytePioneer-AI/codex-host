import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  NPM_PACKAGE_NAME,
  NPM_PLATFORM_PACKAGE_NAMES,
  createNpmBinLauncherSource,
  createNpmPackageManifest,
  expectedNpmPackagePaths,
  npmPackageCpu,
  npmPackageOs,
  npmPlatformPackageName,
  npmReleaseBuildCommands,
  npmTarballFileName,
  parseNpmReleaseArguments,
  validateNpmPackage,
} from "../../scripts/release/prepare-npm.mjs";
import {
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
      await writeFile(absolute, createNpmBinLauncherSource());
    } else {
      await writeFile(absolute, `npm-meta-package:${relative}\n`);
    }
  }
}

describe("npm package release", () => {
  it("maps the current host to a release target id", () => {
    expect(hostReleaseTargetId("darwin", "arm64")).toBe("macos-arm64");
    expect(hostReleaseTargetId("darwin", "x64")).toBe("macos-x64");
    expect(hostReleaseTargetId("win32", "x64")).toBe("windows-x64");
    expect(hostReleaseTargetId("win32", "arm64")).toBe("windows-arm64");
    expect(() => hostReleaseTargetId("linux", "x64")).toThrow("unsupported npm release host");
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
    expect(commands.at(-1).args).not.toContain("codexhost-platform");
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
    const source = createNpmBinLauncherSource();
    expect(source).toContain('"darwin-arm64": "@codexhost/cli-darwin-arm64"');
    expect(source).toContain("require.resolve");
    expect(source).toContain("--omit=optional");
    expect(source).toContain('launchArguments = ["launch", "--agent", "pi"]');
    expect(source).toContain('extras.push("--node", process.execPath)');
    expect(source).toContain('extras.push("--shim", shim)');
    expect(source).toContain('extras.push("--host-runtime", hostRuntime)');
    expect(source).toContain('extras.push("--desktop-controller", desktopController)');
    expect(source).toContain('extras.push("--renderer", rendererExtension)');
    expect(source).not.toContain("runtime/node");
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
      expect(paths).not.toContain("runtime/node");
      expect(paths).toContain("bin/codexhost");
      expect(paths).toContain("libexec/codexhost-shim");
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
  });
});
