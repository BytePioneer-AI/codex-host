import {
  accountCreditsSnapshotSchema,
  type AccountCreditsSnapshot,
} from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resetTime(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

type Window = NonNullable<AccountCreditsSnapshot["productUsage"]>[number];

/** Native percentages describe consumed allowance, independently of Session token counts. */
export function projectCodexAccountCredits(value: unknown): AccountCreditsSnapshot | null {
  if (!isRecord(value)) return null;
  const buckets = new Map<string, Record<string, unknown>>();
  if (isRecord(value.rateLimits))
    buckets.set(text(value.rateLimits.limitId) ?? "codex", value.rateLimits);
  if (isRecord(value.rateLimitsByLimitId))
    for (const [id, bucket] of Object.entries(value.rateLimitsByLimitId))
      if (isRecord(bucket)) buckets.set(id, bucket);

  const windows: Window[] = [];
  const ordered = [...buckets].sort(([left], [right]) =>
    left === "codex" ? -1 : right === "codex" ? 1 : 0,
  );
  for (const [id, bucket] of ordered) {
    const scope = id === "codex" ? undefined : { id, label: text(bucket.limitName) ?? id };
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!isRecord(window)) continue;
      const used = window.usedPercent;
      if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
      const minutes = window.windowDurationMins;
      const periodType =
        minutes === 300 ? "five_hour" : minutes === 10_080 ? "seven_day" : "unknown";
      const product =
        periodType === "five_hour"
          ? "5-hour window"
          : periodType === "seven_day"
            ? "7-day window"
            : typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes > 0
              ? `${minutes}-minute window`
              : "Account quota";
      const resetsAt = resetTime(window.resetsAt);
      windows.push({
        product,
        periodType,
        ...(scope ? { scope } : {}),
        usagePercent: used,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  const [primary, ...others] = windows;
  if (!primary) return null;
  const parsed = accountCreditsSnapshotSchema.safeParse({
    usedPercent: primary.usagePercent,
    periodType: primary.periodType,
    ...(primary.periodType === "unknown" ? { label: primary.product } : {}),
    ...(primary.scope ? { scope: primary.scope } : {}),
    ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
    ...(others.length ? { productUsage: others } : {}),
  });
  return parsed.success ? parsed.data : null;
}
