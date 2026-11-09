import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Locator, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { defined } from "../support/defined.ts";

async function capture(page: Page, name: string) {
  const directory = process.env.CODEXHOST_TEST_SCREENSHOTS;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.mouse.move(1100, 800);
  // Keep the established screenshot timing; scroll assertions below use sampled stability.
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify(
      await page.locator("body").evaluate((body) => {
        const row = body.querySelector('[data-row-key^="session:phone-"]');
        const drawer = body.querySelector("[data-phone-drawer]");
        const view = body.querySelector("[data-phone-sidebar-view]");
        const styles = [drawer, view, view?.firstElementChild].map((el) =>
          el
            ? {
                box: el.getBoundingClientRect().toJSON(),
                css: {
                  filter: getComputedStyle(el).backdropFilter,
                  background: getComputedStyle(el).background,
                  position: getComputedStyle(el).position,
                  color: getComputedStyle(el).color,
                  display: getComputedStyle(el).display,
                  visibility: getComputedStyle(el).visibility,
                  z: getComputedStyle(el).zIndex,
                },
                text: el.textContent?.slice(0, 120),
              }
            : null,
        );
        return {
          styles,
          phone: !!body.querySelector("[data-phone]"),
          rowHeight: row?.getBoundingClientRect().height,
          menus: [...body.querySelectorAll('[role="menu"]')].map((menu) => ({
            text: menu.textContent,
            width: menu.getBoundingClientRect().width,
          })),
        };
      }),
      null,
      2,
    ),
  );
}

async function hiddenPhoneScrollbars(drawer: Locator) {
  const scrollers = await drawer.evaluate((root) =>
    [root, ...root.querySelectorAll("*")]
      .filter((element) => /^(auto|scroll)$/.test(getComputedStyle(element).overflowY))
      .map((element) => ({
        className: element.className,
        overflow: getComputedStyle(element).overflowY,
        width: getComputedStyle(element).scrollbarWidth,
        webkitDisplay: getComputedStyle(element, "::-webkit-scrollbar").display,
        webkitWidth: getComputedStyle(element, "::-webkit-scrollbar").width,
      })),
  );
  assert.ok(scrollers.length > 0);
  for (const scroller of scrollers) {
    assert.equal(scroller.width, "none", scroller.className);
    assert.equal(scroller.webkitDisplay, "none", scroller.className);
    assert.equal(scroller.webkitWidth, "0px", scroller.className);
  }
}

async function stableScroll(list: Locator) {
  return list.evaluate(async (element) => {
    const started = performance.now();
    let changedAt = started;
    let previous = element.scrollTop;
    let quietFrames = 0;
    const samples = [{ ms: 0, top: previous }];
    while (performance.now() - started < 4000) {
      await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      const top = element.scrollTop;
      samples.push({ ms: now - started, top });
      if (Math.abs(top - previous) < 0.01) quietFrames++;
      else {
        changedAt = now;
        quietFrames = 0;
      }
      previous = top;
      if (quietFrames >= 12 && now - changedAt >= 180) return { top, samples };
    }
    throw new Error(`Scroll did not stabilize: ${JSON.stringify(samples.slice(-20))}`);
  });
}

it(
  "desktop sidebar visual baseline (including coarse pointer)",
  { timeout: 120_000 },
  async (t) => {
    const host = new FakeChHost();
    for (let i = 0; i < 24; i++)
      host.add(
        `phone-${i}`,
        "/computer/product",
        `Conversation ${String(i).padStart(2, "0")} — long title for sidebar regression`,
      );
    host.add("other", "/computer/reference", "Reference thread");
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--dev-web-ui",
        resolve("apps/web-ui"),
      ],
      { authenticated: true },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const width of [1280, 1440])
      for (const colorScheme of ["light", "dark"] as const)
        for (const hasTouch of [false, true]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme,
            hasTouch,
            reducedMotion: "reduce",
          });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.getByText("Native Model", { exact: true }).waitFor({ state: "attached" });
          const folder = page.getByRole("treeitem").filter({ hasText: /^product$/ });
          await folder.waitFor();
          if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
          const row = page.locator('[data-row-key="session:phone-0"]');
          await row.waitFor();
          assert.equal(
            await row.evaluate((el) => el.getBoundingClientRect().height),
            hasTouch ? 44 : 32,
          );
          assert.deepEqual(
            await page
              .locator('[role="tree"]')
              .first()
              .evaluate((element) => ({
                width: getComputedStyle(element).scrollbarWidth,
                gutter: getComputedStyle(element).scrollbarGutter,
                webkitWidth: getComputedStyle(element, "::-webkit-scrollbar").width,
                webkitVisible: getComputedStyle(element, "::-webkit-scrollbar").display !== "none",
              })),
            { width: "auto", gutter: "stable", webkitWidth: "5px", webkitVisible: true },
            "desktop scrollbar styling is unchanged, including coarse pointer",
          );
          const name = `${width}-${colorScheme}-${hasTouch ? "coarse" : "fine"}`;
          await capture(page, `${name}-list`);
          await row.hover();
          await row.getByRole("button", { name: /^Session actions/ }).click();
          await page.getByRole("menu").waitFor();
          await capture(page, `${name}-menu`);
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "View options", exact: true }).click();
          await page.getByRole("menu").waitFor();
          await capture(page, `${name}-options`);
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Add workspace", exact: true }).click();
          await page.getByRole("dialog").waitFor();
          await capture(page, `${name}-workspace`);
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
          await capture(page, `${name}-closed`);
          await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
          await capture(page, `${name}-reopened`);
          assert.deepEqual(errors, []);
          await context.close();
        }
  },
);

it(
  "phone sidebar keeps real options, actions, directory flow and interruptible edge gestures",
  { timeout: 180_000 },
  async (t) => {
    const host = new FakeChHost();
    for (let i = 0; i < 24; i++)
      host.add(
        `phone-${i}`,
        "/computer/product",
        `Conversation ${String(i).padStart(2, "0")} — long title for sidebar regression`,
      );
    host.archivedIds.add("phone-23");
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--dev-web-ui",
        resolve("apps/web-ui"),
      ],
      { authenticated: true },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const [width, height] of [
      [320, 740],
      [390, 844],
      [430, 932],
      [390, 514],
    ] as const)
      for (const colorScheme of ["light", "dark"] as const) {
        const context = await browser.newContext({
          viewport: { width, height },
          colorScheme,
          hasTouch: true,
          isMobile: true,
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.getByText("Native Model", { exact: true }).waitFor({ state: "attached" });
        const drawer = page.locator("[data-phone-drawer]");
        const open = () =>
          page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
        const settle = () =>
          page.waitForFunction(() => {
            const drawer = document.querySelector("[data-phone-drawer]");
            return (
              drawer !== null &&
              Math.abs(new DOMMatrix(getComputedStyle(drawer).transform).m41) < 0.1
            );
          });
        await open();
        await settle();
        assert.equal(
          await drawer.evaluate((el) => getComputedStyle(el).backdropFilter),
          "blur(18px)",
          "the shipped CSS must retain the real standard backdrop filter",
        );
        const folder = page.getByRole("treeitem").filter({ hasText: /^product$/ });
        if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
        const row = page.locator('[data-row-key="session:phone-0"]');
        await row.waitFor();
        assert.equal(await row.evaluate((el) => el.getBoundingClientRect().height), 48);
        assert.equal(
          await row
            .locator('[data-harness-id="fake"]')
            .evaluate((el) => el.getBoundingClientRect().width),
          14,
        );
        assert.ok(defined(await drawer.boundingBox()).width <= width - 40);
        await hiddenPhoneScrollbars(drawer);
        assert.equal(
          await drawer
            .locator('span[class*="_fade"]')
            .evaluate((element) => getComputedStyle(element).display),
          "none",
          "a transparent phone sidebar has no solid bottom fade",
        );
        await capture(page, `phone-${width}-${height}-${colorScheme}-list`);
        const options = page.getByRole("button", { name: "View options", exact: true });
        await options.click();
        const view = page.locator("[data-phone-sidebar-view]");
        await view.waitFor();
        assert.equal(
          await page.getByRole("dialog").count(),
          1,
          "only the internal view owns modal semantics",
        );
        assert.equal(
          await page
            .locator("[data-phone-sidebar-content]")
            .evaluate((el) => (el as HTMLElement).inert),
          true,
        );
        assert.equal(await page.locator('body > [role="presentation"] [role="menu"]').count(), 0);
        for (const label of [
          "WorkSpace",
          "Workspace Tree",
          "In one list",
          "Manual",
          "Last updated",
          "Hide archived",
          "All conversations (show archived)",
          "Archived only",
        ]) {
          assert.equal(
            await page.getByRole("menuitem", { name: label, exact: true }).count(),
            1,
            label,
          );
        }
        await hiddenPhoneScrollbars(drawer);
        await capture(page, `phone-${width}-${height}-${colorScheme}-options`);
        if (width === 390 && height === 514) {
          await view.getByRole("menuitem").first().focus();
          await page.keyboard.press("End");
          const last = view.getByRole("menuitem", { name: "Archived only", exact: true });
          assert.equal(await last.evaluate((element) => element === document.activeElement), true);
          assert.equal(
            await last.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return element.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
              );
            }),
            true,
            "the last internal-view option remains keyboard reachable and exposed on a short phone",
          );
        }
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await view.waitFor({ state: "hidden" });
        assert.equal(
          await options.evaluate((el) => document.activeElement === el),
          true,
          "back restores options trigger",
        );
        await row.getByRole("button", { name: /^Session actions/ }).click();
        await view.waitFor();
        assert.equal(await row.getAttribute("aria-selected"), "false");
        for (const name of ["Rename", "Pin", "Archive"])
          assert.ok(await page.getByRole("menuitem", { name: new RegExp(name, "i") }).count());
        await capture(page, `phone-${width}-${height}-${colorScheme}-details`);
        await page.keyboard.press("Escape");
        await view.waitFor({ state: "hidden" });
        assert.equal(
          await row
            .getByRole("button", { name: /^Session actions/ })
            .evaluate((el) => document.activeElement === el),
          true,
        );
        await page.getByRole("button", { name: "Add workspace", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Select Workspace Directory", exact: true })
          .waitFor();
        assert.equal(await drawer.locator("[data-phone-sidebar-view]").count(), 1);
        await hiddenPhoneScrollbars(drawer);
        const directoryOpen = view.getByRole("button", { name: "Open", exact: true });
        assert.equal(
          await directoryOpen.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
            );
          }),
          true,
          "directory bottom actions remain exposed, including on short phones",
        );
        await capture(page, `phone-${width}-${height}-${colorScheme}-workspace`);
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await view.waitFor({ state: "hidden" });
        await options.click();
        await page.getByRole("menuitem", { name: "In one list", exact: true }).click();
        await page.getByRole("button", { name: "Show 10 more", exact: true }).click();
        if (width === 390 && height === 514) {
          const list = drawer.locator('[role="tree"]').first();
          assert.equal(
            await list.evaluate((element) => getComputedStyle(element).scrollbarGutter),
            "auto",
          );
          await row.focus();
          await page.keyboard.press("End");
          assert.ok(
            await list.evaluate((element) => element.scrollTop > 0),
            "keyboard End scrolls the native list",
          );
          await page.keyboard.press("Home");
          assert.equal(await row.evaluate((element) => element === document.activeElement), true);
          const beforeTouch = await stableScroll(list);
          const bounds = defined(await list.boundingBox());
          const cdp = await context.newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: 130, y: bounds.y + bounds.height * 0.8 }],
          });
          for (let step = 1; step <= 5; step++) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: 130, y: bounds.y + bounds.height * (0.8 - step * 0.12) }],
            });
            await page.waitForTimeout(20);
          }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          const beforeView = await stableScroll(list);
          assert.ok(
            beforeView.top > beforeTouch.top + 1,
            "real synthesized touch pans the list without claiming drawer navigation",
          );
          await options.click();
          await page.getByRole("button", { name: "Back", exact: true }).click();
          const immediate = await list.evaluate((el) => el.scrollTop);
          const afterView = await stableScroll(list);
          const directory = process.env.CODEXHOST_TEST_SCREENSHOTS;
          if (directory) {
            mkdirSync(directory, { recursive: true });
            writeFileSync(
              join(directory, `phone-${colorScheme}-scroll.json`),
              JSON.stringify({ beforeTouch, beforeView, immediate, afterView }, null, 2),
            );
          }
          assert.ok(
            Math.abs(immediate - beforeView.top) < 1 &&
              Math.abs(afterView.top - beforeView.top) < 1,
            `return preserves immediate and settled scroll (${beforeView.top} -> ${immediate} -> ${afterView.top})`,
          );
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: 130, y: bounds.y + bounds.height * 0.2 }],
          });
          for (let step = 1; step <= 5; step++) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: 130, y: bounds.y + bounds.height * (0.2 + step * 0.12) }],
            });
            await page.waitForTimeout(20);
          }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          const afterReverseTouch = await stableScroll(list);
          if (directory)
            writeFileSync(
              join(directory, `phone-${colorScheme}-scroll.json`),
              JSON.stringify(
                { beforeTouch, beforeView, immediate, afterView, afterReverseTouch },
                null,
                2,
              ),
            );
          assert.ok(
            afterReverseTouch.top < afterView.top - 1,
            "the hidden-scrollbar list also scrolls back up with native touch",
          );
          await cdp.detach();
        }
        await row.scrollIntoViewIfNeeded();
        await page.getByRole("button", { name: "Search sessions", exact: true }).click();
        const search = page.getByPlaceholder("Search session names");
        await search.fill("Conversation 00");
        await page.getByRole("treeitem").filter({ hasText: "Conversation 00" }).waitFor();
        await search.press("Escape");
        // The edge, not the list or inline actions, owns horizontal manipulation.
        const edge = drawer.locator("[data-phone-drawer-edge]");
        const box = defined(await edge.boundingBox());
        await page.mouse.move(box.x + 6, box.y + 150);
        await page.mouse.down();
        await page.mouse.move(box.x - 80, box.y + 151, { steps: 5 });
        await edge.dispatchEvent("pointercancel", { pointerId: 1, isPrimary: true });
        await page.mouse.up();
        await settle();
        assert.equal(await drawer.getAttribute("data-open"), "true");
        await page.mouse.move(box.x + 6, box.y + 150);
        await page.mouse.down();
        await page.mouse.move(box.x - 90, box.y + 151, { steps: 5 });
        await page.mouse.move(box.x + 4, box.y + 151, { steps: 6 });
        await page.mouse.up();
        await settle();
        await page.mouse.move(box.x + 6, box.y + 150);
        await page.mouse.down();
        await page.mouse.move(box.x - 220, box.y + 151, { steps: 8 });
        await page.mouse.up();
        await page.waitForFunction(() => {
          const drawer = document.querySelector("[data-phone-drawer]");
          return drawer !== null && getComputedStyle(drawer).visibility === "hidden";
        });
        await open();
        await page.waitForTimeout(40);
        await drawer
          .getByRole("button", { name: "Collapse sidebar", exact: true })
          .dispatchEvent("click");
        await page.waitForTimeout(40);
        await page.locator("[data-shell-leading] button").first().dispatchEvent("click");
        await settle();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => {
          const drawer = document.querySelector("[data-phone-drawer]");
          return drawer !== null && getComputedStyle(drawer).visibility === "hidden";
        });
        await open();
        await settle();
        await capture(page, `phone-${width}-${height}-${colorScheme}-reduced`);
        if (width === 390 && height === 514) {
          const cdp = await context.newCDPSession(page);
          for (const feature of [
            "prefers-reduced-transparency",
            "prefers-contrast",
            "forced-colors",
          ]) {
            await cdp.send("Emulation.setEmulatedMedia", {
              features: [
                { name: "prefers-color-scheme", value: colorScheme },
                { name: "prefers-reduced-motion", value: "reduce" },
                {
                  name: feature,
                  value:
                    feature === "prefers-contrast"
                      ? "more"
                      : feature === "forced-colors"
                        ? "active"
                        : "reduce",
                },
              ],
            });
            assert.equal(
              await drawer.evaluate((el) => getComputedStyle(el).backdropFilter),
              "none",
            );
            await capture(page, `phone-${colorScheme}-${feature}`);
          }
          await cdp.detach();
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
    assert.equal(
      host.requests.some((r) =>
        ["turn/start", "thread/start", "thread/resume", "thread/archive"].includes(r.method),
      ),
      false,
    );
  },
);

it(
  "phone internal views preserve archived guards and workspace pending/error/cancel contracts",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    host.add("active", "/computer/generated", "Active recent", false);
    host.add("archived", "/computer/generated", "Archived recent", false);
    host.archivedIds.add("archived");
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--dev-web-ui",
        resolve("apps/web-ui"),
      ],
      { authenticated: true },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 390, height: 514 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    await page.goto(url);
    await page.getByText("Native Model", { exact: true }).waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
    const options = page.getByRole("button", { name: "View options", exact: true });
    const choose = async (name: string) => {
      await options.click();
      await page.getByRole("menuitem", { name, exact: true }).click();
    };
    await choose("In one list");
    await choose("Manual");
    await choose("Archived only");
    const archived = page.locator('[data-row-key="session:archived"]');
    await archived.waitFor();
    await archived.click();
    assert.equal(await page.locator("[data-phone-drawer][data-open]").count(), 1);
    assert.equal(
      host.requests.some((r) => r.method === "thread/resume" && r.params.threadId === "archived"),
      false,
    );
    await archived.getByRole("button", { name: /^Session actions/ }).click();
    await page.getByRole("menuitem", { name: "Unarchive session", exact: true }).click();
    await archived.waitFor({ state: "detached" });
    await choose("Hide archived");
    const active = page.locator('[data-row-key="session:active"]');
    await active.waitFor();
    await active.getByRole("button", { name: /^Session actions/ }).click();
    await page.getByRole("menuitem", { name: "Pin session", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-row-key="section:pinned"]') !== null,
    );
    assert.ok(host.pinnedIds.includes("active"));
    await active.getByRole("button", { name: /^Session actions/ }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByRole("textbox", { name: "Session name", exact: true }).waitFor();
    assert.equal(
      await page.locator("[data-phone-sidebar-view]").count(),
      1,
      "shell.overlay actions inherit only the phone presentation outlet",
    );
    await page.getByRole("button", { name: "Back", exact: true }).click();
    const add = page.getByRole("button", { name: "Add workspace", exact: true });
    await add.click();
    const directory = page.getByRole("dialog", { name: "Select Workspace Directory", exact: true });
    await directory.waitFor();
    const newFolder = directory.getByRole("button", { name: "New folder", exact: true });
    await newFolder.click();
    await page.getByRole("textbox", { name: "Folder name", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("dialog").count(),
      1,
      "folder creation replaces the browser view",
    );
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await directory.waitFor();
    assert.equal(await newFolder.evaluate((el) => document.activeElement === el), true);
    // An actual unreadable Host path stays in the real directory browser's error state.
    await directory.getByRole("button", { name: "Edit path", exact: true }).click();
    const path = directory.getByRole("textbox");
    await path.fill("/nonexistent-codexhost-phone-sidebar-fixture");
    await path.press("Enter");
    await directory.getByRole("alert").waitFor();
    await page.keyboard.press("Escape");
    if (await directory.isVisible()) await page.keyboard.press("Escape");
    await add.click();
    await directory.waitFor();
    let gate = Promise.withResolvers<undefined>();
    t.after(() => gate.resolve(undefined));
    let adoption = 0;
    await page.route("**/api/workspace/create", async (route) => {
      adoption++;
      await gate.promise;
      const request = route.request().postDataJSON() as { rpcId: string };
      await route.fulfill({
        json: {
          type: "server-response",
          rpcId: request.rpcId,
          result: {
            ok: false,
            error: { code: "gateway/internal", message: "Fixture adoption refused", details: {} },
          },
        },
      });
    });
    await directory.getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(adoption, 1);
    await directory.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(
      await directory.isVisible(),
      true,
      "pending adoption keeps the owner's guarded close",
    );
    gate.resolve(undefined);
    await page.getByRole("alert").filter({ hasText: "Fixture adoption refused" }).waitFor();
    assert.equal(await page.locator("[data-phone-sidebar-view]").count(), 1);
    await capture(page, "phone-directory-adoption-error");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.locator("[data-phone-sidebar-view]").waitFor({ state: "hidden" });
    gate = Promise.withResolvers<undefined>();
    await add.click();
    await directory.waitFor();
    await directory.getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(adoption, 2);
    await page.mouse.click(380, 150);
    await page.waitForFunction(() => !document.querySelector("[data-phone-drawer][data-open]"));
    gate.resolve(undefined);
    const lateError = page
      .locator('[data-phone-sidebar-view] [role="alert"]')
      .filter({ hasText: "Fixture adoption refused" });
    await lateError.waitFor({ state: "attached" });
    assert.equal(
      await page.getByRole("dialog").count(),
      0,
      "late adoption errors do not raise a second modal over a dismissed drawer",
    );
    await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
    await lateError.waitFor();
    await page.keyboard.press("Escape");
    await lateError.waitFor({ state: "detached" });
    assert.equal(
      await page.locator("[data-phone-drawer][data-open]").count(),
      1,
      "Escape first leaves the retained error view",
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Open sidebar",
    );
    assert.equal(
      host.requests.some((r) => ["turn/start", "thread/start"].includes(r.method)),
      false,
    );
  },
);
