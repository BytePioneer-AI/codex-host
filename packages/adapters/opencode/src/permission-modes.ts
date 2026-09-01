import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";

export type OpenCodePermissionMode = "default" | "ask" | "allow";

const nativePermissionModes = new Set<OpenCodePermissionMode>(["default", "ask", "allow"]);

export const OPENCODE_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("default");

export const OPENCODE_PERMISSION_MODE_CATALOG: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: "default",
        label: "Default",
        description: "Use OpenCode's configured permission rules.",
      },
      {
        id: "ask",
        label: "Ask",
        description: "Ask before protected OpenCode actions.",
      },
      {
        id: "allow",
        label: "Allow all",
        description: "Allow OpenCode actions without approval prompts.",
        dangerous: true,
      },
    ],
    defaultModeId: OPENCODE_DEFAULT_PERMISSION_MODE_ID,
  });

export function decodeOpenCodePermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): OpenCodePermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!nativePermissionModes.has(parsed as OpenCodePermissionMode)) {
    throw new Error("OpenCode Permission Mode belongs to another Adapter");
  }
  return parsed as OpenCodePermissionMode;
}

export function openCodePermissionRules(
  permissionMode: Exclude<OpenCodePermissionMode, "default">,
): PermissionRuleset {
  return [{ permission: "*", pattern: "*", action: permissionMode }];
}

export function permissionModeFromSession(
  permission: PermissionRuleset | undefined,
): OpenCodePermissionMode {
  for (let index = (permission?.length ?? 0) - 1; index >= 0; index -= 1) {
    const rule = permission?.[index];
    if (rule?.permission !== "*" || rule.pattern !== "*") continue;
    if (rule.action === "ask" || rule.action === "allow") return rule.action;
  }
  return "default";
}

export function requestedPermissionRules(
  current: PermissionRuleset | undefined,
  permissionMode: OpenCodePermissionMode,
): PermissionRuleset {
  const withoutCodexhostMode = (current ?? []).filter(
    (rule) => rule.permission !== "*" || rule.pattern !== "*" || !isCodexhostModeRule(rule.action),
  );
  if (permissionMode === "default") return withoutCodexhostMode;
  return [...withoutCodexhostMode, ...openCodePermissionRules(permissionMode)];
}

function isCodexhostModeRule(action: string): boolean {
  return action === "ask" || action === "allow";
}
