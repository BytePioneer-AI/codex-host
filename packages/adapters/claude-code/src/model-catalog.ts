import { Buffer } from "node:buffer";

import {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessResolvedModelLabelSchema,
  type HarnessModel,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import {
  CLAUDE_DEFAULT_THINKING_OPTION_ID,
  CLAUDE_THINKING_OPTION_IDS,
  CLAUDE_THINKING_OPTIONS,
} from "./thinking-options.js";

const CLAUDE_MODEL_REF_PREFIX = "claude-model-v1.";
const CLAUDE_MODEL_VALUE_MAX_LENGTH = 512;

const modelInfoSchema = z.object({
  value: z.string().trim().min(1).max(CLAUDE_MODEL_VALUE_MAX_LENGTH),
  displayName: z.string().trim().min(1).max(HARNESS_MODEL_LABEL_MAX_LENGTH),
  resolvedModel: harnessResolvedModelLabelSchema.optional(),
  // Capability rows are advisory: an unreadable shape from a future runtime is
  // dropped rather than failing the whole catalog.
  supportsEffort: z.boolean().optional().catch(undefined),
  supportedEffortLevels: z.array(z.string()).optional().catch(undefined),
  supportsAdaptiveThinking: z.boolean().optional().catch(undefined),
});

export interface ClaudeModelInspectionSnapshot {
  models: unknown;
  canSelectModel: boolean;
  canSelectPermissionMode: boolean;
}

export interface NormalizedClaudeModelCatalog {
  catalog: HarnessModelCatalog;
  defaultModel: HarnessModelRef;
}

export const CLAUDE_DEFAULT_MODEL_REF = encodeClaudeModelRef("default");

export function encodeClaudeModelRef(value: string): HarnessModelRef {
  const parsed = z.string().trim().min(1).max(CLAUDE_MODEL_VALUE_MAX_LENGTH).parse(value);
  const id = `${CLAUDE_MODEL_REF_PREFIX}${Buffer.from(parsed, "utf8").toString("base64url")}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("Claude Code Model value is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeClaudeModelRef(ref: HarnessModelRef): string | undefined {
  const parsed = harnessModelRefSchema.parse(ref);
  if (!parsed.id.startsWith(CLAUDE_MODEL_REF_PREFIX)) {
    throw new Error("Claude Code Model Ref belongs to another Adapter");
  }
  const encoded = parsed.id.slice(CLAUDE_MODEL_REF_PREFIX.length);
  if (encoded.length === 0) throw new Error("Claude Code Model Ref is empty");
  let value: string;
  try {
    value = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("Claude Code Model Ref is malformed");
  }
  if (encodeClaudeModelRef(value).id !== parsed.id) {
    throw new Error("Claude Code Model Ref is not canonical");
  }
  return value === "default" ? undefined : value;
}

function uniqueDisplayLabels(rows: Array<z.infer<typeof modelInfoSchema>>): Map<string, string> {
  const groups = new Map<string, Array<z.infer<typeof modelInfoSchema>>>();
  for (const row of rows) {
    const group = groups.get(row.displayName) ?? [];
    group.push(row);
    groups.set(row.displayName, group);
  }
  const labels = new Map<string, string>();
  for (const [displayName, group] of groups) {
    const sorted = [...group].sort((left, right) => left.value.localeCompare(right.value));
    for (const [index, row] of sorted.entries()) {
      if (sorted.length === 1) {
        labels.set(row.value, displayName);
        continue;
      }
      const nativeSuffix = ` (${row.value})`;
      const suffix =
        displayName.length + nativeSuffix.length <= HARNESS_MODEL_LABEL_MAX_LENGTH
          ? nativeSuffix
          : ` (alias ${index + 1})`;
      labels.set(
        row.value,
        `${displayName.slice(0, HARNESS_MODEL_LABEL_MAX_LENGTH - suffix.length)}${suffix}`,
      );
    }
  }
  return labels;
}

function normalizeRows(value: unknown): {
  rows: Array<z.infer<typeof modelInfoSchema>>;
  syntheticDefault: boolean;
} {
  if (!Array.isArray(value)) throw new Error("Claude Code Model catalog is not an array");
  const byValue = new Map<string, z.infer<typeof modelInfoSchema>>();
  for (const nativeRow of value) {
    const row = modelInfoSchema.parse(nativeRow);
    const existing = byValue.get(row.value);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
      throw new Error("Claude Code Model catalog contains conflicting selectable values");
    }
    if (!existing) byValue.set(row.value, row);
  }
  if (byValue.size === 0) throw new Error("Claude Code Model catalog is empty");
  const syntheticDefault = !byValue.has("default");
  if (syntheticDefault) {
    byValue.set("default", { value: "default", displayName: "Default" });
  }
  return { rows: [...byValue.values()], syntheticDefault };
}

/**
 * Thinking options a single Model can actually honour. `off` and `auto` always
 * apply — every Model can run without extended Thinking, and `auto` just leaves
 * the depth to Claude Code. Explicit effort levels only apply to Models that
 * report effort support: Claude Code silently downgrades an unsupported level,
 * so offering one would misreport how hard the Model is about to think.
 *
 * Installations that report no capabilities at all (older Claude Code builds)
 * keep the full list rather than losing levels that do work there.
 */
function thinkingOptionIdsForModel(
  row: z.infer<typeof modelInfoSchema>,
  capabilitiesReported: boolean,
): HarnessThinkingOptionId[] {
  if (!capabilitiesReported) return [...CLAUDE_THINKING_OPTION_IDS];
  const levels = new Set(row.supportsEffort === false ? [] : (row.supportedEffortLevels ?? []));
  return CLAUDE_THINKING_OPTION_IDS.filter(
    (id) => id === "off" || id === CLAUDE_DEFAULT_THINKING_OPTION_ID || levels.has(id),
  );
}

export function normalizeClaudeModelCatalog(
  snapshot: ClaudeModelInspectionSnapshot,
): NormalizedClaudeModelCatalog {
  if (!snapshot.canSelectModel) throw new Error("Claude Code Model selection is unavailable");
  const { rows, syntheticDefault } = normalizeRows(snapshot.models);
  const labels = uniqueDisplayLabels(rows);
  const capabilitiesReported = rows.some(
    (row) =>
      row.supportsEffort !== undefined ||
      row.supportedEffortLevels !== undefined ||
      row.supportsAdaptiveThinking !== undefined,
  );
  const models: HarnessModel[] = rows.map((row) => {
    // A `default` row this Adapter synthesized carries no capabilities of its
    // own, so it keeps the full list instead of being read as "supports nothing".
    const rowCapabilitiesReported =
      capabilitiesReported && !(syntheticDefault && row.value === "default");
    return {
      ref: encodeClaudeModelRef(row.value),
      label: labels.get(row.value) ?? row.displayName,
      ...(row.resolvedModel ? { resolvedModelLabel: row.resolvedModel } : {}),
      supportedThinkingOptionIds: thinkingOptionIdsForModel(row, rowCapabilitiesReported),
    };
  });
  models.sort((left, right) => {
    if (left.ref.id === CLAUDE_DEFAULT_MODEL_REF.id) return -1;
    if (right.ref.id === CLAUDE_DEFAULT_MODEL_REF.id) return 1;
    return left.label.localeCompare(right.label) || left.ref.id.localeCompare(right.ref.id);
  });
  const catalog = harnessModelCatalogSchema.parse({
    models,
    defaultModel: CLAUDE_DEFAULT_MODEL_REF,
    thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
    defaultThinkingOptionId: CLAUDE_DEFAULT_THINKING_OPTION_ID,
  });
  return { catalog, defaultModel: CLAUDE_DEFAULT_MODEL_REF };
}

/**
 * Thinking options a Session may offer while the given Model is selected. Falls
 * back to the full list for a Model the catalog doesn't cover, which keeps a
 * Session opened before the first inspection behaving as it did before.
 */
export function claudeThinkingOptionsForModel(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef | undefined,
): HarnessThinkingOption[] {
  const supported = model
    ? catalog.models.find(({ ref }) => ref.id === model.id)?.supportedThinkingOptionIds
    : undefined;
  if (!supported) return [...CLAUDE_THINKING_OPTIONS];
  return CLAUDE_THINKING_OPTIONS.filter(({ id }) => supported.includes(id));
}
