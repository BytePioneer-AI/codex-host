import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

const COMPOSER_SELECTOR = "[data-codex-composer-root]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexUsageBanner(element: HTMLElement, composer: Element): boolean {
  if (element.closest(COMPOSER_SELECTOR) !== composer) return false;
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
  if (!key) return false;
  for (const { memoizedProps: props } of committedReactAncestors(
    Object.getOwnPropertyDescriptor(element, key)?.value,
  )) {
    if (!isRecord(props) || !isRecord(props.banner)) continue;
    const type = props.banner.banner_type;
    return typeof type === "string" && /^(?:[a-z0-9]+_)*rate_limit_reached$/u.test(type);
  }

  return false;
}

export function hasCodexUsageBanner(composer: Element): boolean {
  return [...composer.querySelectorAll<HTMLElement>('aside[role="status"]')].some((element) =>
    isCodexUsageBanner(element, composer),
  );
}

interface BannerState {
  hidden: HTMLElement["hidden"];
  ariaHidden: string | null;
  display: string;
  priority: string;
}

export interface RendererCodexUsageBanner {
  update(bypassed: boolean): void;
  dispose(): void;
}

/** Hide only the native exhaustion notice belonging to a quota-isolated Composer. */
export function createRendererCodexUsageBanner(composer: Element): RendererCodexUsageBanner {
  const hidden = new Map<HTMLElement, BannerState>();
  let bypassed = false;
  let disposed = false;
  const Observer = composer.ownerDocument?.defaultView?.MutationObserver;
  const observer = Observer
    ? new Observer(() => {
        if (!disposed && bypassed) reconcile();
      })
    : null;
  const restore = (element: HTMLElement, state: BannerState): void => {
    if (element.hidden === true) element.hidden = state.hidden;
    if (element.getAttribute("aria-hidden") === "true") {
      if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", state.ariaHidden);
    }
    if (
      element.style.getPropertyValue("display") === "none" &&
      element.style.getPropertyPriority("display") === "important"
    ) {
      if (state.display) element.style.setProperty("display", state.display, state.priority);
      else element.style.removeProperty("display");
    }
    hidden.delete(element);
  };
  const release = (): void => {
    for (const [element, state] of hidden) restore(element, state);
  };
  const reconcile = (): void => {
    if (!bypassed || !composer.isConnected) {
      release();
      return;
    }
    const banners = new Set(
      [...composer.querySelectorAll<HTMLElement>('aside[role="status"]')].filter((element) =>
        isCodexUsageBanner(element, composer),
      ),
    );
    for (const [element, state] of hidden) {
      if (!banners.has(element)) restore(element, state);
    }
    for (const element of banners) {
      if (!hidden.has(element)) {
        hidden.set(element, {
          hidden: element.hidden,
          ariaHidden: element.getAttribute("aria-hidden"),
          display: element.style.getPropertyValue("display"),
          priority: element.style.getPropertyPriority("display"),
        });
      }
      if (element.hidden !== true) element.hidden = true;
      if (element.getAttribute("aria-hidden") !== "true")
        element.setAttribute("aria-hidden", "true");
      if (
        element.style.getPropertyValue("display") !== "none" ||
        element.style.getPropertyPriority("display") !== "important"
      ) {
        element.style.setProperty("display", "none", "important");
      }
    }
  };
  return {
    update(next) {
      if (disposed) return;
      if (next !== bypassed) {
        bypassed = next;
        observer?.disconnect();
        if (bypassed) {
          // Mutation callbacks run before paint; an animation-frame scan is too late.
          observer?.observe(composer, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["hidden", "aria-hidden", "style"],
          });
        }
      }
      reconcile();
    },
    dispose() {
      disposed = true;
      bypassed = false;
      observer?.disconnect();
      release();
    },
  };
}
