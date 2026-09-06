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

/** Effort suffixes the CLI uses, ordered from least to most reasoning. */
const EFFORT_LABELS = new Map<string, string>([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
]);

const EFFORT_SUFFIX_PATTERN = /^(?<base>.+)-(?<effort>low|medium|high)$/u;

/** Trailing effort in the CLI's display label, e.g. `Gemini 3.1 Pro (Low)`. */
const EFFORT_LABEL_SUFFIX_PATTERN = /\s*\((?:low|medium|high)\)$/iu;

interface ListedModel {
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
  if (!match?.groups) return { baseId: id, baseLabel: label, effort: null };
  return {
    baseId: match.groups.base as string,
    baseLabel: label.replace(EFFORT_LABEL_SUFFIX_PATTERN, "").trim() || label,
    effort: match.groups.effort as string,
  };
}

export function parseAntigravityModels(output: string): HarnessModelCatalog {
  const grouped = new Map<string, { label: string; efforts: HarnessThinkingOptionId[] }>();
  for (const line of output.split(/\r?\n/u)) {
    const listed = listedModel(line.trim());
    if (!listed) continue;
    if (!harnessModelRefSchema.safeParse({ id: listed.baseId }).success) continue;
    const entry = grouped.get(listed.baseId) ?? { label: listed.baseLabel, efforts: [] };
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
  for (const [id, { label, efforts }] of grouped) {
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
