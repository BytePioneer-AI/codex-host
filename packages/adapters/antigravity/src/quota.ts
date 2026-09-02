/**
 * Reads plan quota from the Antigravity CLI's own `/usage` command.
 *
 * `/usage` is answered by the CLI, not the Model, so it is unavailable on
 * `--input-format stream-json` and must run as its own `--print=/usage`
 * invocation. The CLI reports it as a `command_result` event whose payload
 * carries one bucket per limit window.
 */

import { isRecord, parseAntigravityStreamLine } from "./stream-events.js";

/** Runs the Antigravity CLI with the given arguments and resolves stdout. */
export type AntigravityCommandRunner = (arguments_: readonly string[]) => Promise<string>;

export interface AntigravityQuotaBucket {
  product: string;
  usagePercent: number;
  resetsAt?: string;
}

/**
 * Mirrors the Host's `AccountCreditsSnapshot` field-for-field, plus `fetchedAt`
 * which the Host strips before validating.
 */
export interface AntigravityQuotaSnapshot {
  usedPercent: number;
  periodType: "weekly" | "five_hour" | "unknown";
  resetsAt?: string;
  productUsage?: readonly AntigravityQuotaBucket[];
  fetchedAt: string;
}

interface ParsedBucket extends AntigravityQuotaBucket {
  window: string;
}

const USAGE_ARGUMENTS = ["--print=/usage", "--output-format", "stream-json"] as const;

function usedPercentFrom(remainingFraction: unknown): number | null {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return null;
  const used = (1 - Math.min(1, Math.max(0, remainingFraction))) * 100;
  return Math.round(used * 100) / 100;
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

function parseBuckets(groups: readonly unknown[]): ParsedBucket[] {
  const buckets: ParsedBucket[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const groupName = nonEmptyString(group.name);
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
        usagePercent,
        window,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return buckets;
}

/**
 * Picks the bucket that actually constrains the next Turn: the most consumed
 * one, breaking ties toward the 5-hour window because it resets soonest.
 */
function leadingBucket(buckets: readonly ParsedBucket[]): ParsedBucket | undefined {
  return [...buckets].sort((left, right) => {
    if (right.usagePercent !== left.usagePercent) return right.usagePercent - left.usagePercent;
    return (
      Number(periodTypeFrom(right.window) === "five_hour") -
      Number(periodTypeFrom(left.window) === "five_hour")
    );
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
  const others = buckets.filter((bucket) => bucket !== leading);
  return {
    usedPercent: leading.usagePercent,
    periodType: periodTypeFrom(leading.window),
    fetchedAt,
    ...(leading.resetsAt ? { resetsAt: leading.resetsAt } : {}),
    ...(others.length > 0
      ? {
          productUsage: others.map(({ product, usagePercent, resetsAt }) => ({
            product,
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
    const event = parseAntigravityStreamLine(line);
    if (event?.event !== "command_result") continue;
    const snapshot = parseAntigravityUsageCommand(event.command, fetchedAt);
    if (snapshot) return snapshot;
  }
  return null;
}
