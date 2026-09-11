import {
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

// Mirrors the `--permission-mode` choices accepted by the CodeBuddy CLI.
// `default` keeps the CLI's own default permission behavior; interactive
// approval prompts are not available over the stream-json print transport, so
// restrictive modes fall back to the CLI's native non-interactive denial.
export const CODEBUDDY_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog = {
  modes: [
    {
      id: harnessPermissionModeIdSchema.parse("default"),
      label: "Default",
      description: "Use the CodeBuddy CLI's default permission behavior",
    },
    {
      id: harnessPermissionModeIdSchema.parse("acceptEdits"),
      label: "Accept Edits",
      description: "Automatically accept file edits",
    },
    {
      id: harnessPermissionModeIdSchema.parse("plan"),
      label: "Plan",
      description: "Plan mode; no mutating tool execution",
    },
    {
      id: harnessPermissionModeIdSchema.parse("dontAsk"),
      label: "Don't Ask",
      description: "Never prompt; unsupported tools are denied",
    },
    {
      id: harnessPermissionModeIdSchema.parse("auto"),
      label: "Auto",
      description: "Automatic permission decisions",
    },
    {
      id: harnessPermissionModeIdSchema.parse("bypassPermissions"),
      label: "Bypass Permissions",
      description: "Skip all permission prompts",
      dangerous: true,
    },
  ],
  defaultModeId: harnessPermissionModeIdSchema.parse("default"),
};

export const CODEBUDDY_DEFAULT_PERMISSION_MODE_ID: HarnessPermissionModeId =
  CODEBUDDY_PERMISSION_MODE_CATALOG.defaultModeId;

const knownModeIds = new Set<string>(CODEBUDDY_PERMISSION_MODE_CATALOG.modes.map(({ id }) => id));

export function isKnownCodeBuddyPermissionModeId(value: string): value is HarnessPermissionModeId {
  return knownModeIds.has(value);
}
