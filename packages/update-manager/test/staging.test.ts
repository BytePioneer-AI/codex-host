import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupStagedUpdates,
  createBackgroundUpdateManager,
  isUpdateOperationActive,
  readStagedUpdate,
  stageArtifact,
  stageNpm,
  verifyStagedArtifact,
  type CommonUpdateOptions,
} from "../src/index.js";
import { isPathInsideRoot } from "../src/staging.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-staging-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function commonOptions(root: string, version: string): Promise<CommonUpdateOptions> {
  const launcherExecutable = path.join(root, "installed", "bin", "codexhost");
  const updaterExecutable = path.join(root, "installed", "libexec", "codexhost-updater");
  for (const filePath of [launcherExecutable, updaterExecutable]) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "fixture\n", { mode: 0o700 });
  }
  return {
    version,
    launcherPid: 4321,
    launcherExecutable,
    updaterExecutable,
    runtimeDescriptorPath: path.join(root, "runtime", "desktop-runtime-v1.json"),
    stateDirectory: path.join(root, "state"),
  };
}

describe("update staging storage and reuse", () => {
  it("stages a verified installer isolated from active handoff files and retains only the latest version", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = path.join(root, "state");
    const firstBytes = Buffer.from("dmg-v1.2.3");
    const secondBytes = Buffer.from("dmg-v1.2.4");

    const first = await stageArtifact({
      stateDirectory,
      version: "1.2.3",
      target: "macos-arm64",
      assetName: "codexhost-1.2.3-macos-arm64.dmg",
      source: {
        url: "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-macos-arm64.dmg",
        sha256: sha256(firstBytes),
        size: firstBytes.length,
      },
      download: async (_source, destination) => {
        await writeFile(destination, firstBytes, { flag: "wx", mode: 0o600 });
        return { bytes: firstBytes.length, finalUrl: "https://objects.example.test/v1.2.3.dmg" };
      },
      now: () => 1_700_000_000_000,
    });

    expect(first).toMatchObject({
      schemaVersion: 1,
      version: "1.2.3",
      distribution: "installer",
      target: "macos-arm64",
      assetName: "codexhost-1.2.3-macos-arm64.dmg",
      sha256: sha256(firstBytes),
      size: firstBytes.length,
    });
    // Staging must never create active-update-v1.lock, request-v1.json, or status-v1.json.
    await expect(isUpdateOperationActive(stateDirectory)).resolves.toBe(false);
    const stateEntries = await readdir(stateDirectory);
    expect(stateEntries).toEqual(["staged"]);

    const second = await stageArtifact({
      stateDirectory,
      version: "1.2.4",
      target: "macos-arm64",
      assetName: "codexhost-1.2.4-macos-arm64.dmg",
      source: {
        url: "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.4/codexhost-1.2.4-macos-arm64.dmg",
        sha256: sha256(secondBytes),
        size: secondBytes.length,
      },
      download: async (_source, destination) => {
        await writeFile(destination, secondBytes, { flag: "wx", mode: 0o600 });
        return { bytes: secondBytes.length, finalUrl: "https://objects.example.test/v1.2.4.dmg" };
      },
      now: () => 1_700_000_060_000,
    });

    expect(second.version).toBe("1.2.4");
    const stagedEntries = (await readdir(path.join(stateDirectory, "staged"))).sort();
    expect(stagedEntries).toEqual(["staged-v1.json", "update-1.2.4"]);
    await expect(readStagedUpdate(stateDirectory)).resolves.toMatchObject({ version: "1.2.4" });
  });

  it("cleans obsolete staged data once currentVersion reaches or exceeds staged version", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = path.join(root, "state");
    const bytes = Buffer.from("dmg-v1.2.3");

    await stageArtifact({
      stateDirectory,
      version: "1.2.3",
      target: "macos-arm64",
      assetName: "codexhost-1.2.3-macos-arm64.dmg",
      source: {
        url: "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-macos-arm64.dmg",
        sha256: sha256(bytes),
        size: bytes.length,
      },
      download: async (_source, destination) => {
        await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
        return { bytes: bytes.length, finalUrl: "https://objects.example.test/v1.2.3.dmg" };
      },
    });

    await cleanupStagedUpdates(stateDirectory, { currentVersion: "1.2.2" });
    await expect(readStagedUpdate(stateDirectory)).resolves.toMatchObject({ version: "1.2.3" });

    await cleanupStagedUpdates(stateDirectory, { currentVersion: "1.2.3" });
    await expect(readStagedUpdate(stateDirectory)).resolves.toBeNull();
    await expect(readdir(path.join(stateDirectory, "staged"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reuses a verified staged installer without network download and falls back if corrupted or removed", async () => {
    const root = await temporaryDirectory();
    const common = await commonOptions(root, "1.2.3");
    const bytes = Buffer.from("verified-dmg-payload");
    const source = {
      url: "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-macos-arm64.dmg",
      sha256: sha256(bytes),
      size: bytes.length,
    };

    const staged = await stageArtifact({
      stateDirectory: common.stateDirectory,
      version: "1.2.3",
      target: "macos-arm64",
      assetName: "codexhost-1.2.3-macos-arm64.dmg",
      source,
      download: async (_source, destination) => {
        await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
        return { bytes: bytes.length, finalUrl: "https://objects.example.test/v1.2.3.dmg" };
      },
    });
    await expect(
      verifyStagedArtifact(common.stateDirectory, staged, source),
    ).resolves.toMatchObject({
      size: bytes.length,
    });

    const liveDownload = vi.fn(async (_source: { url: string }, destination: string) => {
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      return { bytes: bytes.length, finalUrl: "https://objects.example.test/live.dmg" };
    });
    const manager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "reuse",
      download: liveDownload,
    });

    const prepared = await manager.prepareMacOsDmg({
      ...common,
      artifact: source,
      appPath: path.join(root, "Applications", "codexhost.app"),
    });
    expect(liveDownload).not.toHaveBeenCalled();
    expect(prepared.artifactPath).toBeDefined();
    await expect(readFile(prepared.artifactPath as string)).resolves.toEqual(bytes);

    // Corrupt staged file -> must fall back seamlessly to live download.
    await writeFile(staged.artifactPath as string, Buffer.from("corrupted-dmg-payload"));
    const fallbackManager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "fallback",
      download: liveDownload,
    });
    const preparedFallback = await fallbackManager.prepareMacOsDmg({
      ...common,
      artifact: source,
      appPath: path.join(root, "Applications", "codexhost.app"),
    });
    expect(liveDownload).toHaveBeenCalledOnce();
    await expect(readFile(preparedFallback.artifactPath as string)).resolves.toEqual(bytes);
  });

  it("skips redundant npm prefetch when the same version is already staged", async () => {
    const root = await temporaryDirectory();
    const common = await commonOptions(root, "1.2.3");
    const npmFiles = {
      nodePath: path.join(root, "node", "node"),
      npmCliPath: path.join(root, "node", "npm-cli.js"),
      npmLauncherPath: path.join(root, "npm", "bin", "codexhost.js"),
    };
    for (const filePath of Object.values(npmFiles)) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "fixture\n");
    }
    const packageRoot = path.join(root, "npm", "@codexhost", "cli-darwin-arm64");
    const stagePrefetch = vi.fn(async () => undefined);
    await stageNpm({
      stateDirectory: common.stateDirectory,
      version: "1.2.3",
      target: "macos-arm64",
      npmTarget: {
        nodePath: npmFiles.nodePath,
        npmCliPath: npmFiles.npmCliPath,
        packageRoot,
        version: "1.2.3",
      },
      prefetchNpm: stagePrefetch,
    });
    expect(stagePrefetch).toHaveBeenCalledOnce();

    const interactivePrefetch = vi.fn(async () => undefined);
    const manager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "npm-reuse",
      prefetchNpm: interactivePrefetch,
    });
    const prepared = await manager.prepareNpm({
      ...common,
      ...npmFiles,
      packageRoot,
      target: "macos-arm64",
    });
    expect(prepared.installation).toBe("npm");
    expect(interactivePrefetch).not.toHaveBeenCalled();

    // A staged npm record from a different architecture target must not be reused.
    const mismatchedManager = createBackgroundUpdateManager({
      platform: "darwin",
      randomId: () => "npm-mismatch",
      prefetchNpm: interactivePrefetch,
    });
    await mismatchedManager.prepareNpm({
      ...common,
      ...npmFiles,
      packageRoot,
      target: "macos-x64",
    });
    expect(interactivePrefetch).toHaveBeenCalledOnce();
  });

  it("skips cleanup when an active staging-v1.lock is held by a live process", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = path.join(root, "state");
    const stagedDirectory = path.join(stateDirectory, "staged");
    const inFlightDirectory = path.join(stagedDirectory, "update-1.2.4");
    const inFlightFile = path.join(inFlightDirectory, ".codexhost-1.2.4-macos-arm64.dmg.download");
    const metadataPath = path.join(stagedDirectory, "staged-v1.json");
    const lockPath = path.join(stateDirectory, "staging-v1.lock");

    await mkdir(inFlightDirectory, { recursive: true });
    await writeFile(
      metadataPath,
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        distribution: "npm",
        target: "macos-arm64",
        stagedAt: 1_700_000_000,
      }),
    );
    await writeFile(inFlightFile, "partial-download");
    await writeFile(
      lockPath,
      JSON.stringify({ ownerPid: process.pid, startedAt: Math.floor(Date.now() / 1000) }),
    );

    await cleanupStagedUpdates(stateDirectory, { currentVersion: "1.2.3" });
    await cleanupStagedUpdates(stateDirectory);

    await expect(readFile(inFlightFile, "utf8")).resolves.toBe("partial-download");
    await expect(readStagedUpdate(stateDirectory)).resolves.toMatchObject({ version: "1.2.3" });
    await expect(readFile(lockPath, "utf8")).resolves.toContain(String(process.pid));
  });

  it("recovers an expired staging-v1.lock even if its ownerPid is still alive (PID reuse protection)", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = path.join(root, "state");
    const stagedDirectory = path.join(stateDirectory, "staged");
    const lockPath = path.join(stateDirectory, "staging-v1.lock");
    await mkdir(stagedDirectory, { recursive: true });
    await writeFile(
      path.join(stagedDirectory, "staged-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        distribution: "npm",
        target: "macos-arm64",
        stagedAt: 1_700_000_000,
      }),
    );
    const lockStartedSeconds = 1_700_000_000;
    await writeFile(
      lockPath,
      JSON.stringify({
        ownerPid: process.pid,
        startedAt: lockStartedSeconds,
        token: "stale-lock-token",
      }),
    );

    // Within the 30-minute TTL window: active lock still blocks cleanup.
    await cleanupStagedUpdates(stateDirectory, {
      currentVersion: "1.2.3",
      now: () => (lockStartedSeconds + 29 * 60) * 1000,
    });
    await expect(readStagedUpdate(stateDirectory)).resolves.toMatchObject({ version: "1.2.3" });

    // Past the 30-minute TTL window: stale lock is recovered even with a live PID.
    await cleanupStagedUpdates(stateDirectory, {
      currentVersion: "1.2.3",
      now: () => (lockStartedSeconds + 30 * 60 + 1) * 1000,
    });
    await expect(readStagedUpdate(stateDirectory)).resolves.toBeNull();
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects staged artifacts escaping staged/ through a parent symlink or junction", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = path.join(root, "state");
    const stagedRoot = path.join(stateDirectory, "staged");
    const outsideDir = path.join(root, "outside");
    const bytes = Buffer.from("escaped-artifact-payload");
    const outsideFile = path.join(outsideDir, "codexhost-1.2.3-macos-arm64.dmg");
    const symlinkedVersionDir = path.join(stagedRoot, "update-1.2.3");
    const escapedPathViaLink = path.join(symlinkedVersionDir, "codexhost-1.2.3-macos-arm64.dmg");

    await mkdir(stagedRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsideFile, bytes, { mode: 0o600 });
    await symlink(
      outsideDir,
      symlinkedVersionDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const source = {
      url: "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-macos-arm64.dmg",
      sha256: sha256(bytes),
      size: bytes.length,
    };
    const staged = {
      schemaVersion: 1 as const,
      version: "1.2.3",
      distribution: "installer" as const,
      target: "macos-arm64" as const,
      stagedAt: 1_700_000_000,
      assetName: "codexhost-1.2.3-macos-arm64.dmg",
      artifactPath: escapedPathViaLink,
      sha256: source.sha256,
      size: bytes.length,
    };

    // Even with matching size and SHA-256, realpath resolves outside staged/ and must be rejected.
    await expect(verifyStagedArtifact(stateDirectory, staged, source)).resolves.toBeNull();
  });

  it("normalizes Windows extended-length paths and drive letter casing for containment checks", () => {
    expect(
      isPathInsideRoot(
        "C:\\Users\\Alice\\AppData\\Local\\codexhost\\updates\\staged",
        "\\\\?\\c:\\Users\\Alice\\AppData\\Local\\codexhost\\updates\\staged\\update-1.2.3\\codexhost.exe",
        "win32",
      ),
    ).toBe(true);
    expect(
      isPathInsideRoot(
        "\\\\server\\share\\codexhost\\staged",
        "\\\\?\\UNC\\SERVER\\share\\codexhost\\staged\\update-1.2.3\\codexhost.exe",
        "win32",
      ),
    ).toBe(true);
    expect(
      isPathInsideRoot(
        "C:\\Users\\Alice\\staged",
        "\\\\?\\C:\\Users\\Alice\\staged-evil\\codexhost.exe",
        "win32",
      ),
    ).toBe(false);
    expect(
      isPathInsideRoot(
        "C:\\Users\\Alice\\staged",
        "D:\\Users\\Alice\\staged\\update-1.2.3\\codexhost.exe",
        "win32",
      ),
    ).toBe(false);
  });
});
