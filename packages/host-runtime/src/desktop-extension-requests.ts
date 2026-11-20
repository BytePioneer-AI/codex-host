import {
  DesktopExtensionSelectionError,
  listDesktopExtensions,
  updateDesktopExtensionSelection,
} from "@codexhost/harness-plugin-files";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import {
  DESKTOP_EXTENSIONS_ENABLE_METHOD,
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
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import { codexhostDataDirectory } from "./external-clients.js";

export async function handleDesktopExtensionRequest(
  method: DesktopExtensionManagementMethod,
  request: JsonRpcRequest,
  environment: NodeJS.ProcessEnv,
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
  try {
    if (method === DESKTOP_EXTENSIONS_LIST_METHOD) {
      if (!desktopExtensionsListParamsSchema.safeParse(params).success)
        return rpcError(request, -32602, "Invalid Desktop extension list parameters");
      return reply(desktopExtensionsListResultSchema.parse(await listDesktopExtensions(directory)));
    }
    if (method === DESKTOP_EXTENSIONS_RECOVER_METHOD) {
      const input = desktopExtensionsRecoveryParamsSchema.safeParse(params);
      if (!input.success)
        return rpcError(request, -32602, "Invalid Desktop extension recovery parameters");
      return reply(
        desktopExtensionMutationResultSchema.parse(
          await updateDesktopExtensionSelection(directory, { ...input.data, action: "recover" }),
        ),
      );
    }
    const input = desktopExtensionSelectionParamsSchema.safeParse(params);
    if (!input.success)
      return rpcError(request, -32602, "Invalid Desktop extension selection parameters");
    return reply(
      desktopExtensionMutationResultSchema.parse(
        await updateDesktopExtensionSelection(directory, {
          ...input.data,
          action: method === DESKTOP_EXTENSIONS_ENABLE_METHOD ? "enable" : "disable",
        }),
      ),
    );
  } catch (error) {
    return error instanceof DesktopExtensionSelectionError
      ? rpcError(request, -32602, error.message)
      : rpcError(request, -32000, "Could not read or save Desktop extension settings");
  }
}
