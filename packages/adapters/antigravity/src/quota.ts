/**
 * Reads plan quota from the Antigravity CLI's own `/usage` command.
 *
 * `/usage` is answered by the CLI, not the Model, in a separate
 * `--print=/usage` invocation. Its `command_result` payload
 * carries one bucket per limit window.
 */

import type { HarnessLocalizations } from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runs the Antigravity CLI with the given arguments and resolves stdout. */
export type AntigravityCommandRunner = (arguments_: readonly string[]) => Promise<string>;

export interface AntigravityQuotaScope {
  id: string;
  label: string;
  localizations?: HarnessLocalizations;
}

export interface AntigravityQuotaBucket {
  product: string;
  periodType?: AntigravityQuotaSnapshot["periodType"];
  scope?: AntigravityQuotaScope;
  usagePercent: number;
  resetsAt?: string;
}

/**
 * Mirrors the Host's `AccountCreditsSnapshot` field-for-field, plus `fetchedAt`
 * which the Host strips before validating.
 */
export interface AntigravityQuotaSnapshot {
  label?: string;
  scope?: AntigravityQuotaScope;
  usedPercent: number;
  periodType: "weekly" | "five_hour" | "unknown";
  resetsAt?: string;
  productUsage?: AntigravityQuotaBucket[];
  fetchedAt: string;
}

interface ParsedBucket extends AntigravityQuotaBucket {
  window: string;
  groupOrder: number;
}

const USAGE_ARGUMENTS = ["--print=/usage", "--output-format", "stream-json"] as const;

const GROUP_LOCALIZATIONS: Readonly<Record<string, HarnessLocalizations>> = {
  "gemini models": { "zh-CN": { label: "Gemini 模型" } },
  "claude and gpt models": { "zh-CN": { label: "Claude 与 GPT 模型" } },
};

function usedPercentFrom(remainingFraction: unknown): number | null {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return null;
  const clamped = Math.min(1, Math.max(0, remainingFraction));
  if (clamped <= 0) return 100;
  if (clamped >= 1) return 0;
  return Math.min(99, Math.round((1 - clamped) * 100));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function periodTypeFrom(window: string): AntigravityQuotaSnapshot["periodType"] {
  const normalized = window.trim().toLowerCase();
  if (normalized === "weekly") return "weekly";
  if (normalized === "5h") return "five_hour";
  return "unknown";
}

/**
 * The CLI names buckets from the remaining side ("Weekly Limit Remaining"),
 * while `AccountCreditsSnapshot` carries consumed percentages. Labelling from
 * the window instead keeps the label and the number on the same side.
 */
function windowLabel(window: string, bucketId: string | undefined): string | undefined {
  const normalized = window.trim().toLowerCase();
  if (normalized === "weekly") return "Weekly window";
  if (normalized === "5h") return "5-hour window";
  if (normalized) return `${normalized} window`;
  return bucketId;
}

function periodRank(periodType: AntigravityQuotaSnapshot["periodType"] | undefined): number {
  if (periodType === "five_hour") return 0;
  if (periodType === "weekly") return 1;
  return 2;
}

function parseBuckets(groups: readonly unknown[]): ParsedBucket[] {
  const buckets: ParsedBucket[] = [];
  let groupOrder = 0;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const groupName = nonEmptyString(group.name);
    const localizations = groupName ? GROUP_LOCALIZATIONS[groupName.toLowerCase()] : undefined;
    const currentGroupOrder = groupOrder++;
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) continue;
      const usagePercent = usedPercentFrom(bucket.remaining_fraction);
      if (usagePercent === null) continue;
      const window = nonEmptyString(bucket.window) ?? "";
      const label = windowLabel(window, nonEmptyString(bucket.id));
      if (!label) continue;
      const resetsAt = nonEmptyString(bucket.reset_time);
      buckets.push({
        product: groupName ? `${groupName} · ${label}` : label,
        periodType: periodTypeFrom(window),
        ...(groupName
          ? {
              scope: {
                id: groupName,
                label: groupName,
                ...(localizations ? { localizations } : {}),
              },
            }
          : {}),
        usagePercent,
        window,
        groupOrder: currentGroupOrder,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return buckets;
}

/**
 * Picks the headline bucket: a 5-hour window always leads because it is the
 * most actionable and resets soonest, even when a longer window is more
 * consumed (those stay visible as product usage). Among 5-hour windows, or
 * among the remaining windows when no 5-hour window exists, the most consumed
 * bucket leads.
 */
function leadingBucket(buckets: readonly ParsedBucket[]): ParsedBucket | undefined {
  return [...buckets].sort((left, right) => {
    const leftIsFiveHour = periodTypeFrom(left.window) === "five_hour";
    const rightIsFiveHour = periodTypeFrom(right.window) === "five_hour";
    if (leftIsFiveHour !== rightIsFiveHour) {
      return Number(rightIsFiveHour) - Number(leftIsFiveHour);
    }
    if (right.usagePercent !== left.usagePercent) {
      return right.usagePercent - left.usagePercent;
    }
    return 0;
  })[0];
}

/** Projects a `/usage` `command_result` payload into a quota snapshot. */
export function parseAntigravityUsageCommand(
  command: unknown,
  fetchedAt: string = new Date().toISOString(),
): AntigravityQuotaSnapshot | null {
  if (!isRecord(command) || command.name !== "usage" || !isRecord(command.data)) return null;
  const { groups } = command.data;
  if (!Array.isArray(groups)) return null;
  const buckets = parseBuckets(groups);
  const leading = leadingBucket(buckets);
  if (!leading) return null;
  const others = buckets
    .filter((bucket) => bucket !== leading)
    .sort((left, right) => {
      const leftSameGroup = left.groupOrder === leading.groupOrder;
      const rightSameGroup = right.groupOrder === leading.groupOrder;
      if (leftSameGroup !== rightSameGroup) return Number(rightSameGroup) - Number(leftSameGroup);
      if (left.groupOrder !== right.groupOrder) return left.groupOrder - right.groupOrder;
      return periodRank(left.periodType) - periodRank(right.periodType);
    });
  return {
    ...(leading.scope || periodTypeFrom(leading.window) === "unknown"
      ? { label: leading.product }
      : {}),
    ...(leading.scope ? { scope: leading.scope } : {}),
    usedPercent: leading.usagePercent,
    periodType: periodTypeFrom(leading.window),
    fetchedAt,
    ...(leading.resetsAt ? { resetsAt: leading.resetsAt } : {}),
    ...(others.length > 0
      ? {
          productUsage: others.map(({ product, periodType, scope, usagePercent, resetsAt }) => ({
            product,
            ...(periodType ? { periodType } : {}),
            ...(scope ? { scope } : {}),
            usagePercent,
            ...(resetsAt ? { resetsAt } : {}),
          })),
        }
      : {}),
  };
}

/** Runs `/usage` and returns the quota snapshot, or null when unavailable. */
export async function fetchAntigravityQuota(
  run: AntigravityCommandRunner,
  now: Date = new Date(),
): Promise<AntigravityQuotaSnapshot | null> {
  let stdout: string;
  try {
    stdout = await run(USAGE_ARGUMENTS);
  } catch {
    return null;
  }
  const fetchedAt = now.toISOString();
  for (const line of stdout.split(/\r?\n/u)) {
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event) || event.event !== "command_result") continue;
      const snapshot = parseAntigravityUsageCommand(event.command, fetchedAt);
      if (snapshot) return snapshot;
    } catch {
      // The CLI can interleave diagnostics with structured command results.
    }
  }
  return null;
}
