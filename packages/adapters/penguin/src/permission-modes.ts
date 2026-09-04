import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type PenguinApprovalMode = "allow-all" | "deny-all" | "read-only" | "always-ask";

const nativePermissionModes = new Set<PenguinApprovalMode>([
  "allow-all",
  "deny-all",
  "read-only",
  "always-ask",
]);

export const PENGUIN_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("always-ask");

export const PENGUIN_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "always-ask",
        label: "Always ask",
        description: "Ask before every tool action.",
      },
      {
        id: "read-only",
        label: "Read only",
        description: "Allow read-only actions and deny changes.",
      },
      {
        id: "allow-all",
        label: "Allow all",
        description: "Allow Penguin Harness tool actions without approval prompts.",
        dangerous: true,
      },
      {
        id: "deny-all",
        label: "Deny all",
        description: "Deny all tool actions.",
      },
    ],
    defaultModeId: PENGUIN_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodePenguinPermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): PenguinApprovalMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!nativePermissionModes.has(parsed as PenguinApprovalMode)) {
    throw new Error("Penguin Permission Mode belongs to another Adapter");
  }
  return parsed as PenguinApprovalMode;
}

export function encodePenguinPermissionModeId(mode: PenguinApprovalMode): HarnessPermissionModeId {
  if (!nativePermissionModes.has(mode)) {
    throw new Error("Penguin returned an unsupported Permission Mode");
  }
  return harnessPermissionModeIdSchema.parse(mode);
}

export function isPenguinPermissionMode(value: unknown): value is PenguinApprovalMode {
  return typeof value === "string" && nativePermissionModes.has(value as PenguinApprovalMode);
}
