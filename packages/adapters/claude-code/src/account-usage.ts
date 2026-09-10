import type { AccountInfo, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessAccountSnapshot, AccountCreditsSnapshot } from "@codexhost/shared-contracts";

/** A per-model weekly window claude.ai reports only inside `rate_limits.limits[]`. */
export interface ClaudeScopedWeeklyLimit {
  /** Already suffixed for the Renderer's `" · 7-day window"` localization rule. */
  product: string;
  usagePercent: number;
  resetsAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `${displayName} · 7-day window` is the single spelling both call sites emit. */
export function claudeScopedWeeklyProduct(displayName: string): string {
  return `${displayName} · 7-day window`;
}

/**
 * `rate_limits.limits[]` is the only place claude.ai reports per-model weekly
 * windows (e.g. Fable); the older `model_scoped` key is absent from live
 * payloads and is not declared in the SDK's `.d.ts`, so the array is parsed
 * defensively from `unknown`. Entries without a model display name (the plain
 * `session` / `weekly_all` rows, which the caller already has) and entries with
 * an out-of-range percent are dropped; the first entry wins per display name.
 */
export function parseClaudeScopedWeeklyLimits(rateLimits: unknown): ClaudeScopedWeeklyLimit[] {
  if (!isRecord(rateLimits) || !Array.isArray(rateLimits.limits)) return [];
  const seen = new Set<string>();
  const scoped: ClaudeScopedWeeklyLimit[] = [];
  for (const entry of rateLimits.limits) {
    if (!isRecord(entry) || entry.kind !== "weekly_scoped") continue;
    const model = isRecord(entry.scope) && isRecord(entry.scope.model) ? entry.scope.model : null;
    const displayName = typeof model?.display_name === "string" ? model.display_name.trim() : "";
    if (displayName.length === 0) continue;
    const percent = entry.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)
      continue;
    const product = claudeScopedWeeklyProduct(displayName);
    if (seen.has(product)) continue;
    seen.add(product);
    const resetsAt = entry.resets_at;
    scoped.push({
      product,
      usagePercent: percent,
      ...(typeof resetsAt === "string" && Number.isFinite(Date.parse(resetsAt))
        ? { resetsAt }
        : {}),
    });
  }
  return scoped;
}

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
    add(claudeScopedWeeklyProduct(window.display_name), "seven_day", window);
  for (const scoped of parseClaudeScopedWeeklyLimits(limits)) {
    if (windows.some((window) => window.product === scoped.product)) continue;
    windows.push({
      product: scoped.product,
      periodType: "seven_day",
      usagePercent: scoped.usagePercent,
      ...(scoped.resetsAt ? { resetsAt: scoped.resetsAt } : {}),
    });
  }
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
