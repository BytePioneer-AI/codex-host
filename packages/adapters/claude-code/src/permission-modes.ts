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
    localizations: {
      "zh-CN": {
        label: "规划模式",
        description: "探索并制定计划；批准计划后退出规划，恢复此前的权限模式。",
      },
    },
    description:
      "Explore and prepare a plan; approval exits planning and resumes the previous permission mode.",
  },
  {
    id: "default",
    label: "Default",
    localizations: { "zh-CN": { label: "默认", description: "编辑和其他受保护操作前询问。" } },
    description: "Ask before edits and other protected actions.",
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    localizations: {
      "zh-CN": { label: "接受编辑", description: "允许文件编辑；其他受保护操作前询问。" },
    },
    description: "Allow file edits and ask for other protected actions.",
  },
  {
    id: "auto",
    label: "Auto mode",
    localizations: { "zh-CN": { label: "自动模式", description: "由 Claude 判断权限请求。" } },
    description: "Let Claude classify permission requests.",
  },
  {
    id: "bypassPermissions",
    label: "Bypass permissions",
    localizations: { "zh-CN": { label: "绕过权限", description: "跳过 Claude Code 权限检查。" } },
    description: "Skip Claude Code permission checks.",
    dangerous: true,
  },
] as const;

function createPermissionModeCatalog(
  includeAuto: boolean,
  includeBypassPermissions: boolean,
): HarnessPermissionModeCatalog {
  return harnessPermissionModeCatalogSchema.parse({
    modes: claudePermissionModes.filter(
      ({ id }) =>
        (includeAuto || id !== "auto") && (includeBypassPermissions || id !== "bypassPermissions"),
    ),
    defaultModeId: CLAUDE_DEFAULT_PERMISSION_MODE_ID,
  });
}

export const CLAUDE_PERMISSION_MODE_CATALOG = createPermissionModeCatalog(true, true);
const CLAUDE_PERMISSION_MODE_CATALOGS = {
  auto: CLAUDE_PERMISSION_MODE_CATALOG,
  autoWithoutBypass: createPermissionModeCatalog(true, false),
  withoutAuto: createPermissionModeCatalog(false, true),
  withoutAutoOrBypass: createPermissionModeCatalog(false, false),
} as const;
const autoModeModelInfoSchema = z.object({ supportsAutoMode: z.literal(true) });

export function claudePermissionModeCatalogForModels(
  models: unknown,
  bypassPermissionsAvailable = true,
): HarnessPermissionModeCatalog {
  const supportsAutoMode =
    Array.isArray(models) &&
    models.some((model) => autoModeModelInfoSchema.safeParse(model).success);
  if (supportsAutoMode) {
    return bypassPermissionsAvailable
      ? CLAUDE_PERMISSION_MODE_CATALOGS.auto
      : CLAUDE_PERMISSION_MODE_CATALOGS.autoWithoutBypass;
  }
  return bypassPermissionsAvailable
    ? CLAUDE_PERMISSION_MODE_CATALOGS.withoutAuto
    : CLAUDE_PERMISSION_MODE_CATALOGS.withoutAutoOrBypass;
}

/**
 * Claude Code refuses `bypassPermissions` for root unless the process declares a deliberate
 * sandbox. Mirror its native rule so root plus `IS_SANDBOX=1` keeps live bypass selection while
 * plain root never receives the dangerous flag, which would make the native CLI exit at startup.
 */
export function claudeBypassPermissionsAvailable(
  environment: NodeJS.ProcessEnv,
  platform: { getuid?: () => number } = process,
): boolean {
  const uid = platform.getuid?.();
  if (uid === undefined || uid !== 0) return true;
  return environment.IS_SANDBOX === "1" || isNativeTruthyFlag(environment.CLAUDE_CODE_BUBBLEWRAP);
}

function isNativeTruthyFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export const CLAUDE_BYPASS_PERMISSIONS_UNAVAILABLE_MESSAGE =
  "Bypass permissions is unavailable because Claude Code runs as root without a declared sandbox; set IS_SANDBOX=1 for the codexhost Host and restart it";

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
