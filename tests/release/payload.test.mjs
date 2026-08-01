import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  expectedPayloadPaths,
  numericPackageVersion,
  prepareReleasePayload,
  releaseBuildCommands,
  validatePayload,
} from "../../scripts/release/prepare-payload.mjs";
import { releaseTarget } from "../../scripts/release/targets.mjs";

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "codexhost-payload-"));
}

async function createPayload(root, target) {
  for (const relative of expectedPayloadPaths(target)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `payload:${relative}\n`);
  }
}

describe("release Payload", () => {
  it("builds shared outputs before the selected Rust target", () => {
    const commands = releaseBuildCommands(releaseTarget("windows-arm64"), "win32");
    expect(commands.map((command) => command.command)).toEqual(["npm.cmd", "npm.cmd", "cargo"]);
    expect(commands.at(-1).args).toContain("aarch64-pc-windows-msvc");
    expect(commands.at(-1).args).toContain("codexhost-launcher");
    expect(commands.at(-1).args).toContain("codexhost-shim");
  });

  it("defensively rejects direct cross-operating-system calls", async () => {
    const target =
      process.platform === "win32" ? releaseTarget("macos-arm64") : releaseTarget("windows-x64");
    await expect(prepareReleasePayload({ target })).rejects.toThrow("requires host platform");
  });

  it("validates exactly thirteen allowlisted files without internal manifests", async () => {
    const root = await temporaryDirectory();
    const target = releaseTarget("macos-arm64");
    try {
      await createPayload(root, target);
      const paths = await validatePayload({ payloadRoot: root, target, root: "/repo/source" });
      expect(paths).toEqual(expectedPayloadPaths(target));
      expect(paths).toHaveLength(13);
      expect(paths).not.toContain("release-manifest.json");
      expect(paths).not.toContain("SHA256SUMS.txt");
      await writeFile(path.join(root, "app/host-runtime.js.map"), "unexpected");
      await expect(
        validatePayload({ payloadRoot: root, target, root: "/repo/source" }),
      ).rejects.toThrow("non-allowlist files: app/host-runtime.js.map");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symbolic links and repository source paths", async () => {
    const root = await temporaryDirectory();
    const target = releaseTarget("macos-arm64");
    try {
      await createPayload(root, target);
      await rm(path.join(root, "app/renderer-extension.js"));
      await symlink(
        path.join(root, "app/host-runtime.mjs"),
        path.join(root, "app/renderer-extension.js"),
      );
      await expect(
        validatePayload({ payloadRoot: root, target, root: "/repo/source" }),
      ).rejects.toThrow("symbolic link");

      await rm(path.join(root, "app/renderer-extension.js"));
      await writeFile(path.join(root, "app/renderer-extension.js"), "source=/repo/source");
      await expect(
        validatePayload({ payloadRoot: root, target, root: "/repo/source" }),
      ).rejects.toThrow("forbidden reference: app/renderer-extension.js");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes semantic versions for Apple and MSI metadata", () => {
    expect(numericPackageVersion("1.2.3")).toBe("1.2.3");
    expect(numericPackageVersion("1.2.3-preview.4")).toBe("1.2.3");
    expect(() => numericPackageVersion("preview")).toThrow("major.minor.patch");
    expect(() => numericPackageVersion("1.2.3/../../outside")).toThrow("major.minor.patch");
    expect(() => numericPackageVersion("256.0.0")).toThrow("version limits");
  });

  it("keeps the third-party notice paths relative to the Payload", async () => {
    const root = await temporaryDirectory();
    const target = releaseTarget("windows-x64");
    try {
      await createPayload(root, target);
      const notice = await readFile(path.join(root, "THIRD_PARTY_NOTICES.txt"), "utf8");
      expect(notice).not.toContain(process.cwd());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
