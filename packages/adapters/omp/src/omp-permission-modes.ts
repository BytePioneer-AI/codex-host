import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type OmpPermissionMode = "always-ask" | "write" | "yolo";

const nativePermissionModes = new Set<OmpPermissionMode>(["always-ask", "write", "yolo"]);

export const OMP_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("always-ask");

export const OMP_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "always-ask",
        label: "Always ask",
        description: "Automatically allow reads and ask before write or execution actions.",
      },
      {
        id: "write",
        label: "Write",
        description: "Automatically allow reads and writes; ask before execution actions.",
      },
      {
        id: "yolo",
        label: "Full access",
        description: "Run all tool actions without approval prompts.",
        dangerous: true,
      },
    ],
    defaultModeId: OMP_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeOmpPermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): OmpPermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!nativePermissionModes.has(parsed as OmpPermissionMode)) {
    throw new Error(`Unsupported OMP Permission Mode '${parsed}'`);
  }
  return parsed as OmpPermissionMode;
}

export function encodeOmpPermissionModeId(mode: OmpPermissionMode): HarnessPermissionModeId {
  return harnessPermissionModeIdSchema.parse(mode);
}
