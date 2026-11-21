export {
  discoverHarnessPlugins,
  type HarnessPluginDiscovery,
  type HarnessPluginDiscoveryDiagnosticCode,
  type InstalledHarnessPlugin,
} from "./discovery.js";
export { HarnessLaunchSettingsStore } from "./launch-settings.js";
export {
  desktopExtensionsRoot,
  desktopExtensionsStatusPath,
  isDesktopExtensionTransactionEntry,
  readDesktopExtensionIcon,
  readDesktopExtensionScreenshot,
  type DesktopExtensionInstallation,
} from "./extension-discovery.js";
export {
  DesktopExtensionRevisionConflict,
  desktopExtensionDirectory,
  readDesktopExtensionConfiguration,
  writeDesktopExtensionConfiguration,
} from "./extension-configuration.js";
export {
  DesktopExtensionSelectionError,
  discoverDesktopExtensions,
  listDesktopExtensions,
  readDesktopExtensionSnapshot,
  updateDesktopExtensionSelection,
} from "./extension-management.js";
export {
  desktopExtensionDataDirectory,
  readDesktopExtensionAsset,
  readDesktopExtensionSettings,
  writeDesktopExtensionSettings,
} from "./desktop-extension-data.js";
export { fetchDesktopExtensionCatalog } from "./desktop-extension-catalog.js";
export { DesktopExtensionPackageError } from "./desktop-extension-download.js";
export {
  installDesktopExtension,
  installFromCatalog,
  installFromUrl,
  installFromZipBuffer,
  uninstallDesktopExtension,
} from "./desktop-extension-installer.js";
export { HarnessPreferencesStore, HarnessPreferenceConflict } from "./preferences.js";
export { readExtensionZip } from "./extension-zip.js";
export {
  discoverWebNativeExtensions,
  prepareWebNativeExtension,
  readCodexHostExtensionManifest,
  readWebNativeExtension,
  readWebNativeExtensionAsset,
  readWebNativeExtensionBackend,
  readWebNativeExtensionSettings,
  uninstallWebNativeExtension,
  webNativeExtensionDataDirectory,
  webNativeExtensionsRoot,
  WebNativeExtensionInstallConflict,
  writeWebNativeExtensionSettings,
  type PreparedWebNativeExtension,
  type WebNativeExtensionInstallation,
} from "./web-native-extension-files.js";
export {
  hostExtensionsRoot,
  hostExtensionDataRoot,
  hostExtensionDataDirectory,
  type HostExtensionLocation,
} from "./host-extension-io.js";
export {
  discoverHostExtensions,
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
  fetchHostExtensionCatalog,
  installHostExtension,
  prepareHostExtension,
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
