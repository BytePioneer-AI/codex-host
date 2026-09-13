import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessSessionCapabilities,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";
import type { CursorSessionInfo } from "./transport.js";

export const CURSOR_MODES = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "agent",
  modes: [
    { id: "agent", label: "Agent", description: "Native agent mode with Cursor tool approvals" },
    { id: "plan", label: "Plan", description: "Native read-only planning mode" },
    { id: "ask", label: "Ask", description: "Native read-only question mode" },
  ],
});

export function cursorCapabilities(selectThinkingOption: boolean): HarnessSessionCapabilities {
  return {
    configuration: {
      selectModel: true,
      selectThinkingOption,
      selectPermissionMode: true,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    subagents: { observe: true, readTranscript: false },
  };
}

export const CURSOR_CAPABILITIES = cursorCapabilities(false);

const MODEL_REF_PREFIX = "cursor.";
const GROUPED_THINKING_PREFIX = "g.";

function encodeGroupedThinkingOptionId(
  selections: ReadonlyArray<{ groupId: string; optionId: string }>,
): string {
  const sorted = [...selections].sort((left, right) => left.groupId.localeCompare(right.groupId));
  if (sorted.length === 0) {
    throw new Error("Grouped Thinking option requires at least one selection");
  }
  return `${GROUPED_THINKING_PREFIX}${sorted
    .map((selection) => `${selection.groupId}~${selection.optionId}`)
    .join(".")}`;
}

export function decodeGroupedThinkingOptionId(
  id: string,
): Array<{ groupId: string; optionId: string }> | null {
  if (!id.startsWith(GROUPED_THINKING_PREFIX)) return null;
  const body = id.slice(GROUPED_THINKING_PREFIX.length);
  if (!body) return null;
  const selections: Array<{ groupId: string; optionId: string }> = [];
  for (const part of body.split(".")) {
    const separator = part.indexOf("~");
    if (separator <= 0 || separator === part.length - 1) return null;
    selections.push({ groupId: part.slice(0, separator), optionId: part.slice(separator + 1) });
  }
  try {
    if (encodeGroupedThinkingOptionId(selections) !== id) return null;
  } catch {
    return null;
  }
  return selections;
}

export interface CursorNativeModel {
  value: string;
  name: string;
}

export interface CursorConfigOption {
  id: string;
  name?: string;
  type?: string;
  category?: string;
  currentValue?: string;
  options?: unknown[];
}

export interface CursorParameterGroup {
  id: string;
  label: string;
  currentValue: string;
  options: Array<{ id: string; label: string }>;
}

export const cursorModelRef = (nativeId: string) =>
  harnessModelRefSchema.parse({
    id: `${MODEL_REF_PREFIX}${Buffer.from(nativeId).toString("base64url")}`,
  });

export function decodeCursorModelRef(ref: string): string {
  if (!ref.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("Model is not in this Cursor session's native catalog");
  }
  return Buffer.from(ref.slice(MODEL_REF_PREFIX.length), "base64url").toString("utf8");
}

export function parseCursorNativeModelValue(value: string): {
  base: string;
  params: Record<string, string>;
} {
  const matched = /^(.*)\[(.*)\]$/u.exec(value);
  if (!matched) return { base: value, params: {} };
  const params: Record<string, string> = {};
  const body = matched[2] ?? "";
  if (body) {
    for (const part of body.split(",")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      params[part.slice(0, separator)] = part.slice(separator + 1);
    }
  }
  return { base: matched[1] ?? value, params };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenSelectOptions(options: unknown): CursorNativeModel[] {
  const models: CursorNativeModel[] = [];
  for (const entry of Array.isArray(options) ? options : []) {
    if (!isRecord(entry)) continue;
    if (typeof entry.value === "string" && typeof entry.name === "string") {
      models.push({ value: entry.value, name: entry.name });
      continue;
    }
    models.push(...flattenSelectOptions(entry.options));
  }
  return models;
}

export function cursorConfigOptions(
  info: CursorSessionInfo | { configOptions?: unknown },
): CursorConfigOption[] {
  return Array.isArray(info.configOptions)
    ? info.configOptions.filter(
        (option): option is CursorConfigOption => isRecord(option) && typeof option.id === "string",
      )
    : [];
}

export function cursorModels(info: CursorSessionInfo | { configOptions?: unknown }) {
  const option = cursorConfigOptions(info).find((entry) => entry.id === "model");
  if (!option || option.type !== "select")
    throw new Error("Cursor returned no model configuration");
  const models = flattenSelectOptions(option.options);
  if (typeof option.currentValue !== "string")
    throw new Error("Cursor returned no model configuration");
  return { models, current: option.currentValue };
}

function atom(value: string): boolean {
  return /^[A-Za-z0-9_]+$/u.test(value);
}

export function cursorParameterGroups(options: CursorConfigOption[]): CursorParameterGroup[] {
  const groups: CursorParameterGroup[] = [];
  for (const option of options) {
    if (option.id === "model" || option.id === "mode" || option.category === "mode") continue;
    if (option.type !== "select" || typeof option.currentValue !== "string" || !atom(option.id)) {
      continue;
    }
    const values = flattenSelectOptions(option.options).flatMap((entry) =>
      atom(entry.value) ? [{ id: entry.value, label: entry.name }] : [],
    );
    if (!values.length || !values.some((entry) => entry.id === option.currentValue)) continue;
    groups.push({
      id: option.id,
      label: option.name?.trim() || option.id,
      currentValue: option.currentValue,
      options: values,
    });
  }
  return groups;
}

function cartesian<T>(parts: T[][]): T[][] {
  return parts.reduce<T[][]>(
    (acc, part) => acc.flatMap((prefix) => part.map((item) => [...prefix, item])),
    [[]],
  );
}

export function cursorThinkingId(
  groups: CursorParameterGroup[],
  values?: Record<string, string>,
): HarnessThinkingOptionId {
  return harnessThinkingOptionIdSchema.parse(
    encodeGroupedThinkingOptionId(
      groups.map((group) => ({
        groupId: group.id,
        optionId: values?.[group.id] ?? group.currentValue,
      })),
    ),
  );
}

function thinkingLabel(groups: CursorParameterGroup[], values: Record<string, string>): string {
  return groups
    .filter((group) => group.id !== "fast")
    .map(
      (group) =>
        group.options.find((option) => option.id === values[group.id])?.label ?? values[group.id],
    )
    .filter((label) => label && label !== "Off")
    .join(" · ");
}

function combinationValues(
  groups: CursorParameterGroup[],
  combination: Array<{ id: string; label: string }>,
): Record<string, string> {
  return Object.fromEntries(
    groups.map((group, index) => [group.id, combination[index]?.id ?? group.currentValue]),
  );
}

export function cursorThinkingOptions(groups: CursorParameterGroup[]): HarnessThinkingOption[] {
  if (!groups.length) return [];
  return cartesian(groups.map((group) => group.options)).map((combination) => {
    const values = combinationValues(groups, combination);
    const label = thinkingLabel(groups, values);
    const fast = values.fast === "true";
    return {
      id: cursorThinkingId(groups, values),
      label: [label, fast ? "Fast" : ""].filter(Boolean).join(" · ") || (fast ? "Fast" : "Off"),
    } satisfies HarnessThinkingOption;
  });
}

export function cursorResolvedModelLabel(
  modelLabel: string,
  groups: CursorParameterGroup[],
): string {
  const details = thinkingLabel(
    groups,
    Object.fromEntries(groups.map((group) => [group.id, group.currentValue])),
  );
  const fast = groups.some((group) => group.id === "fast" && group.currentValue === "true");
  return [modelLabel, details, fast ? "Fast" : ""].filter(Boolean).join(" ");
}

function cursorCatalogFromGroups(
  native: { models: CursorNativeModel[]; current: string },
  groupsByNativeId: Map<string, CursorParameterGroup[]>,
): HarnessModelCatalog {
  const parameterized = [...groupsByNativeId.values()].some((groups) => groups.length > 0);
  const current = parseCursorNativeModelValue(native.current);
  const currentGroups =
    groupsByNativeId.get(native.current) ?? groupsByNativeId.get(current.base) ?? [];
  const thinkingOptions = new Map<string, HarnessThinkingOption>();
  const models = native.models.map((model) => {
    const base = parseCursorNativeModelValue(model.value).base;
    const groups = groupsByNativeId.get(model.value) ?? groupsByNativeId.get(base) ?? [];
    const supported = cursorThinkingOptions(groups);
    for (const option of supported) thinkingOptions.set(option.id, option);
    const nativeId = parameterized ? base : model.value;
    return {
      ref: cursorModelRef(nativeId),
      label: model.name,
      ...(parameterized && base === current.base && groups.length
        ? { resolvedModelLabel: cursorResolvedModelLabel(model.name, groups) }
        : {}),
      ...(supported.length
        ? { supportedThinkingOptionIds: supported.map((option) => option.id) }
        : {}),
    };
  });
  if (!models.length) throw new Error("Cursor returned no model catalog");
  const defaultThinkingOptionId = currentGroups.length
    ? cursorThinkingId(currentGroups)
    : undefined;
  const currentRef = cursorModelRef(parameterized ? current.base : native.current);
  const currentModel = models.find((model) => model.ref.id === currentRef.id) ?? models[0];
  return harnessModelCatalogSchema.parse({
    models,
    defaultModel: currentModel?.ref,
    thinkingOptions: [...thinkingOptions.values()],
    ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
  });
}

export function cursorCatalog(
  info: CursorSessionInfo | { configOptions?: unknown },
): HarnessModelCatalog {
  const native = cursorModels(info);
  const groups = cursorParameterGroups(cursorConfigOptions(info));
  const groupsByNativeId = new Map<string, CursorParameterGroup[]>();
  if (groups.length) groupsByNativeId.set(native.current, groups);
  return cursorCatalogFromGroups(native, groupsByNativeId);
}

export function cursorNativeModel(
  info: CursorSessionInfo | { configOptions?: unknown },
  ref: string,
): string {
  const native = cursorModels(info);
  const parameterized = cursorParameterGroups(cursorConfigOptions(info)).length > 0;
  const exact = native.models.find((model) => {
    const nativeId = parameterized ? parseCursorNativeModelValue(model.value).base : model.value;
    return cursorModelRef(nativeId).id === ref;
  });
  if (exact) return parameterized ? parseCursorNativeModelValue(exact.value).base : exact.value;
  const decoded = decodeCursorModelRef(ref);
  const parsed = parseCursorNativeModelValue(decoded);
  const byBase = native.models.find(
    (model) =>
      model.value === decoded ||
      model.value === parsed.base ||
      parseCursorNativeModelValue(model.value).base === parsed.base,
  );
  if (!byBase) throw new Error("Model is not in this Cursor session's native catalog");
  return parameterized ? parseCursorNativeModelValue(byBase.value).base : byBase.value;
}

export function cursorThinkingFromNativeModelId(
  groups: CursorParameterGroup[],
  nativeId: string,
): HarnessThinkingOptionId | undefined {
  if (!groups.length) return undefined;
  const params = parseCursorNativeModelValue(nativeId).params;
  const values: Record<string, string> = {};
  for (const group of groups) {
    const requested = params[group.id];
    values[group.id] = group.options.some((option) => option.id === requested)
      ? (requested as string)
      : group.currentValue;
  }
  return cursorThinkingId(groups, values);
}

export function cursorSessionConfiguration(
  info: CursorSessionInfo | { configOptions?: unknown },
  model: HarnessModelRef,
): {
  effectiveModel: HarnessModelRef;
  resolvedModelLabel?: string;
  effectiveThinkingOptionId?: HarnessThinkingOptionId;
  availableThinkingOptions?: HarnessThinkingOption[];
} {
  const native = cursorModels(info);
  const groups = cursorParameterGroups(cursorConfigOptions(info));
  const current = native.models.find(
    (entry) => cursorModelRef(parseCursorNativeModelValue(entry.value).base).id === model.id,
  );
  const availableThinkingOptions = cursorThinkingOptions(groups);
  const effectiveThinkingOptionId = groups.length ? cursorThinkingId(groups) : undefined;
  return {
    effectiveModel: model,
    ...(current ? { resolvedModelLabel: cursorResolvedModelLabel(current.name, groups) } : {}),
    ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
    ...(availableThinkingOptions.length ? { availableThinkingOptions } : {}),
  };
}
