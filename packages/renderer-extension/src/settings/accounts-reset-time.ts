import type { RendererSettingsMessages } from "./localization.js";

/** At most two units; elapsed time never implies that a quota request succeeded. */
export function formatAccountResetCountdown(
  value: string,
  messages: RendererSettingsMessages,
  now = Date.now(),
): { text: string; description: string } | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.ceil((timestamp - now) / 60_000));
  if (minutes === 0) {
    return {
      text: messages.accountCreditsResetPending,
      description: messages.accountCreditsResetPendingHint,
    };
  }
  const chinese = messages.locale === "zh-CN";
  const parts = [
    { value: Math.floor(minutes / 1440), unit: "d", label: chinese ? "天" : " days" },
    { value: Math.floor((minutes % 1440) / 60), unit: "h", label: chinese ? "小时" : " hours" },
    { value: minutes % 60, unit: "m", label: chinese ? "分钟" : " minutes" },
  ].filter((part, index) => part.value > 0 && (minutes < 1440 || index < 2));
  return {
    text: parts.map((part) => `${part.value}${part.unit}`).join(""),
    description: messages.accountCreditsResetIn.replace(
      "{time}",
      parts
        .map(
          (part) =>
            `${part.value}${!chinese && part.value === 1 ? part.label.slice(0, -1) : part.label}`,
        )
        .join(chinese ? "" : " "),
    ),
  };
}

function updateCountdown(element: HTMLElement, messages: RendererSettingsMessages): void {
  const value = formatAccountResetCountdown(element.dataset.resetsAt ?? "", messages);
  if (!value) return;
  element.textContent = value.text;
  element.title = value.description;
  element.setAttribute("aria-label", value.description);
}

export function renderAccountResetTime(
  document: Document,
  value: string,
  messages: RendererSettingsMessages,
): { countdown: HTMLElement; timestamp: HTMLTimeElement } | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const countdown = document.createElement("span");
  countdown.className = "settings-account-usage__countdown";
  countdown.dataset.resetsAt = date.toISOString();
  updateCountdown(countdown, messages);
  const timestamp = document.createElement("time");
  timestamp.className = "settings-account-usage__sub";
  timestamp.dateTime = date.toISOString();
  const pad = (number: number): string => String(number).padStart(2, "0");
  timestamp.textContent = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  timestamp.title = messages.accountCreditsResetAt.replace(
    "{time}",
    date.toLocaleString(messages.locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }),
  );
  timestamp.setAttribute("aria-label", timestamp.title);
  return { countdown, timestamp };
}

/** One page-local clock, no Host requests or table rebuilds (and no lost focus). */
export function mountAccountResetCountdowns(
  list: HTMLElement,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
): () => void {
  const window = list.ownerDocument.defaultView;
  if (!window || signal.aborted) return () => undefined;
  const refresh = (): void => {
    if (signal.aborted) return;
    for (const element of list.querySelectorAll<HTMLElement>("[data-resets-at]")) {
      updateCountdown(element, messages);
    }
  };
  const timer = window.setInterval(refresh, 60_000);
  window.addEventListener("focus", refresh);
  const stop = (): void => {
    window.clearInterval(timer);
    window.removeEventListener("focus", refresh);
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}
