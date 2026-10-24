import {
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export const CLAUDE_PERMISSION_MODE_PREFERENCE_KEY = "codexhost.claude-code.permission-mode.v1";

export function claudePermissionModeStorageKey(harnessId = "claude-code"): string {
  return harnessId === "claude-code"
    ? CLAUDE_PERMISSION_MODE_PREFERENCE_KEY
    : `codexhost.${harnessId}.permission-mode.v1`;
}

export interface PermissionModePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function rendererStorage(): PermissionModePreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readClaudePermissionModePreference(
  catalog: HarnessPermissionModeCatalog,
  storage: PermissionModePreferenceStorage | null = rendererStorage(),
  harnessId = "claude-code",
): HarnessPermissionModeId | undefined {
  if (!storage) return undefined;
  try {
    const key = claudePermissionModeStorageKey(harnessId);
    const parsed = harnessPermissionModeIdSchema.safeParse(storage.getItem(key));
    return parsed.success && catalog.modes.some(({ id }) => id === parsed.data)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeClaudePermissionModePreference(
  permissionModeId: HarnessPermissionModeId,
  storage: PermissionModePreferenceStorage | null = rendererStorage(),
  harnessId = "claude-code",
): void {
  if (!storage) return;
  try {
    storage.setItem(claudePermissionModeStorageKey(harnessId), permissionModeId);
  } catch {
    // Preference persistence must not prevent native mode selection.
  }
}
