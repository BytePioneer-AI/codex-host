import type { RendererSettingsLocale } from "./settings/localization.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";

export type AdapterStatusState =
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type TranscriptStatusState = AdapterStatusState;

export const TRANSCRIPT_STATUS_CHIP_ATTRIBUTE = "data-codexhost-transcript-status-chip";
export const TRANSCRIPT_STATUS_STATE_ATTRIBUTE = "data-status";
export const DEFAULT_STATUS_AUTO_DISMISS_DELAY_MS = 3000;

export interface TranscriptStatusMessages {
  readonly ready: string;
  readonly running: string;
  readonly completed: string;
  readonly failed: string;
  readonly interrupted: string;
}

export const ENGLISH_STATUS_MESSAGES: TranscriptStatusMessages = Object.freeze({
  ready: "Ready",
  running: "Running...",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
});

export const CHINESE_STATUS_MESSAGES: TranscriptStatusMessages = Object.freeze({
  ready: "就绪",
  running: "运行中...",
  completed: "已完成",
  failed: "执行失败",
  interrupted: "已中断",
});

export function transcriptStatusMessages(
  locale: RendererSettingsLocale = "en",
): TranscriptStatusMessages {
  return locale === "zh-CN" ? CHINESE_STATUS_MESSAGES : ENGLISH_STATUS_MESSAGES;
}

export interface RendererTranscriptStatusChipOptions {
  status?: AdapterStatusState;
  locale?: RendererSettingsLocale;
  ownerDocument?: Document;
  autoDismissDelayMs?: number;
  onDismiss?: () => void;
}

export interface RendererTranscriptStatusChip {
  readonly element: HTMLElement;
  status: AdapterStatusState;
  locale: RendererSettingsLocale;
  setStatus(status: AdapterStatusState): void;
  setLocale(locale: RendererSettingsLocale): void;
  dismiss(): void;
  dispose(): void;
}

interface StatusVisualTone {
  dotColor: string;
  textColor: string;
  backgroundColor: string;
}

function visualToneForStatus(status: AdapterStatusState): StatusVisualTone {
  switch (status) {
    case "running":
      return {
        dotColor: "#3b82f6",
        textColor: "#2563eb",
        backgroundColor: "rgba(59, 130, 246, 0.12)",
      };
    case "completed":
      return {
        dotColor: "#10b981",
        textColor: "#059669",
        backgroundColor: "rgba(16, 185, 129, 0.12)",
      };
    case "failed":
      return {
        dotColor: "#ef4444",
        textColor: "#dc2626",
        backgroundColor: "rgba(239, 68, 68, 0.12)",
      };
    case "interrupted":
      return {
        dotColor: "#f59e0b",
        textColor: "#d97706",
        backgroundColor: "rgba(245, 158, 11, 0.12)",
      };
    case "ready":
    default:
      return {
        dotColor: "#8f8f8f",
        textColor: "var(--color-text-tertiary, #8f8f8f)",
        backgroundColor: "rgba(127, 127, 127, 0.08)",
      };
  }
}

export function mountRendererTranscriptStatusChip(
  options: RendererTranscriptStatusChipOptions = {},
): RendererTranscriptStatusChip {
  const doc = options.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  if (!doc) {
    throw new Error("mountRendererTranscriptStatusChip requires an active Document");
  }

  ensureRendererTriggerChipStyle(doc);

  let currentStatus: AdapterStatusState = options.status ?? "ready";
  let currentLocale: RendererSettingsLocale = options.locale ?? "en";
  const autoDismissDelayMs = options.autoDismissDelayMs ?? DEFAULT_STATUS_AUTO_DISMISS_DELAY_MS;
  const onDismiss = options.onDismiss;

  let autoDismissTimer: number | null = null;
  let disposed = false;

  const element = doc.createElement("div");
  element.setAttribute(TRANSCRIPT_STATUS_CHIP_ATTRIBUTE, "true");
  element.setAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE, currentStatus);
  element.className = `${TRIGGER_CHIP_CLASS} codexhost-transcript-status-chip`;
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");

  element.style.display = "inline-flex";
  element.style.alignItems = "center";
  element.style.gap = "6px";
  element.style.height = "24px";
  element.style.padding = "0 8px";
  element.style.fontSize = "12px";
  element.style.lineHeight = "16px";
  element.style.fontWeight = "500";
  element.style.borderRadius = "9999px";
  element.style.verticalAlign = "middle";
  element.style.cursor = "default";
  element.style.userSelect = "none";
  element.style.boxSizing = "border-box";

  const dot = doc.createElement("span");
  dot.setAttribute("aria-hidden", "true");
  dot.style.display = "inline-block";
  dot.style.width = "6px";
  dot.style.height = "6px";
  dot.style.borderRadius = "50%";
  dot.style.flexShrink = "0";

  const label = doc.createElement("span");
  label.style.display = "inline-block";
  label.style.whiteSpace = "nowrap";

  element.append(dot, label);

  const setTimeoutFn =
    doc.defaultView?.setTimeout?.bind(doc.defaultView) ??
    (typeof window !== "undefined" && window.setTimeout
      ? window.setTimeout.bind(window)
      : globalThis.setTimeout);
  const clearTimeoutFn =
    doc.defaultView?.clearTimeout?.bind(doc.defaultView) ??
    (typeof window !== "undefined" && window.clearTimeout
      ? window.clearTimeout.bind(window)
      : globalThis.clearTimeout);

  const clearAutoDismissTimer = (): void => {
    if (autoDismissTimer !== null) {
      clearTimeoutFn(autoDismissTimer as number);
      autoDismissTimer = null;
    }
  };

  const render = (): void => {
    const tone = visualToneForStatus(currentStatus);
    const messages = transcriptStatusMessages(currentLocale);
    const text = messages[currentStatus];

    element.setAttribute(TRANSCRIPT_STATUS_STATE_ATTRIBUTE, currentStatus);
    element.style.background = tone.backgroundColor;
    element.style.color = tone.textColor;

    dot.style.background = tone.dotColor;
    label.textContent = text;
  };

  const scheduleAutoDismiss = (): void => {
    clearAutoDismissTimer();
    if (currentStatus === "completed" && autoDismissDelayMs > 0 && !disposed) {
      autoDismissTimer = setTimeoutFn(() => {
        autoDismissTimer = null;
        dismiss();
      }, autoDismissDelayMs) as unknown as number;
    }
  };

  const dismiss = (): void => {
    clearAutoDismissTimer();
    element.remove();
    onDismiss?.();
  };

  const setStatus = (nextStatus: AdapterStatusState): void => {
    if (disposed) return;
    clearAutoDismissTimer();
    currentStatus = nextStatus;
    render();
    scheduleAutoDismiss();
  };

  const setLocale = (nextLocale: RendererSettingsLocale): void => {
    if (disposed || currentLocale === nextLocale) return;
    currentLocale = nextLocale;
    render();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearAutoDismissTimer();
    element.remove();
  };

  render();
  scheduleAutoDismiss();

  return {
    get element() {
      return element;
    },
    get status() {
      return currentStatus;
    },
    set status(value: AdapterStatusState) {
      setStatus(value);
    },
    get locale() {
      return currentLocale;
    },
    set locale(value: RendererSettingsLocale) {
      setLocale(value);
    },
    setStatus,
    setLocale,
    dismiss,
    dispose,
  };
}
