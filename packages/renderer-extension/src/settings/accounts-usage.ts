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
  | { readonly status: "ready"; readonly credits: AccountCreditsSnapshot };

export type AccountUsageDisplay = "used" | "remaining";

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
  if (product === "7-day window") return messages.accountCreditsPeriodSevenDay;
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

interface AccountUsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | undefined;
}

export function accountUsageColumnLabel(
  period: "five_hour" | "seven_day",
  display: AccountUsageDisplay,
  messages: RendererSettingsMessages,
): string {
  const mode =
    display === "remaining" ? messages.accountCreditsRemaining : messages.accountCreditsUsed;
  return `${creditsPeriodLabel(period, messages)}${messages.locale === "zh-CN" ? "" : " "}${mode}`;
}

/** Only generic windows occupy the comparison columns; scoped labels are never totals. */
function splitUsageWindows(credits: AccountCreditsSnapshot, messages: RendererSettingsMessages) {
  const columns: Partial<Record<"five_hour" | "seven_day", AccountUsageWindow>> = {};
  const additional: AccountUsageWindow[] = [];
  const primary: AccountUsageWindow = {
    label: credits.label ?? creditsPeriodLabel(credits.periodType, messages),
    usedPercent: credits.usedPercent,
    resetsAt: credits.resetsAt,
  };
  if (!credits.label && credits.periodType === "five_hour") columns.five_hour = primary;
  else if (!credits.label && ["seven_day", "weekly"].includes(credits.periodType))
    columns.seven_day = { ...primary, label: messages.accountCreditsPeriodSevenDay };
  else additional.push(primary);
  for (const product of credits.productUsage ?? []) {
    const window: AccountUsageWindow = {
      label: creditsProductLabel(product.product, messages),
      usedPercent: product.usagePercent,
      resetsAt: product.resetsAt,
    };
    // These exact public labels are shared by native Codex and Harness projections.
    // Do not infer a global window from arbitrary model/product names containing "7-day".
    const period =
      product.product === "7-day window"
        ? "seven_day"
        : product.product === "5-hour window"
          ? "five_hour"
          : null;
    if (period && !columns[period])
      columns[period] = { ...window, label: creditsPeriodLabel(period, messages) };
    else additional.push(window);
  }
  return { columns, additional };
}

function renderUsageWindow(
  document: Document,
  window: AccountUsageWindow,
  messages: RendererSettingsMessages,
  display: AccountUsageDisplay,
): HTMLElement {
  const meter = document.createElement("div");
  meter.className = "settings-account-usage__meter";
  const label = document.createElement("span");
  label.className = "settings-account-usage__title";
  label.textContent = window.label;
  label.title = window.label;
  const value = display === "remaining" ? 100 - window.usedPercent : window.usedPercent;
  const valueLabel =
    display === "remaining" ? messages.accountCreditsRemaining : messages.accountCreditsUsed;
  const tone = rendererCreditsTone(window.usedPercent);
  const percent = document.createElement("div");
  percent.className = `settings-account-usage__percent settings-account-usage__percent--${tone}`;
  const number = document.createElement("span");
  number.textContent = formatRendererCreditsPercent(value);
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
  if (reset) meter.append(reset.timestamp);
  return meter;
}

export function renderAccountUsage(
  document: Document,
  state: AccountUsageViewState | undefined,
  messages: RendererSettingsMessages,
  display: AccountUsageDisplay,
  onRetry: () => void,
): { cells: HTMLTableCellElement[]; additional: HTMLElement | null } {
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
    return { cells: [cell], additional: null };
  }
  const { columns, additional } = splitUsageWindows(state.credits, messages);
  const cells = (["five_hour", "seven_day"] as const).map((period) => {
    const cell = document.createElement("td");
    cell.className = "settings-account-usage-cell";
    const window = columns[period];
    if (window) cell.append(renderUsageWindow(document, window, messages, display));
    else {
      const missing = document.createElement("div");
      missing.className = "settings-account-usage__missing";
      const label = document.createElement("span");
      label.className = "settings-account-usage__title";
      label.textContent = creditsPeriodLabel(period, messages);
      const dash = document.createElement("span");
      dash.textContent = "—";
      dash.setAttribute("aria-hidden", "true");
      missing.append(label, dash);
      cell.append(missing);
    }
    return cell;
  });
  if (!additional.length) return { cells, additional: null };
  const extra = document.createElement("div");
  extra.className = "settings-account-extra-usage";
  for (const window of additional)
    extra.append(renderUsageWindow(document, window, messages, display));
  return { cells, additional: extra };
}

export function renderAccountResetCredits(
  document: Document,
  credits: AccountCreditsSnapshot,
  messages: RendererSettingsMessages,
  options: { onUseReset?: () => void; usingReset: boolean; resetDisabled: boolean },
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
  if (options.onUseReset) {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "settings-command-button settings-command-button--secondary";
    use.textContent = options.usingReset
      ? messages.accountResetCreditsUsing
      : messages.accountResetCreditsUse;
    use.disabled = options.resetDisabled;
    use.addEventListener("click", options.onUseReset);
    details.append(use);
  }
  return { summary, details };
}
