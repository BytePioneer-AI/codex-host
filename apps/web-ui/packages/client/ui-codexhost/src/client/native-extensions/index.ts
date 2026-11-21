/** Public entry point for the Web browser native extension host. */
export {
  startWebNativeExtensionHost,
  type StartWebNativeExtensionHostOptions,
  type WebNativeExtensionHostHandle,
} from "./host.ts";
export {
  webNativeExtensionRpcClient,
  WebExtensionRpcError,
  type WebNativeExtensionRpcClient,
} from "./rpc.ts";
export { createWebExtensionApi, type ManagedWebExtensionResources } from "./api.ts";
export { ExtensionContributionRegistry, resolveContributionTitle } from "./contributions.ts";
