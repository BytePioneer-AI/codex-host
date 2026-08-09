export type {
  ArtifactDownloadProgress,
  ArtifactDownloader,
  ArtifactDownloadResult,
  ArtifactSource,
} from "./artifact.js";
export {
  UPDATE_RUNTIME_ENV,
  defaultUpdateStateDirectory,
  parseDistributionMetadata,
  resolveInstalledUpdateContext,
  type DistributionMetadata,
  type InstalledUpdateContext,
} from "./distribution.js";
export {
  CODEXHOST_LATEST_RELEASE_URL,
  compareSemanticVersions,
  expectedInstallerAssetName,
  fetchLatestGitHubRelease,
  parseLatestGitHubRelease,
  selectInstallerReleaseArtifact,
  type CodexhostLatestRelease,
  type CodexhostReleaseAsset,
  type GitHubReleaseFetchOptions,
  type InstallerReleaseTarget,
  type SelectedReleaseArtifact,
} from "./github-release.js";
export {
  acquireUpdateOperationLock,
  cleanupTerminalUpdateState,
  discoverLatestUpdateStatus,
  recoverUpdateOperationLock,
  type DiscoveredUpdateStatus,
  type UpdateOperationLock,
} from "./operation-state.js";
export type {
  BackgroundUpdateInstallation,
  BackgroundUpdatePhase,
  BackgroundUpdateStatus,
} from "./status.js";
export {
  createBackgroundUpdateManager,
  type BackgroundUpdateManager,
  type BackgroundUpdateManagerDependencies,
  type CommonUpdateOptions,
  type MacOsDmgUpdateOptions,
  type NpmUpdateOptions,
  type PreparedBackgroundUpdate,
  type PreparedUpdateInfo,
  type StartedBackgroundUpdate,
  type WindowsInstallerUpdateOptions,
} from "./update-manager.js";

export const packageMetadata = {
  name: "@codexhost/update-manager",
} as const;
