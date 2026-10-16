/**
 * Hides the backend-provided Codex usage banner while this Composer submits to
 * an external Harness.
 *
 * Desktop renders the quota-exhausted banner from a server payload
 * (`banner_type`, localized title/description, CTAs), so the text depends on
 * the UI locale and plan. The banner is identified through React fibers
 * instead: walk from the banner's rendered `<aside>` to the owner whose props
 * carry `banner.banner_type`, and accept only banner types that belong to the
 * Codex usage-quota family. Anything that cannot be verified stays visible.
 */
import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

type RecordValue = Record<string, unknown>;
type Fiber = { memoizedProps?: unknown; return?: unknown };

/**
 * Server banner types in the Codex usage-quota family. Rate-limit/usage-limit
 * reached types, credit depletion, and the reserve ("luna") gate banner — the
 * notifications that fire when the shared Codex subscription is exhausted.
 * Unrelated banners (image generation, selected model, invitations, generic
 * info) are never hidden.
 */
const USAGE_BANNER_TYPES: ReadonlySet<string> = new Set([
  "rate_limit",
  "usage_limit",
  "luna_reserve",
  "legacy_rate_limit_reached",
  "free_or_go_rate_limit_reached",
  "free_trial_rate_limit_reached",
  "go_trial_rate_limit_reached",
  "plus_rate_limit_reached",
  "plus_gpt6_rate_limit_reached",
  "prolite_rate_limit_reached",
  "pro_rate_limit_reached",
  "business_rate_limit_reached",
  "business_gpt6_rate_limit_reached",
  "cbp_rate_limit_reached",
  "workspace_member_usage_limit_reached",
  "workspace_owner_usage_limit_reached",
  "workspace_member_credits_depleted",
  "workspace_owner_credits_depleted",
  "selected_model_limit_reached",
]);

const BANNER_ASIDE_SELECTOR = "aside[aria-live]";
const HIDDEN_FLAG = "data-codexhost-usage-banner-hidden";

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The banner payload `{ banner_type, ... }` sits in the memoized props of a
 * component above the rendered `<aside>` shell, sometimes wrapped one level
 * deeper (`{ banner: { banner_type } }`).
 */
function bannerTypeOf(fiber: Fiber): string | null {
  const props = fiber.memoizedProps;
  if (!isRecord(props)) return null;
  for (const candidate of [props.banner, props]) {
    if (!isRecord(candidate)) continue;
    const type = candidate.banner_type;
    if (typeof type === "string" && type.length > 0) return type;
  }
  return null;
}

function isUsageBannerAside(element: Element): boolean {
  if (element.tagName !== "ASIDE") return false;
  let current: Fiber | null = null;
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
  if (key)
    current = (Object.getOwnPropertyDescriptor(element, key)?.value as Fiber | undefined) ?? null;
  for (const ancestor of committedReactAncestors(current)) {
    const type = bannerTypeOf(ancestor);
    if (type === null) continue;
    return USAGE_BANNER_TYPES.has(type);
  }
  // No typed ancestor found: not one of ours, leave it alone.
  return false;
}

export interface RendererCodexUsageBanner {
  /**
   * `hidden`: this Composer submits to a ready external Harness, so the Codex
   * usage banner is irrelevant while it is showing.
   */
  update(hidden: boolean): void;
  /** Re-apply the last decision (new banner nodes may have mounted). */
  refresh(): void;
  dispose(): void;
}

export function createRendererCodexUsageBanner(root: ParentNode): RendererCodexUsageBanner {
  let hidden = false;

  const release = (): void => {
    for (const element of root.querySelectorAll<HTMLElement>(`aside[${HIDDEN_FLAG}]`)) {
      element.removeAttribute(HIDDEN_FLAG);
      element.style.display = "";
    }
  };

  const apply = (): void => {
    release();
    if (!hidden) return;
    for (const element of root.querySelectorAll<HTMLElement>(BANNER_ASIDE_SELECTOR)) {
      if (!isUsageBannerAside(element)) continue;
      if (element.hasAttribute(HIDDEN_FLAG)) continue;
      element.setAttribute(HIDDEN_FLAG, "1");
      element.style.display = "none";
    }
  };

  return {
    update(next) {
      hidden = next;
      apply();
    },
    refresh: apply,
    dispose() {
      hidden = false;
      release();
    },
  };
}

/** Read-only inspection for diagnostics: count usage banners in `root`. */
export function inspectCodexUsageBanners(root: ParentNode): { usageBannerCount: number } {
  let count = 0;
  for (const element of root.querySelectorAll(BANNER_ASIDE_SELECTOR)) {
    if (isUsageBannerAside(element)) count += 1;
  }
  return { usageBannerCount: count };
}
