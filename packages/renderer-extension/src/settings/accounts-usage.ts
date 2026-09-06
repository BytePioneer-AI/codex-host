import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

import {
  formatRendererCreditsReset,
  rendererCreditsTone,
} from "../renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../renderer-usage-control.js";
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

export function renderAccountUsageCard(
  document: Document,
  state: AccountUsageViewState | undefined,
  messages: RendererSettingsMessages,
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
    percent.className = "settings-account-usage__skeleton settings-account-usage__skeleton--percent";
    top.append(label, percent);
    const bar = document.createElement("div");
    bar.className = "settings-account-usage__bar settings-account-usage__bar--skeleton";
    card.append(top, bar);
    return card;
  }
  return renderReadyUsageCard(document, state.credits, messages);
}

function renderReadyUsageCard(
  document: Document,
  credits: AccountCreditsSnapshot,
  messages: RendererSettingsMessages,
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
