/** One in-memory draft selection; never a persisted Thread configuration. */
export interface DraftConfiguration {
  selection: { provider: string; model: string; reasoningEffort?: string };
  permissionModeId?: string;
}

export function draftPermissionMode(
  harnessId: string,
  inspection: {
    status: string;
    permissionModes?:
      { modes: readonly { id: string }[]; defaultModeId?: string | undefined } | undefined;
  },
  preferred?: string,
): string | undefined {
  if (inspection.status !== "ready") return undefined;
  const catalog = inspection.permissionModes;
  if (preferred && catalog?.modes.some((mode) => mode.id === preferred)) return preferred;
  return harnessId === "codex" ? undefined : catalog?.defaultModeId;
}
