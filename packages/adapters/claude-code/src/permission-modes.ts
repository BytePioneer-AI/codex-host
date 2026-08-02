import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import { z } from "zod";

export type ClaudePermissionMode = Exclude<PermissionMode, "dontAsk">;

const nativePermissionModes = new Set<ClaudePermissionMode>([
  "plan",
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
]);

export const CLAUDE_DEFAULT_PERMISSION_MODE_ID = harnessPermissionModeIdSchema.parse("default");

const claudePermissionModes = [
  {
    id: "plan",
    label: "Plan mode",
    description: "Analyze and plan without executing tools.",
  },
  {
    id: "default",
    label: "Default",
    description: "Ask before edits and other protected actions.",
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    description: "Allow file edits and ask for other protected actions.",
  },
  {
    id: "auto",
    label: "Auto mode",
    description: "Let Claude classify permission requests.",
  },
  {
    id: "bypassPermissions",
    label: "Bypass permissions",
    description: "Skip Claude Code permission checks.",
    dangerous: true,
  },
] as const;

function createPermissionModeCatalog(includeAuto: boolean): HarnessPermissionModeCatalog {
  return harnessPermissionModeCatalogSchema.parse({
    modes: includeAuto
      ? claudePermissionModes
      : claudePermissionModes.filter(({ id }) => id !== "auto"),
    defaultModeId: CLAUDE_DEFAULT_PERMISSION_MODE_ID,
  });
}

export const CLAUDE_PERMISSION_MODE_CATALOG = createPermissionModeCatalog(true);
const CLAUDE_PERMISSION_MODE_CATALOG_WITHOUT_AUTO = createPermissionModeCatalog(false);
const autoModeModelInfoSchema = z.object({ supportsAutoMode: z.literal(true) });

export function claudePermissionModeCatalogForModels(
  models: unknown,
): HarnessPermissionModeCatalog {
  const supportsAutoMode =
    Array.isArray(models) &&
    models.some((model) => autoModeModelInfoSchema.safeParse(model).success);
  return supportsAutoMode
    ? CLAUDE_PERMISSION_MODE_CATALOG
    : CLAUDE_PERMISSION_MODE_CATALOG_WITHOUT_AUTO;
}

export function decodeClaudePermissionModeId(
  permissionModeId: HarnessPermissionModeId,
): ClaudePermissionMode {
  const parsed = harnessPermissionModeIdSchema.parse(permissionModeId);
  if (!nativePermissionModes.has(parsed as ClaudePermissionMode)) {
    throw new Error("Claude Code Permission Mode belongs to another Adapter");
  }
  return parsed as ClaudePermissionMode;
}

export function encodeClaudePermissionModeId(
  permissionMode: ClaudePermissionMode,
): HarnessPermissionModeId {
  if (!nativePermissionModes.has(permissionMode)) {
    throw new Error("Claude Code returned an unsupported Permission Mode");
  }
  return harnessPermissionModeIdSchema.parse(permissionMode);
}

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === "string" && nativePermissionModes.has(value as ClaudePermissionMode);
}
