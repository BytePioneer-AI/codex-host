import {
  hostThreadIdSchema,
  type HostThreadId,
  type HostTurnId,
  type ThreadInspection,
  type ThreadInspectionParams,
} from "@codexhost/shared-contracts";

import { CODEX_COMPOSER_SELECTOR } from "./renderer-composer-dom.js";
import {
  RendererReasoningPendingBuffer,
  RendererReasoningStore,
  rendererReasoningPanelView,
  type RendererReasoningEvent,
} from "./renderer-reasoning-events.js";
import {
  RENDERER_REASONING_DISPLAY_PREFERENCE_EVENT,
  RENDERER_REASONING_DISPLAY_PREFERENCE_KEY,
  readRendererReasoningDisplayPreference,
} from "./renderer-reasoning-preference.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
} from "./settings/localization.js";

const REASONING_DISPLAY_ATTRIBUTE = "data-codexhost-reasoning-display";
const ABOVE_COMPOSER_PORTAL_ATTRIBUTE = "data-above-composer-portal";
const ABOVE_COMPOSER_THREAD_ATTRIBUTE = "data-above-composer-conversation-id";
const DEFAULT_OWNERSHIP_INSPECTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PENDING_REASONING_TEXT_LENGTH = 256 * 1024;

export interface RendererReasoningDisplayClient {
  inspectThread?(input: ThreadInspectionParams): Promise<ThreadInspection>;
  subscribeThreadReasoning?(listener: (event: RendererReasoningEvent) => void): () => void;
}

export interface RendererReasoningDisplayControl {
  refresh(): void;
  reset(): void;
  dispose(): void;
}

export interface RendererReasoningDisplayOptions {
  readonly ownershipInspectionTimeoutMs?: number;
  readonly maxPendingTextLength?: number;
}

interface PendingOwnershipInspection {
  cancel(): void;
  promise: Promise<void>;
}

interface MountedReasoningPanel {
  readonly root: HTMLElement;
  readonly details: HTMLDetailsElement;
  readonly label: HTMLElement;
  readonly status: HTMLElement;
  readonly body: HTMLElement;
  threadId: HostThreadId | null;
  turnId: HostTurnId | null;
  itemId: string | null;
  phase: "live" | "completed" | null;
  text: string;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function inspectWithTimeout(
  ownerWindow: Window,
  timeoutMs: number,
  inspect: () => Promise<ThreadInspection>,
): { readonly promise: Promise<ThreadInspection>; cancel(): void } {
  let timeout: number | null = null;
  let rejectBoundary: ((reason: Error) => void) | null = null;
  let settled = false;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
    timeout = ownerWindow.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Renderer Reasoning ownership inspection timed out"));
    }, timeoutMs);
  });
  const promise = Promise.race([Promise.resolve().then(inspect), boundary]).finally(() => {
    settled = true;
    if (timeout !== null) ownerWindow.clearTimeout(timeout);
    timeout = null;
    rejectBoundary = null;
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      if (timeout !== null) ownerWindow.clearTimeout(timeout);
      timeout = null;
      const reject = rejectBoundary;
      rejectBoundary = null;
      reject?.(new Error("Renderer Reasoning ownership inspection was cancelled"));
    },
  };
}

function preferenceStorage(ownerWindow: Window): Storage | null {
  try {
    return ownerWindow.localStorage;
  } catch {
    return null;
  }
}

function composerThreadId(composer: Element): HostThreadId | null {
  const portals = [...composer.children].filter((child) =>
    child.hasAttribute(ABOVE_COMPOSER_PORTAL_ATTRIBUTE),
  );
  if (portals.length !== 1) return null;
  const parsed = hostThreadIdSchema.safeParse(
    portals[0]?.getAttribute(ABOVE_COMPOSER_THREAD_ATTRIBUTE),
  );
  return parsed.success ? parsed.data : null;
}

function eligibleComposers(ownerDocument: Document): readonly HTMLElement[] {
  return [...ownerDocument.querySelectorAll<HTMLElement>(CODEX_COMPOSER_SELECTOR)].filter(
    (composer) =>
      composer.isConnected &&
      !composer.hidden &&
      composer.getAttribute("aria-hidden") !== "true" &&
      composerThreadId(composer) !== null,
  );
}

function createPanel(ownerDocument: Document, liveLabel: string): MountedReasoningPanel {
  const root = ownerDocument.createElement("section");
  root.setAttribute(REASONING_DISPLAY_ATTRIBUTE, "v1");
  root.style.width = "100%";
  root.style.maxWidth = "48rem";
  root.style.margin = "0 auto 10px";
  root.style.padding = "0 12px";
  root.style.boxSizing = "border-box";
  root.style.color = "inherit";

  const details = ownerDocument.createElement("details");
  details.style.overflow = "hidden";
  details.style.border = "1px solid rgba(127, 127, 127, 0.22)";
  details.style.borderRadius = "12px";
  details.style.background = "rgba(127, 127, 127, 0.07)";

  const summary = ownerDocument.createElement("summary");
  summary.style.display = "flex";
  summary.style.alignItems = "center";
  summary.style.justifyContent = "space-between";
  summary.style.gap = "12px";
  summary.style.padding = "10px 12px";
  summary.style.cursor = "pointer";
  summary.style.userSelect = "none";

  const label = ownerDocument.createElement("strong");
  label.textContent = liveLabel;
  label.style.font = "600 13px/18px system-ui, sans-serif";
  const status = ownerDocument.createElement("span");
  status.style.color = "rgba(127, 127, 127, 0.9)";
  status.style.font = "400 11px/16px system-ui, sans-serif";
  summary.append(label, status);

  const body = ownerDocument.createElement("div");
  body.style.maxHeight = "min(30vh, 260px)";
  body.style.padding = "0 12px 12px";
  body.style.overflowY = "auto";
  body.style.whiteSpace = "pre-wrap";
  body.style.overflowWrap = "anywhere";
  body.style.color = "rgba(127, 127, 127, 0.98)";
  body.style.font = "400 13px/20px system-ui, sans-serif";
  details.append(summary, body);
  root.append(details);
  return {
    root,
    details,
    label,
    status,
    body,
    threadId: null,
    turnId: null,
    itemId: null,
    phase: null,
    text: "",
  };
}

export function installRendererReasoningDisplay(
  client: RendererReasoningDisplayClient,
  ownerWindow: Window = window,
  options: RendererReasoningDisplayOptions = {},
): RendererReasoningDisplayControl {
  const { document: ownerDocument } = ownerWindow;
  const messages = rendererSettingsMessages(
    resolveRendererSettingsLocale(ownerWindow.navigator.languages),
  );
  const store = new RendererReasoningStore();
  const externalOwnership = new Map<HostThreadId, boolean>();
  const pendingEvents = new Map<HostThreadId, RendererReasoningPendingBuffer>();
  const ownershipRequests = new Map<HostThreadId, PendingOwnershipInspection>();
  const panels = new Map<HTMLElement, MountedReasoningPanel>();
  const ownershipInspectionTimeoutMs = positiveIntegerOr(
    options.ownershipInspectionTimeoutMs,
    DEFAULT_OWNERSHIP_INSPECTION_TIMEOUT_MS,
  );
  const maxPendingTextLength = positiveIntegerOr(
    options.maxPendingTextLength,
    DEFAULT_MAX_PENDING_REASONING_TEXT_LENGTH,
  );
  let enabled = readRendererReasoningDisplayPreference(preferenceStorage(ownerWindow));
  let removeReasoningSubscription: (() => void) | null = null;
  let ownershipGeneration = 0;
  let observing = false;
  let disposed = false;

  const removePanel = (composer: HTMLElement): void => {
    panels.get(composer)?.root.remove();
    panels.delete(composer);
  };

  const resetRouteState = (): void => {
    ownershipGeneration += 1;
    const requests = [...ownershipRequests.values()];
    ownershipRequests.clear();
    externalOwnership.clear();
    pendingEvents.clear();
    store.clear();
    for (const request of requests) request.cancel();
    for (const composer of panels.keys()) removePanel(composer);
  };

  const detachReasoningSubscription = (): void => {
    const remove = removeReasoningSubscription;
    removeReasoningSubscription = null;
    try {
      remove?.();
    } catch {
      // The local state is already detached; teardown remains best effort.
    }
  };

  const render = (): void => {
    if (disposed) return;
    const composers = new Set(eligibleComposers(ownerDocument));
    for (const composer of panels.keys()) {
      if (!composers.has(composer) || !enabled) removePanel(composer);
    }
    if (!enabled) return;

    for (const composer of composers) {
      const threadId = composerThreadId(composer);
      if (!threadId) continue;
      const snapshot = store.snapshot(threadId);
      const view = rendererReasoningPanelView(snapshot);
      if (!view.visible) {
        removePanel(composer);
        continue;
      }
      const parent = composer.parentElement;
      if (!parent) continue;
      let panel = panels.get(composer);
      if (!panel) {
        panel = createPanel(ownerDocument, messages.reasoningDisplayLive);
        panels.set(composer, panel);
      }
      if (panel.root.parentElement !== parent || panel.root.nextElementSibling !== composer) {
        parent.insertBefore(panel.root, composer);
      }
      if (panel.root.dataset.threadId !== threadId) panel.root.dataset.threadId = threadId;
      const textChanged = panel.body.textContent !== view.text;
      if (textChanged) panel.body.textContent = view.text;
      const itemChanged =
        panel.threadId !== snapshot?.threadId ||
        panel.turnId !== snapshot?.turnId ||
        panel.itemId !== snapshot?.itemId;
      const completedTransition = panel.phase === "live" && view.phase === "completed";
      if (itemChanged) {
        panel.details.open = view.expanded;
      } else if (completedTransition) {
        panel.details.open = false;
      } else if (view.phase === "live" && panel.text !== view.text) {
        panel.details.open = true;
      }
      panel.threadId = snapshot?.threadId ?? null;
      panel.turnId = snapshot?.turnId ?? null;
      panel.itemId = snapshot?.itemId ?? null;
      panel.phase = view.phase;
      panel.text = view.text;
      const label =
        view.phase === "live" ? messages.reasoningDisplayLive : messages.reasoningDisplayCompleted;
      if (panel.label.textContent !== label) panel.label.textContent = label;
      const status = view.phase === "live" ? "●" : "";
      if (panel.status.textContent !== status) panel.status.textContent = status;
      if (view.phase === "live" && textChanged) {
        ownerWindow.requestAnimationFrame(() => {
          panel?.body.scrollTo({ top: panel.body.scrollHeight });
        });
      }
    }
  };

  const syncSubscription = (): void => {
    if (enabled && !removeReasoningSubscription) {
      try {
        removeReasoningSubscription =
          client.subscribeThreadReasoning?.((event) => {
            const knownExternal = externalOwnership.get(event.threadId);
            if (knownExternal === true) {
              store.apply(event);
              render();
              return;
            }
            if (knownExternal === false) return;
            let pending = pendingEvents.get(event.threadId);
            if (!pending) {
              pending = new RendererReasoningPendingBuffer(maxPendingTextLength);
              pendingEvents.set(event.threadId, pending);
            }
            if (!pending.append(event)) {
              externalOwnership.set(event.threadId, false);
              pendingEvents.delete(event.threadId);
              const request = ownershipRequests.get(event.threadId);
              ownershipRequests.delete(event.threadId);
              request?.cancel();
              return;
            }
            if (ownershipRequests.has(event.threadId)) return;
            if (!client.inspectThread) {
              externalOwnership.set(event.threadId, false);
              pendingEvents.delete(event.threadId);
              return;
            }
            const generation = ownershipGeneration;
            const bounded = inspectWithTimeout(ownerWindow, ownershipInspectionTimeoutMs, () => {
              if (disposed || generation !== ownershipGeneration) {
                return Promise.reject(
                  new Error("Renderer Reasoning ownership generation is no longer active"),
                );
              }
              return (
                client.inspectThread?.({ threadId: event.threadId }) ??
                Promise.reject(new Error("Renderer Reasoning ownership inspection is unavailable"))
              );
            });
            const request: PendingOwnershipInspection = {
              cancel: bounded.cancel,
              promise: Promise.resolve(),
            };
            request.promise = bounded.promise
              .then((inspection) => {
                if (disposed || generation !== ownershipGeneration) return;
                const isExternal = inspection.owner === "external";
                externalOwnership.set(event.threadId, isExternal);
                const queued = pendingEvents.get(event.threadId)?.drain() ?? [];
                pendingEvents.delete(event.threadId);
                if (!isExternal) return;
                for (const queuedEvent of queued) store.apply(queuedEvent);
                render();
              })
              .catch(() => {
                if (generation === ownershipGeneration) {
                  externalOwnership.set(event.threadId, false);
                  pendingEvents.delete(event.threadId);
                }
              })
              .finally(() => {
                if (ownershipRequests.get(event.threadId) === request) {
                  ownershipRequests.delete(event.threadId);
                }
              });
            ownershipRequests.set(event.threadId, request);
          }) ?? null;
      } catch {
        removeReasoningSubscription = null;
      }
    } else if (!enabled) {
      detachReasoningSubscription();
      resetRouteState();
    }
    if (enabled && !observing) {
      observer.observe(ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: [
          "aria-hidden",
          "hidden",
          "data-codex-composer-root",
          ABOVE_COMPOSER_THREAD_ATTRIBUTE,
        ],
        childList: true,
        subtree: true,
      });
      observing = true;
    } else if (!enabled && observing) {
      observer.disconnect();
      observing = false;
    }
    render();
  };

  const onPreferenceChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ enabled?: unknown }>).detail;
    enabled =
      typeof detail?.enabled === "boolean"
        ? detail.enabled
        : readRendererReasoningDisplayPreference(preferenceStorage(ownerWindow));
    syncSubscription();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== RENDERER_REASONING_DISPLAY_PREFERENCE_KEY) return;
    enabled = readRendererReasoningDisplayPreference(preferenceStorage(ownerWindow));
    syncSubscription();
  };
  const MutationObserverForWindow = (
    ownerWindow as Window & { MutationObserver: typeof MutationObserver }
  ).MutationObserver;
  const observer = new MutationObserverForWindow(render);
  ownerWindow.addEventListener(RENDERER_REASONING_DISPLAY_PREFERENCE_EVENT, onPreferenceChanged);
  ownerWindow.addEventListener("storage", onStorage);
  syncSubscription();

  return {
    refresh: render,
    reset() {
      if (disposed) return;
      resetRouteState();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      observing = false;
      ownerWindow.removeEventListener(
        RENDERER_REASONING_DISPLAY_PREFERENCE_EVENT,
        onPreferenceChanged,
      );
      ownerWindow.removeEventListener("storage", onStorage);
      detachReasoningSubscription();
      resetRouteState();
    },
  };
}
