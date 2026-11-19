import { localizeHarnessPresentation } from "./harness-presentation.js";
import type { AccountCreditsSnapshot } from "./thread-usage.js";

type CreditsWindow = {
  [K in "label" | "periodType" | "scope" | "localizations"]?: AccountCreditsSnapshot[K] | undefined;
} & { product?: string | undefined };

export interface AccountCreditsPresentedWindow {
  readonly label: string;
  readonly scopeLabel?: string;
  readonly usedPercent: number;
  readonly used?: number;
  readonly limit?: number;
  readonly unit?: string;
  readonly resetsAt?: string;
  readonly isPrimary: boolean;
}

export interface AccountCreditsPresentedSection {
  readonly id?: string;
  readonly title?: string;
  readonly windows: readonly AccountCreditsPresentedWindow[];
}

/** Shared by clients; never parses product names or recognizes a Harness ID. */
export function accountCreditsWindowLabel(
  window: CreditsWindow,
  locale: string,
  periodLabel: (period: AccountCreditsSnapshot["periodType"]) => string,
): string {
  if (window.periodType && window.periodType !== "unknown" && (window.scope || !window.label)) {
    const period = periodLabel(window.periodType);
    return window.scope
      ? `${localizeHarnessPresentation(window.scope, locale).label} · ${period}`
      : period;
  }
  return localizeHarnessPresentation(
    {
      label: window.label ?? window.product ?? periodLabel("unknown"),
      ...(window.localizations ? { localizations: window.localizations } : {}),
    },
    locale,
  ).label;
}

function periodOrder(periodType: AccountCreditsSnapshot["periodType"] | undefined): number {
  if (periodType === "five_hour") return 0;
  if (periodType === "seven_day") return 1;
  if (periodType === "weekly") return 2;
  if (periodType === "monthly") return 3;
  return 4;
}

/**
 * Groups multi-window scopes under a shared section header so popovers do not
 * repeat long model-group prefixes on every row, while keeping single-pool and
 * single-window scopes flat.
 */
export function groupAccountCreditsWindows(
  credits: AccountCreditsSnapshot,
  locale: string,
  periodLabel: (period: AccountCreditsSnapshot["periodType"]) => string,
  groupedPeriodLabel: (period: AccountCreditsSnapshot["periodType"]) => string = periodLabel,
): AccountCreditsPresentedSection[] {
  const entries = [
    {
      label: credits.label,
      periodType: credits.periodType,
      scope: credits.scope,
      localizations: credits.localizations,
      usedPercent: credits.usedPercent,
      used: credits.used,
      limit: credits.limit,
      unit: credits.unit,
      resetsAt: credits.resetsAt,
      isPrimary: true,
    },
    ...(credits.productUsage ?? []).map((item) => ({
      product: item.product,
      periodType: item.periodType,
      scope: item.scope,
      localizations: item.localizations,
      usedPercent: item.usagePercent,
      used: item.used,
      limit: item.limit,
      unit: item.unit,
      resetsAt: item.resetsAt,
      isPrimary: false,
    })),
  ];

  const scopeCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.scope) scopeCounts.set(entry.scope.id, (scopeCounts.get(entry.scope.id) ?? 0) + 1);
  }

  const sections = new Map<
    string,
    {
      id?: string;
      title?: string;
      windows: Array<{ window: AccountCreditsPresentedWindow; order: number }>;
    }
  >();
  for (const entry of entries) {
    const groupedScope =
      entry.scope && (scopeCounts.get(entry.scope.id) ?? 0) >= 2 ? entry.scope : undefined;
    const key = groupedScope ? `scope:${groupedScope.id}` : "default";
    let section = sections.get(key);
    if (!section) {
      section = groupedScope
        ? {
            id: groupedScope.id,
            title: localizeHarnessPresentation(groupedScope, locale).label,
            windows: [],
          }
        : { windows: [] };
      sections.set(key, section);
    }

    const inlineScope =
      !groupedScope && entry.scope && entry.periodType && entry.periodType !== "unknown"
        ? localizeHarnessPresentation(entry.scope, locale).label
        : undefined;
    const label =
      groupedScope && entry.periodType && entry.periodType !== "unknown"
        ? groupedPeriodLabel(entry.periodType)
        : inlineScope && entry.periodType && entry.periodType !== "unknown"
          ? periodLabel(entry.periodType)
          : accountCreditsWindowLabel(entry, locale, periodLabel);

    section.windows.push({
      order: groupedScope ? periodOrder(entry.periodType) : 0,
      window: {
        label,
        ...(inlineScope ? { scopeLabel: inlineScope } : {}),
        usedPercent: entry.usedPercent,
        ...(entry.used === undefined ? {} : { used: entry.used }),
        ...(entry.limit === undefined ? {} : { limit: entry.limit }),
        ...(entry.unit === undefined ? {} : { unit: entry.unit }),
        ...(entry.resetsAt === undefined ? {} : { resetsAt: entry.resetsAt }),
        isPrimary: entry.isPrimary,
      },
    });
  }

  return [...sections.values()].map(({ windows, ...section }) => ({
    ...section,
    windows: (section.title !== undefined
      ? [...windows].sort((left, right) => left.order - right.order)
      : windows
    ).map((item) => item.window),
  }));
}

function countdownMinutes(value: string | number, nowMs: number): number | null {
  const timestamp = typeof value === "number" ? value * 1_000 : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - nowMs) / 60_000));
}

function isChineseLocale(locale: string): boolean {
  return locale === "zh-CN" || locale.startsWith("zh-");
}

function compactDurationText(minutes: number): string {
  if (minutes >= 1_440) {
    const days = Math.floor(minutes / 1_440);
    const hours = Math.floor((minutes % 1_440) / 60);
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/**
 * Formats a quota reset timestamp as a compact remaining duration (at most two
 * units, rounded up to whole minutes) without implying an unconfirmed refresh.
 */
export function formatAccountCreditsResetCountdown(
  value: string | number,
  locale: string,
  nowMs: number = Date.now(),
): string | null {
  const minutes = countdownMinutes(value, nowMs);
  if (minutes === null) return null;
  const chinese = isChineseLocale(locale);
  if (minutes === 0) return chinese ? "即将重置" : "Resets soon";
  if (minutes >= 1_440) {
    const days = Math.floor(minutes / 1_440);
    const hours = Math.floor((minutes % 1_440) / 60);
    if (chinese) return hours > 0 ? `${days} 天 ${hours} 小时后重置` : `${days} 天后重置`;
    return hours > 0 ? `Resets in ${days}d ${hours}h` : `Resets in ${days}d`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) {
    if (chinese) return mins > 0 ? `${hours} 小时 ${mins} 分后重置` : `${hours} 小时后重置`;
    return mins > 0 ? `Resets in ${hours}h ${mins}m` : `Resets in ${hours}h`;
  }
  return chinese ? `${mins} 分钟后重置` : `Resets in ${mins}m`;
}

/**
 * Short inline duration token (e.g. `3h48m`, `6d4h`, `28m`) for compact
 * multi-group quota rows where the period label shares the same line.
 */
export function formatAccountCreditsCompactCountdown(
  value: string | number,
  locale: string,
  nowMs: number = Date.now(),
): string | null {
  const minutes = countdownMinutes(value, nowMs);
  if (minutes === null) return null;
  if (minutes === 0) return isChineseLocale(locale) ? "即将重置" : "Resets soon";
  return compactDurationText(minutes);
}

/**
 * Short inline expiry phrase (e.g. `15d4h 后到期`, `in 15d4h`) for footer
 * badges that sit alongside reset-credit counts.
 */
export function formatAccountCreditsCompactExpiry(
  value: string | number,
  locale: string,
  nowMs: number = Date.now(),
): string | null {
  const minutes = countdownMinutes(value, nowMs);
  if (minutes === null) return null;
  const chinese = isChineseLocale(locale);
  if (minutes === 0) return chinese ? "即将到期" : "expires soon";
  const compact = compactDurationText(minutes);
  return chinese ? `${compact} 后到期` : `in ${compact}`;
}
