/**
 * Hides Desktop's Codex usage-limit banner in one external Harness Composer
 * while its usage gate is bypassed. That banner (for example "Codex usage
 * limit reached ... Upgrade / Reset usage") describes the Codex path only, so
 * it is misleading once the Composer submits to another Harness.
 *
 * The banner is identified by the props of the component Desktop renders it
 * with (`banner`, `rateLimitStatus`, `sendBlocked`), searched only inside the
 * submit owner's subtree. Only the inline `display` of its outermost host
 * elements is changed and restored; React state, atoms and the banner's own
 * dismissal bookkeeping are untouched, so the Codex Harness keeps the banner.
 */
type RecordValue = Record<string, unknown>;
type Fiber = { memoizedProps?: unknown; child?: unknown; sibling?: unknown; stateNode?: unknown };

const MAX_FIBERS = 20_000;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsageBanner(props: unknown): boolean {
  return (
    isRecord(props) &&
    "banner" in props &&
    "rateLimitStatus" in props &&
    typeof props.sendBlocked === "boolean"
  );
}

function isElement(value: unknown): value is HTMLElement {
  return (
    isRecord(value) &&
    typeof (value as { setAttribute?: unknown }).setAttribute === "function" &&
    isRecord((value as { style?: unknown }).style)
  );
}

/** Outermost host elements rendered by `fiber`, without descending past them. */
function hostElements(fiber: Fiber, budget: { remaining: number }): HTMLElement[] {
  const result: HTMLElement[] = [];
  const visit = (node: unknown): void => {
    for (let current = node; isRecord(current); current = (current as Fiber).sibling) {
      if (budget.remaining-- <= 0) return;
      const { stateNode } = current as Fiber;
      if (isElement(stateNode)) result.push(stateNode);
      else visit((current as Fiber).child);
    }
  };
  visit(fiber.child);
  return result;
}

/** Usage banner host elements inside `owner`'s committed subtree. */
export function findCodexUsageBannerElements(owner: unknown): HTMLElement[] {
  if (!isRecord(owner)) return [];
  const budget = { remaining: MAX_FIBERS };
  const found: HTMLElement[] = [];
  const stack: unknown[] = [(owner as Fiber).child];
  while (stack.length > 0 && budget.remaining > 0) {
    const node = stack.pop();
    if (!isRecord(node)) continue;
    budget.remaining -= 1;
    const fiber = node as Fiber;
    stack.push(fiber.sibling);
    if (isUsageBanner(fiber.memoizedProps)) found.push(...hostElements(fiber, budget));
    else stack.push(fiber.child);
  }
  return budget.remaining > 0 ? found : [];
}

const HIDDEN_ATTRIBUTE = "data-codexhost-usage-banner-hidden";

export interface RendererCodexUsageBanner {
  /** Hide the banners currently inside `owner`; restore any no longer there. */
  hide(owner: unknown): void;
  restore(): void;
}

export function createRendererCodexUsageBanner(): RendererCodexUsageBanner {
  const hidden = new Map<HTMLElement, { value: string; priority: string }>();
  const show = (element: HTMLElement): void => {
    const previous = hidden.get(element);
    hidden.delete(element);
    if (!previous || element.getAttribute(HIDDEN_ATTRIBUTE) === null) return;
    element.removeAttribute(HIDDEN_ATTRIBUTE);
    if (previous.value) element.style.setProperty("display", previous.value, previous.priority);
    else element.style.removeProperty("display");
  };
  return {
    hide(owner) {
      const current = new Set(findCodexUsageBannerElements(owner));
      for (const element of [...hidden.keys()]) if (!current.has(element)) show(element);
      for (const element of current) {
        if (hidden.has(element)) continue;
        hidden.set(element, {
          value: element.style.getPropertyValue("display"),
          priority: element.style.getPropertyPriority("display"),
        });
        element.setAttribute(HIDDEN_ATTRIBUTE, "");
        element.style.setProperty("display", "none", "important");
      }
    },
    restore() {
      for (const element of [...hidden.keys()]) show(element);
    },
  };
}
