import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export const QODER_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

export type QoderPermissionMode = (typeof QODER_PERMISSION_MODES)[number];

const nativeModes = new Set<string>(QODER_PERMISSION_MODES);

export const QODER_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    defaultModeId: "default",
    modes: [
      {
        id: "default",
        label: "Default",
        description: "Ask before edits and other protected actions.",
      },
      {
        id: "acceptEdits",
        label: "Accept edits",
        description: "Allow file edits and ask for other protected actions.",
      },
      {
        id: "plan",
        label: "Plan",
        description: "Prepare a plan without making changes by default.",
      },
      {
        id: "auto",
        label: "Auto",
        description: "Let Qoder decide safe in-workspace actions.",
      },
      {
        id: "dontAsk",
        label: "Don't ask",
        description: "Deny actions that are not already authorized.",
      },
      {
        id: "bypassPermissions",
        label: "Bypass permissions",
        description: "Skip Qoder CLI permission checks.",
        dangerous: true,
      },
    ],
  });

export function isQoderPermissionMode(value: string): value is QoderPermissionMode {
  return nativeModes.has(value);
}

export function decodeQoderPermissionMode(
  permissionModeId: HarnessPermissionModeId,
): QoderPermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!isQoderPermissionMode(parsed)) {
    throw new Error("Permission Mode is not in this Qoder session's native catalog");
  }
  return parsed;
}

export function encodeQoderPermissionMode(mode: QoderPermissionMode): HarnessPermissionModeId {
  return harnessPermissionModeIdSchema.parse(mode);
}
