import type { AccountInfo, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessAccountSnapshot, AccountCreditsSnapshot } from "@codexhost/shared-contracts";

/** Only native plan limits are account quota; session cost is deliberately ignored. */
export function projectClaudeAccountUsage(
  usage: Pick<
    SDKControlGetUsageResponse,
    "rate_limits_available" | "rate_limits" | "subscription_type"
  >,
  account: AccountInfo,
): HarnessAccountSnapshot | null {
  if (!usage.rate_limits_available || !usage.rate_limits) return null;
  const limits = usage.rate_limits;
  const windows: Array<{
    product: string;
    periodType: AccountCreditsSnapshot["periodType"];
    usagePercent: number;
    resetsAt?: string;
  }> = [];
  const add = (
    product: string,
    periodType: AccountCreditsSnapshot["periodType"],
    value: { utilization: number | null; resets_at: string | null } | null | undefined,
  ): void => {
    if (
      !value ||
      typeof value.utilization !== "number" ||
      !Number.isFinite(value.utilization) ||
      value.utilization < 0 ||
      value.utilization > 100
    )
      return;
    windows.push({
      product,
      periodType,
      usagePercent: value.utilization,
      ...(value.resets_at && Number.isFinite(Date.parse(value.resets_at))
        ? { resetsAt: value.resets_at }
        : {}),
    });
  };
  add("5-hour window", "five_hour", limits.five_hour);
  add("7-day window", "seven_day", limits.seven_day);
  add("OAuth apps · 7-day", "seven_day", limits.seven_day_oauth_apps);
  add("Opus · 7-day", "seven_day", limits.seven_day_opus);
  add("Sonnet · 7-day", "seven_day", limits.seven_day_sonnet);
  for (const window of limits.model_scoped ?? [])
    add(`${window.display_name} · 7-day`, "seven_day", window);
  const [primary, ...others] = windows;
  if (!primary) return null;
  // Keep a model-scoped primary's label rather than presenting it as a global weekly limit.
  const genericPrimary = primary.product === "5-hour window" || primary.product === "7-day window";
  return {
    ...(account.email ? { email: account.email } : {}),
    ...(usage.subscription_type ? { plan: usage.subscription_type } : {}),
    credits: {
      usedPercent: primary.usagePercent,
      periodType: primary.periodType,
      ...(!genericPrimary ? { label: primary.product } : {}),
      ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
      ...(others.length
        ? {
            productUsage: others.map(({ product, usagePercent, resetsAt }) => ({
              product,
              usagePercent,
              ...(resetsAt ? { resetsAt } : {}),
            })),
          }
        : {}),
    },
  };
}
