import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessResolvedModelLabelSchema,
  type HarnessModel,
  type HarnessModelCatalog,
  type HarnessModelRef,
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
  description: z.string().trim().min(1).max(HARNESS_MODEL_LABEL_MAX_LENGTH).optional(),
  resolvedModel: harnessResolvedModelLabelSchema.optional(),
});

const modelPickerOptionSchema = z.object({
  model: z.string().trim().min(1).max(CLAUDE_MODEL_VALUE_MAX_LENGTH),
  label: z.string().trim().min(1).max(HARNESS_MODEL_LABEL_MAX_LENGTH).optional(),
  description: z.string().trim().min(1).max(HARNESS_MODEL_LABEL_MAX_LENGTH).optional(),
  behavesAs: z.string().trim().min(1).max(HARNESS_MODEL_LABEL_MAX_LENGTH).optional(),
});

const modelPickerSettingsSchema = z.object({
  options: z.array(z.unknown()).optional(),
  replaceBuiltInOptions: z.boolean().optional(),
});

export interface ClaudeModelPickerOption {
  model: string;
  label?: string;
  description?: string;
  behavesAs?: string;
}

export interface ClaudeModelPickerSettings {
  options: ClaudeModelPickerOption[];
  replaceBuiltInOptions: boolean;
}

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

export function resolveClaudeConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(environment.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
}

function parseModelPickerOptions(value: unknown): ClaudeModelPickerOption[] {
  if (!Array.isArray(value)) return [];
  const options: ClaudeModelPickerOption[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const parsed = modelPickerOptionSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (seen.has(parsed.data.model)) continue;
    seen.add(parsed.data.model);
    options.push({
      model: parsed.data.model,
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.behavesAs ? { behavesAs: parsed.data.behavesAs } : {}),
    });
  }
  return options;
}

/** Parse a Claude Code user-settings `modelPicker` object. Invalid shapes yield undefined. */
export function parseClaudeModelPickerSettings(
  value: unknown,
): ClaudeModelPickerSettings | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = modelPickerSettingsSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (parsed.data.options === undefined && parsed.data.replaceBuiltInOptions === undefined) {
    return undefined;
  }
  const options = parseModelPickerOptions(parsed.data.options);
  // Non-empty options that yield zero valid entries are malformed — do not return a
  // settings object that could wipe SDK models when replaceBuiltInOptions is true.
  if (
    Array.isArray(parsed.data.options) &&
    parsed.data.options.length > 0 &&
    options.length === 0
  ) {
    return undefined;
  }
  return {
    options,
    replaceBuiltInOptions: parsed.data.replaceBuiltInOptions === true,
  };
}

/**
 * Read user-level `~/.claude/settings.json` (honoring `CLAUDE_CONFIG_DIR`) and return
 * `modelPicker` when present. Missing or malformed files are ignored.
 */
export async function readClaudeUserModelPicker(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeModelPickerSettings | undefined> {
  const settingsPath = path.join(resolveClaudeConfigDirectory(environment), "settings.json");
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    return undefined;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return undefined;
  }
  return parseClaudeModelPickerSettings((document as Record<string, unknown>).modelPicker);
}

function optionToModelInfo(option: ClaudeModelPickerOption): Record<string, unknown> {
  return {
    value: option.model,
    displayName: option.label ?? option.model,
    ...(option.description ? { description: option.description } : {}),
    ...(option.behavesAs ? { resolvedModel: option.behavesAs } : {}),
  };
}

function readModelValue(row: unknown): string | undefined {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  const value = (row as Record<string, unknown>).value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function mergeOptionOntoSdkRow(
  sdkRow: unknown,
  option: ClaudeModelPickerOption,
): Record<string, unknown> {
  const base =
    sdkRow !== null && typeof sdkRow === "object" && !Array.isArray(sdkRow)
      ? { ...(sdkRow as Record<string, unknown>) }
      : {};
  const overlay = optionToModelInfo(option);
  return { ...base, ...overlay };
}

/**
 * Merge Claude Code user `modelPicker.options` into the SDK initialization Model list so
 * CodexHost's catalog matches `/model` picker rows (including third-party gateway IDs).
 */
export function mergeClaudeModelPickerOptions(
  sdkModels: unknown,
  modelPicker: ClaudeModelPickerSettings | undefined,
): unknown {
  if (!modelPicker) return sdkModels;
  const sdkRows = Array.isArray(sdkModels) ? [...sdkModels] : [];
  const sdkByValue = new Map<string, unknown>();
  for (const row of sdkRows) {
    const value = readModelValue(row);
    if (value && !sdkByValue.has(value)) sdkByValue.set(value, row);
  }

  if (modelPicker.replaceBuiltInOptions) {
    const defaultSdk = sdkByValue.get("default");
    const merged: unknown[] = [
      defaultSdk !== undefined ? defaultSdk : { value: "default", displayName: "Default" },
    ];
    const included = new Set<string>(["default"]);
    for (const option of modelPicker.options) {
      if (included.has(option.model)) {
        if (option.model === "default") {
          merged[0] = mergeOptionOntoSdkRow(merged[0], option);
        }
        continue;
      }
      merged.push(mergeOptionOntoSdkRow(sdkByValue.get(option.model), option));
      included.add(option.model);
    }
    return merged;
  }

  const merged = [...sdkRows];
  const included = new Set(
    sdkRows.flatMap((row) => {
      const value = readModelValue(row);
      return value ? [value] : [];
    }),
  );
  for (const option of modelPicker.options) {
    if (included.has(option.model)) continue;
    merged.push(mergeOptionOntoSdkRow(undefined, option));
    included.add(option.model);
  }
  return merged;
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

function normalizeRows(value: unknown): Array<z.infer<typeof modelInfoSchema>> {
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
  if (!byValue.has("default")) {
    byValue.set("default", { value: "default", displayName: "Default" });
  }
  return [...byValue.values()];
}

export function normalizeClaudeModelCatalog(
  snapshot: ClaudeModelInspectionSnapshot,
): NormalizedClaudeModelCatalog {
  if (!snapshot.canSelectModel) throw new Error("Claude Code Model selection is unavailable");
  const rows = normalizeRows(snapshot.models);
  const labels = uniqueDisplayLabels(rows);
  const models: HarnessModel[] = rows.map((row) => {
    return {
      ref: encodeClaudeModelRef(row.value),
      label: labels.get(row.value) ?? row.displayName,
      ...(row.resolvedModel ? { resolvedModelLabel: row.resolvedModel } : {}),
      supportedThinkingOptionIds: [...CLAUDE_THINKING_OPTION_IDS],
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
