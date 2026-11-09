import type { CopilotSession } from "@github/copilot-sdk";
import { parseHarnessAccountCredits } from "@codexhost/harness-adapter";
import {
  harnessAccountSnapshotSchema,
  type AccountCreditsSnapshot,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";

type Quota = Awaited<ReturnType<CopilotSession["rpc"]["quota"]["refresh"]>>;
type Window = NonNullable<AccountCreditsSnapshot["productUsage"]>[number];
const labels: Record<string, string> = {
  chat: "Chat",
  completions: "Code completions",
  premium_interactions: "Premium interactions",
};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const percent = (remaining: unknown): number | undefined =>
  finite(remaining) && remaining <= 100 ? Number((100 - remaining).toFixed(8)) : undefined;
function resetDate(value: number | undefined): string | undefined {
  if (!finite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Only authoritative native budgets become quota percentages; advisory balances are not budgets. */
export function projectCopilotAccount(quota: Quota): HarnessAccountSnapshot | null {
  const windows: Window[] = [];
  if (quota.providerQuotas !== undefined) {
    for (const entry of quota.providerQuotas) {
      const budget = entry.budgetMetadata;
      if (
        entry.quantityKind !== "authoritative_budget" ||
        entry.observationKind !== "account_snapshot" ||
        entry.acquisitionStatus !== "succeeded" ||
        !budget ||
        budget.unlimited
      )
        continue;
      const usedPercent = percent(budget.remainingPercentage);
      if (usedPercent === undefined) continue;
      const label = `${entry.provider.label} · ${labels[entry.quotaId] ?? entry.quotaId}`;
      const unit =
        entry.unit === "ai_credits"
          ? "AI Credits"
          : entry.unit === "requests"
            ? "requests"
            : entry.unit === "tokens"
              ? "tokens"
              : undefined;
      const resetsAt = resetDate(budget.resetAtEpochMs);
      windows.push({
        product: label,
        scope: { id: `${entry.provider.id}:${entry.quotaId}`, label },
        periodType: "unknown",
        usagePercent: usedPercent,
        ...(unit && finite(budget.consumed) && finite(budget.entitlement)
          ? { used: budget.consumed, limit: budget.entitlement, unit }
          : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  } else {
    // Older runtimes lack explicit provider units. Token-billed legacy quantities stay unknown.
    for (const [key, entry] of Object.entries(quota.snapshots)) {
      if (!entry || entry.isUnlimitedEntitlement) continue;
      const usedPercent = percent(entry.remainingPercentage);
      if (usedPercent === undefined) continue;
      const label = labels[key] ?? key;
      const resetsAt = resetDate(entry.resetDateEpochMs);
      windows.push({
        product: label,
        scope: { id: key, label },
        periodType: "unknown",
        usagePercent: usedPercent,
        ...(quota.isTbbUser === false &&
        finite(entry.usedRequests) &&
        finite(entry.entitlementRequests)
          ? { used: entry.usedRequests, limit: entry.entitlementRequests, unit: "requests" }
          : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  const [primary, ...others] = windows;
  if (!primary) return null;
  const credits = parseHarnessAccountCredits({
    usedPercent: primary.usagePercent,
    periodType: primary.periodType,
    label: primary.product,
    scope: primary.scope,
    ...(primary.used === undefined ? {} : { used: primary.used }),
    ...(primary.limit === undefined ? {} : { limit: primary.limit }),
    ...(primary.unit ? { unit: primary.unit } : {}),
    ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
    ...(others.length ? { productUsage: others } : {}),
  });
  if (!credits) return null;
  const result = harnessAccountSnapshotSchema.safeParse({
    label: "GitHub Copilot",
    plan: quota.planTier,
    credits,
  });
  return result.success ? result.data : null;
}
