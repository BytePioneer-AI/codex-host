import { describe, expect, it, vi } from "vitest";

import {
  CODEX_SERVICE_TIER_FLYOUT_ATTRIBUTE,
  CODEX_SERVICE_TIER_OPTION_ATTRIBUTE,
  CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE,
  CODEX_SERVICE_TIER_VALUES,
  FLYOUT_VISIBILITY_GRACE_MS,
  mountRendererServiceTierControl,
  rendererServiceTierMenuFor,
  rendererServiceTierMessages,
  rendererServiceTierOfficialControlPresent,
  rendererServiceTierPlacement,
  type RendererServiceTierView,
} from "../src/renderer-codex-service-tier-bolt.js";
import { CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE } from "../src/renderer-codex-service-tier-style.js";
import {
  asElement,
  clickEvent,
  FakeDocument,
  FakeNode,
  keyEvent,
  type FakeMutationObserver,
} from "./service-tier-dom.js";

/**
 * The official Model trigger plus the menu it opens, shaped like the real one:
 * a `role="menu"` container (the trigger's `aria-controls` target) holding the
 * 254px `ModelPickerDropdownContent` body, which carries `overflow-x-hidden
 * overflow-y-hidden` (the clipping condition the flyout must escape), a
 * `_ViewTrack_` (`overflow:clip`) wrapping the simple panel's top row and its
 * `_ViewControls_` row, where the official model view toggle lives.
 */
function officialMenuFixture(
  options: { popoverSupport?: boolean; document?: FakeDocument; id?: string } = {},
) {
  const document = options.document ?? new FakeDocument();
  if (!options.document && options.popoverSupport === false) document.popoverSupport = false;
  const menuId = options.id ?? "menu-1";
  const composerRoot = new FakeNode(document);
  const trigger = new FakeNode(document);
  const menu = new FakeNode(document);
  const content = new FakeNode(document);
  const track = new FakeNode(document);
  const topRow = new FakeNode(document);
  const viewControls = new FakeNode(document);
  const viewToggle = new FakeNode(document);
  composerRoot.setAttribute("data-codex-composer-root", "true");
  menu.setAttribute("role", "menu");
  menu.setAttribute("id", menuId);
  content.setAttribute(
    "class",
    "_ModelPickerDropdownContent_1ndnu_2 overflow-x-hidden overflow-y-hidden",
  );
  track.setAttribute("class", "_ViewTrack_1d00n_65");
  topRow.setAttribute("class", "_SliderTopRowMotion_1d00n_8");
  viewControls.setAttribute("class", "_ViewControls_1d00n_170");
  viewControls.setAttribute("data-ultra-warning-visible", "false");
  viewToggle.setAttribute("data-model-picker-view-toggle", "true");
  menu.append(content);
  content.append(track);
  track.append(topRow);
  topRow.append(viewControls);
  viewControls.append(viewToggle);
  // Like the browser: the official menu lives in the document, so the injected
  // control's `isConnected` checks observe the real connectivity. The trigger
  // sits inside the local Composer root, the element the scope stamp targets.
  composerRoot.append(trigger);
  document.documentElement.append(composerRoot, menu);
  document.elementsById.set(menuId, menu);
  trigger.setAttribute("aria-controls", menuId);
  return {
    document,
    composerRoot,
    trigger,
    menu,
    content,
    track,
    topRow,
    viewControls,
    viewToggle,
    close: () => trigger.removeAttribute("aria-controls"),
  };
}

const TYPED_FIXTURE = officialMenuFixture();

function view(overrides: Partial<RendererServiceTierView> = {}): RendererServiceTierView {
  return {
    tier: "fast",
    suppressed: false,
    scope: asElement(TYPED_FIXTURE.composerRoot),
    trigger: asElement(TYPED_FIXTURE.trigger),
    locale: "en",
    onSelect: vi.fn(),
    ...overrides,
  };
}

function controlOf(overrides: Partial<RendererServiceTierView> = {}) {
  const control = mountRendererServiceTierControl();
  control.render(view(overrides));
  return control;
}

function toggleOf(scope: FakeNode): FakeNode {
  const toggle = scope.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`);
  if (!toggle) throw new Error("The speed toggle was not injected");
  return toggle;
}

function flyoutOf(scope: FakeNode): FakeNode {
  const flyout = scope.querySelector(`[${CODEX_SERVICE_TIER_FLYOUT_ATTRIBUTE}]`);
  if (!flyout) throw new Error("The tier flyout was not built");
  return flyout;
}

function optionOf(scope: FakeNode, value: string): FakeNode {
  const option = scope.querySelector(`[${CODEX_SERVICE_TIER_OPTION_ATTRIBUTE}="${value}"]`);
  if (!option) throw new Error(`Option ${value} was not built`);
  return option;
}

describe("Composer service-tier speed control", () => {
  it("needs the trigger's own aria-controls to recognize the official menu", () => {
    const { document, trigger, menu } = officialMenuFixture();
    expect(rendererServiceTierMenuFor(asElement(trigger))).toBe(asElement(menu));
    trigger.removeAttribute("aria-controls");
    expect(rendererServiceTierMenuFor(asElement(trigger))).toBeNull();
    const other = new FakeNode(document);
    other.setAttribute("id", "other");
    document.elementsById.set("other", other);
    trigger.setAttribute("aria-controls", "other");
    expect(rendererServiceTierMenuFor(asElement(trigger))).toBeNull();
  });

  it("mounts a 32px menuitem button right after the official view toggle", () => {
    const { viewControls, viewToggle, trigger } = officialMenuFixture();
    const control = controlOf({ trigger: asElement(trigger) });
    const toggle = toggleOf(viewControls);
    expect(viewControls.children).toEqual([viewToggle, toggle]);
    expect(toggle.getAttribute("role")).toBe("menuitem");
    expect(toggle.getAttribute("aria-haspopup")).toBe("menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // The official geometry and icon are CSS + SVG; the button itself carries
    // only the codexhost attribute contract and the official ARIA state.
    expect(toggle.getAttribute("aria-label")).toBe("Speed Fast");
    const content = toggle.querySelector("[data-codexhost-service-tier-toggle-content]");
    const icon = content?.querySelector("[data-codexhost-service-tier-icon]");
    expect(icon?.getAttribute("data-codexhost-service-tier-icon")).toBe("fast");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 16 16");
    // Never the official class name: codexhost must not mistake its own control
    // for the Desktop's own speed toggle.
    expect(toggle.getAttribute("class")).toBeNull();
    expect(rendererServiceTierOfficialControlPresent(asElement(viewControls))).toBe(false);
    control.dispose();
  });

  it("only appears for a native Codex Composer with a confirmed tier and an own menu", () => {
    const { content, trigger, close } = officialMenuFixture();
    const control = mountRendererServiceTierControl();
    const render = (overrides: Partial<RendererServiceTierView>) =>
      control.render(view({ trigger: asElement(trigger), ...overrides }));
    const toggle = () => content.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`);

    render({});
    expect(toggle()).not.toBeNull();
    // Feature off (the Host has confirmed no active tier).
    render({ tier: null });
    expect(toggle()).toBeNull();
    render({});
    // External Harness or a switching Composer.
    render({ suppressed: true });
    expect(toggle()).toBeNull();
    render({});
    // No trigger at all.
    render({ trigger: null });
    expect(toggle()).toBeNull();
    render({});
    // A trigger that does not point at a menu yet (menu closed).
    close();
    render({});
    expect(toggle()).toBeNull();
    control.dispose();
  });

  it("yields to the Desktop's own speed control instead of stacking a second one", () => {
    const { content, viewControls, trigger } = officialMenuFixture();
    const official = new FakeNode(content.ownerDocument);
    official.setAttribute("class", "_ViewControls_1d00n_170 _FastModeToggle_1d00n_54");
    viewControls.append(official);
    expect(rendererServiceTierOfficialControlPresent(asElement(content))).toBe(true);

    const control = mountRendererServiceTierControl();
    control.render(view({ trigger: asElement(trigger) }));
    expect(content.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`)).toBeNull();

    // The official control leaves (account gate closed again): codexhost takes over.
    official.remove();
    control.render(view({ trigger: asElement(trigger) }));
    expect(toggleOf(viewControls)).toBeDefined();
    control.dispose();
  });

  it("does not inject at all where the top layer is unavailable", () => {
    const { content, trigger } = officialMenuFixture({ popoverSupport: false });
    const control = mountRendererServiceTierControl();
    control.render(view({ trigger: asElement(trigger) }));
    // A flyout clipped by the menu's overflow would be unusable; nothing is
    // injected instead of being placed somewhere it cannot work.
    expect(content.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`)).toBeNull();
    control.dispose();
  });

  it("stays out of panels the Desktop swapped away or replaced", () => {
    const { content, track, viewControls, trigger } = officialMenuFixture();
    const control = mountRendererServiceTierControl();
    control.render(view({ trigger: asElement(trigger) }));
    expect(toggleOf(viewControls)).toBeDefined();

    // The advanced model list arrives: the simple panel is hidden and inert.
    track.setAttribute("aria-hidden", "true");
    track.setAttribute("inert", "");
    control.render(view({ trigger: asElement(trigger) }));
    expect(content.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`)).toBeNull();

    track.removeAttribute("aria-hidden");
    track.removeAttribute("inert");
    control.render(view({ trigger: asElement(trigger) }));
    expect(toggleOf(viewControls)).toBeDefined();

    // The ultra usage warning replaces the row's controls.
    viewControls.setAttribute("data-ultra-warning-visible", "true");
    control.render(view({ trigger: asElement(trigger) }));
    expect(content.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`)).toBeNull();
    control.dispose();
  });

  it("reappears inside a rebuilt official menu", () => {
    const first = officialMenuFixture();
    const control = mountRendererServiceTierControl();
    control.render(view({ trigger: asElement(first.trigger) }));
    expect(toggleOf(first.viewControls)).toBeDefined();

    const second = officialMenuFixture();
    second.trigger.setAttribute("aria-controls", "menu-2");
    second.menu.setAttribute("id", "menu-2");
    second.document.elementsById.set("menu-2", second.menu);
    control.render(view({ trigger: asElement(second.trigger) }));
    expect(
      second.viewControls.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`),
    ).not.toBeNull();
    expect(first.viewControls.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`)).toBeNull();
    control.dispose();
  });

  it("opens the official 233px flyout as a manual popover and closes it again", () => {
    const { menu, viewControls, trigger } = officialMenuFixture();
    const control = controlOf({ trigger: asElement(trigger) });
    const toggle = toggleOf(viewControls);
    const flyout = flyoutOf(menu);
    // The official submenu is a separate overlay layer, not a list under the row.
    expect(flyout.getAttribute("popover")).toBe("manual");
    expect(flyout.getAttribute("role")).toBe("menu");
    expect(flyout.popoverOpen).toBe(false);
    expect(
      flyout.children.map((child) => child.getAttribute(CODEX_SERVICE_TIER_OPTION_ATTRIBUTE)),
    ).toEqual(["standard", "fast", "ultrafast"]);
    // The rows are excluded from the official menu's own menuitem walk, so the
    // flyout keeps its own arrow/Home/End handling.
    for (const option of flyout.children) {
      expect(option.getAttribute("data-interactive")).toBe("false");
      expect(option.getAttribute("role")).toBe("menuitemradio");
    }

    toggle.dispatch("click", clickEvent());
    expect(flyout.popoverOpen).toBe(true);
    expect(flyout.showPopoverCalls()).toBe(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    toggle.dispatch("click", clickEvent());
    expect(flyout.popoverOpen).toBe(false);
    expect(flyout.hidePopoverCalls()).toBe(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    control.dispose();
  });

  it("positions the flyout beside the menu, anchored to the button row, mirrored when it does not fit", () => {
    const { document, menu, trigger, viewControls } = officialMenuFixture();
    menu.rect = { left: 300, top: 120, width: 254, height: 300 };
    const control = controlOf({ trigger: asElement(trigger) });
    const flyout = flyoutOf(menu);
    const toggle = toggleOf(viewControls);
    // The button row sits deep inside a tall menu (a side panel pushes the
    // trigger below `menu.top`); the flyout must follow the row, not the menu top.
    toggle.rect = { left: 316, top: 380, width: 32, height: 32 };
    toggle.dispatch("click", clickEvent());
    // 4px past the menu's inline end (300 + 254 + 4).
    expect(flyout.style.left).toBe("558px");
    // Vertically anchored to the speed button's own row, not the menu top.
    expect(flyout.style.top).toBe("380px");

    // A menu hugging the right edge mirrors the flyout to its inline start.
    // Geometry changes arrive through the real reposition trigger (resize).
    menu.rect = { left: document.view.innerWidth - 260, top: 120, width: 254, height: 300 };
    document.view.dispatch("resize", {});
    // Mirrored: 4px before the menu's inline start (1020 - 4 - 233).
    expect(flyout.style.left).toBe(`${menu.rect.left - 4 - flyout.rect.width}px`);

    // A button row past the viewport bottom clamps the flyout inside.
    toggle.rect = { left: 316, top: 760, width: 32, height: 32 };
    document.view.dispatch("resize", {});
    expect(Number.parseFloat(flyout.style.top)).toBe(
      document.view.innerHeight - 8 - flyout.rect.height,
    );

    // RTL flips the inline side, and a small viewport clamps the flyout inside it.
    viewControls.direction = "rtl";
    document.view.innerWidth = 500;
    document.view.dispatch("resize", {});
    expect(Number.parseFloat(flyout.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(flyout.style.left) + flyout.rect.width).toBeLessThanOrEqual(500);
    control.dispose();
  });

  it("keeps an unchanged resize or scroll silent instead of rewriting offsets", () => {
    const { document, menu, viewControls, trigger } = officialMenuFixture();
    menu.rect = { left: 300, top: 120, width: 254, height: 300 };
    const control = controlOf({ trigger: asElement(trigger) });
    const flyout = flyoutOf(menu);
    toggleOf(viewControls).dispatch("click", clickEvent());
    const left = flyout.style.left;
    const top = flyout.style.top;
    const writes = flyout.style.writes;
    const box = flyout.getBoundingClientRect();

    // Same geometry, real reposition triggers: nothing may be written, so the
    // rendered box cannot jump and no MutationObserver records appear.
    document.view.dispatch("resize", {});
    document.view.dispatch("resize", {});
    document.dispatchDocument("scroll", {});
    document.dispatchDocument("scroll", {});
    expect(flyout.style.writes).toBe(writes);
    expect(flyout.style.left).toBe(left);
    expect(flyout.style.top).toBe(top);
    expect(flyout.getBoundingClientRect()).toEqual(box);
    expect(flyout.showPopoverCalls()).toBe(1);
    control.dispose();
  });

  it("opens from the keyboard, focuses the checked row and closes on Escape", () => {
    const { document, menu, viewControls, trigger } = officialMenuFixture();
    const control = controlOf({ tier: "ultrafast", trigger: asElement(trigger) });
    const toggle = toggleOf(viewControls);
    const flyout = flyoutOf(menu);

    const enter = keyEvent("Enter");
    toggle.dispatch("keydown", enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(flyout.popoverOpen).toBe(true);
    // Focus lands on the confirmed tier's row.
    expect(document.activeElement).toBe(optionOf(menu, "ultrafast"));

    const escape = keyEvent("Escape");
    (document.activeElement as FakeNode).dispatch("keydown", escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(flyout.popoverOpen).toBe(false);
    expect(document.activeElement).toBe(toggle);
    control.dispose();
  });

  it("keeps its own roving focus for arrows, Home and End", () => {
    const { document, menu, viewControls, trigger } = officialMenuFixture();
    const control = controlOf({ tier: "ultrafast", trigger: asElement(trigger) });
    const toggle = toggleOf(viewControls);
    toggle.dispatch("keydown", keyEvent("Enter"));
    expect(document.activeElement).toBe(optionOf(menu, "ultrafast"));

    const down = keyEvent("ArrowDown");
    optionOf(menu, "ultrafast").dispatch("keydown", down);
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(optionOf(menu, "standard"));

    const home = keyEvent("Home");
    optionOf(menu, "standard").dispatch("keydown", home);
    expect(document.activeElement).toBe(optionOf(menu, "standard"));

    const end = keyEvent("End");
    optionOf(menu, "standard").dispatch("keydown", end);
    expect(document.activeElement).toBe(optionOf(menu, "ultrafast"));

    const up = keyEvent("ArrowUp");
    optionOf(menu, "ultrafast").dispatch("keydown", up);
    expect(document.activeElement).toBe(optionOf(menu, "fast"));

    const left = keyEvent("ArrowLeft");
    optionOf(menu, "fast").dispatch("keydown", left);
    expect(left.preventDefault).toHaveBeenCalledOnce();
    expect(menu.querySelector(`[${CODEX_SERVICE_TIER_FLYOUT_ATTRIBUTE}]`)?.popoverOpen).toBe(false);
    expect(document.activeElement).toBe(toggle);
    control.dispose();
  });

  it("lets Tab leave without trapping focus or claiming the key", () => {
    const { document, menu, viewControls, trigger } = officialMenuFixture();
    const control = controlOf({ trigger: asElement(trigger) });
    toggleOf(viewControls).dispatch("keydown", keyEvent("Enter"));
    const flyout = flyoutOf(menu);
    const tab = keyEvent("Tab");
    const row = optionOf(menu, "fast");
    row.dispatch("keydown", tab);
    // The browser's own Tab move is never claimed...
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(tab.stopPropagation).not.toHaveBeenCalled();
    // ...and the flyout closes when that focus move actually lands elsewhere,
    // exactly as the browser performs it.
    expect(flyout.popoverOpen).toBe(true);
    const elsewhere = new FakeNode(document);
    elsewhere.focus();
    document.dispatchDocument("focusin", { target: elsewhere });
    expect(flyout.popoverOpen).toBe(false);
    control.dispose();
  });

  it("reports every pick, including re-picking the current tier", () => {
    const { menu, viewControls, trigger } = officialMenuFixture();
    const onSelect = vi.fn();
    const control = controlOf({ trigger: asElement(trigger), onSelect });
    const toggle = toggleOf(viewControls);
    toggle.dispatch("click", clickEvent());

    const pick = clickEvent();
    optionOf(menu, "fast").dispatch("click", pick);
    // The pick is codexhost's: the outer menu must not close on it, and the
    // official semantics report the value even when it is already selected.
    expect(pick.preventDefault).toHaveBeenCalledOnce();
    expect(pick.stopPropagation).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenLastCalledWith("fast");
    expect(flyoutOf(menu).popoverOpen).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.dispatch("click", clickEvent());
    optionOf(menu, "standard").dispatch("click", clickEvent());
    expect(onSelect).toHaveBeenLastCalledWith("standard");
    toggle.dispatch("click", clickEvent());
    optionOf(menu, "ultrafast").dispatch("click", clickEvent());
    expect(onSelect).toHaveBeenLastCalledWith("ultrafast");
    expect(onSelect).toHaveBeenCalledTimes(3);
    // Only the flyout closed; the button and the menu stay exactly as they are.
    expect(toggle.isConnected).toBe(true);
    expect(menu.children).toContain(flyoutOf(menu));
    control.dispose();
  });

  it("turns a hover-open into an open state a click confirms instead of closing", () => {
    vi.useFakeTimers();
    try {
      const { menu, viewControls, trigger } = officialMenuFixture();
      const control = controlOf({ trigger: asElement(trigger) });
      const toggle = toggleOf(viewControls);
      const flyout = flyoutOf(menu);

      toggle.dispatch("pointerenter", { pointerType: "mouse" });
      expect(flyout.popoverOpen).toBe(false);
      vi.advanceTimersByTime(199);
      expect(flyout.popoverOpen).toBe(false);
      vi.advanceTimersByTime(1);
      expect(flyout.popoverOpen).toBe(true);

      // The click that follows the hover-open keeps it open (no hover/click race).
      toggle.dispatch("click", clickEvent());
      expect(flyout.popoverOpen).toBe(true);
      toggle.dispatch("click", clickEvent());
      expect(flyout.popoverOpen).toBe(false);

      // A touch pointer never arms the hover timer.
      toggle.dispatch("pointerenter", { pointerType: "touch" });
      vi.advanceTimersByTime(500);
      expect(flyout.popoverOpen).toBe(false);
      // A pointer that leaves before the delay disarms it again.
      toggle.dispatch("pointerenter", { pointerType: "mouse" });
      toggle.dispatch("pointerleave", {});
      vi.advanceTimersByTime(500);
      expect(flyout.popoverOpen).toBe(false);
      control.dispose();
      // Teardown left no live timer behind.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on an outside pointer or focus and unhooks its listeners", () => {
    const { document, menu, viewControls, trigger } = officialMenuFixture();
    const control = controlOf({ trigger: asElement(trigger) });
    const toggle = toggleOf(viewControls);
    const flyout = flyoutOf(menu);

    toggle.dispatch("click", clickEvent());
    expect(flyout.popoverOpen).toBe(true);
    // The flyout itself and the button are inside; anything else is out.
    document.dispatchDocument("pointerdown", { target: toggle });
    expect(flyout.popoverOpen).toBe(true);
    document.dispatchDocument("pointerdown", { target: optionOf(menu, "standard") });
    expect(flyout.popoverOpen).toBe(true);
    document.dispatchDocument("pointerdown", { target: new FakeNode(document) });
    expect(flyout.popoverOpen).toBe(false);

    toggle.dispatch("click", clickEvent());
    document.dispatchDocument("focusin", { target: new FakeNode(document) });
    expect(flyout.popoverOpen).toBe(false);
    // Closed means no document listeners stay behind.
    expect(document.documentListenerCount("pointerdown")).toBe(0);
    expect(document.documentListenerCount("focusin")).toBe(0);
    control.dispose();
  });

  it("takes an open flyout away when the Desktop hides or inerts the panel", () => {
    vi.useFakeTimers();
    try {
      const { document, menu, track, viewControls, trigger } = officialMenuFixture();
      const control = controlOf({ trigger: asElement(trigger) });
      const toggle = toggleOf(viewControls);
      toggle.dispatch("click", clickEvent());

      const observers = document.view.mutationObservers;
      expect(observers).toHaveLength(1);
      const observer = observers[0] as FakeMutationObserver;
      // Scoped to the menu itself, watching the visibility attributes the Desktop
      // uses to swap panels; never a document-wide observer.
      expect(observer.targets).toEqual([menu]);
      expect(observer.observedOptions?.attributeFilter).toEqual([
        "hidden",
        "aria-hidden",
        "inert",
        "data-ultra-warning-visible",
      ]);

      // The advanced list replaces the panel: aria-hidden + inert on the track.
      // The flip must persist past the grace before the flyout closes.
      track.setAttribute("aria-hidden", "true");
      track.setAttribute("inert", "");
      observer.fire();
      expect(flyoutOf(menu).popoverOpen).toBe(true);
      vi.advanceTimersByTime(FLYOUT_VISIBILITY_GRACE_MS);
      expect(flyoutOf(menu).popoverOpen).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      // The panel was hidden by the Desktop, so the close did not steal focus back.
      expect(document.activeElement).not.toBe(toggle);

      // The observer is gone with the close; the next open installs a fresh one.
      expect(observer.disconnected).toBe(true);
      track.removeAttribute("aria-hidden");
      track.removeAttribute("inert");
      control.render(view({ trigger: asElement(trigger) }));
      toggle.dispatch("click", clickEvent());
      expect(document.view.mutationObservers).toHaveLength(2);
      control.dispose();
      // Teardown left no live grace timer behind.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an open flyout through a visibility flip that is restored inside the grace", () => {
    vi.useFakeTimers();
    try {
      const { document, menu, track, viewControls, trigger } = officialMenuFixture();
      const control = controlOf({ trigger: asElement(trigger) });
      const toggle = toggleOf(viewControls);
      toggle.dispatch("click", clickEvent());
      const observer = document.view.mutationObservers[0] as FakeMutationObserver;

      // The official menu flips these attributes on its own rows while the
      // pointer crosses them; a flip that is restored inside the grace must
      // leave the flyout exactly as it was.
      track.setAttribute("aria-hidden", "true");
      observer.fire();
      vi.advanceTimersByTime(FLYOUT_VISIBILITY_GRACE_MS - 1);
      track.removeAttribute("aria-hidden");
      observer.fire();
      vi.advanceTimersByTime(FLYOUT_VISIBILITY_GRACE_MS * 2);
      expect(flyoutOf(menu).popoverOpen).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      // The grace is armed again for the next flip instead of being spent.
      track.setAttribute("aria-hidden", "true");
      observer.fire();
      vi.advanceTimersByTime(FLYOUT_VISIBILITY_GRACE_MS);
      expect(flyoutOf(menu).popoverOpen).toBe(false);
      control.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes at once when the button, flyout or menu itself is torn out", () => {
    const { document, menu, viewControls, trigger } = officialMenuFixture();
    const control = controlOf({ trigger: asElement(trigger) });
    const toggle = toggleOf(viewControls);
    toggle.dispatch("click", clickEvent());
    const observer = document.view.mutationObservers[0] as FakeMutationObserver;
    // Losing a node is definitive, never a transient attribute flip: no grace.
    toggle.remove();
    observer.fire();
    expect(flyoutOf(menu).popoverOpen).toBe(false);
    control.dispose();
  });

  it("does not resurrect a flyout from a stale option after teardown", () => {
    const { menu, viewControls, trigger } = officialMenuFixture();
    const onSelect = vi.fn();
    const control = controlOf({ trigger: asElement(trigger), onSelect });
    const toggle = toggleOf(viewControls);
    toggle.dispatch("click", clickEvent());
    const staleOption = optionOf(menu, "ultrafast");

    control.dispose();
    expect(menu.querySelector(`[${CODEX_SERVICE_TIER_FLYOUT_ATTRIBUTE}]`)).toBeNull();
    expect(menu.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`)).toBeNull();
    // A detached row never reports, even if something still dispatches at it.
    staleOption.dispatch("click", clickEvent());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("never lets handlers of a replaced control drive the rebuilt one", () => {
    // Both menus live in one document, exactly like a rebuild: the old control
    // is torn down while its nodes are still dispatchable.
    const document = new FakeDocument();
    const first = officialMenuFixture({ document, id: "menu-1" });
    const control = controlOf({ trigger: asElement(first.trigger) });
    const oldToggle = toggleOf(first.viewControls);
    oldToggle.dispatch("click", clickEvent());
    const oldFlyout = flyoutOf(first.menu);
    expect(oldFlyout.popoverOpen).toBe(true);
    const oldShows = oldFlyout.showPopoverCalls();

    const second = officialMenuFixture({ document, id: "menu-2" });
    second.trigger.setAttribute("aria-controls", "menu-2");
    control.render(view({ trigger: asElement(second.trigger) }));
    const newToggle = toggleOf(second.viewControls);
    const newFlyout = flyoutOf(second.menu);
    expect(newFlyout.popoverOpen).toBe(false);
    expect(oldToggle.isConnected).toBe(false);

    // A pointer event that raced the rebuild: the detached old button must not
    // touch the new flyout's open state, ARIA, or the reported selection.
    const onSelect = vi.fn();
    control.render(view({ trigger: asElement(second.trigger), onSelect }));
    oldToggle.dispatch("click", clickEvent());
    expect(newFlyout.popoverOpen).toBe(false);
    expect(newToggle.getAttribute("aria-expanded")).toBe("false");
    expect(oldFlyout.showPopoverCalls()).toBe(oldShows);

    // Same for the old rows: arrows and Escape must not move the new focus or
    // close the new flyout, and clicks must not report.
    newToggle.dispatch("click", clickEvent());
    expect(newFlyout.popoverOpen).toBe(true);
    const staleOption = optionOf(second.menu, "fast");
    // Build a genuinely stale option: rebuild again, then act on the old node.
    const third = officialMenuFixture({ document, id: "menu-3" });
    third.trigger.setAttribute("aria-controls", "menu-3");
    control.render(view({ trigger: asElement(third.trigger) }));
    expect(staleOption.isConnected).toBe(false);
    const staleEnter = keyEvent("Enter");
    staleOption.dispatch("keydown", staleEnter);
    expect(staleEnter.preventDefault).not.toHaveBeenCalled();
    const staleClick = clickEvent();
    staleOption.dispatch("click", staleClick);
    expect(staleClick.preventDefault).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    control.dispose();
    staleOption.dispatch("click", clickEvent());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps an unchanged re-render silent, so it never feeds the DOM observer", () => {
    const { menu, viewControls, trigger } = officialMenuFixture();
    const control = controlOf({ trigger: asElement(trigger) });
    const toggle = toggleOf(viewControls);
    const content = toggle.querySelector("[data-codexhost-service-tier-toggle-content]");
    if (!content) throw new Error("The toggle content was not built");

    // The helper's counters are exactly the DOM mutations a MutationObserver
    // records: attribute writes on the button and child-list writes in content.
    const attributeWrites = toggle.attributeWrites;
    const childWrites = content.childListWrites;
    control.render(view({ trigger: asElement(trigger) }));
    expect(toggle.attributeWrites).toBe(attributeWrites);
    expect(content.childListWrites).toBe(childWrites);

    // Same with the flyout open: the open state itself adds no writes, and the
    // re-render neither writes nor reopens.
    toggle.dispatch("click", clickEvent());
    const flyout = flyoutOf(menu);
    const showCalls = flyout.showPopoverCalls();
    const writesWhileOpen = toggle.attributeWrites;
    control.render(view({ trigger: asElement(trigger) }));
    expect(toggle.attributeWrites).toBe(writesWhileOpen);
    expect(flyout.showPopoverCalls()).toBe(showCalls);
    expect(flyout.popoverOpen).toBe(true);

    // A real change still writes, so the guard is a comparison, not a freeze.
    const iconChildWrites = content.childListWrites;
    control.render(view({ tier: "ultrafast", trigger: asElement(trigger) }));
    expect(toggle.attributeWrites).toBeGreaterThan(writesWhileOpen);
    // The icon swap is a child-list mutation inside the content holder.
    expect(content.childListWrites).toBeGreaterThan(iconChildWrites);
    control.dispose();
  });

  it("follows the locale and swaps the button icon with the tier", () => {
    const { menu, viewControls, trigger } = officialMenuFixture();
    const control = mountRendererServiceTierControl();
    control.render(view({ trigger: asElement(trigger), locale: "zh-CN", tier: "ultrafast" }));
    const toggle = toggleOf(viewControls);
    const iconOf = () => toggle.querySelector("[data-codexhost-service-tier-icon]");
    expect(toggle.getAttribute("aria-label")).toBe("速度 超快");
    expect(iconOf()?.getAttribute("data-codexhost-service-tier-icon")).toBe("ultrafast");
    expect(iconOf()?.getAttribute("viewBox")).toBe("-1 -1 22 22");
    expect(
      flyoutOf(menu)
        .children.map((option) => option.children[0]?.children.map((part) => part.textContent))
        .flat()
        .join("|"),
    ).toBe("标准|默认速度|快速|1.5 倍速度，用量更多|超快|为时延敏感型任务提供最快响应");
    // The check mark renders at its own 17px resource canvas on every row.
    for (const option of flyoutOf(menu).children) {
      const check = option.querySelector("[data-codexhost-service-tier-option-check]");
      expect(check?.children[0]?.getAttribute("viewBox")).toBe("0 0 17 17");
      expect(check?.children[0]?.getAttribute("width")).toBe("17");
    }

    control.render(view({ trigger: asElement(trigger), locale: "en", tier: "fast" }));
    expect(toggle.getAttribute("aria-label")).toBe("Speed Fast");
    expect(iconOf()?.getAttribute("data-codexhost-service-tier-icon")).toBe("fast");
    expect(iconOf()?.getAttribute("viewBox")).toBe("0 0 16 16");
    control.dispose();
  });

  it("marks exactly the selected tier and keeps Standard as a real, visible choice", () => {
    const { content, menu, viewControls, trigger } = officialMenuFixture();
    const control = mountRendererServiceTierControl();
    const checked = () =>
      menu
        .querySelectorAll(`[${CODEX_SERVICE_TIER_OPTION_ATTRIBUTE}]`)
        .map((option) => option.getAttribute("aria-checked"));
    const checkMarks = () =>
      menu
        .querySelectorAll("[data-codexhost-service-tier-option-check]")
        .map((check) => check.getAttribute("data-checked"));

    control.render(view({ tier: "ultrafast", trigger: asElement(trigger) }));
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(checkMarks()).toEqual(["false", "false", "true"]);
    control.render(view({ tier: "fast", trigger: asElement(trigger) }));
    expect(checked()).toEqual(["false", "true", "false"]);
    // Standard is a confirmed tier like any other: the control stays, the row
    // is checked, and the button reports the resting state.
    control.render(view({ tier: "standard", trigger: asElement(trigger) }));
    expect(checked()).toEqual(["true", "false", "false"]);
    expect(checkMarks()).toEqual(["true", "false", "false"]);
    const toggle = toggleOf(viewControls);
    expect(toggle.getAttribute("aria-label")).toBe("Speed Standard");
    expect(toggle.getAttribute("data-fast-mode-enabled")).toBe("false");
    // The same single-bolt glyph as Fast; color is the CSS distinction.
    expect(
      toggle
        .querySelector("[data-codexhost-service-tier-icon]")
        ?.getAttribute("data-codexhost-service-tier-icon"),
    ).toBe("fast");
    // Turning the feature off still removes the button entirely.
    control.render(view({ tier: null, trigger: asElement(trigger) }));
    expect(content.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`)).toBeNull();
    control.dispose();
  });

  it("uses the official option values and the official en/zh wording", () => {
    expect(CODEX_SERVICE_TIER_VALUES).toEqual(["standard", "fast", "ultrafast"]);
    expect(rendererServiceTierMessages("en")).toEqual({
      rowAriaLabel: "Speed {speed}",
      standardLabel: "Standard",
      standardDescription: "Default speed",
      fastLabel: "Fast",
      fastDescription: "1.5x speed, more usage",
      ultrafastLabel: "Ultrafast",
      ultrafastDescription: "The fastest available responses for latency-sensitive work",
    });
    expect(rendererServiceTierMessages("zh-CN")).toEqual({
      rowAriaLabel: "速度 {speed}",
      standardLabel: "标准",
      standardDescription: "默认速度",
      fastLabel: "快速",
      fastDescription: "1.5 倍速度，用量更多",
      ultrafastLabel: "超快",
      ultrafastDescription: "为时延敏感型任务提供最快响应",
    });
  });

  it("routes per mounted Composer: only a local Codex Composer shows the control", () => {
    // The pure rule every surface (probe, fixture, tests) shares.
    expect(
      rendererServiceTierPlacement({
        agent: "codex",
        hostId: "local",
        switching: false,
        confirmedTier: "fast",
      }),
    ).toEqual({ tier: "fast", suppressed: false });
    // A remote Host's native Codex Composer never shows the local tier, even
    // while the machine-wide confirmed tier is active.
    expect(
      rendererServiceTierPlacement({
        agent: "codex",
        hostId: "remote-ssh:linux",
        switching: false,
        confirmedTier: "fast",
      }),
    ).toEqual({ tier: null, suppressed: true });
    // An external Harness owns its own speed UI on any Host.
    expect(
      rendererServiceTierPlacement({
        agent: "claude-code",
        hostId: "local",
        switching: false,
        confirmedTier: "ultrafast",
      }),
    ).toEqual({ tier: null, suppressed: true });
    // A switching Composer yields until the switch settles.
    expect(
      rendererServiceTierPlacement({
        agent: "codex",
        hostId: "local",
        switching: true,
        confirmedTier: "ultrafast",
      }),
    ).toEqual({ tier: null, suppressed: true });
    // An unknown Host is never assumed local.
    expect(
      rendererServiceTierPlacement({
        agent: "codex",
        hostId: null,
        switching: false,
        confirmedTier: "fast",
      }),
    ).toEqual({ tier: null, suppressed: true });
    // The confirmed tier is mirrored only when everything else allows it.
    expect(
      rendererServiceTierPlacement({
        agent: "codex",
        hostId: "local",
        switching: false,
        confirmedTier: null,
      }),
    ).toEqual({ tier: null, suppressed: false });
  });

  it("stamps only the local Composer root and its menu portal, and clears them again", () => {
    const { composerRoot, menu, viewControls, track, trigger } = officialMenuFixture();
    const control = mountRendererServiceTierControl();
    const scope = () => ({
      root: composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE),
      menu: menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE),
    });
    const render = (overrides: Partial<RendererServiceTierView> = {}) =>
      control.render(
        view({ scope: asElement(composerRoot), trigger: asElement(trigger), ...overrides }),
      );

    expect(scope()).toEqual({ root: null, menu: null });
    render();
    expect(scope()).toEqual({ root: "fast", menu: "fast" });
    // A re-render with the same tier rewrites nothing (the attribute-write
    // counter is exactly what a MutationObserver would record).
    const rootWrites = composerRoot.attributeWrites;
    const menuWrites = menu.attributeWrites;
    render();
    expect(composerRoot.attributeWrites).toBe(rootWrites);
    expect(menu.attributeWrites).toBe(menuWrites);

    // The tier change moves the stamp with the confirmed state.
    render({ tier: "ultrafast" });
    expect(scope()).toEqual({ root: "ultrafast", menu: "ultrafast" });

    // Unconfirmed / non-local / switching clears both stamps, so the CSS
    // cannot paint a Composer the control no longer owns.
    render({ tier: null });
    expect(scope()).toEqual({ root: null, menu: null });
    render({ suppressed: true });
    expect(scope()).toEqual({ root: null, menu: null });

    // The trigger gear is outside the menu: with the menu closed the Composer
    // stamp stays (the bolt still paints) while the portal stamp goes away.
    render();
    expect(scope()).toEqual({ root: "fast", menu: "fast" });
    trigger.removeAttribute("aria-controls");
    render();
    expect(scope()).toEqual({ root: "fast", menu: null });

    // The panel the button lives in being hidden does not take the trigger
    // bolt away either, but the portal stamp leaves with it.
    trigger.setAttribute("aria-controls", menu.getAttribute("id") ?? "");
    render();
    track.setAttribute("aria-hidden", "true");
    render();
    expect(scope()).toEqual({ root: "fast", menu: null });
    expect(viewControls.querySelector(`[${CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE}]`)).toBeNull();

    control.dispose();
    expect(scope()).toEqual({ root: null, menu: null });
  });

  it("releases the old root and the old menu portal when either is replaced", () => {
    const document = new FakeDocument();
    const first = officialMenuFixture({ document, id: "menu-1" });
    const control = mountRendererServiceTierControl();
    control.render(
      view({ scope: asElement(first.composerRoot), trigger: asElement(first.trigger) }),
    );
    expect(first.composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBe("fast");
    expect(first.menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBe("fast");

    // The Desktop replaces the Composer (navigation): the old root must lose
    // its stamp before the new one gains it.
    const second = officialMenuFixture({ document, id: "menu-2" });
    second.trigger.setAttribute("aria-controls", "menu-2");
    control.render(
      view({ scope: asElement(second.composerRoot), trigger: asElement(second.trigger) }),
    );
    expect(first.composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();
    expect(first.menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();
    expect(second.composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBe("fast");
    expect(second.menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBe("fast");

    // A rebuilt menu under the same Composer moves only the portal stamp: the
    // Composer root keeps its stamp while the old portal is released.
    const third = officialMenuFixture({ document: second.document, id: "menu-3" });
    second.trigger.setAttribute("aria-controls", "menu-3");
    control.render(
      view({ scope: asElement(second.composerRoot), trigger: asElement(second.trigger) }),
    );
    expect(second.composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBe("fast");
    expect(second.menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();
    expect(third.menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBe("fast");
    expect(third.composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();

    control.dispose();
    expect(second.composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();
    expect(third.menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();
  });

  it("never stamps a Composer the placement marked as non-local", () => {
    const { composerRoot, menu, trigger } = officialMenuFixture();
    const control = mountRendererServiceTierControl();
    // The probe passes scope: null whenever the placement yields, so nothing
    // is written even though the trigger and menu exist.
    control.render(
      view({ scope: null, tier: null, suppressed: true, trigger: asElement(trigger) }),
    );
    expect(composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();
    expect(menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();
    control.render(view({ scope: null, trigger: asElement(trigger) }));
    expect(composerRoot.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBeNull();
    expect(menu.getAttribute(CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE)).toBe("fast");
    control.dispose();
  });
});
