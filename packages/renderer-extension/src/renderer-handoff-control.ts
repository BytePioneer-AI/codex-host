import {
  harnessIdSchema,
  hostThreadIdSchema,
  type HarnessInspection,
  type HarnessModelCatalog,
  type HarnessPluginDescriptor,
  type HostThreadId,
  type ThreadHandoffMetadata,
} from "@codexhost/shared-contracts";

import { readCodexLocaleSettings } from "./codex-locale-adapter.js";
import { rendererAgentLabel } from "./renderer-agent-icon.js";
import {
  CODEX_COMPOSER_SELECTOR,
  sendButtonWithin,
  trailingActionAnchor,
} from "./renderer-composer-dom.js";
import { isOrbitComposer } from "./renderer-composer-kind.js";
import { hasNativeComposerRequest } from "./renderer-composer-request.js";
import { openRendererThread } from "./renderer-fork-control.js";
import { rendererHarnessMessages } from "./renderer-harness-localization.js";
import {
  createHandoffDividerElement,
  createSwapIcon,
  ensureRendererHandoffStyle,
  HANDOFF_CONTROL_ATTRIBUTE,
  HANDOFF_DIVIDER_ATTRIBUTE,
  HANDOFF_POPOVER_ATTRIBUTE,
  HANDOFF_POPOVER_WIDTH,
  renderHandoffPopoverContent,
} from "./renderer-handoff-view.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";
import {
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "./settings/localization.js";

export {
  createHandoffDividerElement,
  ensureRendererHandoffStyle,
  HANDOFF_CONTROL_ATTRIBUTE,
  HANDOFF_DIVIDER_ATTRIBUTE,
  HANDOFF_POPOVER_ATTRIBUTE,
  renderHandoffPopoverContent,
  type HandoffDividerRenderOptions,
  type HandoffPopoverViewOptions,
} from "./renderer-handoff-view.js";

const COMPOSER_TURN_SELECTORS = [
  "[data-turn-key]",
  "[data-content-search-turn-key]",
  "[data-local-conversation-item-target-ids]",
] as const;
const CONVERSATION_ANCESTOR_MAX_DEPTH = 8;
const POPOVER_PADDING = 8;
const POPOVER_OFFSET = 8;
const OWNED_TRAILING_SELECTORS = [
  "[data-codexhost-harness-command-control]",
  "[data-codexhost-usage-control]",
  "[data-codexhost-model-control]",
  "[data-codexhost-agent-control]",
] as const;

export interface RendererHandoffControl {
  refresh(): void;
  dispose(): void;
}

export interface RendererHandoffControlOptions {
  getClient(): RendererModelClient | null;
  getHostId?(composer?: Element): string | null;
  resolveComposerThreadId?(composer: Element): HostThreadId | null;
  getLocale?(): RendererSettingsLocale;
  openThread?(threadId: HostThreadId, options?: { hostId?: string }): Promise<void>;
  document?: Document;
  window?: Window;
  reportError?(error: unknown): void;
}

function defaultResolveComposerThreadId(composer: Element): HostThreadId | null {
  const portals = Array.from(composer.children ?? []).filter((child) =>
    child.hasAttribute("data-above-composer-portal"),
  );
  if (portals.length !== 1) return null;
  const raw = portals[0]?.getAttribute("data-above-composer-conversation-id");
  if (!raw) return null;
  const parsed = hostThreadIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function isComposerVisible(composer: Element, ownerWindow: Window): boolean {
  if (!composer.isConnected) return false;
  if (
    typeof composer.closest === "function" &&
    composer.closest('[hidden], [inert], [aria-hidden="true"]')
  )
    return false;
  if (typeof ownerWindow.getComputedStyle === "function") {
    const style = ownerWindow.getComputedStyle(composer);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function findActiveConversationComposer(
  ownerDocument: Document,
  ownerWindow: Window,
  resolveThreadId: (composer: Element) => HostThreadId | null,
): { composer: Element; threadId: HostThreadId } | null {
  const composers = [...ownerDocument.querySelectorAll(CODEX_COMPOSER_SELECTOR)];
  for (const composer of composers) {
    if (isOrbitComposer(composer) || hasNativeComposerRequest(composer)) continue;
    if (!isComposerVisible(composer, ownerWindow)) continue;
    const threadId = resolveThreadId(composer);
    if (threadId) return { composer, threadId };
  }
  return null;
}

function findTriggerAnchor(composer: Element): { parent: HTMLElement; before: Element } | null {
  const sendButton = sendButtonWithin(composer);
  if (!sendButton) return null;
  const trailing = trailingActionAnchor(sendButton);
  const parent = trailing.parentElement;
  if (!parent || !parent.isConnected || !composer.contains(parent)) return null;
  for (const selector of OWNED_TRAILING_SELECTORS) {
    const existing: Element | null = parent.querySelector(selector);
    if (existing && existing.parentElement === parent) {
      return { parent, before: existing };
    }
  }
  return { parent, before: trailing };
}

function findConversationDividerAnchor(
  composer: Element,
): { parent: Element; before: Element } | null {
  let ancestor: Element | null = composer.parentElement;
  for (
    let depth = 0;
    ancestor && depth < CONVERSATION_ANCESTOR_MAX_DEPTH && ancestor !== composer.ownerDocument.body;
    depth += 1
  ) {
    for (const selector of COMPOSER_TURN_SELECTORS) {
      const firstTurn = ancestor.querySelector(selector);
      if (firstTurn && firstTurn.parentElement && !composer.contains(firstTurn)) {
        return { parent: firstTurn.parentElement, before: firstTurn };
      }
    }
    ancestor = ancestor.parentElement;
  }
  if (composer.parentElement) {
    return { parent: composer.parentElement, before: composer };
  }
  return null;
}

function positionPopover(
  popover: HTMLElement,
  trigger: HTMLElement,
  ownerWindow: Window,
  ownerDocument: Document,
): void {
  const rect = trigger.getBoundingClientRect();
  const rawZoom =
    typeof ownerWindow.getComputedStyle === "function"
      ? ownerWindow
          .getComputedStyle(ownerDocument.documentElement)
          .getPropertyValue("--codex-window-zoom")
      : "";
  const parsedZoom = Number.parseFloat(rawZoom.trim());
  const zoom = Number.isFinite(parsedZoom) && parsedZoom > 0 ? parsedZoom : 1;
  const viewportWidth = (ownerWindow.innerWidth || 1024) / zoom;
  const viewportHeight = (ownerWindow.innerHeight || 768) / zoom;
  const width = Math.min(HANDOFF_POPOVER_WIDTH, Math.max(220, viewportWidth - POPOVER_PADDING * 2));
  const left = Math.max(
    POPOVER_PADDING,
    Math.min(rect.right / zoom - width, viewportWidth - width - POPOVER_PADDING),
  );
  const bottom = Math.max(POPOVER_PADDING, viewportHeight - rect.top / zoom + POPOVER_OFFSET);
  popover.style.width = `${width}px`;
  popover.style.left = `${left}px`;
  popover.style.bottom = `${bottom}px`;
}

function errorDetail(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return `${fallback}: ${error.message.trim()}`;
  }
  return fallback;
}

export function installRendererHandoffControl(
  options: RendererHandoffControlOptions,
): RendererHandoffControl {
  const ownerDocument =
    options.document ?? (typeof document !== "undefined" ? document : undefined);
  const ownerWindow = options.window ?? (typeof window !== "undefined" ? window : undefined);
  if (
    !ownerDocument ||
    !ownerWindow ||
    typeof ownerDocument.querySelectorAll !== "function" ||
    !ownerDocument.documentElement
  ) {
    return {
      refresh() {},
      dispose() {},
    };
  }

  const resolveThreadId = options.resolveComposerThreadId ?? defaultResolveComposerThreadId;
  const openThread =
    options.openThread ??
    ((threadId: HostThreadId, openOptions?: { hostId?: string }) =>
      openRendererThread(threadId, openOptions));

  let disposed = false;
  let locale: RendererSettingsLocale =
    options.getLocale?.() ??
    resolveRendererSettingsLocale(
      ownerWindow.navigator?.languages ?? [ownerWindow.navigator?.language ?? "en"],
    );

  const currentLocale = (): RendererSettingsLocale => options.getLocale?.() ?? locale;

  let activeComposer: Element | null = null;
  let activeThreadId: HostThreadId | null = null;
  let activeHostId: string | null = null;

  let triggerRoot: HTMLElement | null = null;
  let triggerButton: HTMLButtonElement | null = null;
  let dividerElement: HTMLElement | null = null;
  let dividerKey: string | null = null;

  const handoffCache = new Map<string, ThreadHandoffMetadata | null>();
  const threadOwnerHarness = new Map<string, string>();
  const inFlightInspects = new Map<string, Promise<void>>();
  const pluginsByHost = new Map<string, HarnessPluginDescriptor[]>();
  const pluginsLoadingByHost = new Map<string, Promise<void>>();
  const harnessCatalogCache = new Map<string, HarnessModelCatalog | null>();
  const harnessInspectInFlight = new Set<string>();

  interface OpenPopoverState {
    element: HTMLElement;
    threadId: HostThreadId;
    hostId: string | null;
    selectedHarnessId: string;
    selectedModelId: string;
    selectedThinkingOptionId: string;
    submitting: boolean;
    errorMessage: string | null;
    createdThreadId: HostThreadId | null;
  }
  let popoverState: OpenPopoverState | null = null;

  const hostScopeKey = (hostId: string | null): string => hostId ?? "default";
  const cacheKeyFor = (hostId: string | null, threadId: HostThreadId): string =>
    `${hostScopeKey(hostId)}\u0000${threadId}`;
  const catalogCacheKey = (hostId: string | null, harnessId: string): string =>
    `${hostScopeKey(hostId)}\u0000${harnessId}`;

  const clientForHost = (hostId: string | null): RendererModelClient | null => {
    const base = options.getClient();
    if (!base) return null;
    if (hostId === null) return base;
    if (base.clientForHost) return base.clientForHost(hostId);
    if (!base.currentHostId) return hostId === "local" ? base : null;
    return base.currentHostId() === hostId ? base : null;
  };

  const pluginsForHost = (hostId: string | null): HarnessPluginDescriptor[] =>
    pluginsByHost.get(hostScopeKey(hostId)) ?? [];

  const unmountDivider = (): void => {
    dividerElement?.remove();
    dividerElement = null;
    dividerKey = null;
  };

  const unmountTrigger = (): void => {
    triggerRoot?.remove();
    triggerRoot = null;
    triggerButton = null;
  };

  const closePopover = (): void => {
    if (!popoverState) return;
    popoverState.element.remove();
    popoverState = null;
    triggerButton?.setAttribute("aria-expanded", "false");
    triggerButton?.removeAttribute("data-state");
  };

  const availableHarnesses = (
    hostId: string | null,
  ): {
    id: string;
    label: string;
    plugin?: HarnessPluginDescriptor;
  }[] => [
    { id: "codex", label: "Codex" },
    ...pluginsForHost(hostId).map((plugin) => ({
      id: plugin.id,
      label: rendererAgentLabel(plugin.id, plugin),
      plugin,
    })),
  ];

  const loadPlugins = async (client: RendererModelClient, hostId: string | null): Promise<void> => {
    const scope = hostScopeKey(hostId);
    if (pluginsByHost.has(scope) || !client.listHarnessPlugins) return;
    const existing = pluginsLoadingByHost.get(scope);
    if (existing) return existing;
    const request = (async () => {
      try {
        const result = await client.listHarnessPlugins?.();
        if (disposed || !result) return;
        pluginsByHost.set(
          scope,
          result.plugins.filter(({ kind }) => kind !== "usage"),
        );
        if (popoverState && hostScopeKey(popoverState.hostId) === scope) renderPopover();
        if (activeThreadId && hostScopeKey(activeHostId) === scope) syncDivider();
      } catch {
        // Plugin listing is optional; Codex remains selectable and icons fall back gracefully.
      } finally {
        pluginsLoadingByHost.delete(scope);
      }
    })();
    pluginsLoadingByHost.set(scope, request);
    return request;
  };

  const loadHarnessCatalog = (hostId: string | null, harnessId: string): void => {
    const key = catalogCacheKey(hostId, harnessId);
    if (harnessId === "codex" || harnessCatalogCache.has(key)) return;
    if (harnessInspectInFlight.has(key)) return;
    const client = clientForHost(hostId);
    if (!client) return;
    const parsedId = harnessIdSchema.safeParse(harnessId);
    if (!parsedId.success) return;
    harnessInspectInFlight.add(key);
    if (popoverState?.selectedHarnessId === harnessId && popoverState.hostId === hostId) {
      renderPopover();
    }
    void client
      .inspectHarness({ harnessId: parsedId.data })
      .then((inspection: HarnessInspection) => {
        if (disposed) return;
        harnessCatalogCache.set(
          key,
          inspection.status === "ready" ? (inspection.catalog ?? null) : null,
        );
      })
      .catch(() => {
        if (!disposed) harnessCatalogCache.set(key, null);
      })
      .finally(() => {
        harnessInspectInFlight.delete(key);
        if (
          !disposed &&
          popoverState?.selectedHarnessId === harnessId &&
          popoverState.hostId === hostId
        ) {
          renderPopover();
        }
      });
  };

  const submitHandoff = (): void => {
    const state = popoverState;
    if (!state || state.submitting) return;
    const targetHostId = state.hostId;
    const openCreatedTarget = async (createdThreadId: HostThreadId): Promise<void> => {
      await openThread(createdThreadId, targetHostId ? { hostId: targetHostId } : undefined);
      if (disposed) return;
      if (popoverState === state) closePopover();
    };
    if (state.createdThreadId) {
      state.submitting = true;
      state.errorMessage = null;
      renderPopover();
      void openCreatedTarget(state.createdThreadId).catch((error: unknown) => {
        if (disposed) return;
        options.reportError?.(error);
        if (popoverState === state) {
          state.submitting = false;
          state.errorMessage = errorDetail(
            error,
            rendererHarnessMessages(currentLocale()).handoffFailed,
          );
          renderPopover();
        }
      });
      return;
    }
    const client = clientForHost(targetHostId);
    if (!client) {
      state.errorMessage = rendererHarnessMessages(currentLocale()).handoffFailed;
      renderPopover();
      return;
    }
    const parsedHarness = harnessIdSchema.safeParse(state.selectedHarnessId);
    if (!parsedHarness.success) {
      state.errorMessage = rendererHarnessMessages(currentLocale()).handoffFailed;
      renderPopover();
      return;
    }
    state.submitting = true;
    state.errorMessage = null;
    renderPopover();
    void client
      .handoffThread({
        sourceThreadId: state.threadId,
        targetHarnessId: parsedHarness.data,
        ...(state.selectedModelId ? { targetModel: state.selectedModelId } : {}),
        ...(state.selectedThinkingOptionId
          ? { targetThinkingOptionId: state.selectedThinkingOptionId }
          : {}),
      })
      .then(async (result) => {
        if (disposed) return;
        handoffCache.set(cacheKeyFor(targetHostId, result.threadId), result.handoff);
        threadOwnerHarness.set(
          cacheKeyFor(targetHostId, result.threadId),
          result.handoff.targetHarnessId,
        );
        state.createdThreadId = result.threadId;
        await openCreatedTarget(result.threadId);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        options.reportError?.(error);
        if (popoverState === state) {
          state.submitting = false;
          state.errorMessage = errorDetail(
            error,
            rendererHarnessMessages(currentLocale()).handoffFailed,
          );
          renderPopover();
        }
      });
  };

  const renderPopover = (): void => {
    const state = popoverState;
    if (!state) return;
    const harnesses = availableHarnesses(state.hostId);
    if (!harnesses.some(({ id }) => id === state.selectedHarnessId) && harnesses[0]) {
      state.selectedHarnessId = harnesses[0].id;
    }
    const key = catalogCacheKey(state.hostId, state.selectedHarnessId);
    const catalog = harnessCatalogCache.get(key) ?? undefined;
    const loadingModels = harnessInspectInFlight.has(key);
    renderHandoffPopoverContent(state.element, {
      ownerDocument,
      locale: currentLocale(),
      harnesses,
      selectedHarnessId: state.selectedHarnessId,
      catalog,
      loadingModels,
      selectedModelId: state.selectedModelId,
      selectedThinkingOptionId: state.selectedThinkingOptionId,
      submitting: state.submitting,
      errorMessage: state.errorMessage,
      onSelectHarness: (harnessId) => {
        if (state.selectedHarnessId === harnessId) return;
        state.selectedHarnessId = harnessId;
        state.selectedModelId = "";
        state.selectedThinkingOptionId = "";
        state.errorMessage = null;
        state.createdThreadId = null;
        loadHarnessCatalog(state.hostId, harnessId);
        renderPopover();
      },
      onSelectModel: (modelId) => {
        state.selectedModelId = modelId;
        state.selectedThinkingOptionId = "";
        state.createdThreadId = null;
        renderPopover();
      },
      onSelectThinking: (thinkingId) => {
        state.selectedThinkingOptionId = thinkingId;
        state.createdThreadId = null;
        renderPopover();
      },
      onConfirm: submitHandoff,
      onCancel: closePopover,
    });
    if (triggerButton) {
      positionPopover(state.element, triggerButton, ownerWindow, ownerDocument);
    }
  };

  const openPopover = (): void => {
    if (disposed || !activeThreadId || !triggerButton) return;
    if (popoverState) {
      closePopover();
      return;
    }
    const targetHostId = activeHostId;
    const client = clientForHost(targetHostId);
    const currentKey = cacheKeyFor(targetHostId, activeThreadId);
    const currentOwner = threadOwnerHarness.get(currentKey);
    const harnesses = availableHarnesses(targetHostId);
    const defaultTarget =
      harnesses.find(({ id }) => id !== currentOwner)?.id ?? harnesses[0]?.id ?? "codex";

    const element = ownerDocument.createElement("div");
    element.setAttribute(HANDOFF_POPOVER_ATTRIBUTE, "true");
    (ownerDocument.body ?? ownerDocument.documentElement).append(element);

    popoverState = {
      element,
      threadId: activeThreadId,
      hostId: targetHostId,
      selectedHarnessId: defaultTarget,
      selectedModelId: "",
      selectedThinkingOptionId: "",
      submitting: false,
      errorMessage: null,
      createdThreadId: null,
    };
    triggerButton.setAttribute("aria-expanded", "true");
    triggerButton.setAttribute("data-state", "open");
    renderPopover();
    if (client) {
      void loadPlugins(client, targetHostId).then(() => {
        if (!disposed && popoverState && popoverState.hostId === targetHostId) {
          const updatedHarnesses = availableHarnesses(targetHostId);
          if (
            popoverState.selectedHarnessId === currentOwner &&
            updatedHarnesses.some(({ id }) => id !== currentOwner)
          ) {
            popoverState.selectedHarnessId =
              updatedHarnesses.find(({ id }) => id !== currentOwner)?.id ??
              popoverState.selectedHarnessId;
          }
          loadHarnessCatalog(targetHostId, popoverState.selectedHarnessId);
          renderPopover();
        }
      });
    }
    loadHarnessCatalog(targetHostId, defaultTarget);
  };

  const ensureTriggerMounted = (composer: Element): void => {
    const anchor = findTriggerAnchor(composer);
    if (!anchor) {
      unmountTrigger();
      return;
    }
    ensureRendererTriggerChipStyle(ownerDocument);
    ensureRendererHandoffStyle(ownerDocument);
    const messages = rendererHarnessMessages(currentLocale());
    if (!triggerRoot || !triggerButton) {
      const root = ownerDocument.createElement("div");
      root.setAttribute(HANDOFF_CONTROL_ATTRIBUTE, "true");

      const button = ownerDocument.createElement("button");
      button.type = "button";
      button.className = TRIGGER_CHIP_CLASS;
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("data-codexhost-handoff-trigger", "true");
      Object.assign(button.style, {
        width: "28px",
        height: "28px",
        padding: "0",
      });
      button.append(createSwapIcon(ownerDocument, 14));
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        openPopover();
      });
      root.append(button);
      triggerRoot = root;
      triggerButton = button;
    }
    triggerButton.setAttribute("aria-label", messages.handoffAction);
    triggerButton.title = messages.handoffAction;
    if (
      triggerRoot.parentElement !== anchor.parent ||
      triggerRoot.nextElementSibling !== anchor.before
    ) {
      anchor.parent.insertBefore(triggerRoot, anchor.before);
    }
  };

  const syncDivider = (): void => {
    if (!activeComposer || !activeThreadId) {
      unmountDivider();
      return;
    }
    const key = cacheKeyFor(activeHostId, activeThreadId);
    const handoff = handoffCache.get(key);
    if (!handoff) {
      unmountDivider();
      return;
    }
    const anchor = findConversationDividerAnchor(activeComposer);
    if (!anchor) {
      unmountDivider();
      return;
    }
    const plugins = pluginsForHost(activeHostId);
    const renderSignature = JSON.stringify([
      key,
      currentLocale(),
      handoff.createdAtMs,
      plugins.map(({ id, name, icon }) => [id, name, icon]),
    ]);
    if (!dividerElement || dividerKey !== renderSignature) {
      const wasExpanded =
        dividerElement
          ?.querySelector("[data-codexhost-handoff-divider-toggle]")
          ?.getAttribute("aria-expanded") === "true";
      dividerElement?.remove();
      const targetHostId = activeHostId;
      dividerElement = createHandoffDividerElement({
        ownerDocument,
        handoff,
        plugins,
        locale: currentLocale(),
        initiallyExpanded: wasExpanded,
        onOpenSourceThread: (sourceThreadId) => {
          void openThread(
            sourceThreadId,
            targetHostId ? { hostId: targetHostId } : undefined,
          ).catch((error: unknown) => options.reportError?.(error));
        },
      });
      dividerKey = renderSignature;
    }
    if (
      dividerElement.parentElement !== anchor.parent ||
      dividerElement.nextElementSibling !== anchor.before
    ) {
      anchor.parent.insertBefore(dividerElement, anchor.before);
    }
  };

  const ensureThreadInspected = (threadId: HostThreadId, hostId: string | null): void => {
    const key = cacheKeyFor(hostId, threadId);
    if (handoffCache.has(key) || inFlightInspects.has(key)) return;
    const client = clientForHost(hostId);
    if (!client) return;
    const request = (async () => {
      try {
        const inspection = await client.inspectThread({ threadId });
        if (disposed) return;
        threadOwnerHarness.set(
          key,
          inspection.owner === "external" ? inspection.harnessId : "codex",
        );
        const handoff = inspection.handoff ?? null;
        handoffCache.set(key, handoff);
        if (handoff) {
          void loadPlugins(client, hostId);
        }
        if (activeThreadId === threadId && activeHostId === hostId) {
          syncDivider();
        }
      } catch {
        // Inspection can fail transiently before Host routing settles; retry on next refresh.
      } finally {
        inFlightInspects.delete(key);
      }
    })();
    inFlightInspects.set(key, request);
  };

  const refresh = (): void => {
    if (disposed) return;
    const active = findActiveConversationComposer(ownerDocument, ownerWindow, resolveThreadId);
    if (!active) {
      activeComposer = null;
      activeThreadId = null;
      activeHostId = null;
      closePopover();
      unmountTrigger();
      unmountDivider();
      return;
    }
    const hostId = options.getHostId?.(active.composer) ?? null;
    const threadChanged = active.threadId !== activeThreadId || hostId !== activeHostId;
    activeComposer = active.composer;
    activeThreadId = active.threadId;
    activeHostId = hostId;

    if (threadChanged) {
      closePopover();
      unmountDivider();
    }

    ensureTriggerMounted(active.composer);
    ensureThreadInspected(active.threadId, hostId);
    syncDivider();
  };

  let frameId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = (): void => {
    if (disposed || frameId !== null || timerId !== null) return;
    if (typeof ownerWindow.requestAnimationFrame === "function") {
      frameId = ownerWindow.requestAnimationFrame(() => {
        frameId = null;
        refresh();
      });
    } else {
      timerId = setTimeout(() => {
        timerId = null;
        refresh();
      }, 0);
    }
  };

  const refreshLocale = (): void => {
    if (disposed || options.getLocale) return;
    void readCodexLocaleSettings({ ownerWindow })
      .then((settings) => {
        if (disposed) return;
        const next = resolveRendererSettingsLocale([settings.preferredLocale]);
        if (next === locale) return;
        locale = next;
        if (triggerButton) {
          const messages = rendererHarnessMessages(locale);
          triggerButton.setAttribute("aria-label", messages.handoffAction);
          triggerButton.title = messages.handoffAction;
        }
        if (popoverState) renderPopover();
        syncDivider();
      })
      .catch(() => undefined);
  };

  const onDocumentPointerDown = (event: Event): void => {
    if (!popoverState) return;
    const target = event.target instanceof Node ? event.target : null;
    if (!target) return;
    if (popoverState.element.contains(target) || triggerRoot?.contains(target)) return;
    closePopover();
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && popoverState && !popoverState.submitting) {
      closePopover();
      triggerButton?.focus();
    }
  };

  const onWindowResize = (): void => {
    if (popoverState && triggerButton) {
      positionPopover(popoverState.element, triggerButton, ownerWindow, ownerDocument);
    }
  };

  const onWindowFocus = (): void => {
    refreshLocale();
    scheduleRefresh();
  };

  const onRoutingChanged = (): void => {
    scheduleRefresh();
  };

  const observer =
    typeof MutationObserver === "function"
      ? new MutationObserver((mutations) => {
          if (disposed) return;
          for (const mutation of mutations) {
            const target = mutation.target;
            if (
              target instanceof Element &&
              (target.closest(`[${HANDOFF_DIVIDER_ATTRIBUTE}]`) ||
                target.closest(`[${HANDOFF_POPOVER_ATTRIBUTE}]`) ||
                target.closest(`[${HANDOFF_CONTROL_ATTRIBUTE}]`))
            ) {
              continue;
            }
            scheduleRefresh();
            return;
          }
        })
      : null;

  observer?.observe(ownerDocument.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-above-composer-conversation-id", "hidden", "aria-hidden"],
  });

  ownerDocument.addEventListener?.("pointerdown", onDocumentPointerDown, true);
  ownerDocument.addEventListener?.("keydown", onDocumentKeyDown, true);
  ownerWindow.addEventListener?.("resize", onWindowResize);
  ownerWindow.addEventListener?.("focus", onWindowFocus);
  ownerWindow.addEventListener?.("codexhost:draft-prewarm-policy-changed", onRoutingChanged);

  refreshLocale();
  refresh();

  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      if (frameId !== null && typeof ownerWindow.cancelAnimationFrame === "function") {
        ownerWindow.cancelAnimationFrame(frameId);
      }
      if (timerId !== null) clearTimeout(timerId);
      frameId = null;
      timerId = null;
      ownerDocument.removeEventListener?.("pointerdown", onDocumentPointerDown, true);
      ownerDocument.removeEventListener?.("keydown", onDocumentKeyDown, true);
      ownerWindow.removeEventListener?.("resize", onWindowResize);
      ownerWindow.removeEventListener?.("focus", onWindowFocus);
      ownerWindow.removeEventListener?.("codexhost:draft-prewarm-policy-changed", onRoutingChanged);
      closePopover();
      unmountTrigger();
      unmountDivider();
      handoffCache.clear();
      threadOwnerHarness.clear();
      inFlightInspects.clear();
      pluginsByHost.clear();
      pluginsLoadingByHost.clear();
      harnessCatalogCache.clear();
      harnessInspectInFlight.clear();
      activeComposer = null;
      activeThreadId = null;
      activeHostId = null;
    },
  };
}
