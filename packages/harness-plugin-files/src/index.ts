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
  discoverDesktopExtensions,
  type DesktopExtensionInstallation,
} from "./extension-discovery.js";
export {
  DesktopExtensionRevisionConflict,
  readDesktopExtensionConfiguration,
  writeDesktopExtensionConfiguration,
} from "./extension-configuration.js";
export { HarnessPreferencesStore, HarnessPreferenceConflict } from "./preferences.js";
export {
  pluginResourcePath,
  readPluginConfiguration,
  readPluginFile,
  readPluginIcon,
} from "./plugin-files.js";
