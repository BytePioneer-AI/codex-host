import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

import { formatRendererCreditsReset, rendererCreditsTone } from "../renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../renderer-usage-control.js";
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

export function renderAccountUsage(
  document: Document,
  state: AccountUsageViewState | undefined,
  messages: RendererSettingsMessages,
  display: AccountUsageDisplay,
  onRetry: () => void,
): HTMLElement | null {
  if (!state) return null;
  const usage = document.createElement("div");
  usage.className = "settings-account-usage";
  if (state.status !== "ready") {
    const message = document.createElement("span");
    message.className = "settings-account-usage__message";
    message.textContent =
      state.status === "loading"
        ? messages.accountCreditsLoading
        : state.status === "error"
          ? messages.accountCreditsFailed
          : messages.accountCreditsEmpty;
    usage.append(message);
    if (state.status === "loading") usage.setAttribute("aria-busy", "true");
    if (state.status === "error") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "settings-command-button settings-command-button--secondary";
      retry.textContent = messages.accountCreditsRetry;
      retry.addEventListener("click", onRetry);
      usage.append(retry);
    }
    return usage;
  }
  const credits = state.credits;
  // Render only reported windows/products. Neither a plan name nor a missing
  // window is evidence of zero usage, unlimited access, or a synthetic 5h limit.
  const windows = [
    {
      label: credits.label ?? creditsPeriodLabel(credits.periodType, messages),
      usedPercent: credits.usedPercent,
      resetsAt: credits.resetsAt,
    },
    ...(credits.productUsage ?? []).map((product) => ({
      label: creditsProductLabel(product.product, messages),
      usedPercent: product.usagePercent,
      resetsAt: product.resetsAt,
    })),
  ];
  for (const window of windows) {
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
    const percent = document.createElement("span");
    percent.className = `settings-account-usage__percent settings-account-usage__percent--${tone}`;
    const prefix = document.createElement("span");
    prefix.textContent = valueLabel;
    prefix.className = "settings-account-usage__value-label";
    const number = document.createElement("span");
    number.textContent = formatRendererCreditsPercent(value);
    percent.append(prefix, number);
    meter.append(label, bar, percent);
    if (window.resetsAt) {
      const reset = document.createElement("span");
      reset.className = "settings-account-usage__sub";
      reset.textContent = `${formatAccountCreditsReset(window.resetsAt, messages.locale)} ${messages.accountCreditsReset}`;
      meter.append(reset);
    }
    usage.append(meter);
  }
  const freshness = document.createElement("span");
  freshness.className = "settings-account-usage__sub settings-account-usage__freshness";
  const observed = state.observedAt
    ? new Date(state.observedAt).toLocaleString(messages.locale)
    : null;
  freshness.textContent =
    state.freshness === "live"
      ? observed
        ? messages.accountCreditsLiveAt.replace("{time}", observed)
        : messages.accountCreditsLive
      : observed
        ? messages.accountCreditsCachedAt.replace("{time}", observed)
        : messages.accountCreditsCached;
  usage.append(freshness);
  return usage;
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
  summary.append(
    createRendererSettingsIcon("ticket", 16),
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
