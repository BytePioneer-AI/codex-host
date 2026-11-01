import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { KiroHistoryRow } from "./history.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Native request IDs identify the same charge in live notifications and persisted history. */
export class KiroUsage {
  readonly #credits = new Map<string, number>();
  #contextUsagePercent: number | undefined;

  observe(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.kind === "context_usage") this.context(value);
    if (value.kind === "turn_completion" || value.type === "usage_summary") {
      const ids = value.requestIds;
      const key =
        Array.isArray(ids) &&
        ids.length > 0 &&
        ids.every((id) => typeof id === "string" && id.length > 0)
          ? `requests:${JSON.stringify([...new Set(ids)].sort())}`
          : typeof value.executionId === "string" && value.executionId.length > 0
            ? `execution:${value.executionId}`
            : undefined;
      if (!key || !Array.isArray(value.promptTurnSummaries)) return;
      const credits = value.promptTurnSummaries.filter(
        (entry) => isRecord(entry) && entry.unit === "credit",
      );
      if (
        credits.length === 0 ||
        !credits.every((entry) => isRecord(entry) && nonNegative(entry.usage))
      )
        return;
      const total = credits.reduce((sum, entry) => sum + (entry as { usage: number }).usage, 0);
      if (nonNegative(total)) this.#credits.set(key, total);
    }
  }

  context(value: unknown): void {
    if (!isRecord(value)) return;
    const percent = isRecord(value.contextUsage)
      ? value.contextUsage.usagePercentage
      : value.usagePercentage;
    if (nonNegative(percent)) this.#contextUsagePercent = percent;
  }

  load(rows: KiroHistoryRow[]): void {
    for (const row of rows) {
      if (row.payload.type === "usage_summary") this.observe(row.payload);
    }
  }

  snapshot(): HostUsage | null {
    const usage: HostUsage = {};
    const total = [...this.#credits.values()].reduce((sum, value) => sum + value, 0);
    if (this.#credits.size > 0 && nonNegative(total)) usage.totalCredits = total;
    if (this.#contextUsagePercent !== undefined)
      usage.contextUsagePercent = this.#contextUsagePercent;
    return Object.keys(usage).length > 0 ? parseHostUsage(usage) : null;
  }
}
