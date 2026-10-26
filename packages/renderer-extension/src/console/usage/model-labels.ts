import type { UsageStatisticsResult } from "@codexhost/shared-contracts";

/** A display label is never a filter/price key. Conflicting Harness labels stay unmerged. */
export function usageModelLabel(
  model: string,
  labels: UsageStatisticsResult["modelLabels"],
  harness?: string,
): string {
  const names = new Set(
    (labels ?? [])
      .filter((entry) => entry.model === model && (!harness || entry.harness === harness))
      .map((entry) => entry.label),
  );
  return names.size === 1 ? (names.values().next().value ?? model) : model;
}
