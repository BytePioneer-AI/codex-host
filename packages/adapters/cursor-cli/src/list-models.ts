import { spawn } from "node:child_process";
import {
  harnessModelCatalogSchema,
  type HarnessModelCatalog,
  type HarnessThinkingOption,
} from "@codexhost/shared-contracts";
import { cursorInvocation } from "./command.js";
import {
  cursorModelRef,
  cursorThinkingId,
  type CursorParameterGroup,
} from "./models.js";

const EFFORT_SUFFIXES = [
  "extra-high",
  "xhigh",
  "minimal",
  "medium",
  "none",
  "low",
  "high",
  "max",
] as const;
const EFFORT_LABELS: Record<(typeof EFFORT_SUFFIXES)[number] | "default", string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  "extra-high": "Extra High",
  max: "Max",
  default: "Default",
};

export interface CursorListModelsOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}

export interface CursorListModelRow {
  id: string;
  label: string;
  base: string;
  fast: boolean;
  thinking: boolean;
  effort?: string;
  isDefault: boolean;
}

export interface CursorListModelsCatalog {
  catalog: HarnessModelCatalog;
  variants: Map<string, string>;
}

export function cursorListModelsVariantKey(base: string, thinkingOptionId?: string): string {
  return `${base}\0${thinkingOptionId ?? ""}`;
}

export function parseCursorListModelId(id: string): {
  base: string;
  fast: boolean;
  thinking: boolean;
  effort?: string;
} {
  let rest = id;
  let fast = false;
  let thinking = false;
  let effort: string | undefined;
  for (;;) {
    if (rest.endsWith("-fast")) {
      rest = rest.slice(0, -"-fast".length);
      fast = true;
      continue;
    }
    if (rest.endsWith("-thinking")) {
      rest = rest.slice(0, -"-thinking".length);
      thinking = true;
      continue;
    }
    const matched = EFFORT_SUFFIXES.find((suffix) => rest.endsWith(`-${suffix}`));
    if (matched) {
      rest = rest.slice(0, -(matched.length + 1));
      effort = matched;
      continue;
    }
    break;
  }
  return { base: rest || id, fast, thinking, ...(effort ? { effort } : {}) };
}

export function parseCursorListModels(text: string): CursorListModelsCatalog {
  const rows = [...text.matchAll(/^(\S+) - (.+)$/gmu)].map((matched) => {
    const id = matched[1] ?? "";
    const label = matched[2] ?? "";
    return {
      id,
      label,
      ...parseCursorListModelId(id),
      isDefault: /\(default\)/iu.test(label),
    } satisfies CursorListModelRow;
  });
  if (!rows.length) throw new Error("Cursor returned no model catalog");
  const byBase = new Map<string, CursorListModelRow[]>();
  for (const row of rows) {
    const group = byBase.get(row.base) ?? [];
    group.push(row);
    byBase.set(row.base, group);
  }
  const thinkingOptions = new Map<string, HarnessThinkingOption>();
  const variants = new Map<string, string>();
  const models = [...byBase.entries()].map(([base, group]) => {
    const groups = groupsForRows(group);
    const canonical = canonicalRow(group);
    for (const row of group) {
      const thinkingOptionId = groups.length ? thinkingIdForRow(groups, row) : undefined;
      variants.set(cursorListModelsVariantKey(base, thinkingOptionId), row.id);
    }
    const supported = group.flatMap((row) => {
      if (!groups.length) return [];
      const option = {
        id: thinkingIdForRow(groups, row),
        label: thinkingLabelForRow(groups, row),
      } satisfies HarnessThinkingOption;
      thinkingOptions.set(option.id, option);
      return [option.id];
    });
    return {
      ref: cursorModelRef(base),
      label: baseLabel(canonical),
      ...(supported.length ? { supportedThinkingOptionIds: supported } : {}),
    };
  });
  const defaultRow = rows.find((row) => row.isDefault) ?? rows[0];
  if (!defaultRow) throw new Error("Cursor returned no model catalog");
  const defaultThinkingOptionId = defaultRow
    ? variantsKeyThinking(variants, defaultRow)
    : undefined;
  return {
    catalog: harnessModelCatalogSchema.parse({
      models,
      defaultModel: cursorModelRef(defaultRow.base),
      thinkingOptions: [...thinkingOptions.values()],
      ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
    }),
    variants,
  };
}

export async function readCursorListModels(options: CursorListModelsOptions): Promise<string> {
  const invocation = cursorInvocation(options.environment, options.command, ["--list-models"]);
  const timeoutMs = options.timeoutMs ?? 30_000;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: options.environment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error("Cursor --list-models timed out"));
    }, timeoutMs);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) fail(new Error("Cursor --list-models output is too large"));
    });
    child.stderr.resume();
    child.on("error", () =>
      fail(
        new Error(
          "Cursor CLI is not installed; install cursor-agent or set CODEXHOST_CURSOR_COMMAND",
        ),
      ),
    );
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("Cursor --list-models failed"));
        return;
      }
      resolve(stdout);
    });
  });
}

function groupsForRows(rows: CursorListModelRow[]): CursorParameterGroup[] {
  const groups: CursorParameterGroup[] = [];
  const canonical = canonicalRow(rows);
  const fast = new Set(rows.map((row) => row.fast));
  if (fast.size > 1) {
    groups.push({
      id: "fast",
      label: "Fast",
      currentValue: canonical.fast ? "true" : "false",
      options: [
        { id: "false", label: "Off" },
        { id: "true", label: "Fast" },
      ],
    });
  }
  const thinking = new Set(rows.map((row) => row.thinking));
  if (thinking.size > 1) {
    groups.push({
      id: "thinking",
      label: "Thinking",
      currentValue: canonical.thinking ? "true" : "false",
      options: [
        { id: "false", label: "Off" },
        { id: "true", label: "Thinking" },
      ],
    });
  }
  const effort = new Set(rows.map((row) => row.effort ?? "default"));
  if (effort.size > 1) {
    groups.push({
      id: "effort",
      label: "Effort",
      currentValue: canonical.effort ?? "default",
      options: [...effort].map((id) => ({
        id,
        label: EFFORT_LABELS[id as keyof typeof EFFORT_LABELS] ?? id,
      })),
    });
  }
  return groups;
}

function canonicalRow(rows: CursorListModelRow[]): CursorListModelRow {
  return (
    rows.find((row) => row.isDefault) ??
    rows.find((row) => !row.fast && !row.thinking && !row.effort) ??
    rows.find((row) => !row.fast && !row.thinking) ??
    rows.find((row) => !row.fast) ??
    rows[0] ??
    (() => {
      throw new Error("Cursor returned no model catalog");
    })()
  );
}

function thinkingIdForRow(
  groups: CursorParameterGroup[],
  row: CursorListModelRow,
): ReturnType<typeof cursorThinkingId> {
  return cursorThinkingId(groups, {
    ...(groups.some((group) => group.id === "fast")
      ? { fast: row.fast ? "true" : "false" }
      : {}),
    ...(groups.some((group) => group.id === "thinking")
      ? { thinking: row.thinking ? "true" : "false" }
      : {}),
    ...(groups.some((group) => group.id === "effort")
      ? { effort: row.effort ?? "default" }
      : {}),
  });
}

function thinkingLabelForRow(groups: CursorParameterGroup[], row: CursorListModelRow): string {
  const parts: string[] = [];
  if (groups.some((group) => group.id === "effort")) {
    parts.push(EFFORT_LABELS[(row.effort ?? "default") as keyof typeof EFFORT_LABELS]);
  }
  if (groups.some((group) => group.id === "thinking") && row.thinking) parts.push("Thinking");
  if (groups.some((group) => group.id === "fast") && row.fast) parts.push("Fast");
  return parts.join(" · ") || (row.fast ? "Fast" : "Off");
}

function baseLabel(row: CursorListModelRow): string {
  let name = row.label.replace(/\s*\(default\)\s*$/iu, "").replace(/\s*\(NO ZDR\)\s*$/iu, "");
  if (row.fast) name = name.replace(/\s+Fast$/iu, "");
  if (row.thinking) name = name.replace(/\s+Thinking$/iu, "");
  if (row.effort) {
    const label = EFFORT_LABELS[row.effort as keyof typeof EFFORT_LABELS];
    if (label) name = name.replace(new RegExp(`\\s+${label}$`, "u"), "");
  }
  return name.replace(/\s+1M$/iu, "").trim() || row.label;
}

function variantsKeyThinking(
  variants: Map<string, string>,
  row: CursorListModelRow,
): string | undefined {
  for (const [key, nativeId] of variants) {
    if (nativeId === row.id && key.startsWith(`${row.base}\0`) && key !== `${row.base}\0`) {
      return key.slice(row.base.length + 1);
    }
  }
  return undefined;
}