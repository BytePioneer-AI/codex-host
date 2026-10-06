import {
  harnessAccountSnapshotSchema,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function creditAmount(
  used: unknown,
  limit: unknown,
  unit: unknown,
): { used: number; limit: number; unit: string } | undefined {
  if (!nonnegative(used) || !nonnegative(limit)) return undefined;
  return {
    used,
    limit,
    unit: typeof unit === "string" && unit.trim() ? unit : "credits",
  };
}

export function projectQoderAccount(
  usage: unknown,
  identity: unknown,
): HarnessAccountSnapshot | null {
  const data = record(usage);
  const account = record(identity);
  const quota = record(data.userQuota);
  const shared = record(data.orgResourcePackage);
  const nativePercent = quota.percentage ?? data.totalUsagePercentage;
  const usedPercent = nonnegative(nativePercent)
    ? Math.min(100, nativePercent)
    : nonnegative(quota.used) && nonnegative(quota.total) && quota.total > 0
      ? Math.min(100, (quota.used / quota.total) * 100)
      : undefined;
  if (usedPercent === undefined) return null;
  const result = harnessAccountSnapshotSchema.safeParse({
    ...(typeof account.email === "string" && account.email ? { email: account.email } : {}),
    ...(typeof account.subscriptionType === "string" && account.subscriptionType
      ? { plan: account.subscriptionType }
      : typeof data.userType === "string"
        ? { plan: data.userType }
        : {}),
    credits: {
      usedPercent,
      periodType: "unknown",
      label: "Plan credits",
      ...(shared.available === true &&
      nonnegative(shared.percentage) &&
      nonnegative(shared.used) &&
      nonnegative(shared.cap) &&
      shared.cap > 0
        ? {
            productUsage: [
              {
                product: "Shared resource credits",
                usagePercent: Math.min(100, shared.percentage),
                used: shared.used,
                limit: shared.cap,
                unit: typeof shared.unit === "string" ? shared.unit : "credits",
              },
            ],
          }
        : {}),
      ...creditAmount(quota.used, quota.total, quota.unit),
    },
  });
  return result.success ? result.data : null;
}
