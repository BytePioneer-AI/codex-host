import { backendIpcErrorMessage } from "@codexhost/extension-backend";
import {
  hostExtensionInstallationMetadata,
  HostExtensionInstallConflict,
  HostExtensionSettingsRevisionConflict,
} from "@codexhost/harness-plugin-files";
import {
  HOST_EXTENSIONS_RPC as RPC,
  hostExtensionsRpcSchemas as schemas,
  jsonValueSchema,
  type HostExtensionManagementMethod,
} from "@codexhost/shared-contracts";
import type { ConsoleHostReply } from "./app-server-host.js";
import type { HostExtensionManager } from "./host-extension-manager.js";

class InvalidParameters extends Error {}
function params<M extends HostExtensionManagementMethod>(method: M, input: unknown) {
  const parsed = schemas[method].params.safeParse(input);
  if (!parsed.success) throw new InvalidParameters("Invalid Host extension parameters");
  return parsed.data as ReturnType<(typeof schemas)[M]["params"]["parse"]>;
}

async function dispatch(
  manager: HostExtensionManager,
  method: HostExtensionManagementMethod,
  input: unknown,
): Promise<unknown> {
  switch (method) {
    case RPC.list:
      params(method, input);
      return manager.list();
    case RPC.snapshot:
      params(method, input);
      return manager.snapshot();
    case RPC.catalog:
      return manager.catalog(params(method, input));
    case RPC.install:
    case RPC.update: {
      const { source } = params(method, input);
      if (source?.type === "zip" && "localZipPath" in source)
        throw new InvalidParameters("Use a base64 ZIP; local ZIP paths are not accepted");
      const installed =
        method === RPC.install
          ? await manager.install(params(method, input))
          : await manager.update(params(method, input));
      return { ...hostExtensionInstallationMetadata(installed), replaced: installed.replaced };
    }
    case RPC.enable:
    case RPC.disable:
      return manager.select({
        ...params(method, input),
        action: method === RPC.enable ? "enable" : "disable",
      });
    case RPC.recover:
      return manager.select({ ...params(method, input), action: "disableAll" });
    case RPC.uninstall:
      return manager.uninstall(params(method, input));
    case RPC.asset:
      return manager.asset(params(method, input));
    case RPC.settingsGet:
      return manager.settingsGet(params(method, input));
    case RPC.settingsSet:
      return manager.settingsSet(params(method, input));
    case RPC.backendInvoke:
      return { result: await manager.invoke(params(method, input)) };
  }
}

export async function handleHostExtensionRequest(
  manager: HostExtensionManager | undefined,
  method: HostExtensionManagementMethod,
  input: unknown,
): Promise<ConsoleHostReply> {
  if (!manager)
    return {
      error: { code: -32601, message: "Extension management is only available on the local Host" },
    };
  try {
    const result = await dispatch(manager, method, input ?? {});
    return { result: jsonValueSchema.parse(schemas[method].result.parse(result)) };
  } catch (error) {
    if (error instanceof InvalidParameters)
      return { error: { code: -32602, message: error.message } };
    if (
      error instanceof HostExtensionInstallConflict ||
      error instanceof HostExtensionSettingsRevisionConflict
    )
      return { error: { code: -32009, message: error.message } };
    return {
      error: {
        code: -32000,
        message:
          method === RPC.backendInvoke
            ? (backendIpcErrorMessage(error) ?? "Extension backend could not complete the call")
            : `Host extension operation failed: ${method}`,
      },
    };
  }
}
