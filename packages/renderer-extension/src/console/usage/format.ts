import type { UsageStatisticsTotals } from "@codexhost/shared-contracts";

import {
  formatRendererCacheHitRate,
  formatRendererCost,
  formatRendererTokenCount,
} from "../../renderer-usage-control.js";

export type Totals = UsageStatisticsTotals;
/** What the trend, shares and session ranking measure. */
export type Measure = "cost" | "tokens";
export const MEASURES: readonly Measure[] = ["cost", "tokens"];

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    values[name] === undefined ? match : String(values[name]),
  );
}

export function emptyTotals(): Totals {
  return {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheKnownInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
    unmeteredRequests: 0,
  };
}

export function addTotals(target: Totals, source: Totals): Totals {
  target.requests += source.requests;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheWriteInputTokens += source.cacheWriteInputTokens;
  target.cacheKnownInputTokens += source.cacheKnownInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.costUsd += source.costUsd;
  target.unpricedRequests += source.unpricedRequests;
  target.unmeteredRequests += source.unmeteredRequests;
  return target;
}

/**
 * Input that neither came from nor went to the cache. Requests whose cache
 * split is unknown keep their whole input here, since no part of it can be told apart.
 */
export function inputWithoutCache(totals: Totals): number {
  return totals.inputTokens - totals.cachedInputTokens - totals.cacheWriteInputTokens;
}

/** All processed tokens; normalized input already includes cache, output includes reasoning. */
export function tokensWithCache(totals: Totals): number {
  return totals.inputTokens + totals.outputTokens;
}

/** Input without cache plus output. Cache reads and writes are shown on their own. */
export function tokensWithoutCache(totals: Totals): number {
  return inputWithoutCache(totals) + totals.outputTokens;
}

export function measured(totals: Totals, measure: Measure): number {
  return measure === "cost" ? totals.costUsd : tokensWithoutCache(totals);
}

/** USD with thousands separators once it reaches four digits. */
export function money(value: number): string {
  return Math.abs(value) >= 1_000
    ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : formatRendererCost(value);
}

/** Every request lacks token counts in its storage: tokens and cost are unknown, not zero. */
export function unmetered(totals: Totals): boolean {
  return totals.requests > 0 && totals.unmeteredRequests === totals.requests;
}

/** Every request with token counts is unpriced: the cost is unknown, not zero. */
export function allUnpriced(totals: Totals): boolean {
  const metered = totals.requests - totals.unmeteredRequests;
  return metered > 0 && totals.unpricedRequests === metered;
}

/** The priced cost; nothing priced or nothing metered at all is unknown, not zero. */
export function cost(totals: Totals): string {
  return unmetered(totals) || allUnpriced(totals) ? "—" : money(totals.costUsd);
}

/** A token count, or "—" when no request of the row reported any. */
export function tokenCount(totals: Totals, value: number, locale = "en"): string {
  return unmetered(totals) ? "—" : count(value, locale);
}

function isChinese(locale: string): boolean {
  return /^zh(?:-|$)/iu.test(locale);
}

/** Chinese readers use ten-thousands and hundred-millions, not K/M/B. */
export function count(value: number, locale = "en"): string {
  if (!isChinese(locale)) return formatRendererTokenCount(value);
  const absolute = Math.abs(value);
  if (absolute < 10_000) return value.toLocaleString(locale, { maximumFractionDigits: 0 });
  // Promote a rounded 10,000 万 to 亿 rather than displaying the awkward boundary value.
  const hundredMillions =
    absolute >= 100_000_000 || Number((absolute / 10_000).toFixed(2)) >= 10_000;
  const divisor = hundredMillions ? 100_000_000 : 10_000;
  return `${Number((value / divisor).toFixed(2))} ${hundredMillions ? "亿" : "万"}`;
}

/** Keep the exact total prominent; its Chinese approximation is a secondary reading aid. */
export function tokenSummary(
  value: number,
  locale = "en",
): {
  value: string;
  approximation: string | null;
} {
  if (!isChinese(locale)) return { value: count(value), approximation: null };
  return {
    value: value.toLocaleString(locale, { maximumFractionDigits: 0 }),
    approximation: Math.abs(value) >= 10_000 ? `≈ ${count(value, locale)}` : null,
  };
}

/** Cache reads over all input whose split is known, cache writes included. */
export function cacheHitRate(totals: Totals): string {
  return totals.cacheKnownInputTokens > 0
    ? formatRendererCacheHitRate((totals.cachedInputTokens / totals.cacheKnownInputTokens) * 100)
    : "—";
}

export function formatMeasure(measure: Measure, value: number, locale = "en"): string {
  return measure === "cost" ? money(value) : count(value, locale);
}

/** Compact axis label; Token units follow the viewer's language, USD notation stays unchanged. */
export function axisValue(measure: Measure, value: number, locale = "en"): string {
  if (measure !== "cost") return count(value, locale);
  if (value >= 1_000) return `$${count(value)}`;
  return `$${Number(value.toFixed(2))}`;
}

/** Whole percent from 10%, one decimal below; a non-zero sliver never reads as 0. */
export function percent(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${share >= 0.1 ? Math.round(share * 100) : (share * 100).toFixed(1)}%`;
}

/** The smallest round step × 10ⁿ at or above `value`, so the half gridline stays round too. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10])
    if (value <= step * power + 1e-9 * power) return step * power;
  return 10 * power;
}

/** The last segment of a directory, Windows or POSIX. */
export function baseName(directory: string): string {
  const parts = directory.split(/[\\/]+/u).filter(Boolean);
  return parts.at(-1) ?? directory;
}

/**
 * Short names for project directories: the folder name, with its parent when two projects share
 * a folder name (such as several worktrees of one repository).
 */
export function projectNames(projects: Iterable<string>): Map<string, string> {
  const list = [...new Set(projects)];
  const byBase = new Map<string, string[]>();
  for (const project of list) {
    const base = baseName(project);
    byBase.set(base, [...(byBase.get(base) ?? []), project]);
  }
  const names = new Map<string, string>();
  for (const [base, group] of byBase) {
    for (const project of group) {
      if (group.length === 1) {
        names.set(project, base);
        continue;
      }
      const parts = project.split(/[\\/]+/u).filter(Boolean);
      names.set(project, parts.slice(-2).join("/") || base);
    }
  }
  return names;
}

export function asDate(date: string): Date {
  return new Date(`${date}T12:00:00`);
}

export function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Every date from `from` to `to`, oldest first. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const day = asDate(from);
  const last = asDate(to);
  while (day <= last && dates.length < 3_660) {
    dates.push(isoDate(day));
    day.setDate(day.getDate() + 1);
  }
  return dates;
}
