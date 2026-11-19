/**
 * Projects `agy models` output into a Host Model Catalog.
 *
 * The Antigravity CLI bakes reasoning effort into the Model ID it lists
 * (`gemini-3.7-flash-high`), but it also accepts the base ID paired with a
 * separate `--effort` flag and rejects the two forms when they are combined:
 *
 *   --model gemini-3.1-pro                 -> requires --effort (available: low, high)
 *   --model gemini-3.1-pro --effort low    -> gemini-3.1-pro-low
 *   --model gemini-3.1-pro-low --effort high -> conflicts with --effort=high
 *   --model gpt-oss-120b --effort high     -> invalid, only medium exists
 *   --model claude-sonnet-4-6 --effort high -> invalid, no effort variants
 *
 * Efforts are therefore a real second axis, but a per-Model one: each base
 * Model allows its own subset, and some allow none. That is exactly what
 * `HarnessModel.supportedThinkingOptionIds` expresses, so the listed IDs are
 * grouped by base Model and the effort suffix becomes a Thinking option.
 */
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModel,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

import type { AntigravityAcpAvailableModel, AntigravityAcpConfigOption } from "./acp-types.js";

/** Effort suffixes the CLI uses, ordered from least to most reasoning. */
const EFFORT_LABELS = new Map<string, string>([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "XHigh"],
]);

const EFFORT_SUFFIX_PATTERN = /^(?<base>.+)-(?<effort>low|medium|high|xhigh)$/u;

/** Trailing effort in the CLI's display label, e.g. `Gemini 3.1 Pro (Low)`. */
const EFFORT_LABEL_SUFFIX_PATTERN = /\s*\((?:low|medium|high|xhigh)\)$/iu;

interface ListedModel {
  readonly rawId: string;
  readonly rawLabel: string;
  readonly baseId: string;
  readonly baseLabel: string;
  readonly effort: string | null;
}

function listedModel(line: string): ListedModel | null {
  const separator = line.indexOf("\t");
  if (separator <= 0) return null;
  const id = line.slice(0, separator).trim();
  const label = line.slice(separator + 1).trim();
  if (!id || !label) return null;
  const match = EFFORT_SUFFIX_PATTERN.exec(id);
  if (!match?.groups) {
    return { rawId: id, rawLabel: label, baseId: id, baseLabel: label, effort: null };
  }
  return {
    rawId: id,
    rawLabel: label,
    baseId: match.groups.base as string,
    baseLabel: label.replace(EFFORT_LABEL_SUFFIX_PATTERN, "").trim() || label,
    effort: match.groups.effort as string,
  };
}

export function parseAntigravityModels(output: string): HarnessModelCatalog {
  const grouped = new Map<
    string,
    { label: string; efforts: HarnessThinkingOptionId[]; rows: ListedModel[] }
  >();
  for (const line of output.split(/\r?\n/u)) {
    const listed = listedModel(line.trim());
    if (!listed) continue;
    if (!harnessModelRefSchema.safeParse({ id: listed.baseId }).success) continue;
    const entry = grouped.get(listed.baseId) ?? {
      label: listed.baseLabel,
      efforts: [],
      rows: [],
    };
    entry.rows.push(listed);
    if (listed.effort) {
      const effortId = harnessThinkingOptionIdSchema.safeParse(listed.effort);
      if (effortId.success && !entry.efforts.includes(effortId.data)) {
        entry.efforts.push(effortId.data);
      }
    }
    grouped.set(listed.baseId, entry);
  }

  const models: HarnessModel[] = [];
  const thinkingOptions = new Map<HarnessThinkingOptionId, HarnessThinkingOption>();
  for (const [id, { label, efforts, rows }] of grouped) {
    // Single-variant models (such as `gpt-oss-120b-medium`) are exposed in ACP
    // under their unsplit ID with no `thought_level` selector.
    const soleRow = rows.length === 1 ? rows[0] : undefined;
    if (soleRow?.effort && harnessModelRefSchema.safeParse({ id: soleRow.rawId }).success) {
      models.push({
        ref: harnessModelRefSchema.parse({ id: soleRow.rawId }),
        label: soleRow.rawLabel,
        resolvedModelLabel: soleRow.rawLabel,
      });
      continue;
    }
    const ordered = [...EFFORT_LABELS.keys()].flatMap((effort) => {
      const match = efforts.find((candidate) => candidate === effort);
      return match ? [match] : [];
    });
    for (const effort of ordered) {
      thinkingOptions.set(effort, { id: effort, label: EFFORT_LABELS.get(effort) as string });
    }
    models.push({
      ref: harnessModelRefSchema.parse({ id }),
      label,
      resolvedModelLabel: label,
      ...(ordered.length > 0 ? { supportedThinkingOptionIds: ordered } : {}),
    });
  }
  if (models.length === 0) throw new Error("Antigravity CLI returned no usable Models");

  // The CLI's own default is the strongest effort of its default Model
  // (observed: `Gemini 3.7 Flash (High)`), so lead with the strongest listed.
  const options = [...EFFORT_LABELS.keys()].flatMap((effort) => {
    const option = thinkingOptions.get(effort as HarnessThinkingOptionId);
    return option ? [option] : [];
  });
  const defaultThinkingOptionId = options.at(-1)?.id;
  return harnessModelCatalogSchema.parse({
    models,
    defaultModel: models[0]?.ref,
    thinkingOptions: options,
    ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
  });
}

/**
 * Builds the `--model` / `--effort` arguments for a launch.
 *
 * A Model Ref that still carries an effort suffix comes from a Thread stored
 * before efforts were split out; the CLI accepts it as long as `--effort` is
 * left off, so those Threads keep resuming unchanged.
 */
export function antigravityModelArguments(
  model: HarnessModelRef | undefined,
  thinkingOptionId: HarnessThinkingOptionId | undefined,
): string[] {
  if (!model) return [];
  const arguments_ = ["--model", model.id];
  if (thinkingOptionId && !EFFORT_SUFFIX_PATTERN.test(model.id)) {
    arguments_.push("--effort", thinkingOptionId);
  }
  return arguments_;
}

/** Thinking options the given Model actually accepts, or undefined when none. */
export function antigravityAvailableThinkingOptions(
  catalog: HarnessModelCatalog | undefined,
  model: HarnessModelRef | undefined,
): HarnessThinkingOption[] | undefined {
  if (!catalog || !model) return undefined;
  const supported = catalog.models.find(
    ({ ref }) => ref.id === model.id,
  )?.supportedThinkingOptionIds;
  if (!supported) return undefined;
  const options = supported.flatMap((id) => {
    const option = catalog.thinkingOptions.find((candidate) => candidate.id === id);
    return option ? [option] : [];
  });
  return options.length > 0 ? options : undefined;
}

export interface AntigravityAcpEffectiveModelState {
  effectiveModel?: HarnessModelRef;
  resolvedModelLabel?: string;
  effectiveThinkingOptionId?: HarnessThinkingOptionId;
  availableThinkingOptions?: HarnessThinkingOption[];
}

export function parseAntigravityAcpModelCatalog(
  availableModels: readonly AntigravityAcpAvailableModel[],
  configOptions: readonly AntigravityAcpConfigOption[] = [],
): HarnessModelCatalog {
  const modelOption = configOptions.find(({ id }) => id === "model");
  const thoughtOption = configOptions.find(({ id }) => id === "thought_level");
  const thinkingOptions = (thoughtOption?.options ?? []).map(({ value, name }) => ({
    id: harnessThinkingOptionIdSchema.parse(value),
    label: name,
  }));
  const listed =
    modelOption?.options.map(({ value, name }) => ({ modelId: value, name })) ?? availableModels;
  const first = listed[0];
  if (!first) throw new Error("Antigravity ACP returned no usable Models");
  const currentModelId = modelOption?.currentValue ?? first.modelId;
  return harnessModelCatalogSchema.parse({
    models: listed.map(({ modelId, name }) => ({
      ref: { id: modelId },
      label: name,
      resolvedModelLabel: name,
      ...(modelId === currentModelId && thinkingOptions.length > 0
        ? { supportedThinkingOptionIds: thinkingOptions.map(({ id }) => id) }
        : {}),
    })),
    defaultModel: { id: currentModelId },
    thinkingOptions,
    ...(thoughtOption && thinkingOptions.some(({ id }) => id === thoughtOption.currentValue)
      ? { defaultThinkingOptionId: thoughtOption.currentValue }
      : {}),
  });
}

export function readAcpEffectiveModelState(
  configOptions: readonly AntigravityAcpConfigOption[] | undefined,
  catalog?: HarnessModelCatalog,
): AntigravityAcpEffectiveModelState {
  const model = configOptions?.find(({ id }) => id === "model");
  const thought = configOptions?.find(({ id }) => id === "thought_level");
  const effectiveModel = model
    ? harnessModelRefSchema.parse({ id: model.currentValue })
    : undefined;
  const resolvedModelLabel =
    model?.options.find(({ value }) => value === model.currentValue)?.name ??
    catalog?.models.find(({ ref }) => ref.id === effectiveModel?.id)?.resolvedModelLabel;
  const availableThinkingOptions = thought
    ? thought.options.map(({ value, name }) => ({
        id: harnessThinkingOptionIdSchema.parse(value),
        label: name,
      }))
    : configOptions !== undefined
      ? []
      : antigravityAvailableThinkingOptions(catalog, effectiveModel);
  const effectiveThinkingOptionId =
    thought && availableThinkingOptions?.some(({ id }) => id === thought.currentValue)
      ? harnessThinkingOptionIdSchema.parse(thought.currentValue)
      : undefined;
  return {
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
    ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
    ...(availableThinkingOptions ? { availableThinkingOptions } : {}),
  };
}

export function splitAntigravityModelAndEffort(rawModelId: string): {
  modelRef: HarnessModelRef;
  effort?: HarnessThinkingOptionId;
} {
  const match = EFFORT_SUFFIX_PATTERN.exec(rawModelId.trim());
  if (match?.groups?.base && match.groups.effort) {
    const baseRef = harnessModelRefSchema.safeParse({ id: match.groups.base });
    const effortId = harnessThinkingOptionIdSchema.safeParse(match.groups.effort);
    if (baseRef.success && effortId.success) {
      return { modelRef: baseRef.data, effort: effortId.data };
    }
  }
  return { modelRef: harnessModelRefSchema.parse({ id: rawModelId.trim() }) };
}
