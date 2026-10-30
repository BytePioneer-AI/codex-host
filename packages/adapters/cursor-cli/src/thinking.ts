import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  harnessThinkingOptionIdSchema,
  type HarnessThinkingOption,
} from "@codexhost/shared-contracts";
import type { CursorSessionInfo } from "./transport.js";

const choices = (option: SessionConfigOption) =>
  option.type === "select"
    ? option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    : [];

/**
 * Native parameters Host offers as Thinking although Cursor files them under `model_config`.
 * Cursor's Auto (`auto-smart`) has no thought level; its router preference
 * (`optimize_for`: Intelligence / Balance / Cost) is its only reasoning trade-off.
 */
const CURSOR_THINKING_MODEL_CONFIG_IDS = new Set(["optimize_for"]);

/** Whether a native parameter is presented as Thinking rather than kept in the Model Ref. */
export function isCursorThinkingOption(option: SessionConfigOption): boolean {
  return (
    option.type === "select" &&
    (option.category === "thought_level" ||
      (option.category === "model_config" && CURSOR_THINKING_MODEL_CONFIG_IDS.has(option.id)))
  );
}

/** A Host Thinking choice preserves every native thought-level parameter (e.g. thinking + effort). */
export function cursorThinking(options: SessionConfigOption[] | null | undefined) {
  const native = (options ?? []).filter(isCursorThinkingOption);
  let combinations: Array<{ values: Array<[string, string]>; labels: string[] }> = [
    { values: [], labels: [] },
  ];
  for (const option of native) {
    const entries = choices(option);
    if (!entries.length || combinations.length * entries.length > 64) return [];
    combinations = combinations.flatMap((combination) =>
      entries.map((entry) => ({
        values: [...combination.values, [option.id, entry.value] as [string, string]],
        labels: [
          ...combination.labels,
          native.length > 1 ? `${option.name}: ${entry.name}` : entry.name,
        ],
      })),
    );
  }
  if (!native.length) return [];
  return combinations.flatMap(({ values, labels }) => {
    const encoded = Buffer.from(JSON.stringify(values)).toString("base64url");
    const id = harnessThinkingOptionIdSchema.safeParse(`cursor.${encoded}`);
    return id.success ? [{ id: id.data, label: labels.join(" / "), values }] : [];
  });
}

export function cursorThinkingState(info: CursorSessionInfo) {
  const options = cursorThinking(info.configOptions);
  const current = options.find((entry) =>
    entry.values.every(([id, value]) =>
      info.configOptions?.some((option) => option.id === id && option.currentValue === value),
    ),
  );
  return {
    availableThinkingOptions: options.map(({ id, label }): HarnessThinkingOption => ({
      id,
      label,
    })),
    ...(current ? { effectiveThinkingOptionId: current.id } : {}),
  };
}
