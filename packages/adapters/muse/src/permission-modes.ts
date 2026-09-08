import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type MuseApprovalMode = "onRequest" | "promptUnmatched" | "denyUnmatched" | "allowAll";

export const MUSE_DEFAULT_PERMISSION_MODE_ID =
  harnessPermissionModeIdSchema.parse("promptUnmatched");

export const MUSE_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    // Muse 1.0.3 serve's sealed startup policy rejects onRequest and allowAll.
    // Keep decoding them below for existing native Sessions, without offering
    // choices that this transport cannot apply.
    modes: [
      {
        id: "promptUnmatched",
        label: "Prompt unmatched",
        description: "Allow configured tools; ask when a call is not covered.",
      },
      {
        id: "denyUnmatched",
        label: "Deny unmatched",
        description: "Allow configured tools; deny anything else.",
      },
    ],
    defaultModeId: MUSE_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeMusePermissionModeId(value: HarnessPermissionModeId): MuseApprovalMode {
  const parsed = harnessPermissionModeIdSchema.parse(value);
  if (
    parsed !== "onRequest" &&
    parsed !== "promptUnmatched" &&
    parsed !== "denyUnmatched" &&
    parsed !== "allowAll"
  ) {
    throw new Error("Muse Permission Mode belongs to another Adapter");
  }
  return parsed as MuseApprovalMode;
}

export function musePermissionModeForExecutionPolicy(
  policy: "default" | "unattended-full-access" | undefined,
  requested?: HarnessPermissionModeId,
): MuseApprovalMode {
  if (policy === "unattended-full-access") return "allowAll";
  return decodeMusePermissionModeId(requested ?? MUSE_DEFAULT_PERMISSION_MODE_ID);
}
