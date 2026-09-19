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

/** A Host Thinking choice preserves every native thought-level parameter (e.g. thinking + effort). */
export function cursorThinking(options: SessionConfigOption[] | null | undefined) {
  const native = (options ?? []).filter(
    (option) => option.category === "thought_level" && option.type === "select",
  );
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
