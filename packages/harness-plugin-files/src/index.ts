export {
  discoverHarnessPlugins,
  type HarnessPluginDiscovery,
  type HarnessPluginDiscoveryDiagnosticCode,
  type InstalledHarnessPlugin,
} from "./discovery.js";
export { HarnessLaunchSettingsStore } from "./launch-settings.js";
export {
  desktopExtensionDirectory,
  desktopExtensionsRoot,
  desktopExtensionsStatusPath,
  discoverDesktopExtensions,
  readDesktopExtensionScreenshot,
  type DesktopExtensionInstallation,
} from "./extension-discovery.js";
export {
  DesktopExtensionRevisionConflict,
  readDesktopExtensionConfiguration,
  writeDesktopExtensionConfiguration,
} from "./extension-configuration.js";
export {
  DesktopExtensionSelectionError,
  listDesktopExtensions,
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
export {
  pluginResourcePath,
  readPluginConfiguration,
  readPluginFile,
  readPluginIcon,
} from "./plugin-files.js";
