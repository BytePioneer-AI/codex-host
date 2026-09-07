import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

import { formatRendererCreditsReset, rendererCreditsTone } from "../renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../renderer-usage-control.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export type AccountUsageViewState =
  | { readonly status: "loading" }
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly credits: AccountCreditsSnapshot };

const TONE_COLOR = {
  ok: "#3d9a64",
  warn: "#c9a227",
  hot: "#c45c4a",
} as const;

let resetCreditsDetailsId = 0;

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

export function creditsUsedResetLine(
  resetsAt: string | undefined,
  messages: RendererSettingsMessages,
): string {
  if (!resetsAt) return messages.accountCreditsUsed;
  const reset = formatAccountCreditsReset(resetsAt, messages.locale);
  return `${messages.accountCreditsUsed} · ${reset} ${messages.accountCreditsReset}`;
}

export interface AccountUsageCardOptions {
  onUseReset?: () => void;
  usingReset?: boolean;
}

export function renderAccountUsageCard(
  document: Document,
  state: AccountUsageViewState | undefined,
  messages: RendererSettingsMessages,
  options: AccountUsageCardOptions = {},
): HTMLElement | null {
  if (!state || state.status === "empty") return null;
  if (state.status === "loading") {
    const card = document.createElement("div");
    card.className = "settings-account-usage settings-account-usage--loading";
    card.setAttribute("aria-hidden", "true");
    const top = document.createElement("div");
    top.className = "settings-account-usage__meter-top";
    const label = document.createElement("div");
    label.className = "settings-account-usage__skeleton settings-account-usage__skeleton--label";
    const percent = document.createElement("div");
    percent.className =
      "settings-account-usage__skeleton settings-account-usage__skeleton--percent";
    top.append(label, percent);
    const bar = document.createElement("div");
    bar.className = "settings-account-usage__bar settings-account-usage__bar--skeleton";
    card.append(top, bar);
    return card;
  }
  return renderReadyUsageCard(document, state.credits, messages, options);
}

function creditsNeedReset(credits: AccountCreditsSnapshot): boolean {
  if (rendererCreditsTone(credits.usedPercent) === "hot") return true;
  return (credits.productUsage ?? []).some(
    (product) => rendererCreditsTone(product.usagePercent) === "hot",
  );
}

function resetExpiryTone(value: string, now: Date = new Date()): "ok" | "warn" | "hot" | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const remainingMs = date.getTime() - now.getTime();
  if (remainingMs <= 8 * 60 * 60 * 1000) return "hot";
  if (remainingMs <= 24 * 60 * 60 * 1000) return "warn";
  return undefined;
}

function resetCreditsCount(count: number, locale: RendererSettingsMessages["locale"]): string {
  if (locale === "zh-CN") return `${count} 张`;
  return count === 1 ? "1 available" : `${count} available`;
}

function resetCreditsExpiryLine(nextExpiresAt: string, messages: RendererSettingsMessages): string {
  const reset = formatAccountCreditsReset(nextExpiresAt, messages.locale);
  return messages.locale === "zh-CN" ? `最近 ${reset}到期` : `next expires ${reset}`;
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

function renderReadyUsageCard(
  document: Document,
  credits: AccountCreditsSnapshot,
  messages: RendererSettingsMessages,
  options: AccountUsageCardOptions,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "settings-account-usage";
  const glow = TONE_COLOR[rendererCreditsTone(credits.usedPercent)];
  card.style.backgroundImage = `radial-gradient(220px 110px at 12% -18%, color-mix(in srgb, ${glow} 18%, transparent), transparent 70%)`;
  card.append(
    renderMeter(document, {
      label: creditsPeriodLabel(credits.periodType, messages),
      usedPercent: credits.usedPercent,
      resetsAt: credits.resetsAt,
      primary: true,
      messages,
    }),
  );
  for (const product of credits.productUsage ?? []) {
    card.append(
      renderMeter(document, {
        label: creditsProductLabel(product.product, messages),
        usedPercent: product.usagePercent,
        resetsAt: product.resetsAt,
        primary: false,
        messages,
      }),
    );
  }
  const resetCredits = credits.resetCredits;
  if (resetCredits) {
    const footer = document.createElement("div");
    footer.className = "settings-account-usage__resets";
    const copy = document.createElement("div");
    const heading = document.createElement("div");
    heading.className = "settings-account-usage__resets-heading";
    const title = document.createElement("div");
    title.className = "settings-account-usage__resets-title";
    title.textContent = messages.accountResetCredits;
    heading.append(title);
    const expiresAt = resetCredits.expiresAt ?? [];
    let details: HTMLElement | null = null;
    if (expiresAt.length > 0) {
      const detailsId = `codexhost-reset-credits-${++resetCreditsDetailsId}`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "settings-icon-button settings-account-usage__resets-details";
      toggle.setAttribute("aria-label", messages.accountResetCreditsDetails);
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", detailsId);
      toggle.title = messages.accountResetCreditsDetails;
      toggle.append(createRendererSettingsIcon("info", 14));
      details = document.createElement("ul");
      details.id = detailsId;
      details.className = "settings-account-usage__resets-list";
      details.hidden = true;
      for (const [index, value] of expiresAt.entries()) {
        const item = document.createElement("li");
        item.textContent = resetCreditDetailLine(index + 1, value, messages);
        details.append(item);
      }
      toggle.addEventListener("click", () => {
        const open = details?.hidden === true;
        if (details) details.hidden = !open;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
      heading.append(toggle);
    }
    const sub = document.createElement("div");
    const expiryTone = resetCredits.nextExpiresAt
      ? resetExpiryTone(resetCredits.nextExpiresAt)
      : undefined;
    sub.className = expiryTone
      ? `settings-account-usage__resets-sub settings-account-usage__resets-sub--${expiryTone}`
      : "settings-account-usage__resets-sub";
    const parts = [resetCreditsCount(resetCredits.availableCount, messages.locale)];
    if (resetCredits.nextExpiresAt) {
      parts.push(resetCreditsExpiryLine(resetCredits.nextExpiresAt, messages));
    }
    sub.textContent = parts.join(" · ");
    copy.append(heading, sub);
    if (details) copy.append(details);
    footer.append(copy);
    if (options.onUseReset) {
      const use = document.createElement("button");
      use.type = "button";
      use.className = creditsNeedReset(credits)
        ? "settings-command-button"
        : "settings-command-button settings-command-button--secondary";
      use.textContent = options.usingReset
        ? messages.accountResetCreditsUsing
        : messages.accountResetCreditsUse;
      use.disabled = options.usingReset === true;
      use.addEventListener("click", options.onUseReset);
      footer.append(use);
    }
    card.append(footer);
  }
  return card;
}

function renderMeter(
  document: Document,
  input: {
    label: string;
    usedPercent: number;
    resetsAt?: string | undefined;
    primary: boolean;
    messages: RendererSettingsMessages;
  },
): HTMLElement {
  const tone = rendererCreditsTone(input.usedPercent);
  const color = TONE_COLOR[tone];
  const meter = document.createElement("div");
  meter.className = input.primary
    ? "settings-account-usage__meter settings-account-usage__meter--primary"
    : "settings-account-usage__meter settings-account-usage__meter--secondary";
  const top = document.createElement("div");
  top.className = "settings-account-usage__meter-top";
  const copy = document.createElement("div");
  const title = document.createElement("div");
  title.className = "settings-account-usage__title";
  title.textContent = input.label;
  copy.append(title);
  const sub = document.createElement("div");
  sub.className = "settings-account-usage__sub";
  sub.textContent = creditsUsedResetLine(input.resetsAt, input.messages);
  copy.append(sub);
  const percent = document.createElement("div");
  percent.className = `settings-account-usage__percent settings-account-usage__percent--${tone}`;
  percent.textContent = formatRendererCreditsPercent(input.usedPercent);
  top.append(copy, percent);
  const bar = document.createElement("div");
  bar.className = "settings-account-usage__bar";
  const fill = document.createElement("span");
  fill.style.width = `${Math.min(100, Math.max(0, input.usedPercent))}%`;
  fill.style.background = color;
  bar.append(fill);
  meter.append(top, bar);
  return meter;
}
