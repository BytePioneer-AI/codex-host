export {
  discoverHarnessPlugins,
  type HarnessPluginDiscovery,
  type HarnessPluginDiscoveryDiagnosticCode,
  type InstalledHarnessPlugin,
} from "./discovery.js";
export { HarnessLaunchSettingsStore } from "./launch-settings.js";
export {
  readDesktopExtensionIcon,
  readDesktopExtensionScreenshot,
} from "./desktop-extension-artwork.js";
export { ExtensionDownloadError } from "./desktop-extension-download.js";
export { InvalidHostExtensionManifest } from "./host-extension-package.js";
export { HarnessPreferencesStore, HarnessPreferenceConflict } from "./preferences.js";
export { migrateLegacyDesktopExtensionsOnce } from "./host-extension-legacy-migration.js";
export {
  desktopExtensionsStatusPath,
  hostExtensionsRoot,
  hostExtensionDataRoot,
  hostExtensionDataDirectory,
  type HostExtensionLocation,
} from "./host-extension-io.js";
export {
  discoverHostExtensions,
  hostExtensionInstallationMetadata,
  readHostExtension,
  readHostExtensionBackend,
  readHostExtensionAsset,
  readHostExtensionConfiguration,
  updateHostExtensionConfiguration,
  rollbackHostExtension,
  uninstallHostExtension,
  HostExtensionInstallConflict,
  HostExtensionRevisionConflict,
  type HostExtensionActivePointer,
  type HostExtensionCommitExpectation,
  type HostExtensionDiskInstallation,
  type PreparedHostExtension,
} from "./host-extension-files.js";
export {
  DEFAULT_HOST_EXTENSION_STATS_URL,
  fetchHostExtensionCatalog,
  installHostExtension,
  prepareHostExtension,
  reportHostExtensionInstall,
  resolveHostExtensionStatsUrl,
  type HostExtensionPrepareOptions,
} from "./host-extension-sources.js";
export {
  readHostExtensionSettings,
  writeHostExtensionSettings,
  HostExtensionSettingsRevisionConflict,
} from "./host-extension-settings.js";
export {
  pluginResourcePath,
  readPluginConfiguration,
  readPluginFile,
  readPluginIcon,
} from "./plugin-files.js";
