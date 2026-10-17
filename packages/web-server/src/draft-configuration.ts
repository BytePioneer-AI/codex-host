export type { DraftConfiguration } from "@codexhost/session-runtime";

export function draftPermissionMode(
  inspection: {
    status: string;
    permissionModes?:
      { modes: readonly { id: string }[]; defaultModeId?: string | undefined } | undefined;
  },
  preferred?: string,
): string | undefined {
  if (inspection.status !== "ready") return undefined;
  const catalog = inspection.permissionModes;
  return preferred && catalog?.modes.some((mode) => mode.id === preferred)
    ? preferred
    : catalog?.defaultModeId;
}
