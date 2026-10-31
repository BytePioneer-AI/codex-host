export interface PermissionMode {
  id: string;
  label: string;
  description: string;
  dangerous?: boolean;
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export const PERMISSION_MODES: readonly PermissionMode[] = [
  {
    id: "read-only",
    label: "Read only",
    description: "Codex can read files; edits and commands need approval.",
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  {
    id: "workspace-write",
    label: "Auto",
    description: "Codex works in the workspace and asks before leaving it.",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  {
    id: "danger-full-access",
    label: "Full access",
    description: "No sandbox and no approvals.",
    dangerous: true,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
];

export const DEFAULT_PERMISSION_MODE = "workspace-write";

/** Only an explicit selection becomes an override; native defaults are observed separately. */
export function permissionMode(id: string | undefined): PermissionMode | undefined {
  return PERMISSION_MODES.find((mode) => mode.id === id);
}

/** Native sandbox policy names only; network and writable roots stay in user config. */
export function sandboxPolicy(mode: PermissionMode): Record<string, unknown> {
  switch (mode.sandbox) {
    case "read-only":
      return { type: "readOnly" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return { type: "workspaceWrite" };
  }
}

/** Both native policy axes must match; custom or missing settings have no standard mode ID. */
export function confirmedPermissionMode(
  approvalPolicy: unknown,
  sandbox: unknown,
): PermissionMode | undefined {
  if (typeof sandbox !== "object" || sandbox === null || !("type" in sandbox)) return undefined;
  return PERMISSION_MODES.find(
    (mode) => mode.approvalPolicy === approvalPolicy && sandboxPolicy(mode).type === sandbox.type,
  );
}
