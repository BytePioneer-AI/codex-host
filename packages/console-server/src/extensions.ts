import {
  DesktopExtensionPackageError,
  DesktopExtensionSelectionError,
  fetchDesktopExtensionCatalog,
  installDesktopExtension,
  listDesktopExtensions,
  uninstallDesktopExtension,
  updateDesktopExtensionSelection,
} from "@codexhost/harness-plugin-files";
import {
  desktopExtensionSelectionParamsSchema,
  desktopExtensionsCatalogParamsSchema,
  desktopExtensionsInstallParamsSchema,
  desktopExtensionsRecoveryParamsSchema,
  desktopExtensionsUninstallParamsSchema,
} from "@codexhost/shared-contracts";

export const INSTALL = "POST /api/extensions/install";
const UNINSTALL = "POST /api/extensions/uninstall";
const CATALOG = "GET /api/extensions/catalog";
const ENABLE = "POST /api/extensions/enable";
const DISABLE = "POST /api/extensions/disable";
const RECOVERY = "POST /api/extensions/disable-all-and-reload";

export async function extensionsRoute(
  route: string,
  body: Record<string, unknown>,
  dataDirectory: string,
  query: URLSearchParams,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/extensions")
    return { status: 200, body: await listDesktopExtensions(dataDirectory) };
  if (route === CATALOG) {
    const value = query.get("forceRefresh");
    const params = desktopExtensionsCatalogParamsSchema.safeParse(
      value === null
        ? {}
        : { forceRefresh: value === "true" ? true : value === "false" ? false : value },
    );
    if (!params.success) return { status: 400, body: { error: "Invalid forceRefresh" } };
    return {
      status: 200,
      body: await fetchDesktopExtensionCatalog({ ...params.data, environment }),
    };
  }
  if (route === INSTALL || route === UNINSTALL) {
    try {
      if (route === INSTALL) {
        const params = desktopExtensionsInstallParamsSchema.safeParse(body);
        if (!params.success)
          return { status: 400, body: { error: "Invalid extension install parameters" } };
        return {
          status: 200,
          body: await installDesktopExtension(dataDirectory, params.data, environment),
        };
      }
      const params = desktopExtensionsUninstallParamsSchema.safeParse(body);
      if (!params.success) return { status: 400, body: { error: "Invalid extension ID" } };
      return {
        status: 200,
        body: await uninstallDesktopExtension({ dataDir: dataDirectory, id: params.data.id }),
      };
    } catch (error) {
      return error instanceof DesktopExtensionPackageError
        ? { status: 400, body: { error: error.message } }
        : { status: 500, body: { error: "Could not install or uninstall Desktop extension" } };
    }
  }
  if (route !== ENABLE && route !== DISABLE && route !== RECOVERY) return;
  try {
    const result = await (async () => {
      if (route === RECOVERY) {
        const params = desktopExtensionsRecoveryParamsSchema.safeParse(body);
        if (!params.success) throw new DesktopExtensionSelectionError("Invalid expectedRevision");
        return updateDesktopExtensionSelection(dataDirectory, {
          ...params.data,
          action: "recover",
        });
      }
      const params = desktopExtensionSelectionParamsSchema.safeParse(body);
      if (!params.success)
        throw new DesktopExtensionSelectionError("Invalid extension ID or expectedRevision");
      return updateDesktopExtensionSelection(dataDirectory, {
        ...params.data,
        action: route === ENABLE ? "enable" : "disable",
      });
    })();
    switch (result.state) {
      case "saved":
        return { status: 200, body: { configuration: result.configuration } };
      case "slot-conflict":
        return {
          status: 409,
          body: {
            error: `Slot already occupied by ${result.conflictWith}`,
            conflictWith: result.conflictWith,
          },
        };
      case "revision-conflict":
        return {
          status: 409,
          body: {
            error: "Extension selection changed; refresh and try again",
            revision: result.revision,
          },
        };
    }
  } catch (error) {
    return error instanceof DesktopExtensionSelectionError
      ? { status: 400, body: { error: error.message } }
      : { status: 500, body: { error: "Could not save Desktop extension selection" } };
  }
}
