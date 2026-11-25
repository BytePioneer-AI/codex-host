import { backendIpcErrorMessage } from "@codexhost/extension-backend";
import {
  ExtensionDownloadError,
  hostExtensionInstallationMetadata,
  HostExtensionInstallConflict,
  HostExtensionSettingsRevisionConflict,
  InvalidHostExtensionManifest,
} from "@codexhost/harness-plugin-files";
import {
  HOST_EXTENSIONS_RPC as RPC,
  hostExtensionsRpcSchemas as schemas,
  jsonValueSchema,
  type HostExtensionManagementMethod,
} from "@codexhost/shared-contracts";
import type { ConsoleHostReply } from "./app-server-host.js";
import type { HostExtensionManager } from "./host-extension-manager.js";

const SAFE_EXACT_MESSAGES = new Set([
  "Host extension catalog unavailable",
  "Extension is not in the catalog",
  "Requested package does not match the catalog entry",
  "Extension ZIP SHA-256 mismatch",
  "Extension ZIP exceeds 64 MiB",
  "Manifest id or version does not match the expected package",
  "Requested GitHub Release ZIP asset was not found",
  "An update source is required for this installation",
  "Updated extension backend could not start",
  "Extension is not installed or is invalid",
  "Extension is not installed",
  "Host extensions are closing",
  "Extension staging aborted",
  "Too many extension package files",
  "Too many extension package entries",
  "Extension index exceeds size limit",
  "Extension package files are missing",
  "Expected an absolute local path without dot segments",
  "Local package path must not traverse symlinks or special files",
]);

const SAFE_MESSAGE_PREFIXES = [
  "Invalid Desktop extension ZIP:",
  "Missing required extension file:",
  "Unsupported extension package file:",
  "Extension package size limit exceeded:",
  "Extension file exceeds size limit:",
  "Invalid image signature:",
];

const SAFE_EXTENSION_LIMIT_PATTERN = /^At most \d+ Host extensions are supported$/u;

function safeHostExtensionErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error instanceof ExtensionDownloadError || error instanceof InvalidHostExtensionManifest)
    return error.message;
  if (
    SAFE_EXACT_MESSAGES.has(error.message) ||
    SAFE_MESSAGE_PREFIXES.some((prefix) => error.message.startsWith(prefix)) ||
    SAFE_EXTENSION_LIMIT_PATTERN.test(error.message)
  )
    return error.message;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "ELOCKED" || code === "ECOMPROMISED")
    return "Extension storage is busy; please try again";
  if (code === "ENOSPC") return "Insufficient disk space for extension installation";
  if (code === "EACCES" || code === "EPERM" || code === "EBUSY")
    return "Extension directory is temporarily busy or inaccessible; please try again";
  return undefined;
}

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
    if (method !== RPC.backendInvoke) manager.diagnoseOperationError(method, error);
    return {
      error: {
        code: -32000,
        message:
          method === RPC.backendInvoke
            ? (backendIpcErrorMessage(error) ?? "Extension backend could not complete the call")
            : (safeHostExtensionErrorMessage(error) ??
              `Host extension operation failed: ${method}`),
      },
    };
  }
}
