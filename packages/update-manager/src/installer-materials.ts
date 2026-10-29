import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ArtifactSource } from "./artifact.js";
import {
  fetchGitHubReleaseVersion,
  selectInstallerReleaseArtifact,
  selectInstallerRecoveryArtifact,
  type CodexhostLatestRelease,
  type InstallerReleaseTarget,
} from "./github-release.js";
import {
  INSTALLER_FILES_PATH,
  inside,
  parseInstallerFiles,
  parseInstallerSidecar,
  validateInstallerPaths,
} from "./installer-files.js";

export interface PreparedInstallerRecovery {
  installer_path: string;
  artifact_sha256: string;
  manifest_path: string;
  manifest_sha256: string;
  target_manifest_path: string;
  target_manifest_sha256: string;
  replacement_files_path: string;
  protected_roots: string[];
}
export async function prepareInstallerRecovery(options: {
  installRoot: string;
  operation: string;
  installedVersion: string;
  version: string;
  architecture: string;
  artifact: ArtifactSource;
  download(source: ArtifactSource, name: string): Promise<string>;
  release?(version: string): Promise<CodexhostLatestRelease>;
  environment?: NodeJS.ProcessEnv;
}): Promise<PreparedInstallerRecovery> {
  const marker = await readFile(path.join(options.installRoot, INSTALLER_FILES_PATH), "utf8").catch(
    () => {
      throw new Error(
        "Original installer has no file-recovery capability; use the manual installer in the original directory",
      );
    },
  );
  const installed = parseInstallerFiles(marker);
  const target = `windows-${options.architecture}` as InstallerReleaseTarget;
  if (installed.version !== options.installedVersion || installed.target !== target)
    throw new Error("Installed recovery capability identity mismatch");
  const release = options.release ?? fetchGitHubReleaseVersion;
  const oldRelease = await release(options.installedVersion),
    nextRelease = await release(options.version);
  if (oldRelease.version !== options.installedVersion || nextRelease.version !== options.version)
    throw new Error("Recovery release identity mismatch");
  const oldExe = selectInstallerReleaseArtifact(oldRelease, target).source;
  const nextExe = selectInstallerReleaseArtifact(nextRelease, target).source;
  if (nextExe.sha256 !== options.artifact.sha256 || nextExe.url !== options.artifact.url)
    throw new Error("Selected installer changed during recovery preparation");
  const oldDescriptor = selectInstallerRecoveryArtifact(oldRelease, target).source;
  const nextDescriptor = selectInstallerRecoveryArtifact(nextRelease, target).source;
  const manifestPath = await options.download(oldDescriptor, "previous-installer.json");
  const targetManifestPath = await options.download(nextDescriptor, "target-installer.json");
  const old = parseInstallerSidecar(
    await readFile(manifestPath, "utf8"),
    options.installedVersion,
    target,
    oldExe.sha256,
  );
  const next = parseInstallerSidecar(
    await readFile(targetManifestPath, "utf8"),
    options.version,
    target,
    options.artifact.sha256,
  );
  if (marker !== old.text)
    throw new Error("Installed ownership manifest differs from the original release");
  if (inside(await realpath(options.installRoot), await realpath(options.operation)))
    throw new Error("Installer preparation must be outside the installation");
  const env = options.environment ?? process.env;
  const protectedRoots = [
    path.resolve(
      env.CODEXHOST_DATA_DIR ??
        path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), ".codexhost"),
    ),
    ...[env.CODEXHOST_PLUGIN_DIRECTORY, env.CODEX_HOME]
      .filter((v): v is string => !!v)
      .map((v) => path.resolve(v)),
  ];
  await validateInstallerPaths(
    options.installRoot,
    old.manifest,
    next.manifest,
    protectedRoots,
    true,
  );
  const previous = await options.download(oldExe, "previous.exe");
  const replacement = path.join(options.operation, "replacement-files.txt");
  await writeFile(replacement, next.text, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(options.operation, "previous-files.txt"), old.text, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    installer_path: previous,
    artifact_sha256: oldExe.sha256,
    manifest_path: manifestPath,
    manifest_sha256: oldDescriptor.sha256,
    target_manifest_path: targetManifestPath,
    target_manifest_sha256: nextDescriptor.sha256,
    replacement_files_path: replacement,
    protected_roots: protectedRoots,
  };
}
