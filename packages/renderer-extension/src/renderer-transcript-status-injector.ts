import type { RendererSettingsLocale } from "./settings/localization.js";
import {
  mountRendererTranscriptStatusChip,
  type AdapterStatusState,
  type RendererTranscriptStatusChip,
} from "./renderer-transcript-status-chip.js";
import { TRANSCRIPT_ITEM_SELECTOR } from "./renderer-transcript-dom.js";

export const TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE = "data-codexhost-transcript-status-container";
const TRANSCRIPT_TURN_SELECTOR = "[data-turn-key], [data-content-search-turn-key]";
const TRANSCRIPT_CONTAINER_SELECTORS = [
  '[data-testid="conversation-turns"]',
  '[data-testid="transcript-container"]',
  "[data-transcript-root]",
  '[data-testid="virtuoso-item-list"]',
  ".transcript-container",
  "main",
];

export const RUNNING_TURN_SELECTORS = [
  '[data-testid="composer-cancel-button"]',
  '[data-testid="composer-stop-button"]',
  '[data-testid="stop-button"]',
  '[data-testid="cancel-button"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="Cancel"]',
  'button[aria-label*="停止"]',
  'button[aria-label*="取消"]',
  '.composer-stop-button',
  '[data-composer-state="running"]',
  '[data-turn-state="inProgress"]',
  '[data-status="inProgress"]',
  '[data-turn-status="running"]',
  '[data-testid="thinking-indicator"]',
  '[data-testid="streaming-indicator"]',
  '.in-progress',
  '.turn-in-progress',
] as const;

export const FAILED_TURN_SELECTORS = [
  '[data-testid="turn-error"]',
  '[data-testid="transcript-error"]',
  '[data-item-status="failed"]',
  '[data-turn-status="failed"]',
  '.turn-error',
  '.transcript-error',
] as const;

export function detectTurnStatusFromDom(root: ParentNode): AdapterStatusState | null {
  for (const selector of RUNNING_TURN_SELECTORS) {
    if (root.querySelector(selector)) return "running";
  }
  return null;
}

export interface RendererTranscriptStatusInjectorOptions {
  root?: ParentNode;
  ownerDocument?: Document;
  getLocale?: () => RendererSettingsLocale;
  autoDismissDelayMs?: number;
  initialStatus?: AdapterStatusState;
}

export interface RendererTranscriptStatusInjector {
  readonly chip: RendererTranscriptStatusChip;
  readonly container: HTMLElement;
  getStatus(): AdapterStatusState;
  setStatus(status: AdapterStatusState): void;
  setLocale(locale: RendererSettingsLocale): void;
  place(): boolean;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdapterStatusState(value: unknown): value is AdapterStatusState {
  return (
    typeof value === "string" &&
    (value === "ready" ||
      value === "running" ||
      value === "completed" ||
      value === "failed" ||
      value === "interrupted")
  );
}

export function findTranscriptTarget(root: ParentNode): HTMLElement | null {
  const turns = [...root.querySelectorAll<HTMLElement>(TRANSCRIPT_TURN_SELECTOR)];
  if (turns.length > 0) {
    return turns[turns.length - 1] ?? null;
  }

  const items = [...root.querySelectorAll<HTMLElement>(TRANSCRIPT_ITEM_SELECTOR)];
  if (items.length > 0) {
    return items[items.length - 1] ?? null;
  }

  for (const selector of TRANSCRIPT_CONTAINER_SELECTORS) {
    const candidate = root.querySelector<HTMLElement>(selector);
    if (candidate) return candidate;
  }

  if (typeof HTMLElement !== "undefined" && root instanceof HTMLElement) {
    return root;
  }
  if (isRecord(root) && "tagName" in root && typeof (root as { append?: unknown }).append === "function") {
    return root as unknown as HTMLElement;
  }

  const doc = "ownerDocument" in root && root.ownerDocument ? root.ownerDocument : (root as Document);
  return (doc.body ?? doc.documentElement ?? null) as unknown as HTMLElement | null;
}

export function installRendererTranscriptStatusInjector(
  options: RendererTranscriptStatusInjectorOptions = {},
): RendererTranscriptStatusInjector {
  const doc =
    options.ownerDocument ??
    ("ownerDocument" in (options.root ?? {})
      ? ((options.root as Element).ownerDocument ?? document)
      : typeof document !== "undefined"
        ? document
        : null);

  if (!doc) {
    throw new Error("installRendererTranscriptStatusInjector requires an active Document");
  }

  const root = options.root ?? doc;
  const getLocale = options.getLocale;
  const initialLocale = getLocale ? getLocale() : "en";
  let disposed = false;

  const container = doc.createElement("div");
  container.setAttribute(TRANSCRIPT_STATUS_CONTAINER_ATTRIBUTE, "true");
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.padding = "4px 8px";
  container.style.margin = "4px 0";
  container.style.boxSizing = "border-box";

  const chip = mountRendererTranscriptStatusChip({
    status: options.initialStatus ?? "ready",
    locale: initialLocale,
    ownerDocument: doc,
    ...(options.autoDismissDelayMs !== undefined
      ? { autoDismissDelayMs: options.autoDismissDelayMs }
      : {}),
  });

  container.append(chip.element);

  const place = (): boolean => {
    if (disposed) return false;
    const target = findTranscriptTarget(root);
    if (!target) return false;

    if (container.parentElement !== target) {
      target.append(container);
    }
    if (!chip.element.isConnected && chip.status !== "completed") {
      container.append(chip.element);
    }
    return true;
  };

  let wasRunning = false;

  const setStatus = (status: AdapterStatusState): void => {
    if (disposed) return;
    if (status === "running") wasRunning = true;
    else if (status === "completed" || status === "failed" || status === "interrupted") {
      wasRunning = false;
    }
    chip.setStatus(status);
    if (status !== "completed") {
      if (!chip.element.isConnected) {
        container.append(chip.element);
      }
      place();
    }
  };

  const syncTurnStatusFromDom = (): void => {
    if (disposed) return;
    const running = detectTurnStatusFromDom(root) === "running";
    if (running) {
      if (!wasRunning || chip.status !== "running") {
        setStatus("running");
      }
    } else if (wasRunning) {
      wasRunning = false;
      let failed = false;
      for (const selector of FAILED_TURN_SELECTORS) {
        if (root.querySelector(selector)) {
          failed = true;
          break;
        }
      }
      setStatus(failed ? "failed" : "completed");
    }
  };

  const handleStatusEvent = (event: Event | { detail?: unknown }): void => {
    if (disposed) return;
    const detail = "detail" in event ? event.detail : undefined;
    if (isRecord(detail)) {
      if (isAdapterStatusState(detail.status)) {
        setStatus(detail.status);
      } else if (typeof detail.state === "string") {
        if (detail.state === "ready") setStatus("ready");
        else if (detail.state === "unsupported") setStatus("failed");
        else if (detail.state === "installing") setStatus("running");
      }
      if (
        typeof detail.locale === "string" &&
        (detail.locale === "en" || detail.locale === "zh-CN")
      ) {
        setLocale(detail.locale);
      }
    } else {
      setStatus("ready");
    }
  };

  const setLocale = (locale: RendererSettingsLocale): void => {
    if (disposed) return;
    chip.setLocale(locale);
  };

  const getStatus = (): AdapterStatusState => {
    return chip.status;
  };

  // Setup MutationObserver to anchor into transcript and track live turn progress
  let observer: MutationObserver | null = null;
  const MutationObserverCtor =
    doc.defaultView?.MutationObserver ??
    (typeof MutationObserver === "function" ? MutationObserver : null);

  if (MutationObserverCtor) {
    observer = new MutationObserverCtor(() => {
      if (!disposed) {
        syncTurnStatusFromDom();
        place();
      }
    });

    const ElementCtor =
      doc.defaultView?.Element ??
      (typeof Element !== "undefined" ? Element : null);
    const isElementNode =
      (ElementCtor && root instanceof ElementCtor) ||
      (isRecord(root) && "tagName" in root);
    const observeTarget = isElementNode
      ? (root as unknown as Node)
      : ((doc.body ?? doc.documentElement) as unknown as Node);
    if (observeTarget) {
      observer.observe(observeTarget, {
        childList: true,
        subtree: true,
      });
    }
  }

  const win = doc.defaultView ?? (typeof window !== "undefined" ? window : null);
  win?.addEventListener("codexhost:renderer-adapter-status", handleStatusEvent);
  win?.addEventListener("codexhost:transcript-status", handleStatusEvent);
  win?.addEventListener("codexhost:transcript-status-changed", handleStatusEvent);

  syncTurnStatusFromDom();
  place();

  return {
    get chip() {
      return chip;
    },
    get container() {
      return container;
    },
    getStatus,
    setStatus,
    setLocale,
    place,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      observer = null;
      win?.removeEventListener("codexhost:renderer-adapter-status", handleStatusEvent);
      win?.removeEventListener("codexhost:transcript-status", handleStatusEvent);
      win?.removeEventListener("codexhost:transcript-status-changed", handleStatusEvent);
      chip.dispose();
      container.remove();
    },
  };
}
