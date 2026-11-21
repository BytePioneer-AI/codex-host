import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  desktopExtensionsDiagnosticSchema,
  resolveDesktopExtensionSlots,
  type DesktopExtensionListItem,
  type DesktopExtensionMutationResult,
  type DesktopExtensionSelectionParams,
  type DesktopExtensionStatus,
  type DesktopExtensionsListResult,
  type DesktopExtensionsRecoveryParams,
} from "@codexhost/shared-contracts";
import {
  DesktopExtensionRevisionConflict,
  missingDesktopExtensionConfiguration,
  readDesktopExtensionConfiguration,
  withDesktopExtensionDirectoryLock,
  writeDesktopExtensionConfiguration,
} from "./extension-configuration.js";
import {
  desktopExtensionsRoot,
  desktopExtensionsStatusPath,
  discoverDesktopExtensions as scanDesktopExtensions,
  extensionFileMissing,
  privateExtensionDirectory,
} from "./extension-discovery.js";

const MAX_STATUS_AGE_MS = 15_000;

export class DesktopExtensionSelectionError extends Error {}

class DesktopExtensionSlotConflict extends Error {
  constructor(readonly conflictWith: string) {
    super(`Slot already occupied by ${conflictWith}`);
  }
}

export async function readDesktopExtensionSnapshot(
  root: string,
  { skipScanIfNoneEnabled = false } = {},
) {
  let directory: string;
  try {
    directory = await privateExtensionDirectory(root);
  } catch (error) {
    return {
      selection: missingDesktopExtensionConfiguration(error),
      discovery: {
        extensions: [],
        ...(!extensionFileMissing(error) && {
          diagnostic: error instanceof Error ? error.message : String(error),
        }),
      },
    };
  }
  return withDesktopExtensionDirectoryLock(directory, async () => {
    const selection = await readDesktopExtensionConfiguration(directory);
    const discovery =
      skipScanIfNoneEnabled && !selection.configuration.enabled.length
        ? { extensions: [] }
        : await scanDesktopExtensions(directory);
    return { selection, discovery };
  });
}

export async function discoverDesktopExtensions(root: string) {
  return (await readDesktopExtensionSnapshot(root)).discovery;
}

export async function listDesktopExtensions(
  dataDirectory: string,
): Promise<DesktopExtensionsListResult> {
  const [
    {
      discovery,
      selection: { configuration, diagnostic },
    },
    status,
  ] = await Promise.all([
    readDesktopExtensionSnapshot(desktopExtensionsRoot(dataDirectory)),
    readStatus(dataDirectory),
  ]);
  const { conflicts } = resolveDesktopExtensionSlots(
    configuration.enabled,
    discovery.extensions.flatMap((item) => (item.state === "valid" ? [item.manifest] : [])),
  );
  const extensions = discovery.extensions.map<DesktopExtensionListItem>((item) => {
    const enabled = configuration.enabled.includes(item.id);
    if (item.state !== "valid")
      return { id: item.id, enabled, status: { state: item.state, error: item.error } };
    const active =
      status && Object.hasOwn(status.extensions, item.id) ? status.extensions[item.id] : undefined;
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
    return {
      id: item.id,
      manifest: item.manifest,
      ...(item.iconDataUrl ? { iconDataUrl: item.iconDataUrl } : {}),
      ...(item.screenshotDataUrls ? { screenshotDataUrls: item.screenshotDataUrls } : {}),
      enabled,
      status: observed,
    };
  });
  for (const id of configuration.enabled)
    if (!extensions.some((item) => item.id === id))
      extensions.push({
        id,
        enabled: true,
        status: { state: "invalid", error: "Extension directory not found" },
      });
  return {
    configuration,
    desktopConnected: status !== null,
    diagnostics: [discovery.diagnostic, diagnostic].filter((value) => value !== undefined),
    extensions,
  };
}

type SelectionChange =
  | ({ action: "enable" | "disable" } & DesktopExtensionSelectionParams)
  | ({ action: "recover" } & DesktopExtensionsRecoveryParams);

export async function updateDesktopExtensionSelection(
  dataDirectory: string,
  change: SelectionChange,
): Promise<DesktopExtensionMutationResult> {
  const root = desktopExtensionsRoot(dataDirectory);
  try {
    const configuration = await writeDesktopExtensionConfiguration(
      root,
      change.expectedRevision,
      async ({ enabled }) => {
        if (change.action === "recover") return { enabled: [], reloadToken: randomUUID() };
        if (change.action === "disable")
          return { enabled: enabled.filter((id) => id !== change.id) };
        const { extensions } = await scanDesktopExtensions(root);
        const item = extensions.find((item) => item.id === change.id);
        if (!item || item.state !== "valid")
          throw new DesktopExtensionSelectionError(item?.error ?? "Extension not found");
        const next = enabled.includes(change.id) ? enabled : [...enabled, change.id];
        const { conflicts } = resolveDesktopExtensionSlots(
          next,
          extensions.flatMap((item) => (item.state === "valid" ? [item.manifest] : [])),
        );
        const conflict = conflicts.get(change.id);
        if (conflict) throw new DesktopExtensionSlotConflict(conflict);
        return { enabled: next };
      },
    );
    return { state: "saved", configuration };
  } catch (error) {
    if (error instanceof DesktopExtensionRevisionConflict)
      return { state: "revision-conflict", revision: error.revision };
    if (error instanceof DesktopExtensionSlotConflict)
      return { state: "slot-conflict", conflictWith: error.conflictWith };
    throw error;
  }
}

async function readStatus(dataDirectory: string) {
  try {
    const value = desktopExtensionsDiagnosticSchema.parse(
      JSON.parse(await readFile(desktopExtensionsStatusPath(dataDirectory), "utf8")),
    );
    const age = Date.now() - Date.parse(value.updatedAt);
    if (!value.targetId || age < 0 || age > MAX_STATUS_AGE_MS) return null;
    try {
      process.kill(value.controllerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
    }
    return value;
  } catch {
    return null;
  }
}
