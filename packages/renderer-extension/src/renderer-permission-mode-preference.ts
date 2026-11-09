import {
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import {
  rendererHarnessPreferences,
  writeRendererHarnessPreferences,
} from "./renderer-harness-preferences.js";
import { installedHarnessPluginIdSchema } from "@codexhost/shared-contracts";

export const CLAUDE_PERMISSION_MODE_PREFERENCE_KEY = "codexhost.claude-code.permission-mode.v1";

export interface PermissionModePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readClaudePermissionModePreference(
  catalog: HarnessPermissionModeCatalog,
  storage?: PermissionModePreferenceStorage | null,
): HarnessPermissionModeId | undefined {
  if (storage === null) return undefined;
  try {
    const parsed = harnessPermissionModeIdSchema.safeParse(
      storage === undefined
        ? rendererHarnessPreferences()?.values.newThread?.byHarness["claude-code"]?.permissionModeId
        : storage.getItem(CLAUDE_PERMISSION_MODE_PREFERENCE_KEY),
    );
    return parsed.success && catalog.modes.some(({ id }) => id === parsed.data)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeClaudePermissionModePreference(
  permissionModeId: HarnessPermissionModeId,
  storage?: PermissionModePreferenceStorage | null,
): void {
  if (storage === null) return;
  try {
    if (storage) storage.setItem(CLAUDE_PERMISSION_MODE_PREFERENCE_KEY, permissionModeId);
    else
      void writeRendererHarnessPreferences(window, "local", [
        {
          kind: "newThread",
          harnessId: installedHarnessPluginIdSchema.parse("claude-code"),
          configuration: {
            ...rendererHarnessPreferences()?.values.newThread?.byHarness["claude-code"],
            permissionModeId,
          },
        },
      ]).catch(() => {});
  } catch {
    // Preference persistence must not prevent native mode selection.
  }
}
