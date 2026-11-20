import {
  DesktopExtensionPackageError,
  DesktopExtensionSelectionError,
  fetchDesktopExtensionCatalog,
  installDesktopExtension,
  listDesktopExtensions,
  uninstallDesktopExtension,
  updateDesktopExtensionSelection,
  desktopExtensionDirectory,
  readDesktopExtensionAsset,
  readDesktopExtensionSettings,
  writeDesktopExtensionSettings,
} from "@codexhost/harness-plugin-files";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import {
  DESKTOP_EXTENSIONS_CATALOG_METHOD,
  DESKTOP_EXTENSIONS_ASSET_METHOD,
  DESKTOP_EXTENSIONS_BACKEND_INVOKE_METHOD,
  DESKTOP_EXTENSIONS_SETTINGS_GET_METHOD,
  DESKTOP_EXTENSIONS_SETTINGS_SET_METHOD,
  desktopExtensionsAssetParamsSchema,
  desktopExtensionsBackendInvokeParamsSchema,
  desktopExtensionsBackendInvokeResultSchema,
  desktopExtensionsSettingsGetParamsSchema,
  desktopExtensionsSettingsSetParamsSchema,
  DESKTOP_EXTENSIONS_ENABLE_METHOD,
  DESKTOP_EXTENSIONS_INSTALL_METHOD,
  DESKTOP_EXTENSIONS_UNINSTALL_METHOD,
  desktopExtensionsCatalogParamsSchema,
  desktopExtensionsCatalogResultSchema,
  desktopExtensionsInstallParamsSchema,
  desktopExtensionsInstallResultSchema,
  desktopExtensionsUninstallParamsSchema,
  desktopExtensionsUninstallResultSchema,
  DESKTOP_EXTENSIONS_LIST_METHOD,
  DESKTOP_EXTENSIONS_RECOVER_METHOD,
  desktopExtensionMutationResultSchema,
  desktopExtensionSelectionParamsSchema,
  desktopExtensionsListParamsSchema,
  desktopExtensionsListResultSchema,
  desktopExtensionsRecoveryParamsSchema,
  jsonValueSchema,
  type DesktopExtensionManagementMethod,
} from "@codexhost/shared-contracts";
import type { DesktopExtensionBackendManager } from "./desktop-extension-backend-manager.js";
import { backendIpcErrorMessage } from "./desktop-extension-backend-process.js";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import { codexhostDataDirectory } from "./external-clients.js";

export async function handleDesktopExtensionRequest(
  method: DesktopExtensionManagementMethod,
  request: JsonRpcRequest,
  environment: NodeJS.ProcessEnv,
  backends: DesktopExtensionBackendManager | undefined,
): Promise<JsonObject> {
  if (environment.CODEXHOST_REMOTE_SSH_MANAGED === "1")
    return rpcError(
      request,
      -32601,
      "Desktop extension settings are only available on the local Host",
    );
  const directory = codexhostDataDirectory(environment);
  const params = request.params ?? {};
  const reply = (result: unknown) =>
    rpcEnvelope(request, { result: jsonValueSchema.parse(result) });
  const invalid = () => rpcError(request, -32602, "Invalid Desktop extension parameters");
  try {
    if (method === DESKTOP_EXTENSIONS_ASSET_METHOD) {
      const input = desktopExtensionsAssetParamsSchema.safeParse(params);
      if (!input.success) return invalid();
      const { id, path } = input.data;
      return reply(await readDesktopExtensionAsset({ dataDir: directory, id, assetPath: path }));
    }
    if (method === DESKTOP_EXTENSIONS_SETTINGS_GET_METHOD) {
      const input = desktopExtensionsSettingsGetParamsSchema.safeParse(params);
      if (!input.success) return invalid();
      const { id } = input.data;
      await desktopExtensionDirectory(directory, id);
      return reply({ values: await readDesktopExtensionSettings({ dataDir: directory, id }) });
    }
    if (method === DESKTOP_EXTENSIONS_SETTINGS_SET_METHOD) {
      const input = desktopExtensionsSettingsSetParamsSchema.safeParse(params);
      if (!input.success) return invalid();
      const { id, values } = input.data;
      await desktopExtensionDirectory(directory, id);
      return reply({
        values: await writeDesktopExtensionSettings({ dataDir: directory, id, values }),
      });
    }
    if (method === DESKTOP_EXTENSIONS_BACKEND_INVOKE_METHOD) {
      const input = desktopExtensionsBackendInvokeParamsSchema.safeParse(params);
      if (!input.success) return invalid();
      if (!backends) return rpcError(request, -32000, "Desktop extension backends are unavailable");
      try {
        const { id, method, params } = input.data;
        const result = await backends.invoke(id, method, params);
        return reply(desktopExtensionsBackendInvokeResultSchema.parse({ result }));
      } catch (error) {
        return rpcError(
          request,
          -32000,
          backendIpcErrorMessage(error) ?? "Desktop extension backend could not complete the call",
        );
      }
    }
    if (method === DESKTOP_EXTENSIONS_CATALOG_METHOD) {
      const input = desktopExtensionsCatalogParamsSchema.safeParse(params);
      if (!input.success)
        return rpcError(request, -32602, "Invalid Desktop extension catalog parameters");
      return reply(
        desktopExtensionsCatalogResultSchema.parse(
          await fetchDesktopExtensionCatalog({ ...input.data, environment }),
        ),
      );
    }
    if (method === DESKTOP_EXTENSIONS_INSTALL_METHOD) {
      const input = desktopExtensionsInstallParamsSchema.safeParse(params);
      if (!input.success)
        return rpcError(request, -32602, "Invalid Desktop extension install parameters");
      const result = await installDesktopExtension(directory, input.data, environment);
      await backends?.reconcile();
      return reply(desktopExtensionsInstallResultSchema.parse(result));
    }
    if (method === DESKTOP_EXTENSIONS_UNINSTALL_METHOD) {
      const input = desktopExtensionsUninstallParamsSchema.safeParse(params);
      if (!input.success)
        return rpcError(request, -32602, "Invalid Desktop extension uninstall parameters");
      const result = await uninstallDesktopExtension({ dataDir: directory, id: input.data.id });
      await backends?.reconcile();
      return reply(desktopExtensionsUninstallResultSchema.parse(result));
    }
    if (method === DESKTOP_EXTENSIONS_LIST_METHOD) {
      if (!desktopExtensionsListParamsSchema.safeParse(params).success)
        return rpcError(request, -32602, "Invalid Desktop extension list parameters");
      return reply(desktopExtensionsListResultSchema.parse(await listDesktopExtensions(directory)));
    }
    if (method === DESKTOP_EXTENSIONS_RECOVER_METHOD) {
      const input = desktopExtensionsRecoveryParamsSchema.safeParse(params);
      if (!input.success)
        return rpcError(request, -32602, "Invalid Desktop extension recovery parameters");
      const result = await updateDesktopExtensionSelection(directory, {
        ...input.data,
        action: "recover",
      });
      if (result.state === "saved") await backends?.reconcile();
      return reply(desktopExtensionMutationResultSchema.parse(result));
    }
    const input = desktopExtensionSelectionParamsSchema.safeParse(params);
    if (!input.success)
      return rpcError(request, -32602, "Invalid Desktop extension selection parameters");
    const result = await updateDesktopExtensionSelection(directory, {
      ...input.data,
      action: method === DESKTOP_EXTENSIONS_ENABLE_METHOD ? "enable" : "disable",
    });
    if (result.state === "saved") await backends?.reconcile();
    return reply(desktopExtensionMutationResultSchema.parse(result));
  } catch (error) {
    return error instanceof DesktopExtensionSelectionError ||
      error instanceof DesktopExtensionPackageError
      ? rpcError(request, -32602, error.message)
      : rpcError(request, -32000, "Desktop extension operation failed");
  }
}
