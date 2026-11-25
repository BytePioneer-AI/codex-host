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

export interface ParsedBucket extends AntigravityQuotaBucket {
  groupName?: string;
  groupOrder: number;
}

/** Parsed `/usage` buckets, kept so each Session can project its own headline. */
export interface AntigravityQuotaReading {
  readonly buckets: readonly ParsedBucket[];
  readonly fetchedAt: string;
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
              groupName,
              scope: {
                id: groupName,
                label: groupName,
                ...(localizations ? { localizations } : {}),
              },
            }
          : {}),
        usagePercent,
        groupOrder: currentGroupOrder,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return buckets;
}

/**
 * The CLI groups quota by model family ("Gemini Models", "Claude and GPT
 * Models") without listing Model IDs, so a Model belongs to the group whose
 * name contains its leading family token (`claude-opus-4-6` -> `claude`).
 */
function modelGroupOrder(buckets: readonly ParsedBucket[], modelId: string): number | undefined {
  const family = /^[a-z]+/u.exec(modelId.trim().toLowerCase())?.[0];
  if (!family) return undefined;
  return buckets.find((bucket) =>
    bucket.groupName
      ?.toLowerCase()
      .split(/[^a-z0-9]+/u)
      .includes(family),
  )?.groupOrder;
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
    const leftIsFiveHour = left.periodType === "five_hour";
    const rightIsFiveHour = right.periodType === "five_hour";
    if (leftIsFiveHour !== rightIsFiveHour) {
      return Number(rightIsFiveHour) - Number(leftIsFiveHour);
    }
    if (right.usagePercent !== left.usagePercent) {
      return right.usagePercent - left.usagePercent;
    }
    return 0;
  })[0];
}

/** Parses a `/usage` `command_result` payload into its quota buckets. */
export function readAntigravityUsageCommand(
  command: unknown,
  fetchedAt: string = new Date().toISOString(),
): AntigravityQuotaReading | null {
  if (!isRecord(command) || command.name !== "usage" || !isRecord(command.data)) return null;
  const { groups } = command.data;
  if (!Array.isArray(groups)) return null;
  const buckets = parseBuckets(groups);
  return buckets.length > 0 ? { buckets, fetchedAt } : null;
}

/**
 * Projects buckets into a quota snapshot. With a Model, the headline comes
 * from that Model's quota group; otherwise, or when no group matches, it comes
 * from every bucket.
 */
export function projectAntigravityQuota(
  reading: AntigravityQuotaReading,
  modelId?: string,
): AntigravityQuotaSnapshot | null {
  const { buckets, fetchedAt } = reading;
  const groupOrder = modelId ? modelGroupOrder(buckets, modelId) : undefined;
  const leading =
    leadingBucket(
      groupOrder === undefined
        ? buckets
        : buckets.filter((bucket) => bucket.groupOrder === groupOrder),
    ) ?? leadingBucket(buckets);
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
    ...(leading.scope || leading.periodType === "unknown" ? { label: leading.product } : {}),
    ...(leading.scope ? { scope: leading.scope } : {}),
    usedPercent: leading.usagePercent,
    periodType: leading.periodType ?? "unknown",
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

/** Projects a `/usage` `command_result` payload into a quota snapshot. */
export function parseAntigravityUsageCommand(
  command: unknown,
  fetchedAt: string = new Date().toISOString(),
  modelId?: string,
): AntigravityQuotaSnapshot | null {
  const reading = readAntigravityUsageCommand(command, fetchedAt);
  return reading ? projectAntigravityQuota(reading, modelId) : null;
}

/** Runs `/usage` and returns its quota buckets, or null when unavailable. */
export async function fetchAntigravityQuota(
  run: AntigravityCommandRunner,
  now: Date = new Date(),
): Promise<AntigravityQuotaReading | null> {
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
      const reading = readAntigravityUsageCommand(event.command, fetchedAt);
      if (reading) return reading;
    } catch {
      // The CLI can interleave diagnostics with structured command results.
    }
  }
  return null;
}
