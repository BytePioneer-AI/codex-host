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
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from "@deepseek-ai/dsh-client-ui-primitives";

import type { HostAccountCredits, HostThreadUsage } from "./usage.ts";
import css from "./HostUsageDock.module.css";

type HostUsageDockProps = PropsLocale<"codexhostImport"> & { useProjection: UseProjection };
type Translate = HostUsageDockProps["t"];

interface DetailRow {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly remaining?: number;
}

interface DetailGroup {
  readonly label: string;
  readonly rows: readonly DetailRow[];
}

const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

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

function resetTime(value: string | number | undefined, t: Translate): string | null {
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
  return t("usage.reset.at", { time });
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
  if (usage.totalTokens !== undefined)
    return [`${tokenCount(usage.totalTokens)} ${t("usage.unit.tokens")}`];
  const context = contextPercent(usage);
  if (context !== undefined) return [`${t("usage.context")}: ${percent(context)}`];
  return [];
}

function usageGroups(usage: HostThreadUsage | null, t: Translate): DetailGroup[] {
  const groups: DetailGroup[] = [];
  if (usage !== null) {
    const session: DetailRow[] = [];
    const formattedCost = cost(usage);
    if (formattedCost !== null)
      session.push({
        label: usage.costSource === "publicPrice" ? t("usage.cost.estimate") : t("usage.cost"),
        value: formattedCost,
        ...(usage.unpricedModels?.length
          ? { note: `${t("usage.unpriced")}: ${usage.unpricedModels.join(", ")}` }
          : {}),
      });
    if (usage.totalCredits !== undefined)
      session.push({ label: t("usage.credits"), value: credits(usage.totalCredits, t) });
    if (usage.sessionCacheHitRatePercent !== undefined)
      session.push({
        label: t("usage.cache.average"),
        value: percent(usage.sessionCacheHitRatePercent),
      });
    if (usage.cacheHitRatePercent !== undefined)
      session.push({
        label: t("usage.cache.latest"),
        value: percent(usage.cacheHitRatePercent),
      });
    if (session.length) groups.push({ label: t("usage.group.session"), rows: session });

    const turn: DetailRow[] = [];
    if (usage.outputTokensPerSecond !== undefined)
      turn.push({ label: t("usage.speed"), value: tokenRate(usage.outputTokensPerSecond, t) });
    else if (usage.apiOutputTokensPerSecond !== undefined)
      turn.push({
        label: t("usage.speed.api"),
        value: tokenRate(usage.apiOutputTokensPerSecond, t),
      });
    if (usage.timeToFirstOutputMs !== undefined)
      turn.push({ label: t("usage.ttft"), value: latency(usage.timeToFirstOutputMs, t) });
    if (turn.length) groups.push({ label: t("usage.group.turn"), rows: turn });

    const tokens: DetailRow[] = [];
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

function quotaGroups(
  usage: HostThreadUsage | null,
  account: HostAccountCredits | undefined,
  t: Translate,
): DetailGroup[] {
  const groups: DetailGroup[] = [];
  // Match Desktop: account credits is one complete quota view. Thread plan
  // fields are a fallback, not extra windows to append to that same account.
  if (!account && usage) {
    const plan: DetailRow[] = [];
    for (const [label, used, reset] of [
      [t("usage.plan.fiveHour"), usage.planFiveHourUsedPercent, usage.planFiveHourResetsAtUnix],
      [t("usage.plan.sevenDay"), usage.planSevenDayUsedPercent, usage.planSevenDayResetsAtUnix],
    ] as const) {
      if (used === undefined) continue;
      const at = resetTime(reset, t);
      plan.push({
        label,
        value: percent(remainingPercent(used)),
        remaining: remainingPercent(used),
        ...(at ? { note: at } : {}),
      });
    }
    if (plan.length) groups.push({ label: t("usage.group.plan"), rows: plan });
  }

  if (account) {
    const windowLabel = (
      period: HostAccountCredits["periodType"] | undefined,
      fallback: string,
      scope: unknown,
    ) =>
      !scope && period === "five_hour"
        ? t("usage.plan.fiveHour")
        : !scope && period === "seven_day"
          ? t("usage.plan.sevenDay")
          : fallback;
    const accountRows: DetailRow[] = [];
    const primary = quotaValue(account.used, account.limit, account.unit);
    accountRows.push({
      label: windowLabel(
        account.periodType,
        account.label ?? t("usage.group.quota"),
        account.scope,
      ),
      value: percent(remainingPercent(account.usedPercent)),
      remaining: remainingPercent(account.usedPercent),
      note: [primary ? `${t("usage.quota")}: ${primary}` : null, resetTime(account.resetsAt, t)]
        .filter(Boolean)
        .join(" · "),
    });
    if (account.resetCredits) {
      const expires = resetTime(account.resetCredits.nextExpiresAt, t);
      accountRows.push({
        label: t("usage.resetCredits"),
        value: String(account.resetCredits.availableCount),
        ...(expires ? { note: expires } : {}),
      });
    }
    for (const product of account.productUsage ?? []) {
      const productValue = quotaValue(product.used, product.limit, product.unit);
      accountRows.push({
        label: windowLabel(product.periodType, product.product, product.scope),
        value: percent(remainingPercent(product.usagePercent)),
        remaining: remainingPercent(product.usagePercent),
        note: [
          productValue ? `${t("usage.quota")}: ${productValue}` : null,
          resetTime(product.resetsAt, t),
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (accountRows.length) groups.push({ label: t("usage.group.quota"), rows: accountRows });
  }
  return groups;
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

/** Independent metrics and remaining-quota controls, backed by the same projection. */
export function HostUsageDock({ useProjection, t }: HostUsageDockProps) {
  const projection = useProjection("codexhostUsage");
  const usage = projection?.usage ?? null;
  const account = projection?.accountCredits;
  const summary = useMemo(() => summaryParts(usage, t), [usage, t]);
  const groups = useMemo(() => usageGroups(usage, t), [usage, t]);
  const quotas = useMemo(() => quotaGroups(usage, account, t), [usage, account, t]);
  const primary = quotas.flatMap((group) => group.rows).find((row) => row.remaining !== undefined);
  const hasContext = usage !== null && contextPercent(usage) !== undefined;
  const summaryText = summary.join(" · ");
  return (
    <>
      {primary && (
        <UsagePopover
          stat="codexhost-quota"
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
          {quotas.map((group) => (
            <section className={css.quotaGroup} key={group.label} aria-label={group.label}>
              {group.rows.map((row, index) => (
                <div
                  className={css.quotaRow}
                  key={`${row.label}:${index}`}
                  style={{ "--quota-color": quotaColor(row.remaining ?? 100) } as CSSProperties}
                >
                  <div className={css.quotaHeading}>
                    <div className={css.quotaDescription}>
                      <span>{row.label}</span>
                      {row.note && <p>{row.note}</p>}
                    </div>
                    <strong>
                      {row.remaining !== undefined && (
                        <span className={css.remainingLabel}>{t("usage.quota.remaining")} </span>
                      )}
                      <span className={css.remainingValue}>{row.value}</span>
                    </strong>
                  </div>
                  {row.remaining !== undefined && (
                    <div
                      className={css.progressTrack}
                      role="progressbar"
                      aria-label={`${row.label}: ${t("usage.quota.remaining")}`}
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
        </UsagePopover>
      )}
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
}: {
  stat: string;
  label: string;
  title: string;
  trigger: ReactNode;
  children: ReactNode;
  panelStyle?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const closeTimer = useRef<number | null>(null);
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
  const close = useCallback(() => {
    pinned.current = false;
    setOpen(false);
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const scheduleClose = useCallback(() => {
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
    }, 140);
  }, [cancelClose]);

  useDismissOnOutsidePointer(
    rootRef,
    open,
    (next) => {
      if (!next) close();
    },
    panelRef,
  );
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
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );
  return (
    <span
      ref={rootRef}
      className={css.anchor}
      data-composer-stat={stat}
      onPointerEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onPointerLeave={scheduleClose}
    >
      <button
        type="button"
        className={css.pill}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onFocus={() => {
          cancelClose();
          setOpen(true);
        }}
        onBlur={scheduleClose}
        onClick={() => {
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
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}
