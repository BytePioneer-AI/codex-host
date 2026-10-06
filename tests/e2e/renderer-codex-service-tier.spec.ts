import { expect, test, type Page } from "@playwright/test";
import { serviceTierFixtureHtml } from "./service-tier-fixture.js";

const html = await serviceTierFixtureHtml();
const url = "http://localhost/codex-service-tier";

async function setup(page: Page, lang = "en") {
  await page.route(`${url}**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${url}?lang=${lang}`);
  // The preference sync always sends an initial request; settle it so the
  // following steps interact with a confirmed "off" state.
  await page.locator("#accept").click();
}
const settingsSwitch = (page: Page, lang = "en") =>
  page.getByRole("switch", {
    name: lang === "en" ? "Codex request tier" : "Codex 请求档位",
    exact: true,
  });
// The fixture output is an implicit `role=status`; the settings badge also is
// one, so every status assertion is scoped to the settings region.
const settingsStatus = (page: Page, lang = "en") =>
  page
    .getByRole("region", {
      name: lang === "en" ? "Codex request tier" : "Codex 请求档位",
      exact: true,
    })
    .getByRole("status");
const accept = (page: Page) => page.locator("#accept").click();
const openMenu = (page: Page) => page.locator("#open-menu").click();
const localMenu = (page: Page) => page.locator("#local-menu-host .fixture-model-menu");
/** The remote Composer's own menu, the same native structure on another Host. */
const remoteMenu = (page: Page) => page.locator("#remote-menu-host .fixture-model-menu");
const toggle = (page: Page) => page.locator("[data-codexhost-service-tier-toggle]");
const localToggle = (page: Page) =>
  page.locator("#local-menu-host [data-codexhost-service-tier-toggle]");
const remoteToggle = (page: Page) =>
  page.locator("#remote-menu-host [data-codexhost-service-tier-toggle]");
const flyout = (page: Page) => page.locator("[data-codexhost-service-tier-flyout]");
const option = (page: Page, value: "standard" | "fast" | "ultrafast") =>
  page.locator(`[data-codexhost-service-tier-option="${value}"]`);
const marker = (page: Page) => page.locator("html");
const isOpen = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector("[data-codexhost-service-tier-flyout]")?.matches(":popover-open") ??
      false,
  );
/**
 * Every element carrying the local ownership scope, read through the attribute
 * name the production control exports (the fixture publishes it). The scope must
 * only ever cover the local Composer root and the local menu portal — the
 * remote Composer and its menu must never appear here.
 */
const scopedElements = (page: Page) =>
  page.evaluate(() => {
    const attribute: string = Reflect.get(globalThis, "__fixture").scopeAttribute;
    return Array.from(document.querySelectorAll(`[${attribute}]`)).map((node) => ({
      id: node.id,
      tier: node.getAttribute(attribute),
      isComposerRoot: node.hasAttribute("data-codex-composer-root"),
      isMenu: node.getAttribute("role") === "menu",
    }));
  });
/** The pseudo-element paint state of the tier accents inside one surface. */
const accentState = (page: Page, hostId: string, triggerId: string) =>
  page.evaluate(
    ({ hostId: host, triggerId: trigger }) => {
      const hostElement = document.getElementById(host);
      const triggerElement = document.getElementById(trigger);
      if (!hostElement || !triggerElement) throw new Error("Missing accent host");
      const slot = triggerElement.querySelector('[class~="tabular-nums"]');
      const range = hostElement.querySelector(
        '[data-model-picker-power-slider] [class*="_Range_"]',
      );
      const content = (element: Element | null, which: "::before" | "::after") =>
        element ? getComputedStyle(element, which).content : null;
      return {
        triggerSlot: content(slot, "::before"),
        rangeBefore: content(range, "::before"),
        rangeAfter: content(range, "::after"),
      };
    },
    { hostId, triggerId },
  );
const selections = (page: Page) =>
  page.evaluate(() => JSON.stringify(Reflect.get(globalThis, "tierSelections")));
const activeOption = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.getAttribute?.("data-codexhost-service-tier-option") ?? null,
  );
const focusedToggle = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.hasAttribute?.("data-codexhost-service-tier-toggle") ?? false,
  );
async function enableTier(page: Page) {
  // The settings switch writes the preference and the pending Host sync is
  // settled; a first run leaves it off. `check()` would be a no-op on an
  // already-checked box (no change event), so toggling via uncheck → check
  // guarantees a real change once and stays idempotent when re-run.
  const box = settingsSwitch(page);
  if (await box.isChecked()) await box.uncheck();
  await box.check();
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "fast");
}

/** Fixed fake-clock origin; the 60s headroom absorbs the install→pause roundtrips. */
const HOVER_CLOCK_TIME = new Date("2026-01-01T00:00:00Z");
const HOVER_CLOCK_FROZEN = new Date(HOVER_CLOCK_TIME.getTime() + 60_000);
/**
 * Freeze only after setup so the fixture's timers stay live until then; the
 * paused clock then advances the 200ms hover timer only through `runFor`,
 * not through mouse or evaluate roundtrips.
 */
async function freezeHoverClock(page: Page): Promise<void> {
  await page.clock.install({ time: HOVER_CLOCK_TIME });
  await page.clock.pauseAt(HOVER_CLOCK_FROZEN);
}

test("the button appears only after the Host confirms, and opens the official flyout", async ({
  page,
}) => {
  await setup(page);
  await settingsSwitch(page).check();
  // Pending: the Host has not confirmed, so nothing may appear yet.
  await expect(toggle(page)).toHaveCount(0);
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "fast");
  await openMenu(page);

  const button = localToggle(page);
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute("role", "menuitem");
  await expect(button).toHaveAttribute("aria-label", "Speed Fast");
  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toHaveAttribute("data-fast-mode-enabled", "true");
  // Official 32px box right after the official model view toggle.
  const box = await button.boundingBox();
  expect(box?.width).toBe(32);
  expect(box?.height).toBe(32);
  // The button is an absolutely positioned official slot
  // (`position:absolute; inset-inline-start:0`), so its visual x is not a
  // reliable ordering signal; the real contract is DOM order — immediately
  // after the official model view toggle.
  const order = await page.evaluate(() => {
    const row = document.querySelector("#local-menu-host [class*='ViewControls']");
    if (!row) return { gap: -1 };
    const children = Array.from(row.children);
    const view = children.findIndex((node) => node.matches("[data-model-picker-view-toggle]"));
    const speed = children.findIndex((node) =>
      node.matches("[data-codexhost-service-tier-toggle]"),
    );
    return { gap: speed - view };
  });
  expect(order.gap).toBe(1);
  // The 26px content square and the 16px official Fast icon.
  const content = button.locator("[data-codexhost-service-tier-toggle-content]");
  const contentBox = await content.boundingBox();
  expect(contentBox?.width).toBe(26);
  expect(contentBox?.height).toBe(26);
  const icon = content.locator("[data-codexhost-service-tier-icon]");
  await expect(icon).toHaveAttribute("data-codexhost-service-tier-icon", "fast");
  await expect(icon).toHaveAttribute("viewBox", "0 0 16 16");
  const iconBox = await icon.boundingBox();
  expect(iconBox?.width).toBe(16);
  // The flyout stays a menu child (top layer, not reparented) and is closed.
  await expect(localMenu(page).locator("[data-codexhost-service-tier-flyout]")).toHaveCount(1);
  expect(await isOpen(page)).toBe(false);
  await expect(button).toHaveAttribute("aria-expanded", "false");
});

test("click opens, a second click closes, and a click after hover-open confirms", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  const button = localToggle(page);
  await button.click();
  expect(await isOpen(page)).toBe(true);
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(flyout(page)).toBeVisible();
  await button.click();
  expect(await isOpen(page)).toBe(false);
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // Hover-open after the official 200ms, then a click keeps it open instead of
  // closing what the hover just opened; the next click closes. Both reads run
  // on the frozen clock so neither can drift across the 200ms boundary.
  await freezeHoverClock(page);
  await page.mouse.move(10, 10);
  await button.hover();
  await page.clock.runFor(120);
  expect(await isOpen(page)).toBe(false);
  await page.clock.runFor(150);
  expect(await isOpen(page)).toBe(true);
  await button.click();
  expect(await isOpen(page)).toBe(true);
  await button.click();
  expect(await isOpen(page)).toBe(false);
});

test("a hover that leaves before the delay never opens", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  const button = localToggle(page);
  await freezeHoverClock(page);
  // Leaving 100ms in cancels the pending open; the following 250ms cross the
  // 200ms delay with the timer already cancelled.
  await button.hover();
  await page.clock.runFor(100);
  await page.mouse.move(10, 10);
  await page.clock.runFor(250);
  expect(await isOpen(page)).toBe(false);
});

test("the keyboard opens on the checked row, roves with arrows, and Escape returns focus", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await localToggle(page).focus();
  await page.keyboard.press("Enter");
  expect(await isOpen(page)).toBe(true);
  expect(await activeOption(page)).toBe("fast");

  await page.keyboard.press("ArrowDown");
  expect(await activeOption(page)).toBe("ultrafast");
  await page.keyboard.press("ArrowUp");
  expect(await activeOption(page)).toBe("fast");
  await page.keyboard.press("End");
  expect(await activeOption(page)).toBe("ultrafast");
  await page.keyboard.press("Home");
  expect(await activeOption(page)).toBe("standard");
  await page.keyboard.press("ArrowDown");
  expect(await activeOption(page)).toBe("fast");

  await page.keyboard.press("Escape");
  expect(await isOpen(page)).toBe(false);
  expect(await focusedToggle(page)).toBe(true);
  // The outer official menu stays open the whole time.
  await expect(localMenu(page)).toBeVisible();
  // Space and the right arrow also open the flyout.
  await page.keyboard.press(" ");
  expect(await isOpen(page)).toBe(true);
  await page.keyboard.press("ArrowLeft");
  expect(await isOpen(page)).toBe(false);
  expect(await focusedToggle(page)).toBe(true);
});

test("Tab is never trapped: it moves through real focus and leaving closes the flyout", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await localToggle(page).focus();
  await page.keyboard.press("Enter");
  expect(await activeOption(page)).toBe("fast");
  await page.keyboard.press("Tab");
  // The browser's own move lands on the next real option.
  expect(await activeOption(page)).toBe("ultrafast");
  expect(await isOpen(page)).toBe(true);
  // One more Tab leaves the flyout for the page's next focusable element, and
  // the control closes the flyout without touching the outer menu.
  await page.keyboard.press("Tab");
  expect(await isOpen(page)).toBe(false);
  await expect(localMenu(page)).toBeVisible();
  // The focus landed outside the flyout (the Test Host controls).
  expect(await focusedToggle(page)).toBe(false);
});

test("picking reports once, keeps the outer menu open and returns focus", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  const button = localToggle(page);
  await button.click();
  await option(page, "ultrafast").click();
  expect(await selections(page)).toBe('["ultrafast"]');
  expect(await isOpen(page)).toBe(false);
  await expect(localMenu(page)).toBeVisible();
  expect(await focusedToggle(page)).toBe(true);
  // Re-picking the current tier reports again, exactly like the official row.
  await button.click();
  await option(page, "ultrafast").click();
  expect(await selections(page)).toBe('["ultrafast","ultrafast"]');
  await expect(localMenu(page)).toBeVisible();
});

test("a pending Host never claims the new tier until the confirmation arrives", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await localToggle(page).click();
  await option(page, "ultrafast").click();
  // Pending: the pick was reported, but neither the marker nor the icon moved.
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "fast");
  await expect(localToggle(page).locator("[data-codexhost-service-tier-icon]")).toHaveAttribute(
    "data-codexhost-service-tier-icon",
    "fast",
  );
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "ultrafast");
  await expect(localToggle(page).locator("[data-codexhost-service-tier-icon]")).toHaveAttribute(
    "data-codexhost-service-tier-icon",
    "ultrafast",
  );
  await expect(localToggle(page)).toHaveAttribute("aria-label", "Speed Ultrafast");
});

test("Standard keeps the feature on, the controls resident and the switch checked", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await localToggle(page).click();
  await option(page, "standard").click();
  // The pick is reported as a real tier, not as a feature-off signal.
  expect(await selections(page)).toBe('["standard"]');
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "standard");
  // The switch stays on and both controls stay resident with the tier checked.
  await expect(settingsSwitch(page)).toBeChecked();
  await expect(toggle(page)).toHaveCount(1);
  await expect(localToggle(page)).toHaveAttribute("aria-label", "Speed Standard");
  await expect(localToggle(page)).toHaveAttribute("data-fast-mode-enabled", "false");
  await expect(option(page, "standard")).toHaveAttribute("aria-checked", "true");
  await expect(page.evaluate(() => Reflect.get(globalThis, "storedTier"))).resolves.toBe(
    "standard",
  );
  // The scope stamp follows the standard tier, so the resting bolt paints.
  const scope = await scopedElements(page);
  expect(scope.map(({ tier }) => tier)).toEqual(["standard", "standard"]);
  // No speed accent: the bolt is a resting glyph and no particle layer draws,
  // exactly like the official at-rest trigger.
  const accents = await accentState(page, "local-menu-host", "native-trigger");
  expect(accents.triggerSlot).not.toBe("none");
  expect(accents.rangeAfter).toBe("none");
  expect(accents.rangeBefore).toBe("none");

  // Only switching the settings switch off hides the controls.
  await settingsSwitch(page).uncheck();
  await accept(page);
  await expect(marker(page)).not.toHaveAttribute("data-codexhost-service-tier");
  await expect(toggle(page)).toHaveCount(0);
  // Re-enabling keeps Standard as the remembered tier. Pressing the switch is
  // an outside press that closed the model menu, so it is reopened first.
  await settingsSwitch(page).check();
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "standard");
  await openMenu(page);
  await expect(localToggle(page)).toHaveCount(1);
  await expect(localToggle(page)).toHaveAttribute("aria-label", "Speed Standard");
});

test("the official provider manages its own tier and the control yields", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await expect(toggle(page)).toHaveCount(1);
  await page.locator("#effect").selectOption("officialProvider");
  // The switch is already on after enableTier; flipping it off and on again
  // produces the real change. The preference sync coalesces the two changes
  // into one in-flight request plus one queued re-sync, so each Host answer
  // is confirmed in turn before the marker reflects the officialProvider
  // effect (off).
  await settingsSwitch(page).uncheck();
  await settingsSwitch(page).check();
  await accept(page);
  await accept(page);
  await expect(marker(page)).not.toHaveAttribute("data-codexhost-service-tier");
  await expect(toggle(page)).toHaveCount(0);
  await expect(settingsStatus(page)).toHaveText(
    "Not applied: the official OpenAI provider manages its own tier",
  );
});

test("an unlisted tier stays applied and the control stays visible", async ({ page }) => {
  await setup(page);
  await settingsSwitch(page).check();
  await page.locator("#effect").selectOption("notAdvertised");
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "fast");
  await openMenu(page);
  await expect(toggle(page)).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Codex request tier", exact: true })).toContainText(
    "The current model catalog does not declare this tier",
  );
});

test("drawing the official FastModeToggle makes the control yield", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await expect(toggle(page)).toHaveCount(1);
  await page.evaluate(() => {
    const row = document.querySelector("#local-menu-host [class*='ViewControls']");
    const official = document.createElement("button");
    official.setAttribute("class", "_ViewControls_1d00n_170 _FastModeToggle_1d00n_54");
    official.setAttribute("aria-label", "Cycle speed");
    row?.append(official);
    Reflect.get(globalThis, "__fixture").render();
  });
  await expect(toggle(page)).toHaveCount(0);
});

test("rebuilding the menu re-injects the control and old handles are inert", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await localToggle(page).click();
  expect(await isOpen(page)).toBe(true);
  await page.locator("#rebuild-menu").click();
  // The rebuilt menu gets a fresh, closed flyout.
  await expect(localMenu(page).locator("[data-codexhost-service-tier-flyout]")).toHaveCount(1);
  expect(await isOpen(page)).toBe(false);
  await expect(localToggle(page)).toHaveCount(1);
  // Old handles cannot drive the new control: click the detached old button.
  const staleDriven = await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "__fixture");
    const old = fixture.stale.handles.at(-1);
    if (!old?.toggle) return { tapped: false };
    old.toggle.click();
    return {
      tapped: true,
      newOpen:
        document.querySelector("[data-codexhost-service-tier-flyout]")?.matches(":popover-open") ??
        false,
      oldOpen: old.flyout?.matches(":popover-open") ?? false,
      expanded: document
        .querySelector("[data-codexhost-service-tier-toggle]")
        ?.getAttribute("aria-expanded"),
    };
  });
  expect(staleDriven).toEqual({ tapped: true, newOpen: false, oldOpen: false, expanded: "false" });
  // The stale option never reports.
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "__fixture");
    const old = fixture.stale.handles.at(-1);
    old?.options
      .find(
        (node: Element) => node.getAttribute("data-codexhost-service-tier-option") === "ultrafast",
      )
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(
    page.evaluate(() => JSON.stringify(Reflect.get(globalThis, "tierSelections"))),
  ).resolves.toBe("[]");
});

test("a side panel pushing the menu to the right edge keeps the flyout in view beside the button row", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await page.locator("#menu-right-edge").click();
  const button = localToggle(page);
  await button.click();
  const box = await flyout(page).boundingBox();
  const buttonBox = await button.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !buttonBox || !viewport) throw new Error("Missing geometry");
  // The flyout stays fully inside the viewport...
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  // ...and vertically hugs the speed button's own row instead of drifting to
  // the menu's top edge (the header above the row pushes the row down).
  expect(Math.abs(box.y - buttonBox.y)).toBeLessThanOrEqual(2);
  // It is clickable in place: a real pick lands without moving first.
  await option(page, "fast").click();
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "fast");

  // A button row near the viewport bottom still clamps the flyout inside it.
  await page.evaluate(() => {
    const host = document.getElementById("local-menu-host");
    if (host) host.style.bottom = "4px";
  });
  await button.click();
  const clamped = await flyout(page).boundingBox();
  const clampedButton = await button.boundingBox();
  if (!clamped || !clampedButton) throw new Error("Missing clamped geometry");
  expect(clamped.y + clamped.height).toBeLessThanOrEqual(viewport.height);
  // The row no longer fits below the clamped flyout's height, so the flyout
  // slides up and stays wholly above the row instead of being cropped.
  expect(clamped.y).toBeLessThanOrEqual(clampedButton.y);
});

test("a transient visibility flip under the pointer never closes the flyout", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await localToggle(page).click();
  expect(await isOpen(page)).toBe(true);
  // The official menu flips a visibility attribute on its own rows for one
  // frame while the pointer crosses them, then restores it. That must not be
  // mistaken for a panel swap. Driven through the fixture hook: an outside
  // pointer press is itself a dismissal and would confound the case.
  await page.evaluate(() => Reflect.get(globalThis, "__fixture").transientFlip());
  await page.waitForTimeout(300);
  expect(await isOpen(page)).toBe(true);
  await expect(localToggle(page)).toHaveAttribute("aria-expanded", "true");
  // The flyout is still fully usable afterwards.
  await option(page, "ultrafast").click();
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "ultrafast");
});

test("switching to the advanced panel or the ultra warning takes an open flyout away", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await localToggle(page).click();
  expect(await isOpen(page)).toBe(true);
  // The Desktop swaps the simple panel out by re-rendering (aria-hidden + inert
  // on the track). The fixture applies the same mutation directly, with no
  // pointer or focus traffic at all, so the close can only come from the
  // control's own scoped MutationObserver — not from an outside press.
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "__fixture");
    fixture.clearPointerLog();
    fixture.clearFocusLog();
    fixture.setView(true);
  });
  await expect.poll(() => isOpen(page)).toBe(false);
  await expect(localToggle(page)).toBeHidden();
  const traffic = await page.evaluate(() => ({
    pointers: Reflect.get(globalThis, "__fixture").pointerLog.length,
    focuses: Reflect.get(globalThis, "__fixture").focusLog.length,
  }));
  expect(traffic).toEqual({ pointers: 0, focuses: 0 });

  await page.evaluate(() => Reflect.get(globalThis, "__fixture").setView(false));
  await expect(localToggle(page)).toBeVisible();
  await localToggle(page).click();
  expect(await isOpen(page)).toBe(true);
  await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "__fixture");
    fixture.clearPointerLog();
    fixture.clearFocusLog();
    fixture.setUltraWarning(true);
  });
  await expect.poll(() => isOpen(page)).toBe(false);
  await expect(localToggle(page)).toBeHidden();
  const warningTraffic = await page.evaluate(() => ({
    pointers: Reflect.get(globalThis, "__fixture").pointerLog.length,
    focuses: Reflect.get(globalThis, "__fixture").focusLog.length,
  }));
  expect(warningTraffic).toEqual({ pointers: 0, focuses: 0 });
});

test("an outside pointer press closes the flyout", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await localToggle(page).click();
  expect(await isOpen(page)).toBe(true);
  await page.mouse.click(20, 300);
  await expect.poll(() => isOpen(page)).toBe(false);
});

test("under a real 125% CSS zoom the flyout keeps its scaled size and placement", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await page.locator("#zoom-toggle").click();
  await openMenu(page);
  const button = localToggle(page);
  await button.click();
  const box = await flyout(page).boundingBox();
  const menuBox = await localMenu(page).boundingBox();
  // 233px at zoom 1.25 renders as 291.25; the 4px side offset scales too.
  expect(box?.width).toBeCloseTo(291.25, 1);
  expect(menuBox ? box && Math.round(box.x - (menuBox.x + menuBox.width)) : 0).toBe(5);
  expect(box && box.x >= 0 && box.x + box.width <= 1280).toBe(true);
  // A subsequent resize with the same geometry writes nothing: the rendered
  // box and the recorded mutations stay untouched.
  const before = await page.evaluate(() => {
    const element = document.querySelector("[data-codexhost-service-tier-flyout]");
    const fixture = Reflect.get(globalThis, "__fixture");
    fixture.clearRecords();
    return element?.getBoundingClientRect().toJSON();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => ({
    rect: document
      .querySelector("[data-codexhost-service-tier-flyout]")
      ?.getBoundingClientRect()
      .toJSON(),
    mutations: Reflect.get(globalThis, "__fixture").records.filter(
      (record: MutationRecord) => record.type === "attributes" && record.attributeName === "style",
    ).length,
  }));
  expect(after.mutations).toBe(0);
  expect(after.rect).toEqual(before);
  // Picking still works under zoom, with the flyout unmoved until it closes.
  await option(page, "ultrafast").click();
  expect(await selections(page)).toBe('["ultrafast"]');
});

test("the zh-CN wording follows the official labels", async ({ page }) => {
  await setup(page, "zh");
  const box = settingsSwitch(page, "zh");
  await box.check();
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "fast");
  await openMenu(page);
  const button = localToggle(page);
  await expect(button).toHaveAttribute("aria-label", "速度 快速");
  await button.click();
  await expect(flyout(page).getByRole("menuitemradio")).toHaveText([
    "标准默认速度",
    "快速1.5 倍速度，用量更多",
    "超快为时延敏感型任务提供最快响应",
  ]);
  await expect(option(page, "fast")).toHaveAttribute("aria-checked", "true");
  await expect(option(page, "standard")).toHaveAttribute("aria-checked", "false");
  // The 17px check renders only on the selected row.
  const checkedCheck = option(page, "fast").locator("[data-codexhost-service-tier-option-check]");
  const plainCheck = option(page, "standard").locator("[data-codexhost-service-tier-option-check]");
  await expect(checkedCheck).toBeVisible();
  await expect(plainCheck).toBeHidden();
  const checkBox = await checkedCheck.boundingBox();
  expect(checkBox?.width).toBe(17);
});

test("dispose removes the control and a remount rebuilds it", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await expect(localToggle(page)).toHaveCount(1);
  await page.locator("#dispose-tier").click();
  await expect(toggle(page)).toHaveCount(0);
  await expect(localMenu(page).locator('[data-model-picker-view-toggle="true"]')).toHaveCount(1);
  // The scope is released with the control, so nothing can paint the accents.
  expect(await scopedElements(page)).toEqual([]);
  await page.locator("#remount-tier").click();
  await expect(localToggle(page)).toHaveCount(1);
});

test("failure never claims success and reconnecting applies the saved choice", async ({ page }) => {
  await setup(page);
  await settingsSwitch(page).check();
  await page.locator("#reject").click();
  await expect(settingsStatus(page)).toHaveText("Sync failed, try again");
  await expect(marker(page)).not.toHaveAttribute("data-codexhost-service-tier");
  await expect(toggle(page)).toHaveCount(0);
  await page.locator("#reconnect").click();
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "fast");
});

test("another window follows the shared preference", async ({ page, context }) => {
  await setup(page);
  const second = await context.newPage();
  await setup(second);
  await settingsSwitch(page).check();
  await expect(settingsSwitch(second)).toBeChecked();
  await accept(second);
  await expect(marker(second)).toHaveAttribute("data-codexhost-service-tier", "fast");
  await openMenu(second);
  await expect(toggle(second)).toHaveCount(1);
  await second.close();
});

test("an unchanged re-render writes nothing observable", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  // `settle()` and the MutationObserver callbacks are asynchronous: each
  // render must be awaited, or the count is read before the observer has
  // delivered anything and the guard passes vacuously. Both the closed and
  // the open state are checked (opening must not itself write).
  const guard = async (open: boolean) =>
    await page.evaluate(async (shouldOpen) => {
      const fixture = Reflect.get(globalThis, "__fixture");
      if (
        shouldOpen &&
        !document.querySelector("[data-codexhost-service-tier-flyout]")?.matches(":popover-open")
      ) {
        document.querySelector<HTMLElement>("[data-codexhost-service-tier-toggle]")?.click();
      }
      await fixture.settle();
      fixture.clearRecords();
      fixture.render();
      fixture.render();
      await fixture.settle();
      return fixture.records.length;
    }, open);
  expect(await guard(false)).toBe(0);
  expect(await guard(true)).toBe(0);
});

test("the tier accents paint only the local Composer and its menu portal", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await page.locator("#remote-open-menu").click();
  // Both menus are open with the same DOM shapes; only the local one is scoped.
  await expect(remoteMenu(page)).toBeVisible();
  await expect(remoteMenu(page).locator("[data-codexhost-service-tier-scope]")).toHaveCount(0);

  // The scope covers exactly the local Composer root and the local menu
  // portal; the remote Composer and its menu are absent by construction.
  expect(await scopedElements(page)).toEqual([
    { id: "local-composer", tier: "fast", isComposerRoot: true, isMenu: false },
    {
      id: await localMenu(page).getAttribute("id"),
      tier: "fast",
      isComposerRoot: false,
      isMenu: true,
    },
  ]);
  await expect(remoteToggle(page)).toHaveCount(0);

  // Local: the trigger bolt and both particle layers of the slider paint.
  const local = await accentState(page, "local-menu-host", "native-trigger");
  expect(local.triggerSlot).not.toBe("none");
  expect(local.rangeAfter).not.toBe("none");
  // Fast drifts one layer; the echo layer is Ultrafast only.
  expect(local.rangeBefore).toBe("none");

  // Remote: the same DOM shapes, none of the accents.
  const remote = await accentState(page, "remote-menu-host", "remote-trigger");
  expect(remote.triggerSlot).toBe("none");
  expect(remote.rangeAfter).toBe("none");
  expect(remote.rangeBefore).toBe("none");

  // Ultrafast adds the echo layer locally only.
  await page.locator("#open-menu").click();
  await localToggle(page).click();
  await option(page, "ultrafast").click();
  await accept(page);
  await expect(marker(page)).toHaveAttribute("data-codexhost-service-tier", "ultrafast");
  await expect
    .poll(async () => (await accentState(page, "local-menu-host", "native-trigger")).rangeBefore)
    .not.toBe("none");
  const remoteUltrafast = await accentState(page, "remote-menu-host", "remote-trigger");
  expect(remoteUltrafast.triggerSlot).toBe("none");
  expect(remoteUltrafast.rangeBefore).toBe("none");
  expect(remoteUltrafast.rangeAfter).toBe("none");
});

test("the Host-wide route stays out of the per-Composer decision", async ({ page }) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  // The fixture starts with the Host-wide route pointing at the remote Host
  // while the local Composer is local: the local accents still paint, and the
  // recorded placement shows the local Host id, not the global route.
  const placements = await page.evaluate(() => Reflect.get(globalThis, "__fixture").lastPlacements);
  expect(placements).toMatchObject({
    local: { tier: "fast", suppressed: false, globalRoute: "remote-ssh:linux" },
    remote: { tier: null, suppressed: true },
  });
  // Flipping the global route (and leaving it opposite) changes nothing.
  await page.locator("#global-route").selectOption("local");
  const flipped = await page.evaluate(() => Reflect.get(globalThis, "__fixture").lastPlacements);
  expect(flipped).toMatchObject({
    local: { tier: "fast", suppressed: false },
    remote: { tier: null, suppressed: true },
  });
  // The remote Composer Host switching to local is what moves the accent there.
  await page.locator("#remote-host").selectOption("local");
  await page.locator("#remote-open-menu").click();
  await expect(remoteToggle(page)).toHaveCount(1);
  await expect(localToggle(page)).toHaveCount(1);
});

test("a local Composer that turns remote or external releases its scope immediately", async ({
  page,
}) => {
  await setup(page);
  await enableTier(page);
  await openMenu(page);
  await expect(localToggle(page)).toHaveCount(1);

  // Switching Composer: the confirmed tier stays, the accent yields.
  await page.locator("#local-switching").click();
  await expect(localToggle(page)).toHaveCount(0);
  expect(await scopedElements(page)).toEqual([]);
  await page.locator("#local-switching").click();
  await expect(localToggle(page)).toHaveCount(1);

  // The same Composer's Host turning remote (a local draft re-routed): the
  // scope goes away in the same render, and returning restores it.
  await page.locator("#local-host").selectOption("remote-ssh:linux");
  await expect(localToggle(page)).toHaveCount(0);
  expect(await scopedElements(page)).toEqual([]);
  await page.locator("#local-host").selectOption("local");
  await expect(localToggle(page)).toHaveCount(1);

  // An external Harness on the same Composer never shows the local tier.
  await page.locator("#local-agent").selectOption("claude-code");
  await expect(localToggle(page)).toHaveCount(0);
  expect(await scopedElements(page)).toEqual([]);
  await page.locator("#local-agent").selectOption("codex");
  await expect(localToggle(page)).toHaveCount(1);
  expect(await scopedElements(page)).toEqual([
    { id: "local-composer", tier: "fast", isComposerRoot: true, isMenu: false },
    {
      id: await localMenu(page).getAttribute("id"),
      tier: "fast",
      isComposerRoot: false,
      isMenu: true,
    },
  ]);
});
