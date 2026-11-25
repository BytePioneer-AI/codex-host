import { discoverHostExtensions, fetchHostExtensionCatalog } from "@codexhost/harness-plugin-files";
import {
  HOST_EXTENSIONS_RPC as RPC,
  hostExtensionsRpcSchemas as schemas,
  type HostExtensionManagementMethod,
  type HostExtensionsListResult,
} from "@codexhost/shared-contracts";
import { HostUnavailableError, type ConsoleHostClient } from "./host-client.js";

const INSTALL = "POST /api/extensions/install";
const UPDATE = "POST /api/extensions/update";
export const isExtensionUploadRoute = (route: string) => route === INSTALL || route === UPDATE;

const methods = new Map<string, HostExtensionManagementMethod>([
  ["GET /api/extensions", RPC.list],
  ["GET /api/extensions/snapshot", RPC.snapshot],
  ["GET /api/extensions/catalog", RPC.catalog],
  [INSTALL, RPC.install],
  [UPDATE, RPC.update],
  ["POST /api/extensions/uninstall", RPC.uninstall],
  ["POST /api/extensions/enable", RPC.enable],
  ["POST /api/extensions/disable", RPC.disable],
  ["POST /api/extensions/recover", RPC.recover],
  ["POST /api/extensions/disable-all-and-reload", RPC.recover],
]);

// The existing Console page still shows a single status badge. Keep that UI
// working while returning the unified manifest and status fields alongside it.
function consoleList(list: HostExtensionsListResult) {
  return {
    ...list,
    desktopConnected: false,
    extensions: list.extensions.map((item) => {
      if (item.state !== "valid")
        return { ...item, status: { state: item.state, error: item.error } };
      const { manifest, enabled, backendState, backendError, desktopConflictWith } = item;
      return {
        ...item,
        manifest: { ...manifest, slots: manifest.slots ?? [] },
        status: !enabled
          ? { state: "disabled" }
          : desktopConflictWith
            ? { state: "conflict", conflictWith: desktopConflictWith }
            : backendState === "failed"
              ? { state: "failed", error: backendError }
              : backendState === "running" || !manifest.desktop
                ? { state: "running" }
                : { state: "waiting" },
      };
    }),
  };
}

export async function extensionsRoute(
  route: string,
  body: Record<string, unknown>,
  dataDirectory: string,
  query: URLSearchParams,
  host: ConsoleHostClient,
): Promise<{ status: number; body: unknown } | undefined> {
  const method = methods.get(route);
  if (!method) return;
  const refresh = query.get("forceRefresh");
  const input =
    method !== RPC.catalog
      ? body
      : refresh === null
        ? {}
        : {
            forceRefresh: refresh === "true" ? true : refresh === "false" ? false : refresh,
          };
  const params = schemas[method].params.safeParse(input);
  if (!params.success) return { status: 400, body: { error: "Invalid extension parameters" } };
  if (
    "source" in params.data &&
    params.data.source?.type === "zip" &&
    "localZipPath" in params.data.source
  )
    return { status: 400, body: { error: "Use a base64 ZIP; local ZIP paths are not accepted" } };

  try {
    const reply = await host.request(method, params.data);
    if ("error" in reply)
      return {
        status:
          reply.error.code === -32602
            ? 400
            : reply.error.code === -32009
              ? 409
              : reply.error.code === -32601
                ? 404
                : 500,
        body: { error: reply.error.message },
      };
    if (method === RPC.list)
      return { status: 200, body: consoleList(schemas[RPC.list].result.parse(reply.result)) };
    if (method === RPC.enable || method === RPC.disable || method === RPC.recover) {
      const result = schemas[method].result.parse(reply.result);
      if (result.state === "revision-conflict")
        return {
          status: 409,
          body: {
            error: "Extension selection changed; refresh and try again",
            revision: result.revision,
          },
        };
    }
    return { status: 200, body: schemas[method].result.parse(reply.result) };
  } catch (error) {
    if (!(error instanceof HostUnavailableError))
      return { status: 500, body: { error: "Host extension request failed" } };
    if (method === RPC.list) {
      const { configuration, diagnostics, extensions } =
        await discoverHostExtensions(dataDirectory);
      return {
        status: 200,
        body: consoleList({ configuration, diagnostics, extensions, revision: 0 }),
      };
    }
    if (method === RPC.catalog)
      return {
        status: 200,
        body: await fetchHostExtensionCatalog(schemas[RPC.catalog].params.parse(input)),
      };
    // A mutation must be coordinated with the owner that stops/starts backends.
    return { status: 503, body: { error: "The shared Host is not running" } };
  }
}
