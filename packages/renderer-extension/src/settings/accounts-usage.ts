import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

import { formatRendererCreditsReset, rendererCreditsTone } from "../renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../renderer-usage-control.js";
import { renderAccountResetTime } from "./accounts-reset-time.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export type AccountUsageViewState =
  | { readonly status: "loading" }
  | { readonly status: "empty" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly credits: AccountCreditsSnapshot;
      readonly freshness: "live" | "cached";
      readonly observedAt: string | null;
    };

export type AccountUsageDisplay = "used" | "remaining";
export type AccountUsageWindowFilter = "all" | "weekly-only";

export function creditsPeriodLabel(
  periodType: AccountCreditsSnapshot["periodType"],
  messages: RendererSettingsMessages,
): string {
  if (periodType === "weekly") return messages.accountCreditsPeriodWeekly;
  if (periodType === "monthly") return messages.accountCreditsPeriodMonthly;
  if (periodType === "five_hour") return messages.accountCreditsPeriodFiveHour;
  if (periodType === "seven_day") return messages.accountCreditsPeriodSevenDay;
  return messages.accountCreditsPeriodUnknown;
}

export function creditsProductLabel(product: string, messages: RendererSettingsMessages): string {
  if (product === "GrokBuild" || product === "Build") return messages.accountCreditsBuild;
  if (product === "5-hour window") return messages.accountCreditsPeriodFiveHour;
  if (product === "7-day window") return messages.accountCreditsPeriodSevenDay;
  if (product.endsWith(" · monthly"))
    return `${product.slice(0, -" · monthly".length)} · ${messages.accountCreditsPeriodMonthly}`;
  if (product === "GrokChat") return "Chat";
  if (product === "GrokImagine") return "Imagine";
  if (product === "GrokVoice") return "Voice";
  return product;
}

export function formatAccountCreditsReset(
  value: string,
  locale: RendererSettingsMessages["locale"],
  now: Date = new Date(),
): string {
  if (locale !== "zh-CN") return formatRendererCreditsReset(value, now);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function resetCreditDetailLine(
  index: number,
  expiresAt: string,
  messages: RendererSettingsMessages,
  now: Date = new Date(),
): string {
  return messages.accountResetCreditsCardExpiry
    .replace("{index}", String(index))
    .replace("{time}", formatAccountCreditsReset(expiresAt, messages.locale, now));
}

type AccountUsagePeriod = "five_hour" | "seven_day";

interface AccountUsageAmount {
  readonly used?: number | undefined;
  readonly limit?: number | undefined;
  readonly unit?: string | undefined;
}

interface AccountUsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | undefined;
  readonly scoped: boolean;
  readonly amount?: AccountUsageAmount;
}

interface AccountUsageRow {
  readonly scope?: string;
  readonly columns: Partial<Record<AccountUsagePeriod, AccountUsageWindow>>;
}

export function accountUsageColumnLabel(
  display: AccountUsageDisplay,
  messages: RendererSettingsMessages,
): string {
  return display === "remaining"
    ? messages.accountCreditsRemainingQuota
    : messages.accountCreditsUsedQuota;
}

function comparisonPeriod(
  periodType: AccountCreditsSnapshot["periodType"],
): AccountUsagePeriod | null {
  if (periodType === "five_hour") return "five_hour";
  if (periodType === "weekly" || periodType === "seven_day") return "seven_day";
  return null;
}

function scopedUsageProduct(product: string): {
  scope: string;
  period: AccountUsagePeriod;
} | null {
  const suffixes: ReadonlyArray<readonly [string, AccountUsagePeriod]> = [
    [" · 5-hour window", "five_hour"],
    [" · Weekly window", "seven_day"],
    [" · 7-day window", "seven_day"],
    [" · 5-hour", "five_hour"],
    [" · 7-day", "seven_day"],
  ];
  for (const [suffix, period] of suffixes) {
    if (!product.endsWith(suffix)) continue;
    const scope = product.slice(0, -suffix.length).trim();
    if (scope) return { scope, period };
  }
  return null;
}

/** Generic limits occupy the first row; related scoped limits add aligned quota-only rows. */
function splitUsageWindows(
  credits: AccountCreditsSnapshot,
  messages: RendererSettingsMessages,
  filter: AccountUsageWindowFilter,
): { rows: AccountUsageRow[]; additional: AccountUsageWindow[] } {
  const generic: AccountUsageRow = { columns: {} };
  const scopedRows = new Map<string, AccountUsageRow[]>();
  const additional: AccountUsageWindow[] = [];
  const addScoped = (
    scope: string,
    period: AccountUsagePeriod,
    window: AccountUsageWindow,
  ): void => {
    const rows = scopedRows.get(scope) ?? [];
    let row = rows.find((candidate) => !candidate.columns[period]);
    if (!row) {
      row = { scope, columns: {} };
      rows.push(row);
      scopedRows.set(scope, rows);
    }
    row.columns[period] = {
      ...window,
      label: `${scope} · ${creditsPeriodLabel(period, messages)}`,
      scoped: true,
    };
  };
  const addWindow = (
    window: AccountUsageWindow,
    period: AccountUsagePeriod | null,
    scope?: string,
  ): void => {
    if (scope && period) addScoped(scope, period, window);
    else if (!scope && period && !generic.columns[period]) generic.columns[period] = window;
    else additional.push(window);
  };

  const primary: AccountUsageWindow = {
    label: credits.label
      ? creditsProductLabel(credits.label, messages)
      : creditsPeriodLabel(credits.periodType, messages),
    usedPercent: credits.usedPercent,
    amount: credits,
    resetsAt: credits.resetsAt,
    scoped: Boolean(credits.label && scopedUsageProduct(credits.label)),
  };
  const primaryScope = credits.label ? scopedUsageProduct(credits.label) : null;
  addWindow(
    primary,
    primaryScope?.period ?? (credits.label ? null : comparisonPeriod(credits.periodType)),
    primaryScope?.scope,
  );

  for (const product of credits.productUsage ?? []) {
    const scoped = scopedUsageProduct(product.product);
    const window: AccountUsageWindow = {
      label: creditsProductLabel(product.product, messages),
      usedPercent: product.usagePercent,
      amount: product,
      resetsAt: product.resetsAt,
      scoped: Boolean(scoped),
    };
    const genericPeriod =
      product.product === "5-hour window"
        ? "five_hour"
        : product.product === "7-day window"
          ? "seven_day"
          : null;
    addWindow(window, scoped?.period ?? genericPeriod, scoped?.scope);
  }

  const structured = [...scopedRows.values()].flat();
  let rows = Object.keys(generic.columns).length > 0 ? [generic, ...structured] : structured;
  if (rows.length === 0) rows = [generic];
  if (filter === "weekly-only") {
    rows = rows
      .map((row) => ({
        ...row,
        columns: row.columns.seven_day ? { seven_day: row.columns.seven_day } : {},
      }))
      .filter((row) => row.columns.seven_day);
    if (rows.length === 0) rows = [{ columns: {} }];
    return { rows, additional: [] };
  }
  return { rows, additional };
}

function renderUsageWindow(
  document: Document,
  window: AccountUsageWindow,
  messages: RendererSettingsMessages,
  display: AccountUsageDisplay,
): HTMLElement {
  const meter = document.createElement("div");
  meter.className = window.scoped
    ? "settings-account-usage__meter settings-account-usage__meter--scoped"
    : "settings-account-usage__meter";
  const label = document.createElement("span");
  label.className = "settings-account-usage__title";
  label.textContent = window.label;
  label.title = window.label;
  const emptyCap = window.amount?.limit === 0;
  const value = emptyCap
    ? 0
    : display === "remaining"
      ? 100 - window.usedPercent
      : window.usedPercent;
  const valueLabel =
    display === "remaining" ? messages.accountCreditsRemaining : messages.accountCreditsUsed;
  const tone = rendererCreditsTone(window.usedPercent);
  const percent = document.createElement("div");
  percent.className = `settings-account-usage__percent settings-account-usage__percent--${tone}`;
  const number = document.createElement("span");
  number.textContent = emptyCap ? "—" : formatRendererCreditsPercent(value);
  const reset = window.resetsAt
    ? renderAccountResetTime(document, window.resetsAt, messages)
    : null;
  if (reset) percent.append(reset.countdown);
  percent.append(number);
  const bar = document.createElement("div");
  bar.className = `settings-account-usage__bar settings-account-usage__bar--${tone}`;
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-label", `${window.label} · ${valueLabel}`);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(value));
  const fill = document.createElement("span");
  fill.style.width = `${Math.min(100, Math.max(0, value))}%`;
  bar.append(fill);
  meter.append(label, percent, bar);
  const credits = window.amount;
  if (credits && credits.used !== undefined && credits.limit !== undefined && credits.unit) {
    const amount = document.createElement("div");
    amount.className = "settings-account-usage__sub";
    const quantity =
      display === "remaining" ? Math.max(0, credits.limit - credits.used) : credits.used;
    amount.textContent = `${quantity.toLocaleString(messages.locale)} / ${credits.limit.toLocaleString(messages.locale)} ${credits.unit}`;
    meter.append(amount);
  }
  if (reset) meter.append(reset.timestamp);
  return meter;
}

export function renderAccountUsage(
  document: Document,
  state: AccountUsageViewState | undefined,
  messages: RendererSettingsMessages,
  display: AccountUsageDisplay,
  onRetry: () => void,
  filter: AccountUsageWindowFilter = "all",
): {
  cells: HTMLTableCellElement[];
  continuationCells: HTMLTableCellElement[][];
} {
  if (state?.status !== "ready") {
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.className = "settings-account-usage-cell settings-account-usage-cell--message";
    const usage = document.createElement("div");
    usage.className = "settings-account-usage";
    const message = document.createElement("span");
    message.className = "settings-account-usage__message";
    message.textContent = !state
      ? "—"
      : state.status === "loading"
        ? messages.accountCreditsLoading
        : state.status === "error"
          ? messages.accountCreditsFailed
          : messages.accountCreditsEmpty;
    if (!state) message.title = messages.accountCreditsEmpty;
    usage.append(message);
    if (state?.status === "loading") usage.setAttribute("aria-busy", "true");
    if (state?.status === "error") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "settings-command-button settings-command-button--secondary";
      retry.textContent = messages.accountCreditsRetry;
      retry.addEventListener("click", onRetry);
      usage.append(retry);
    }
    cell.append(usage);
    return { cells: [cell], continuationCells: [] };
  }
  const { rows, additional } = splitUsageWindows(state.credits, messages, filter);
  // Non-comparison quotas use the same two physical columns, without inventing periods.
  const onlyRow = rows.length === 1 ? rows[0] : undefined;
  if (additional.length && onlyRow && !Object.keys(onlyRow.columns).length) rows.pop();
  for (let index = 0; index < additional.length; index += 2) {
    const first = additional[index];
    const second = additional[index + 1];
    rows.push({
      columns: {
        ...(first ? { five_hour: first } : {}),
        ...(second ? { seven_day: second } : {}),
      },
    });
  }
  const renderCells = (row: AccountUsageRow): HTMLTableCellElement[] =>
    (["five_hour", "seven_day"] as const).map((period) => {
      const cell = document.createElement("td");
      cell.className = "settings-account-usage-cell";
      const window = row.columns[period];
      if (window) cell.append(renderUsageWindow(document, window, messages, display));
      else {
        const missing = document.createElement("div");
        missing.className = "settings-account-usage__missing";
        const dash = document.createElement("span");
        dash.textContent = "—";
        dash.setAttribute("aria-hidden", "true");
        missing.append(dash);
        cell.append(missing);
      }
      return cell;
    });
  const [firstRow = { columns: {} }, ...continuations] = rows;
  const cells = renderCells(firstRow);
  const continuationCells = continuations.map(renderCells);
  return { cells, continuationCells };
}

export function renderAccountResetCredits(
  document: Document,
  credits: AccountCreditsSnapshot,
  messages: RendererSettingsMessages,
): { summary: HTMLButtonElement; details: HTMLElement } | null {
  const resetCredits = credits.resetCredits;
  if (!resetCredits) return null;
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "settings-account-reset-summary";
  summary.setAttribute("aria-label", messages.accountResetCreditsDetails);
  summary.title = messages.accountResetCreditsDetails;
  const count = document.createElement("span");
  count.textContent =
    messages.locale === "zh-CN"
      ? `${resetCredits.availableCount} 张`
      : String(resetCredits.availableCount);
  const label = document.createElement("span");
  label.textContent = messages.accountResetCredits;
  summary.append(
    createRendererSettingsIcon("ticket", 16),
    label,
    count,
    createRendererSettingsIcon("chevron-right", 14),
  );

  const details = document.createElement("div");
  details.className = "settings-account-reset-details";
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = messages.accountResetCredits;
  copy.append(heading);
  if (resetCredits.nextExpiresAt) {
    const next = document.createElement("p");
    next.className = "settings-account-reset-expiry";
    const reset = formatAccountCreditsReset(resetCredits.nextExpiresAt, messages.locale);
    next.textContent = messages.locale === "zh-CN" ? `最早 ${reset}到期` : `Next expires ${reset}`;
    const remaining = Date.parse(resetCredits.nextExpiresAt) - Date.now();
    if (remaining <= 24 * 60 * 60 * 1000) {
      next.className += remaining <= 8 * 60 * 60 * 1000 ? " is-hot" : " is-warn";
    }
    copy.append(next);
  }
  if (resetCredits.expiresAt?.length) {
    const list = document.createElement("ul");
    list.className = "settings-account-reset-list";
    for (const [index, expiresAt] of resetCredits.expiresAt.entries()) {
      const item = document.createElement("li");
      item.textContent = resetCreditDetailLine(index + 1, expiresAt, messages);
      list.append(item);
    }
    copy.append(list);
  }
  details.append(copy);
  return { summary, details };
}
