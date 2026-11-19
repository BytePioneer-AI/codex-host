import { randomUUID } from "node:crypto";
import {
  DesktopExtensionRevisionConflict,
  desktopExtensionsRoot,
  desktopExtensionsStatusPath,
  discoverDesktopExtensions,
  readDesktopExtensionConfiguration,
  writeDesktopExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import {
  desktopExtensionIdSchema,
  desktopExtensionsDiagnosticSchema,
  resolveDesktopExtensionSlots,
  type DesktopExtensionStatus,
} from "@codexhost/shared-contracts";
import { readFile } from "node:fs/promises";
import { processIsAlive } from "./diagnostics.js";

const ENABLE = "POST /api/extensions/enable";
const DISABLE = "POST /api/extensions/disable";
const RECOVERY = "POST /api/extensions/disable-all-and-reload";
const LIST = "GET /api/extensions";
const MAX_STATUS_AGE_MS = 15_000;

class ExtensionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly conflictWith?: string,
  ) {
    super(message);
  }
}

export async function extensionsRoute(
  route: string,
  body: Record<string, unknown>,
  dataDirectory: string,
): Promise<{ status: number; body: unknown } | undefined> {
  if (![LIST, ENABLE, DISABLE, RECOVERY].includes(route)) return;
  const root = desktopExtensionsRoot(dataDirectory);
  if (route === LIST) {
    const [discovery, { configuration, diagnostic }, status] = await Promise.all([
      discoverDesktopExtensions(root),
      readDesktopExtensionConfiguration(root),
      readStatus(dataDirectory),
    ]);
    const { conflicts } = resolveDesktopExtensionSlots(
      configuration.enabled,
      discovery.extensions.flatMap((item) => (item.state === "valid" ? [item.manifest] : [])),
    );
    const items = discovery.extensions.map((item) => {
      const enabled = configuration.enabled.includes(item.id);
      if (item.state !== "valid")
        return { id: item.id, enabled, status: { state: item.state, error: item.error } };
      const active =
        status && Object.hasOwn(status.extensions, item.id)
          ? status.extensions[item.id]
          : undefined;
      const conflictWith = conflicts.get(item.id);
      const observed: DesktopExtensionStatus = !enabled
        ? {
            state: "disabled",
            ...(active?.state === "disabled" && active.error ? { error: active.error } : {}),
          }
        : conflictWith
          ? { state: "conflict", conflictWith }
          : active?.hash === item.hash
            ? active
            : { state: "waiting" };
      return { id: item.id, manifest: item.manifest, enabled, status: observed };
    });
    for (const id of configuration.enabled)
      if (!items.some((item) => item.id === id))
        items.push({
          id,
          enabled: true,
          status: { state: "invalid", error: "Extension directory not found" },
        });
    return {
      status: 200,
      body: {
        extensions: items,
        configuration,
        desktopConnected: status !== null,
        diagnostics: [discovery.diagnostic, diagnostic].filter(Boolean),
      },
    };
  }
  try {
    const expected = body.expectedRevision;
    const id = desktopExtensionIdSchema.safeParse(body.id);
    if (
      (route !== RECOVERY || expected !== undefined) &&
      (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0)
    )
      throw new ExtensionError(400, "Invalid expectedRevision");
    if (route !== RECOVERY && !id.success) throw new ExtensionError(400, "Invalid extension ID");
    const changed = await writeDesktopExtensionConfiguration(
      root,
      typeof expected === "number" ? expected : undefined,
      async ({ enabled }) => {
        if (route === RECOVERY) return { enabled: [], reloadToken: randomUUID() };
        if (!id.success) throw new ExtensionError(400, "Invalid extension ID");
        if (route === DISABLE) return { enabled: enabled.filter((other) => other !== id.data) };
        const { extensions } = await discoverDesktopExtensions(root);
        const item = extensions.find((item) => item.id === id.data);
        if (!item || item.state !== "valid")
          throw new ExtensionError(400, item?.error ?? "Extension not found");
        const next = enabled.includes(id.data) ? enabled : [...enabled, id.data];
        const { conflicts } = resolveDesktopExtensionSlots(
          next,
          extensions.flatMap((item) => (item.state === "valid" ? [item.manifest] : [])),
        );
        const conflict = conflicts.get(id.data);
        if (conflict)
          throw new ExtensionError(409, `Slot already occupied by ${conflict}`, conflict);
        return { enabled: next };
      },
    );
    return { status: 200, body: { configuration: changed } };
  } catch (error) {
    if (error instanceof DesktopExtensionRevisionConflict)
      return { status: 409, body: { error: error.message, revision: error.revision } };
    if (error instanceof ExtensionError)
      return {
        status: error.status,
        body: { error: error.message, conflictWith: error.conflictWith },
      };
    return { status: 500, body: { error: "Could not save Desktop extension selection" } };
  }
}

async function readStatus(dataDirectory: string) {
  try {
    const value = desktopExtensionsDiagnosticSchema.parse(
      JSON.parse(await readFile(desktopExtensionsStatusPath(dataDirectory), "utf8")),
    );
    const age = Date.now() - Date.parse(value.updatedAt);
    return value.targetId &&
      age >= 0 &&
      age <= MAX_STATUS_AGE_MS &&
      processIsAlive(value.controllerPid)
      ? value
      : null;
  } catch {
    return null;
  }
}
