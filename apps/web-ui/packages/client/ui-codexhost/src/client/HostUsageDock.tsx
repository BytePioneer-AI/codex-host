import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { UseProjection } from "@deepseek-ai/dsh-api-session-controller/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  Tooltip,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from "@deepseek-ai/dsh-client-ui-primitives";

import {
  formatAccountCreditsCompactCountdown,
  formatAccountCreditsCompactExpiry,
  formatAccountCreditsResetCountdown,
  groupAccountCreditsWindows,
  localizeHarnessText,
} from "@codexhost/shared-contracts";

import type {} from "./SessionHarnessIcon.tsx";
import type { HostAccountCredits, HostThreadUsage } from "./usage.ts";
import css from "./HostUsageDock.module.css";

type HostUsageDockProps = PropsLocale<"codexhostImport"> & { useProjection: UseProjection };
type Translate = HostUsageDockProps["t"];

interface DetailRow {
  readonly label: string;
  readonly scopeLabel?: string;
  readonly value: string;
  readonly note?: string;
  readonly noteTitle?: string;
  readonly remaining?: number;
}

interface DetailGroup {
  readonly label: string;
  readonly title?: string;
  readonly rows: readonly DetailRow[];
}

const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };
const HOVER_OPEN_DELAY_MS = 160;
const HOVER_CLOSE_DELAY_MS = 140;
const TAP_SLOP_PX = 8;
/** Countdowns stay hidden until this little time remains. */
const INDICATOR_SHOW_WITHIN_SECONDS = 50 * 60;
const MAX_INDICATOR_TIMER_MS = 60 * 60 * 1_000;

function decimal(value: number, digits = 1): string {
  return value.toFixed(digits).replace(/\.?0+$/u, "");
}

function tokenCount(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${decimal(value / 1_000)}K`;
  if (value < 1_000_000_000) return `${decimal(value / 1_000_000)}M`;
  return `${decimal(value / 1_000_000_000)}B`;
}

function percent(value: number): string {
  return `${decimal(value)}%`;
}

function contextPercent(usage: HostThreadUsage): number | undefined {
  return (
    usage.contextUsagePercent ??
    (usage.contextUsedTokens !== undefined && usage.contextWindowTokens !== undefined
      ? (usage.contextUsedTokens / usage.contextWindowTokens) * 100
      : undefined)
  );
}

function tokenRate(value: number, t: Translate): string {
  return `${value >= 100 ? Math.round(value) : decimal(value)} ${t("usage.unit.tps")}`;
}

function latency(value: number, t: Translate): string {
  return value < 1_000
    ? `${Math.round(value)} ${t("usage.unit.ms")}`
    : `${decimal(value / 1_000)} ${t("usage.unit.seconds")}`;
}

function cost(usage: HostThreadUsage): string | null {
  if (usage.totalCostUsd === undefined) return null;
  const formatted = `$${usage.totalCostUsd.toFixed(usage.totalCostUsd >= 1 ? 2 : 3)}`;
  return usage.unpricedModels?.length ? `≥${formatted}` : formatted;
}

function credits(value: number, t: Translate): string {
  const amount = value > 0 && value < 0.001 ? "<0.001" : decimal(value, 3);
  return `${amount} ${t("usage.unit.credits")}`;
}

function resetTime(
  value: string | number | undefined,
  t: Translate,
  key: "usage.reset.at" | "usage.expires.at" = "usage.reset.at",
): string | null {
  if (value === undefined) return null;
  const date = new Date(typeof value === "number" ? value * 1_000 : value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const locale = t("usage.dateLocale");
  const time = today
    ? t("usage.reset.today", {
        time: date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }),
      })
    : date.toLocaleString(locale, {
        month: locale === "zh-CN" ? "long" : "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  return t(key, { time });
}

function quotaValue(used: number | undefined, limit: number | undefined, unit?: string): string {
  if (used === undefined || limit === undefined) return "";
  return `${decimal(used, 2)} / ${decimal(limit, 2)}${unit ? ` ${unit}` : ""}`;
}

function summaryParts(usage: HostThreadUsage | null, t: Translate): string[] {
  if (usage === null) return [];
  const result = [
    usage.cacheHitRatePercent === undefined
      ? null
      : `${t("usage.cache.short")} ${percent(usage.cacheHitRatePercent)}`,
    usage.outputTokensPerSecond !== undefined
      ? tokenRate(usage.outputTokensPerSecond, t)
      : usage.apiOutputTokensPerSecond !== undefined
        ? `API ${tokenRate(usage.apiOutputTokensPerSecond, t)}`
        : null,
    cost(usage),
  ].filter((value): value is string => value !== null);
  if (result.length > 0) return result;
  if (usage.sessionOutputTokensPerSecond !== undefined)
    return [tokenRate(usage.sessionOutputTokensPerSecond, t)];
  if (usage.totalTokens !== undefined)
    return [`${tokenCount(usage.totalTokens)} ${t("usage.unit.tokens")}`];
  const context = contextPercent(usage);
  if (context !== undefined) return [`${t("usage.context")}: ${percent(context)}`];
  return [];
}

function usageGroups(usage: HostThreadUsage | null, t: Translate): DetailGroup[] {
  const groups: DetailGroup[] = [];
  if (usage !== null) {
    const speed: DetailRow[] = [];
    if (usage.outputTokensPerSecond !== undefined)
      speed.push({
        label: t("usage.speed"),
        value: tokenRate(usage.outputTokensPerSecond, t),
      });
    else if (usage.apiOutputTokensPerSecond !== undefined)
      speed.push({
        label: t("usage.speed.api"),
        value: tokenRate(usage.apiOutputTokensPerSecond, t),
      });
    if (usage.sessionOutputTokensPerSecond !== undefined)
      speed.push({
        label: t("usage.speed.average"),
        value: tokenRate(usage.sessionOutputTokensPerSecond, t),
      });
    const ttft = usage.latestRequestTimeToFirstOutputMs ?? usage.timeToFirstOutputMs;
    if (ttft !== undefined) speed.push({ label: t("usage.ttft"), value: latency(ttft, t) });
    if (speed.length) groups.push({ label: t("usage.group.performance"), rows: speed });

    const cache: DetailRow[] = [];
    if (usage.cacheHitRatePercent !== undefined)
      cache.push({
        label: t("usage.cache.latest"),
        value: percent(usage.cacheHitRatePercent),
      });
    if (usage.sessionCacheHitRatePercent !== undefined)
      cache.push({
        label: t("usage.cache.average"),
        value: percent(usage.sessionCacheHitRatePercent),
      });
    if (cache.length) groups.push({ label: t("usage.group.cache"), rows: cache });

    const session: DetailRow[] = [];
    if (usage.totalCredits !== undefined)
      session.push({ label: t("usage.credits"), value: credits(usage.totalCredits, t) });
    if (session.length) groups.push({ label: t("usage.group.session"), rows: session });

    const tokens: DetailRow[] = [];
    const formattedCost = cost(usage);
    if (formattedCost !== null)
      tokens.push({
        label: usage.costSource === "publicPrice" ? t("usage.cost.estimate") : t("usage.cost"),
        value: formattedCost,
        ...(usage.unpricedModels?.length
          ? { note: `${t("usage.unpriced")}: ${usage.unpricedModels.join(", ")}` }
          : {}),
      });
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
      tokens.push({
        label: t("usage.tokens.io"),
        value: `${usage.inputTokens === undefined ? "—" : tokenCount(usage.inputTokens)} / ${usage.outputTokens === undefined ? "—" : tokenCount(usage.outputTokens)}`,
      });
    if (usage.cachedInputTokens !== undefined || usage.cacheWriteInputTokens !== undefined)
      tokens.push({
        label:
          usage.cacheWriteInputTokens !== undefined && usage.cacheWriteInputTokens > 0
            ? t("usage.tokens.cacheReadWrite")
            : t("usage.tokens.cacheRead"),
        value:
          usage.cacheWriteInputTokens !== undefined && usage.cacheWriteInputTokens > 0
            ? `${usage.cachedInputTokens === undefined ? "—" : tokenCount(usage.cachedInputTokens)} / ${tokenCount(usage.cacheWriteInputTokens)}`
            : tokenCount(usage.cachedInputTokens ?? 0),
      });
    if (usage.totalTokens !== undefined)
      tokens.push({ label: t("usage.tokens.total"), value: tokenCount(usage.totalTokens) });
    if (tokens.length) groups.push({ label: t("usage.group.tokens"), rows: tokens });
  }
  return groups;
}

function remainingPercent(used: number): number {
  return Math.min(100, Math.max(0, 100 - used));
}

function quotaColor(remaining: number): string {
  return remaining <= 10 ? "#c45c4a" : remaining <= 30 ? "#c9a227" : "#3d9a64";
}

function resetCreditsColor(nextExpiresAt: string | undefined, nowMs: number): string {
  if (!nextExpiresAt) return "#3d9a64";
  const timestamp = Date.parse(nextExpiresAt);
  if (!Number.isFinite(timestamp)) return "#3d9a64";
  const remainingMs = timestamp - nowMs;
  if (remainingMs <= 8 * 60 * 60 * 1_000) return "#c45c4a";
  if (remainingMs <= 24 * 60 * 60 * 1_000) return "#c9a227";
  return "#3d9a64";
}

function quotaGroups(
  usage: HostThreadUsage | null,
  account: HostAccountCredits | undefined,
  t: Translate,
  nowMs: number,
): DetailGroup[] {
  const groups: DetailGroup[] = [];
  const locale = t("usage.dateLocale");
  const resetSummary = (
    value: string | number | undefined,
  ): { text: string | null; title: string | undefined } => {
    if (value === undefined) return { text: null, title: undefined };
    const exact = resetTime(value, t) ?? undefined;
    const countdown = formatAccountCreditsResetCountdown(value, locale, nowMs);
    return { text: countdown ?? exact ?? null, title: exact };
  };
  // Match Desktop: account credits is one complete quota view. Thread plan
  // fields are a fallback, not extra windows to append to that same account.
  if (!account && usage) {
    const plan: DetailRow[] = [];
    for (const [label, used, reset] of [
      [t("usage.plan.fiveHour"), usage.planFiveHourUsedPercent, usage.planFiveHourResetsAtUnix],
      [t("usage.plan.sevenDay"), usage.planSevenDayUsedPercent, usage.planSevenDayResetsAtUnix],
    ] as const) {
      if (used === undefined) continue;
      const at = resetSummary(reset);
      plan.push({
        label,
        value: percent(remainingPercent(used)),
        remaining: remainingPercent(used),
        ...(at.text ? { note: at.text } : {}),
        ...(at.title ? { noteTitle: at.title } : {}),
      });
    }
    if (plan.length) groups.push({ label: t("usage.group.plan"), rows: plan });
  }

  if (account) {
    const periodLabel = (period: HostAccountCredits["periodType"]): string => {
      if (period === "five_hour") return t("usage.plan.fiveHour");
      if (period === "seven_day") return t("usage.plan.sevenDay");
      if (period === "weekly") return t("usage.plan.weekly");
      if (period === "monthly") return t("usage.plan.monthly");
      return t("usage.group.quota");
    };
    const groupedPeriodLabel = (period: HostAccountCredits["periodType"]): string => {
      if (period === "five_hour") return t("usage.plan.fiveHour.short");
      if (period === "seven_day") return t("usage.plan.sevenDay.short");
      if (period === "weekly") return t("usage.plan.weekly.short");
      if (period === "monthly") return t("usage.plan.monthly.short");
      return t("usage.group.quota");
    };
    const sections = groupAccountCreditsWindows(account, locale, periodLabel, groupedPeriodLabel);
    for (const [sectionIndex, section] of sections.entries()) {
      const isGrouped = section.title !== undefined;
      const accountRows: DetailRow[] = [];
      for (const window of section.windows) {
        const amount = quotaValue(window.used, window.limit, window.unit);
        const at = isGrouped
          ? {
              text:
                window.resetsAt !== undefined && window.usedPercent > 0
                  ? (formatAccountCreditsCompactCountdown(window.resetsAt, locale, nowMs) ??
                    resetTime(window.resetsAt, t))
                  : null,
              title:
                window.resetsAt === undefined
                  ? undefined
                  : (resetTime(window.resetsAt, t) ?? undefined),
            }
          : resetSummary(window.resetsAt);
        const note = [
          amount ? (isGrouped ? amount : `${t("usage.quota")}: ${amount}`) : null,
          at.text,
        ]
          .filter(Boolean)
          .join(" · ");
        accountRows.push({
          label: window.label,
          ...(window.scopeLabel ? { scopeLabel: window.scopeLabel } : {}),
          value: percent(remainingPercent(window.usedPercent)),
          remaining: remainingPercent(window.usedPercent),
          ...(note ? { note } : {}),
          ...(at.title ? { noteTitle: at.title } : {}),
        });
      }
      if (accountRows.length) {
        groups.push({
          label:
            section.title ??
            (sectionIndex === 0
              ? t("usage.group.quota")
              : `${t("usage.group.quota")}-${sectionIndex}`),
          ...(section.title ? { title: section.title } : {}),
          rows: accountRows,
        });
      }
    }
  }
  return groups;
}

function ResetCreditsFooter({
  resetCredits,
  t,
  nowMs,
}: {
  resetCredits: NonNullable<HostAccountCredits["resetCredits"]>;
  t: Translate;
  nowMs: number;
}) {
  const locale = t("usage.dateLocale");
  const exactExpiry = resetTime(resetCredits.nextExpiresAt, t, "usage.expires.at") ?? undefined;
  const compactExpiry =
    resetCredits.nextExpiresAt !== undefined
      ? (formatAccountCreditsCompactExpiry(resetCredits.nextExpiresAt, locale, nowMs) ??
        exactExpiry)
      : null;
  const color = resetCreditsColor(resetCredits.nextExpiresAt, nowMs);
  return (
    <div
      className={css.resetCreditsFooter}
      style={{ "--reset-credits-color": color } as CSSProperties}
    >
      <span className={css.resetCreditsLeft} title={exactExpiry}>
        <svg className={css.resetCreditsIcon} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.25 5.25a1 1 0 0 1 1-1h9.5a1 1 0 0 1 1 1v1.45a1.3 1.3 0 0 0 0 2.6v1.45a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1V9.3a1.3 1.3 0 0 0 0-2.6V5.25Z" />
          <path d="M6 4.5v7" strokeDasharray="1.5 1.8" />
        </svg>
        <span className={css.resetCreditsCopy}>
          <span>{t("usage.resetCredits.short")}</span>
          {compactExpiry && <span className={css.resetCreditsExpiry}> · {compactExpiry}</span>}
        </span>
      </span>
      <span className={css.resetCreditsPill}>
        {t("usage.resetCredits.count", { count: String(resetCredits.availableCount) })}
      </span>
    </div>
  );
}

function ContextSummary({ usage, t }: { usage: HostThreadUsage | null; t: Translate }) {
  if (usage === null) return null;
  const usedPercent = contextPercent(usage);
  if (usedPercent === undefined) return null;
  const value =
    usage.contextWindowTokens === undefined
      ? percent(usedPercent)
      : `${percent(usedPercent)} / ${tokenCount(usage.contextWindowTokens)}`;
  return (
    <section className={css.context}>
      <div className={css.contextRow}>
        <span>{t("usage.context")}</span>
        <strong>{value}</strong>
      </div>
      <div
        className={css.progressTrack}
        role="progressbar"
        aria-label={t("usage.context")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.max(0, usedPercent))}
      >
        <span
          className={css.progressFill}
          style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }}
        />
      </div>
    </section>
  );
}

function DetailGroups({ groups }: { groups: readonly DetailGroup[] }): ReactNode {
  return groups.map((group) => (
    <section className={css.group} key={group.label}>
      <h3>{group.label}</h3>
      <dl>
        {group.rows.map((row) => (
          <div className={css.detail} key={`${row.label}:${row.value}`}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
            {row.note && <p>{row.note}</p>}
          </div>
        ))}
      </dl>
    </section>
  ));
}

function ComposerIndicators({
  indicators,
  t,
}: {
  indicators: HostThreadUsage["composerIndicators"];
  t: Translate;
}) {
  const [tick, setTick] = useState(0);
  const [clipped, setClipped] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const nowMs = Date.now();
  const nowSec = nowMs / 1_000;
  const pending = indicators?.filter(({ expiresAtUnix }) => expiresAtUnix > nowSec) ?? [];
  const active = pending.filter(
    ({ expiresAtUnix }) => expiresAtUnix - nowSec <= INDICATOR_SHOW_WITHIN_SECONDS,
  );
  const nextRefreshMs =
    pending.length === 0
      ? null
      : Math.min(
          MAX_INDICATOR_TIMER_MS,
          Math.min(
            ...pending.map(({ expiresAtUnix }) => {
              const remainingMs = expiresAtUnix * 1_000 - nowMs;
              if (remainingMs > INDICATOR_SHOW_WITHIN_SECONDS * 1_000) {
                return remainingMs - INDICATOR_SHOW_WITHIN_SECONDS * 1_000;
              }
              return remainingMs % 60_000 || 60_000;
            }),
          ) + 50,
        );

  useEffect(() => {
    if (nextRefreshMs === null) return;
    const bump = (): void => setTick((value) => value + 1);
    const timer = window.setTimeout(bump, nextRefreshMs);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [indicators, nextRefreshMs, tick]);

  useEffect(() => {
    const el = rootRef.current;
    if (el === null) {
      setClipped(false);
      return;
    }
    const dock = el.closest<HTMLElement>("[data-composer-dock]");
    const container = dock?.parentElement ?? dock;
    const check = (): void => {
      setClipped((current) => {
        if (!current) return el.scrollWidth > el.clientWidth + 0.5;
        if (!dock || !container) return false;
        const containerStyle = window.getComputedStyle(container);
        const available =
          container.clientWidth -
          (parseFloat(containerStyle.paddingLeft) || 0) -
          (parseFloat(containerStyle.paddingRight) || 0);
        const gap = parseFloat(window.getComputedStyle(dock).columnGap) || 0;
        const needed = dock.scrollWidth + (dock.scrollWidth > 0 ? gap : 0) + el.scrollWidth;
        return needed > available - 2;
      });
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (dock) observer.observe(dock);
    if (container && container !== dock) observer.observe(container);
    return () => observer.disconnect();
  }, [active.length]);

  if (active.length === 0) return null;
  const locale = t("usage.dateLocale");
  return (
    <span
      ref={rootRef}
      className={`${css.anchor} ${css.indicatorGroup}`}
      data-composer-stat="codexhost-indicators"
      data-clipped={clipped || undefined}
    >
      {active.map((indicator) => {
        const minutes = Math.ceil((indicator.expiresAtUnix - nowSec) / 60);
        const remaining = t("usage.indicator.remaining", { minutes: String(minutes) });
        const label = indicator.label ? localizeHarnessText(indicator.label, locale) : "";
        const tooltip = indicator.tooltip ? localizeHarnessText(indicator.tooltip, locale) : "";
        const summary = [label, tooltip, remaining].filter(Boolean).join(" · ");
        return (
          <Tooltip
            key={indicator.id}
            label={summary}
            side="top"
            portal
            openOnClick
            disabled={clipped}
          >
            <button
              type="button"
              className={`${css.pill} ${css.indicatorPill}`}
              data-indicator-id={indicator.id}
              aria-label={summary}
            >
              <svg className={css.indicatorIcon} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" />
              </svg>
              <span>{`${minutes}m`}</span>
            </button>
          </Tooltip>
        );
      })}
    </span>
  );
}

/** Independent metrics and remaining-quota controls, backed by the same projection. */
export function HostUsageDock({ useProjection, t }: HostUsageDockProps) {
  const projection = useProjection("codexhostUsage");
  const harness = useProjection("harnessIdentity");
  const usage = projection?.usage ?? null;
  const account = projection?.accountCredits;
  const indicators = harness?.id === "codex" ? undefined : usage?.composerIndicators;
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!quotaOpen) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [quotaOpen]);
  const summary = useMemo(() => summaryParts(usage, t), [usage, t]);
  const groups = useMemo(() => usageGroups(usage, t), [usage, t]);
  const quotas = useMemo(() => quotaGroups(usage, account, t, nowMs), [usage, account, t, nowMs]);
  const firstScopedIndex = useMemo(
    () => quotas.findIndex((group) => group.title !== undefined),
    [quotas],
  );
  const primary = quotas.flatMap((group) => group.rows).find((row) => row.remaining !== undefined);
  const hasContext = usage !== null && contextPercent(usage) !== undefined;
  const summaryText = summary.join(" · ");
  return (
    <>
      {primary && (
        <UsagePopover
          stat="codexhost-quota"
          onOpenChange={setQuotaOpen}
          panelStyle={{ "--quota-color": quotaColor(primary.remaining ?? 100) } as CSSProperties}
          label={`${t("usage.quota.remaining")}: ${primary.value}`}
          title={t("usage.quota.details")}
          trigger={
            <>
              <svg
                className={css.quotaRing}
                style={{ stroke: quotaColor(primary.remaining ?? 100) }}
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <circle className={css.ringTrack} cx="10" cy="10" r="7" />
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  pathLength="100"
                  strokeDasharray={`${primary.remaining} 100`}
                  transform="rotate(-90 10 10)"
                />
              </svg>
              <span>{primary.value}</span>
            </>
          }
        >
          {quotas.map((group, groupIndex) => (
            <section
              className={css.quotaGroup}
              data-scoped-group={group.title ? "" : undefined}
              key={group.label}
              aria-label={group.label}
            >
              {group.title && <h4 className={css.quotaGroupTitle}>{group.title}</h4>}
              {group.rows.map((row, index) => (
                <div
                  className={css.quotaRow}
                  data-hero-row={groupIndex === firstScopedIndex && index === 0 ? "" : undefined}
                  key={`${row.scopeLabel ?? ""}:${row.label}:${index}`}
                  style={{ "--quota-color": quotaColor(row.remaining ?? 100) } as CSSProperties}
                >
                  <div className={css.quotaHeading}>
                    <div
                      className={css.quotaDescription}
                      title={group.title && !row.note ? row.noteTitle : undefined}
                    >
                      <span>
                        {row.scopeLabel ? (
                          <>
                            <span>{row.scopeLabel}</span> · {row.label}
                          </>
                        ) : (
                          row.label
                        )}
                      </span>
                      {group.title
                        ? row.note && (
                            <span className={css.quotaInlineNote} title={row.noteTitle}>
                              · {row.note}
                            </span>
                          )
                        : row.note && <p title={row.noteTitle}>{row.note}</p>}
                    </div>
                    <strong>
                      {row.remaining !== undefined && !group.title && (
                        <span className={css.remainingLabel}>{t("usage.quota.remaining")} </span>
                      )}
                      <span className={css.remainingValue}>{row.value}</span>
                    </strong>
                  </div>
                  {row.remaining !== undefined && (
                    <div
                      className={css.progressTrack}
                      role="progressbar"
                      aria-label={`${row.scopeLabel ? `${row.scopeLabel} · ${row.label}` : row.label}: ${t("usage.quota.remaining")}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={row.remaining}
                    >
                      <span className={css.quotaFill} style={{ width: `${row.remaining}%` }} />
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
          {account?.resetCredits && (
            <ResetCreditsFooter resetCredits={account.resetCredits} t={t} nowMs={nowMs} />
          )}
        </UsagePopover>
      )}
      <ComposerIndicators indicators={indicators} t={t} />
      {summary.length > 0 && (groups.length > 0 || hasContext) && (
        <UsagePopover
          stat="codexhost-usage"
          label={`${t("usage.title")}: ${summaryText}`}
          title={t("usage.details")}
          trigger={<span className={css.label}>{summaryText}</span>}
        >
          <header>{t("usage.title")}</header>
          <ContextSummary usage={usage} t={t} />
          <DetailGroups groups={groups} />
        </UsagePopover>
      )}
    </>
  );
}

function UsagePopover({
  stat,
  label,
  title,
  trigger,
  children,
  panelStyle,
  onOpenChange,
}: {
  stat: string;
  label: string;
  title: string;
  trigger: ReactNode;
  children: ReactNode;
  panelStyle?: CSSProperties;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);
  const pinned = useRef(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const tapOrigin = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const position = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: "top",
    gap: 8,
    margin: 12,
  });
  const cancelOpen = useCallback(() => {
    if (openTimer.current === null) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const close = useCallback(() => {
    cancelOpen();
    cancelClose();
    pinned.current = false;
    setOpen(false);
  }, [cancelClose, cancelOpen]);
  const scheduleOpen = useCallback(() => {
    cancelClose();
    if (open) return;
    cancelOpen();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  }, [cancelClose, cancelOpen, open]);
  const scheduleClose = useCallback(() => {
    cancelOpen();
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (
        !pinned.current &&
        rootRef.current?.matches(":hover") !== true &&
        panelRef.current?.matches(":hover") !== true &&
        !rootRef.current?.contains(document.activeElement)
      )
        setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelClose, cancelOpen]);

  useDismissOnOutsidePointer(rootRef, open, close, panelRef);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);
  useEffect(
    () => () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );
  return (
    <span
      ref={rootRef}
      className={css.anchor}
      data-composer-stat={stat}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        scheduleOpen();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        scheduleClose();
      }}
    >
      <button
        type="button"
        className={css.pill}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onFocus={(event) => {
          if (!event.currentTarget.matches(":focus-visible")) return;
          cancelClose();
          setOpen(true);
        }}
        onBlur={scheduleClose}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") {
            tapOrigin.current = null;
            return;
          }
          tapOrigin.current = { x: event.clientX, y: event.clientY, moved: false };
        }}
        onPointerMove={(event) => {
          const origin = tapOrigin.current;
          if (!origin || origin.moved) return;
          if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > TAP_SLOP_PX) {
            origin.moved = true;
          }
        }}
        onPointerCancel={() => {
          if (tapOrigin.current) tapOrigin.current.moved = true;
        }}
        onClick={() => {
          const origin = tapOrigin.current;
          tapOrigin.current = null;
          if (origin?.moved) return;
          cancelOpen();
          cancelClose();
          if (open && pinned.current) close();
          else {
            pinned.current = true;
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={`${css.panel} ${stat === "codexhost-quota" ? css.quotaPanel : ""}`}
            style={{ ...panelStyle, ...(position ?? MEASURE_STYLE) }}
            role="dialog"
            aria-label={title}
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse") return;
              cancelClose();
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== "mouse") return;
              scheduleClose();
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}
