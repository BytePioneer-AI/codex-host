import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Locator, type Page } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  // Wait for finite layout motion, not the status spinner being verified.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getTiming().iterations === Infinity ||
          animation.playState !== "running",
      ),
  );
  await page.screenshot({ path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `${name}.png`) });
}

async function rightStatus(row: Locator, state: "ongoing" | "done", mobile: boolean) {
  const status = row.locator(`[data-session-status="${state}"]`);
  const glyph = status.locator(`[data-state="${state}"]`);
  await glyph.waitFor({ state: "visible" });
  await row
    .page()
    .waitForFunction(() =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.effect?.getTiming().iterations === Infinity ||
            animation.playState !== "running",
        ),
    );
  const geometry = await row.evaluate((element) => {
    const identity = element.querySelector<HTMLElement>("[data-harness-id]");
    const title = element.querySelector<HTMLElement>("[data-session-title]");
    const status = element.querySelector<HTMLElement>("[data-session-status]");
    const dot = status?.querySelector<HTMLElement>("[data-state]");
    const menu = element.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
    if (!identity || !title || !status || !dot || !menu)
      throw new Error("Row identity/status/menu missing");
    const titleBox = title.getBoundingClientRect(),
      statusBox = status.getBoundingClientRect();
    return {
      identityWidth: identity.getBoundingClientRect().width,
      identityStates: identity.parentElement?.querySelectorAll("[data-state]").length,
      titleRight: titleBox.right,
      statusLeft: statusBox.left,
      statusRight: statusBox.right,
      menuLeft: menu.getBoundingClientRect().left,
      width: dot.getBoundingClientRect().width,
      height: dot.getBoundingClientRect().height,
      declaredWidth: dot.getAttribute("width"),
      declaredHeight: dot.getAttribute("height"),
      parent: status.parentElement?.className,
    };
  });
  assert.equal(geometry.identityWidth, 14);
  assert.equal(
    geometry.identityStates,
    0,
    "never overlay activity or completion onto Harness identity",
  );
  assert.ok(
    geometry.statusLeft >= geometry.titleRight,
    "status occupies the former trailing time cell",
  );
  assert.match(geometry.parent ?? "", /trailing/u);
  if (state === "ongoing") {
    assert.equal(geometry.declaredWidth, "16");
    assert.equal(geometry.declaredHeight, "16");
    // DOMRects use floating-point transforms even after settling. Preserve
    // exact SVG dimensions and allow only a sub-millipixel rounding error.
    assert.ok(Math.abs(geometry.width - 16) < 0.001);
    assert.ok(Math.abs(geometry.height - 16) < 0.001);
  }
  if (mobile)
    assert.ok(geometry.statusRight <= geometry.menuLeft, "touch menu must not cover the status");
}

for (const dark of [false, true]) {
  for (const mobile of [false, true]) {
    it(
      `sidebar activity and completion use the trailing time cell (${dark ? "dark" : "light"}, ${mobile ? "touch" : "desktop"})`,
      { timeout: 60_000 },
      async (t) => {
        const directory = mkdtempSync(join(tmpdir(), "ch-sidebar-status-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const host = new FakeChChannel();
        const pinned = host.add(
          "pinned-live",
          "/computer/status-project",
          "Pinned running conversation",
        );
        const project = host.add(
          "project-live",
          "/computer/status-project",
          "Project running conversation",
        );
        const recent = host.add(
          "recent-live",
          "/computer/generated",
          "Recent running conversation",
          false,
        );
        for (const row of [pinned, project, recent]) row.status = { type: "active" };
        host.pinnedIds = [pinned.id];
        const debug = await startFakeChDebugger(host);
        t.after(() => debug.close());
        const channel = await startFakeChChannel(host, directory);
        t.after(() => channel.close());
        const url = await startServer(
          t,
          resolve(import.meta.dirname, "../.."),
          ["--import", "tsx", "src/main.ts"],
          [
            "--session-source",
            "codexhost",
            "--ch-cdp",
            debug.endpoint,
            "--ch-control-directory",
            directory,
          ],
        );
        const browser = await chromium.launch();
        t.after(() => browser.close());
        const page = await browser.newPage({
          viewport: { width: mobile ? 390 : 1280, height: 900 },
          isMobile: mobile,
          hasTouch: mobile,
          colorScheme: dark ? "dark" : "light",
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        // Preparation ends here. Only normal GUI actions and read-only page
        // inspection follow; state changes below are events from the fake owner.
        await page.goto(url);
        await page.getByText("Native Model", { exact: true }).waitFor();
        if (dark) await page.locator("body[data-ds-dark-theme]").waitFor();
        const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
        if (mobile) await openSidebar.first().click();
        const heading = page.getByRole("treeitem").filter({ hasText: /^status-project$/u });
        await heading.waitFor();
        if ((await heading.getAttribute("aria-expanded")) === "false") await heading.click();
        const row = (id: string) => page.locator(`[data-row-key="session:${id}"]`);
        if (!mobile) await page.mouse.move(1100, 700);
        for (const id of [pinned.id, project.id, recent.id])
          await rightStatus(row(id), "ongoing", mobile);
        const pin = row(pinned.id).getByRole("img", { name: "Pinned", exact: true });
        if (!mobile)
          assert.ok(await pin.isVisible(), "a running pinned row retains its independent pin");
        const variant = `${dark ? "dark" : "light"}-${mobile ? "touch" : "desktop"}`;
        await shot(page, `status-${variant}-running`);

        pinned.status = { type: "idle" };
        host.changed(pinned.id, "turn/completed");
        await rightStatus(row(pinned.id), "done", mobile);
        assert.ok(await row(pinned.id).getByText("Completed", { exact: true }).count());
        const completionColor = await row(pinned.id)
          .locator('[data-state="done"]')
          .evaluate((element) => ({
            actual: getComputedStyle(element).color,
            expected: getComputedStyle(element)
              .getPropertyValue("--dsw-alias-state-business-primary")
              .trim(),
          }));
        const hex = /^#([0-9a-f]{6})$/iu.exec(completionColor.expected)?.[1];
        assert.ok(hex, "completion uses the existing blue business/info token");
        assert.equal(
          completionColor.actual,
          `rgb(${[0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`,
        );
        await shot(page, `status-${variant}-completed`);
        await row(pinned.id).click();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
        if (mobile) await openSidebar.last().click();
        await row(pinned.id).locator('[data-session-status="done"]').waitFor({ state: "hidden" });
        if (!mobile) await page.mouse.move(1100, 700);
        assert.equal(
          await row(pinned.id)
            .locator('[class*="time"]')
            .first()
            .getAttribute("data-session-status"),
          null,
        );
        await shot(page, `status-${variant}-read`);

        await row(recent.id).click();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
        recent.status = { type: "idle" };
        host.changed(recent.id, "turn/completed");
        if (mobile) await openSidebar.last().click();
        await row(recent.id)
          .locator('[data-session-status="ongoing"]')
          .waitFor({ state: "hidden" });
        assert.equal(
          await row(recent.id).locator('[data-session-status="done"]').count(),
          0,
          "currently viewed completion does not become an unread reminder",
        );
        project.status = { type: "idle" };
        host.changed(project.id, "turn/completed");
        if (!mobile) await page.mouse.move(1100, 700);
        await rightStatus(row(project.id), "done", mobile);
        await page.getByRole("button", { name: "View options", exact: true }).click();
        await page.getByRole("menuitem", { name: "In one list", exact: true }).click();
        if (!mobile) await page.mouse.move(1100, 700);
        await rightStatus(row(project.id), "done", mobile);
        await shot(page, `status-${variant}-flat`);
        await page.getByRole("button", { name: "Search sessions", exact: true }).click();
        await shot(page, `status-${variant}-search-open`);
        await page
          .getByPlaceholder("Search session names", { exact: true })
          .fill("Project running conversation");
        const search = page
          .getByRole("tree", { name: "Search results", exact: true })
          .getByRole("treeitem");
        await search.locator('[data-session-status="done"] [data-state="done"]').waitFor();
        const searchPosition = await search.evaluate((element) => {
          const title = element.querySelector('[class*="searchResultTitle"]');
          const status = element.querySelector("[data-session-status]");
          return {
            titleRight: title?.getBoundingClientRect().right ?? NaN,
            statusLeft: status?.getBoundingClientRect().left ?? NaN,
            leadingStates: element
              .querySelector('[class*="slot"]')
              ?.querySelectorAll("[data-state]").length,
          };
        });
        assert.ok(searchPosition.statusLeft >= searchPosition.titleRight);
        assert.equal(searchPosition.leadingStates, 0);
        await shot(page, `status-${variant}-search`);
        assert.deepEqual(errors, []);
      },
    );
  }
}
