import type { CodexServiceTierId } from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import {
  CODEX_SERVICE_TIER_BOLT_PATHS,
  CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE,
} from "./renderer-codex-service-tier-style.js";
import type { RendererSettingsLocale } from "./settings/localization.js";
import { rendererSettingsMessages } from "./settings/localization.js";

/**
 * The codexhost Composer speed control for the request tier (Fast / Ultrafast).
 *
 * The Desktop builds its own speed control only when the account tier gate and
 * the catalog both allow it (`B0e` returns null for an empty option list). The
 * account half normally fails on a custom Model Provider, but codexhost itself
 * declares `priority` / `ultrafast` in the catalog, so the official control can
 * still appear; this module detects it first and yields rather than stacking a
 * second speed entry.
 *
 * Where it takes over, codexhost fills the official slots: the tier gear inside
 * the official Model trigger is pure CSS keyed on the local ownership scope this
 * module stamps onto the local Composer root, and this module adds the
 * official 32px speed button inside the menu's `_ViewControls_` row, right
 * after the model view toggle, opening the official 233px tier flyout. The
 * scope stamp is also written onto the official menu portal, which is where the
 * slider particles read it; a remote Host Composer, an external Harness and a
 * switching Composer are never stamped, so the accent cannot appear there.
 *
 * Two constraints shape the implementation and must not be "simplified":
 * - The flyout cannot be a plain child of the menu: `_ViewTrack_` is
 *   `overflow:clip`, `_ModelPickerDropdownContent_` is `overflow-hidden` with
 *   `will-change:transform`, and the official submenu handles ancestor `zoom`.
 *   The official `FlyoutSubmenuItem` therefore renders into its own overlay
 *   layer; codexhost uses a `popover="manual"` element in the top layer for the
 *   same reason. Without popover support nothing is injected at all.
 * - The official menu walks `[role^="menuitem"]:not([data-disabled]):not(
 *   [data-interactive="false"])` in a capture-phase keydown. The flyout rows
 *   carry `data-interactive="false"` so that walk leaves them to this module's
 *   own arrow/Home/End handling; Tab is never trapped.
 *
 * While the flyout is open, a menu-scoped MutationObserver watches the
 * visibility attributes the Desktop uses to swap panels, because the top layer
 * does not inherit them. A visibility flip is re-checked after a short grace,
 * because the official menu toggles those attributes on its own rows while the
 * pointer crosses them; a real swap stays invalid and still closes, and losing
 * the button, flyout or menu closes at once. Every DOM write is a comparison
 * guard, so a re-render with no change touches nothing and cannot feed the
 * probe's observer.
 */

/** The codexhost speed button inside the official `_ViewControls_` row. */
export const CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE = "data-codexhost-service-tier-toggle";
/** The codexhost tier flyout opened by the button (the official 233px submenu). */
export const CODEX_SERVICE_TIER_FLYOUT_ATTRIBUTE = "data-codexhost-service-tier-flyout";
export const CODEX_SERVICE_TIER_OPTION_ATTRIBUTE = "data-codexhost-service-tier-option";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** The official row holding the model view toggle and the speed button. */
const VIEW_CONTROLS_SELECTOR = '[class*="ViewControls"]';
/** The official model view toggle; the official speed button follows it. */
const VIEW_TOGGLE_SELECTOR = "[data-model-picker-view-toggle]";
/**
 * The official speed control, when the account and catalog both allow it.
 * Only the official class fragment is matched — never codexhost's own
 * attribute — so the injected button cannot be mistaken for the Desktop's.
 */
const OFFICIAL_SPEED_SELECTOR = '[class*="FastModeToggle"]';

/**
 * Official `bolt-fill-light-16` (`Lne`), viewBox 0 0 16 16: the Fast icon the
 * Desktop masks into the button's 26px content.
 */
const FAST_ICON = {
  viewBox: "0 0 16 16",
  d: "M8.34278 1.71324C9.03756 1.01907 10.2544 1.67038 10.0137 2.66441L9.32715 5.49644H12.5938C13.5715 5.49644 14.1035 6.63914 13.4736 7.38707L7.72266 14.2162C7.04234 15.0231 5.73791 14.3622 5.98633 13.3363L6.67285 10.5043H3.40625C2.42855 10.5042 1.89667 9.36153 2.52637 8.61363L8.27735 1.78453L8.34278 1.71324Z",
} as const;
/** Official Ultrafast double bolt (`hU`), rendered at 16px like `_UltrafastIcon_`. */
const ULTRAFAST_ICON = CODEX_SERVICE_TIER_BOLT_PATHS.ultrafast;
const TIER_ICON_SIZE_PX = 16;

/**
 * Official check mark, exactly as bundled: the 17-unit `checkmark` glyph the
 * Desktop renders as a menu row's `RightIcon`.
 */
const CHECK_PATH =
  "M12.8961 3.64101C13.1297 3.41418 13.4984 3.37523 13.7779 3.56581C14.0571 3.75635 14.1554 4.11331 14.0299 4.41347L13.9615 4.53847L7.71151 13.7045C7.59411 13.8767 7.4063 13.9877 7.19881 14.0072C6.99136 14.0267 6.78564 13.9533 6.63826 13.806L2.88826 10.056L2.79842 9.9457C2.6192 9.67407 2.64927 9.30496 2.88826 9.06581C3.12738 8.82669 3.49647 8.79676 3.76815 8.97597L3.8785 9.06581L7.03084 12.2182L12.8053 3.74941L12.8961 3.64101Z";
const CHECK_VIEW_BOX = "0 0 17 17";
const CHECK_SIZE_PX = 17;

/** Official flyout geometry: the submenu's own 4px `sideOffset` from the menu. */
const FLYOUT_SIDE_OFFSET_PX = 4;
/** Keep the flyout inside the viewport, like the official collision padding. */
const FLYOUT_VIEWPORT_MARGIN_PX = 8;
/** The official `FlyoutSubmenuItem` opens after this mouse-hover delay (nbi = 200). */
const FLYOUT_HOVER_DELAY_MS = 200;
/**
 * The attributes the Desktop uses to hide or swap out the panel the button
 * lives in; a change in any of them takes an open flyout away with it.
 */
const VISIBILITY_ATTRIBUTES = [
  "hidden",
  "aria-hidden",
  "inert",
  "data-ultra-warning-visible",
] as const;

/**
 * Consecutive frame checks a visibility flip gets before it closes an open
 * flyout. The official menu toggles these attributes on its own rows while the
 * pointer crosses them; a real panel swap keeps them set past the grace.
 */
const FLYOUT_VISIBILITY_GRACE_FRAMES = 2;
/** The same grace in milliseconds where the view cannot schedule frames. */
export const FLYOUT_VISIBILITY_GRACE_MS = 72;

/**
 * The official tier list, in the official order. `standard` is a real
 * selection: it keeps the feature on and selects no outgoing request value.
 */
export const CODEX_SERVICE_TIER_VALUES: readonly CodexServiceTierId[] = [
  "standard",
  "fast",
  "ultrafast",
];

export interface RendererServiceTierView {
  /** The Host-confirmed tier; null means the feature is off or unconfirmed. */
  readonly tier: CodexServiceTierId | null;
  /** External Harness, switching Composer, or a missing official trigger. */
  readonly suppressed: boolean;
  /**
   * Stamp the local ownership scope on this element (the local Composer root).
   * The tier CSS keys on the scope attribute, so a surface that is never
   * stamped here can never draw the tier accent; null clears any stale stamp.
   */
  readonly scope: HTMLElement | null;
  /** The official Model trigger: both the menu locator and the open signal. */
  readonly trigger: HTMLElement | null;
  readonly locale: RendererSettingsLocale;
  /** Reports a choice; every value is a real tier, `standard` included. */
  readonly onSelect: (tier: CodexServiceTierId) => void;
}

/**
 * The one rule that decides where the tier control may appear, shared by the
 * probe, the unit tests and the e2e fixture so all three route the same way:
 *
 * - a non-Codex Agent (external Harness) never shows it;
 * - a Composer whose Host is anything but `local` never shows it — the tier is
 *   a local-machine setting, and a remote Host's native Composer keeps its own
 *   speed UI;
 * - a switching Composer hides it;
 * - an unconfirmed (null) tier hides the control and clears the scope stamp;
 *   `standard` is a confirmed tier like any other, so the control stays.
 */
export function rendererServiceTierPlacement(input: {
  readonly agent: RendererAgent;
  readonly hostId: string | null;
  readonly switching: boolean;
  readonly confirmedTier: CodexServiceTierId | null;
}): { readonly tier: CodexServiceTierId | null; readonly suppressed: boolean } {
  const localCodex = input.agent === "codex" && input.hostId === "local";
  if (!localCodex) return { tier: null, suppressed: true };
  const suppressed = input.switching;
  return { tier: suppressed ? null : input.confirmedTier, suppressed };
}

export interface RendererServiceTierControl {
  render(view: RendererServiceTierView): void;
  dispose(): void;
}

/** An icon sized to its own official resource canvas. */
function sizedIcon(
  ownerDocument: Document,
  icon: { readonly viewBox: string; readonly d: string },
  sizePx: number,
): SVGElement {
  const svg = ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", icon.viewBox);
  svg.setAttribute("width", String(sizePx));
  svg.setAttribute("height", String(sizePx));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = ownerDocument.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", icon.d);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

function setAttributeIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function removeAttributeIfPresent(element: Element, name: string): void {
  if (element.getAttribute(name) !== null) element.removeAttribute(name);
}

/** The official menu is the `role="menu"` container the open trigger points at. */
export function rendererServiceTierMenuFor(trigger: HTMLElement | null): HTMLElement | null {
  const id = trigger?.getAttribute("aria-controls");
  if (!id) return null;
  const menu = trigger?.ownerDocument?.getElementById?.(id) ?? null;
  if (!menu || !menu.matches?.('[role="menu"]')) return null;
  return menu;
}

/** True while the Desktop's own speed control exists in this menu. */
export function rendererServiceTierOfficialControlPresent(menu: HTMLElement): boolean {
  return menu.querySelector(OFFICIAL_SPEED_SELECTOR) !== null;
}

interface ServiceTierMessages {
  readonly rowAriaLabel: string;
  readonly standardLabel: string;
  readonly standardDescription: string;
  readonly fastLabel: string;
  /** The Fast row's submenu subtitle, with speedMultiplier already substituted. */
  readonly fastDescription: string;
  readonly ultrafastLabel: string;
  readonly ultrafastDescription: string;
}

export function rendererServiceTierMessages(locale: RendererSettingsLocale): ServiceTierMessages {
  const messages = rendererSettingsMessages(locale);
  return {
    rowAriaLabel: messages.codexServiceTierRowAriaLabel,
    standardLabel: messages.codexServiceTierStandardLabel,
    standardDescription: messages.codexServiceTierStandardDescription,
    fastLabel: messages.codexServiceTierFastLabel,
    // The official submenu overwrites the Fast row's description with the
    // `…fastMode.advanced.subtitle.withMultiplier` message; the Desktop's own
    // `Lqr` hardcodes the multiplier at 1.5, so the interpolation is too.
    fastDescription: messages.codexServiceTierFastMenuDescription.replace(
      "{speedMultiplier, number}",
      messages.codexServiceTierFastSpeedMultiplier,
    ),
    ultrafastLabel: messages.codexServiceTierUltrafastLabel,
    ultrafastDescription: messages.codexServiceTierUltrafastDescription,
  };
}

function tierLabel(messages: ServiceTierMessages, tier: CodexServiceTierId): string {
  if (tier === "fast") return messages.fastLabel;
  if (tier === "ultrafast") return messages.ultrafastLabel;
  return messages.standardLabel;
}

function optionDescription(messages: ServiceTierMessages, tier: CodexServiceTierId): string {
  if (tier === "fast") return messages.fastDescription;
  if (tier === "ultrafast") return messages.ultrafastDescription;
  return messages.standardDescription;
}

/** The official `_ViewControls_` row of the simple (slider) panel, preferred over other panels'. */
function viewControlsIn(menu: HTMLElement): HTMLElement | null {
  return (
    menu.querySelector<HTMLElement>(`[class*="SliderTopRowMotion"] ${VIEW_CONTROLS_SELECTOR}`) ??
    menu.querySelector<HTMLElement>(VIEW_CONTROLS_SELECTOR)
  );
}

/** The panel holding the button is swapped out (aria-hidden / inert / hidden) by the Desktop. */
function panelInactive(element: Element): boolean {
  return (
    element.closest(
      '[class*="ViewTrack"][aria-hidden="true"], [class*="ViewTrack"][inert], [class*="ViewTrack"][hidden]',
    ) !== null
  );
}

/** True while an ancestor hides or inerts this subtree (the official panel swap). */
function hiddenByAncestors(element: Element | null): boolean {
  return element?.closest('[hidden], [aria-hidden="true"], [inert]') != null;
}

/**
 * True when this document renders popovers into the top layer. Without that
 * primitive the flyout would be clipped by the menu's `overflow:clip` body, so
 * nothing is injected at all rather than placed somewhere unusable. The answer
 * is a property of the document and is memoized per document.
 */
const topLayerSupport = new WeakMap<Document, boolean>();
function topLayerSupported(ownerDocument: Document): boolean {
  const cached = topLayerSupport.get(ownerDocument);
  if (cached !== undefined) return cached;
  const probe = ownerDocument.createElement?.("div") as HTMLElement | undefined;
  const supported = typeof probe?.showPopover === "function";
  topLayerSupport.set(ownerDocument, supported);
  return supported;
}

function tierIcon(ownerDocument: Document, tier: CodexServiceTierId): SVGElement {
  const svg = sizedIcon(
    ownerDocument,
    tier === "ultrafast" ? ULTRAFAST_ICON : FAST_ICON,
    TIER_ICON_SIZE_PX,
  );
  svg.setAttribute("data-codexhost-service-tier-icon", tier);
  return svg;
}

interface FlyoutOption {
  readonly tier: CodexServiceTierId;
  readonly element: HTMLButtonElement;
  readonly label: HTMLSpanElement;
  readonly description: HTMLSpanElement;
  readonly check: HTMLSpanElement;
}

/**
 * Place the flyout beside the menu like the official submenu: 4px past the
 * menu's inline end when it fits, mirrored to the other side when it does not,
 * and finally clamped inside the viewport. Vertically the flyout anchors to the
 * speed button's own row, not the menu's top edge: with a side panel or a tall
 * menu the official trigger row can sit far below `menu.top`, and anchoring to
 * it would strand the flyout away from the button the user just pressed.
 * The flyout is `position: fixed` in the top layer, so ancestor overflow and
 * ancestor transforms (including the containing-block ones the menu itself
 * establishes) cannot clip or displace it, and only viewport coordinates matter.
 *
 * Measured quantities are viewport pixels. An ancestor CSS `zoom` scales the
 * rendered (viewport) size of everything inside it, and the top layer is not
 * exempt: a probe at `zoom: 1.25` rendered a 246px popover at 307.25px. The
 * element's own `left`/`top` are authored in its local (unscaled) CSS pixels,
 * so both the reading and the writing of those offsets must divide by the
 * measured render scale for the offsets to be interpreted per CSS pixel.
 * The `left`/`top` written last time are subtracted back out to recover the
 * base position, so an unchanged position stays untouched (a comparison
 * guard, never an unconditional write).
 */
function positionFlyout(flyout: HTMLElement, menu: HTMLElement, button: HTMLElement): void {
  const view = flyout.ownerDocument.defaultView;
  const viewportWidth = view?.innerWidth ?? 0;
  const viewportHeight = view?.innerHeight ?? 0;
  const currentLeft = Number.parseFloat(flyout.style.left) || 0;
  const currentTop = Number.parseFloat(flyout.style.top) || 0;
  const origin = flyout.getBoundingClientRect();
  // Rendered viewport pixels per local CSS pixel (1 without ancestor zoom).
  // `offsetWidth` is integer-rounded, so a ratio within rounding noise of 1 is
  // taken as exactly 1 to keep the common case free of float jitter.
  const measuredScale = flyout.offsetWidth > 0 ? origin.width / flyout.offsetWidth : 1;
  const scale = Math.abs(measuredScale - 1) < 0.005 ? 1 : measuredScale;
  // The viewport position the element would render at with zeroed offsets.
  const baseLeft = origin.left - currentLeft * scale;
  const baseTop = origin.top - currentTop * scale;
  const menuRect = menu.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const width = origin.width;
  const height = origin.height;
  const margin = FLYOUT_VIEWPORT_MARGIN_PX * scale;
  const sideOffset = FLYOUT_SIDE_OFFSET_PX * scale;
  const rtl = view?.getComputedStyle?.(button)?.direction === "rtl";
  // Inline end is the right side in LTR and the left side in RTL.
  const inlineEnd = rtl ? menuRect.left - sideOffset - width : menuRect.right + sideOffset;
  const inlineStart = rtl ? menuRect.right + sideOffset : menuRect.left - sideOffset - width;
  const fitsInlineEnd = inlineEnd >= margin && inlineEnd + width <= viewportWidth - margin;
  const candidate = fitsInlineEnd ? inlineEnd : inlineStart;
  const left = Math.min(
    Math.max(candidate, margin),
    Math.max(margin, viewportWidth - margin - width),
  );
  const maxTop = Math.max(margin, viewportHeight - margin - height);
  const top = Math.min(Math.max(buttonRect.top, margin), maxTop);
  const nextLeft = `${Math.round((left - baseLeft) / scale)}px`;
  const nextTop = `${Math.round((top - baseTop) / scale)}px`;
  if (nextLeft === flyout.style.left && nextTop === flyout.style.top) return;
  flyout.style.left = nextLeft;
  flyout.style.top = nextTop;
}

export function mountRendererServiceTierControl(): RendererServiceTierControl {
  let button: HTMLButtonElement | null = null;
  let flyout: HTMLDivElement | null = null;
  let options: FlyoutOption[] = [];
  let view: RendererServiceTierView | null = null;
  let menu: HTMLElement | null = null;
  let locale: RendererSettingsLocale | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** A click right after a hover-open confirms it instead of toggling it shut. */
  let openedByHover = false;
  let removeOpenListeners: (() => void) | null = null;
  /** Frames left in the current visibility grace; 0 means none is scheduled. */
  let graceFramesLeft = 0;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last elements this control stamped with its ownership scope. */
  let scopeRoot: Element | null = null;
  let scopeMenu: Element | null = null;

  const cancelHover = (): void => {
    if (hoverTimer !== null) clearTimeout(hoverTimer);
    hoverTimer = null;
  };

  const isOpen = (): boolean =>
    flyout !== null && typeof flyout.matches === "function" && flyout.matches(":popover-open");

  /** The button, flyout and menu are still part of their document. */
  const attachedValid = (): boolean => {
    if (!button || !flyout || !menu) return false;
    return button.isConnected && flyout.isConnected && menu.isConnected;
  };

  /** The button is still in a panel the Desktop has not hidden, inert or replaced. */
  const stillValid = (): boolean => {
    if (!attachedValid()) return false;
    if (!button || !menu) return false;
    if (hiddenByAncestors(menu) || hiddenByAncestors(button)) return false;
    return button.parentElement?.getAttribute("data-ultra-warning-visible") !== "true";
  };

  const cancelVisibilityGrace = (): void => {
    graceFramesLeft = 0;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  /**
   * One grace check, scheduled by the tick below. Restoring the attributes
   * inside the grace keeps the flyout open; a flip that survives the whole
   * grace is the official panel swap and closes it.
   */
  const settleVisibilityGrace = (): void => {
    if (!isOpen()) {
      cancelVisibilityGrace();
      return;
    }
    if (!attachedValid()) {
      cancelVisibilityGrace();
      closeFlyout(false);
      return;
    }
    if (stillValid()) {
      cancelVisibilityGrace();
      return;
    }
    graceFramesLeft -= 1;
    if (graceFramesLeft <= 0) {
      cancelVisibilityGrace();
      closeFlyout(false);
      return;
    }
    scheduleVisibilityGraceTick();
  };

  /**
   * Prefer real frames where the view renders them; a view without rAF (a test
   * double) gets one `FLYOUT_VISIBILITY_GRACE_MS` deadline instead, which is
   * the same grace expressed in milliseconds so it stays testable without a
   * frame loop.
   */
  const scheduleVisibilityGraceTick = (): void => {
    const ownerWindow = button?.ownerDocument.defaultView ?? null;
    if (typeof ownerWindow?.requestAnimationFrame === "function") {
      ownerWindow.requestAnimationFrame(() => settleVisibilityGrace());
      return;
    }
    if (graceTimer !== null) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      graceFramesLeft = 1;
      settleVisibilityGrace();
    }, FLYOUT_VISIBILITY_GRACE_MS);
  };

  const startVisibilityGrace = (): void => {
    if (graceFramesLeft > 0 || graceTimer !== null) return;
    graceFramesLeft = FLYOUT_VISIBILITY_GRACE_FRAMES;
    scheduleVisibilityGraceTick();
  };

  const closeFlyout = (restoreFocus: boolean): void => {
    cancelHover();
    cancelVisibilityGrace();
    openedByHover = false;
    removeOpenListeners?.();
    removeOpenListeners = null;
    if (flyout && isOpen() && typeof flyout.hidePopover === "function") flyout.hidePopover();
    if (button) setAttributeIfChanged(button, "aria-expanded", "false");
    // Restoring focus into a panel the Desktop just hid would fight it, so the
    // observer-driven close never focuses.
    if (restoreFocus && button?.isConnected && stillValid()) button.focus();
  };

  const syncOptions = (tier: CodexServiceTierId): void => {
    for (const option of options) {
      const checked = option.tier === tier;
      setAttributeIfChanged(option.element, "aria-checked", String(checked));
      setAttributeIfChanged(option.check, "data-checked", String(checked));
    }
  };

  const syncLabel = (messages: ServiceTierMessages, tier: CodexServiceTierId): void => {
    if (!button) return;
    setAttributeIfChanged(
      button,
      "aria-label",
      messages.rowAriaLabel.replace("{speed}", tierLabel(messages, tier)),
    );
    // Standard is a real selection but sends nothing, so the button keeps the
    // official resting (tertiary) color instead of the chart-blue active one.
    setAttributeIfChanged(
      button,
      "data-fast-mode-enabled",
      String(tier === "fast" || tier === "ultrafast"),
    );
  };

  const syncText = (messages: ServiceTierMessages): void => {
    for (const option of options) {
      const label = tierLabel(messages, option.tier);
      const description = optionDescription(messages, option.tier);
      if (option.label.textContent !== label) option.label.textContent = label;
      if (option.description.textContent !== description) {
        option.description.textContent = description;
      }
    }
  };

  const syncButtonIcon = (tier: CodexServiceTierId): void => {
    if (!button) return;
    // Standard shows the same single-bolt glyph as Fast; only the color differs.
    const shown = tier === "ultrafast" ? "ultrafast" : "fast";
    const holder = button.querySelector("[data-codexhost-service-tier-toggle-content]");
    if (!holder) return;
    const current = holder.querySelector("[data-codexhost-service-tier-icon]");
    if (current?.getAttribute("data-codexhost-service-tier-icon") === shown) return;
    const icon = tierIcon(button.ownerDocument, shown);
    if (current) current.replaceWith(icon);
    else holder.append(icon);
  };

  const reposition = (): void => {
    if (!isOpen() || !flyout || !menu || !button) return;
    positionFlyout(flyout, menu, button);
  };

  const openFlyout = (focusFirst: boolean, byHover: boolean): void => {
    if (!button || !flyout || !menu || !stillValid()) return;
    cancelHover();
    if (!isOpen() && typeof flyout.showPopover === "function") flyout.showPopover();
    openedByHover = byHover;
    setAttributeIfChanged(button, "aria-expanded", "true");
    positionFlyout(flyout, menu, button);
    if (!removeOpenListeners) {
      const ownerDocument = button.ownerDocument;
      const view = ownerDocument.defaultView;
      const isInside = (target: Node | null): boolean =>
        target != null && (button?.contains(target) === true || flyout?.contains(target) === true);
      const onPointerDown = (event: Event): void => {
        if (!isInside(event.target as Node | null)) closeFlyout(false);
      };
      // Tabbing out of the flyout closes it here rather than in the option's
      // own keydown: the browser performs its normal focus move (no trap, no
      // preventDefault) and this listener records that the flyout was left.
      const onFocusIn = (event: Event): void => {
        if (!isInside(event.target as Node | null)) closeFlyout(false);
      };
      // The top layer does not follow the panel's visibility, so an open flyout
      // is taken away by the same conditions the Desktop uses to switch panels.
      // A lost node is definitive and closes at once; a pure visibility flip
      // waits out the grace, because the official menu toggles those attributes
      // on its own rows under the pointer while a real swap never restores them.
      const MutationObserverCtor = view?.MutationObserver;
      const observer =
        typeof MutationObserverCtor === "function"
          ? new MutationObserverCtor(() => {
              if (!isOpen()) return;
              if (!attachedValid()) {
                closeFlyout(false);
                return;
              }
              if (stillValid()) cancelVisibilityGrace();
              else startVisibilityGrace();
            })
          : null;
      observer?.observe(menu, {
        attributes: true,
        attributeFilter: [...VISIBILITY_ATTRIBUTES],
        childList: true,
        subtree: true,
      });
      ownerDocument.addEventListener("pointerdown", onPointerDown, true);
      ownerDocument.addEventListener("focusin", onFocusIn, true);
      view?.addEventListener("resize", reposition);
      ownerDocument.addEventListener("scroll", reposition, true);
      removeOpenListeners = () => {
        observer?.disconnect();
        ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
        ownerDocument.removeEventListener("focusin", onFocusIn, true);
        view?.removeEventListener("resize", reposition);
        ownerDocument.removeEventListener("scroll", reposition, true);
      };
    }
    if (focusFirst) {
      const target = options.find((option) => option.tier === (view?.tier ?? null)) ?? options[0];
      target?.element.focus();
    }
  };

  /** The button's own open/close keys, matching the official submenu trigger. */
  const onToggleKeyDown = (event: KeyboardEvent): void => {
    const rtl = button?.ownerDocument.defaultView?.getComputedStyle?.(button)?.direction === "rtl";
    if (isOpen()) {
      // The arrow pointing back out of the flyout closes it, like the official
      // submenu: ArrowLeft in LTR, ArrowRight in RTL.
      const closes = event.key === "Escape" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
      if (!closes) return;
      event.preventDefault();
      event.stopPropagation();
      closeFlyout(true);
      return;
    }
    // The official trigger opens on Enter / Space and on the arrow pointing
    // into the flyout: ArrowRight in LTR, ArrowLeft in RTL.
    if (
      event.key !== "Enter" &&
      event.key !== " " &&
      event.key !== (rtl ? "ArrowLeft" : "ArrowRight")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openFlyout(true, false);
  };

  /**
   * The official row reports every pick, including re-picking the current
   * tier, and only the flyout closes: the outer menu stays open and focus
   * returns to the button (the official `keepOpenOnSelect` behaviour).
   */
  const select = (tier: CodexServiceTierId): void => {
    const current = view;
    closeFlyout(true);
    if (!current) return;
    current.onSelect(tier);
  };

  const moveFocus = (from: number, delta: number): void => {
    if (options.length === 0) return;
    const next = (from + delta + options.length) % options.length;
    options[next]?.element.focus();
  };

  const buildOption = (
    ownerDocument: Document,
    tier: CodexServiceTierId,
    index: number,
  ): FlyoutOption => {
    const element = ownerDocument.createElement("button");
    element.type = "button";
    element.setAttribute("role", "menuitemradio");
    element.setAttribute(CODEX_SERVICE_TIER_OPTION_ATTRIBUTE, tier);
    // The official menu's capture keydown walks
    // `[role^="menuitem"]:not([data-disabled]):not([data-interactive="false"])`
    // and moves focus itself. These rows own their own arrow/Home/End handling,
    // so the walk is told to skip them; they stay ordinary interactive buttons
    // for the browser and assistive technology.
    element.setAttribute("data-interactive", "false");
    element.setAttribute("aria-checked", "false");
    const text = ownerDocument.createElement("span");
    text.setAttribute("data-codexhost-service-tier-option-text", "");
    const label = ownerDocument.createElement("span");
    label.setAttribute("data-codexhost-service-tier-option-label", "");
    const description = ownerDocument.createElement("span");
    description.setAttribute("data-codexhost-service-tier-option-description", "");
    text.append(label, description);
    const check = ownerDocument.createElement("span");
    check.setAttribute("data-codexhost-service-tier-option-check", "");
    check.setAttribute("data-checked", "false");
    check.append(
      sizedIcon(ownerDocument, { viewBox: CHECK_VIEW_BOX, d: CHECK_PATH }, CHECK_SIZE_PX),
    );
    element.append(text, check);
    element.addEventListener("click", (event) => {
      // A row left over from a replaced menu must never report.
      if (!element.isConnected || element !== options[index]?.element) return;
      event.preventDefault();
      event.stopPropagation();
      select(tier);
    });
    element.addEventListener("keydown", (event) => {
      // A row left over from a replaced menu must not drive the live control.
      if (!element.isConnected || element !== options[index]?.element) return;
      if (event.key === "ArrowDown") moveFocus(index, 1);
      else if (event.key === "ArrowUp") moveFocus(index, -1);
      else if (event.key === "Home") moveFocus(-1, 1);
      else if (event.key === "End") moveFocus(0, -1);
      else if (event.key === "Escape") closeFlyout(true);
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // The arrow pointing back toward the trigger closes the flyout, like
        // the official submenu content: ArrowLeft in LTR, ArrowRight in RTL.
        const rtl = ownerDocument.defaultView?.getComputedStyle?.(element)?.direction === "rtl";
        if (event.key !== (rtl ? "ArrowRight" : "ArrowLeft")) return;
        closeFlyout(true);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });
    return { tier, element, label, description, check };
  };

  const build = (ownerDocument: Document, host: HTMLElement): void => {
    const nextButton = ownerDocument.createElement("button");
    nextButton.type = "button";
    nextButton.setAttribute(CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE, "");
    nextButton.setAttribute("role", "menuitem");
    nextButton.setAttribute("aria-haspopup", "menu");
    nextButton.setAttribute("aria-expanded", "false");
    const content = ownerDocument.createElement("span");
    content.setAttribute("data-codexhost-service-tier-toggle-content", "");
    nextButton.append(content);
    // Every handler is guarded on its own element still being the live button:
    // handlers from a torn-down control must never act on a rebuilt one.
    const isLive = (): boolean => nextButton === button && nextButton.isConnected;
    nextButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isLive()) return;
      if (!isOpen()) openFlyout(false, false);
      // A click right after the 200ms hover-open keeps it open instead of
      // closing what the hover just opened.
      else if (openedByHover) openedByHover = false;
      else closeFlyout(false);
    });
    nextButton.addEventListener("keydown", (event) => {
      if (!isLive()) return;
      onToggleKeyDown(event);
    });
    nextButton.addEventListener("pointerenter", (event) => {
      if (!isLive()) return;
      if ((event as PointerEvent).pointerType !== "mouse" || isOpen()) return;
      cancelHover();
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        if (isLive()) openFlyout(false, true);
      }, FLYOUT_HOVER_DELAY_MS);
    });
    nextButton.addEventListener("pointerleave", () => {
      if (isLive()) cancelHover();
    });

    const nextFlyout = ownerDocument.createElement("div");
    nextFlyout.setAttribute(CODEX_SERVICE_TIER_FLYOUT_ATTRIBUTE, "");
    nextFlyout.setAttribute("role", "menu");
    // The official submenu content is its own overlay layer; the same placement
    // escapes the menu's overflow:clip / overflow-hidden / transformed body.
    nextFlyout.setAttribute("popover", "manual");
    button = nextButton;
    flyout = nextFlyout;
    options = CODEX_SERVICE_TIER_VALUES.map((tier, index) =>
      buildOption(ownerDocument, tier, index),
    );
    nextFlyout.append(...options.map((option) => option.element));

    const toggle = host.querySelector(VIEW_TOGGLE_SELECTOR);
    if (toggle && toggle.parentElement === host) toggle.after(nextButton);
    else host.append(nextButton);
    // A DOM child only for ownership and menu dismissal; the top layer renders it.
    menu?.append(nextFlyout);
  };

  const teardown = (): void => {
    closeFlyout(false);
    button?.remove();
    flyout?.remove();
    button = null;
    flyout = null;
    options = [];
    menu = null;
    locale = null;
  };

  /**
   * Move the ownership scope to exactly the elements this control owns right
   * now: the local Composer root that draws the trigger bolt and the official
   * menu portal that draws the slider particles. Stale stamps are released
   * first, so a Host switch, a replaced menu or a disposed control cannot
   * leave a surface painted. Every write is guarded by a comparison.
   */
  const releaseScope = (
    keepRoot: Element | null,
    keepMenu: Element | null,
    tier: CodexServiceTierId | null,
  ): void => {
    if (scopeRoot && (scopeRoot !== keepRoot || tier === null)) {
      removeAttributeIfPresent(scopeRoot, CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE);
      scopeRoot = null;
    }
    if (scopeMenu && (scopeMenu !== keepMenu || tier === null)) {
      removeAttributeIfPresent(scopeMenu, CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE);
      scopeMenu = null;
    }
    if (keepRoot && tier !== null) {
      setAttributeIfChanged(keepRoot, CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE, tier);
      scopeRoot = keepRoot;
    }
    if (keepMenu && tier !== null) {
      setAttributeIfChanged(keepMenu, CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE, tier);
      scopeMenu = keepMenu;
    }
  };

  return {
    render(next: RendererServiceTierView): void {
      view = next;
      if (next.tier === null || next.suppressed) {
        if (button || flyout) teardown();
        // The CSS keys on this stamp, so an unconfirmed, non-local or
        // switching Composer must not keep one: release it even when nothing
        // was injected.
        releaseScope(null, null, null);
        return;
      }
      const tier = next.tier;
      const nextMenu = rendererServiceTierMenuFor(next.trigger);
      if (!nextMenu || !topLayerSupported(nextMenu.ownerDocument)) {
        if (button || flyout) teardown();
        // The trigger bolt lives outside the menu: keep the Composer scope so
        // the confirmed tier still draws its gear, but the particles' portal
        // scope goes away with the menu it belonged to.
        releaseScope(next.scope, null, tier);
        return;
      }
      if (rendererServiceTierOfficialControlPresent(nextMenu)) {
        if (button || flyout) teardown();
        releaseScope(next.scope, null, tier);
        return;
      }
      const host = viewControlsIn(nextMenu);
      if (
        !host ||
        panelInactive(host) ||
        host.getAttribute("data-ultra-warning-visible") === "true"
      ) {
        if (button || flyout) teardown();
        releaseScope(next.scope, null, tier);
        return;
      }
      if (
        menu !== nextMenu ||
        !button?.isConnected ||
        !flyout?.isConnected ||
        button.parentElement !== host
      ) {
        teardown();
        menu = nextMenu;
        build(nextMenu.ownerDocument, host);
      }
      // The trigger bolt needs the local Composer root, not the whole document:
      // the scope stamp is what keeps a remote Host's Composer unpainted. The
      // slider particles ride the menu portal, stamped separately.
      releaseScope(next.scope, nextMenu, tier);
      const messages = rendererServiceTierMessages(next.locale);
      if (locale !== next.locale) {
        locale = next.locale;
        syncText(messages);
      }
      syncLabel(messages, tier);
      syncButtonIcon(tier);
      syncOptions(tier);
    },
    dispose(): void {
      teardown();
      releaseScope(null, null, null);
      view = null;
    },
  };
}
