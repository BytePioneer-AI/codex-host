import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const dark of [false, true])
  for (const mobile of [false, true]) {
    it(
      `sidebar Harness appearance matches Codex typography (${dark ? "dark" : "light"}, ${mobile ? "touch" : "desktop"})`,
      { timeout: 60_000 },
      async (t) => {
        const repo = resolve(import.meta.dirname, "../../../..");
        const pi = JSON.parse(
          readFileSync(join(repo, "packages/adapters/pi/manifest.json"), "utf8"),
        );
        const claude = JSON.parse(
          readFileSync(join(repo, "packages/adapters/claude-code/manifest.json"), "utf8"),
        );
        const host = new FakeChHost();
        host.add("pi", "/computer/project", "Pi appearance reference");
        host.add("claude", "/computer/project", "Claude brand reference");
        host.pinnedIds = ["pi"];
        const native = host.request.bind(host);
        host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
          if (method === "codexhost/harness/plugins/list")
            return {
              plugins: [
                { id: "fake", name: "Pi", version: "1", iconStyle: pi.iconStyle },
                {
                  id: "claude-code",
                  name: "Claude Code",
                  version: "1",
                  iconStyle: claude.iconStyle,
                },
              ],
            } as T;
          if (method === "codexhost/thread/ownership/list")
            return {
              threads: (params.threadIds as string[]).map((id) => ({
                threadId: id,
                owner: "external",
                harnessId: id === "claude" ? "claude-code" : "fake",
              })),
            } as T;
          return native<T>(method, params);
        };
        const debug = await startFakeChDebugger(host);
        t.after(() => debug.close());
        const url = await startServer(
          t,
          resolve(import.meta.dirname, "../.."),
          ["--import", "tsx", "src/main.ts"],
          ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
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
        // Preparation is complete. Verify through normal GUI and read-only style inspection.
        await page.goto(url);
        await page.getByText("Native Model", { exact: true }).waitFor();
        if (dark) await page.locator("body[data-ds-dark-theme]").waitFor();
        if (mobile)
          await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
        const row = page.locator('[data-sidebar-pinned] [data-row-key="session:pi"]');
        await row.getByText("Pi appearance reference", { exact: true }).waitFor();
        await row.locator('[data-harness-id="fake"] svg').waitFor();
        const appearance = await row.evaluate((element) => {
          const title = element.querySelector<HTMLElement>("[data-session-title]");
          const icon = element.querySelector<HTMLElement>("[data-harness-id]");
          const art = icon?.querySelector("svg");
          if (!title || !icon || !art) throw new Error("Harness/title missing");
          const text = getComputedStyle(title),
            glyph = getComputedStyle(art),
            marker = icon.getBoundingClientRect();
          return {
            color: text.color,
            fill: glyph.fill,
            iconColor: getComputedStyle(icon).color,
            fontFamily: text.fontFamily,
            fontSize: text.fontSize,
            fontWeight: text.fontWeight,
            lineHeight: text.lineHeight,
            letterSpacing: text.letterSpacing,
            fontSynthesisWeight: text.getPropertyValue("font-synthesis-weight"),
            iconWidth: marker.width,
            iconHeight: marker.height,
            artworkWidth: art.getBoundingClientRect().width,
            viewBox: art.getAttribute("viewBox"),
          };
        });
        // Light reference values were read from the running Codex GUI (26.1007).
        assert.equal(
          appearance.color,
          dark
            ? "oklab(0.999994 0.0000455678 0.0000200868 / 0.85)"
            : "oklab(0.22559 -0.00131416 -0.00642684 / 0.85)",
        );
        assert.equal(appearance.fill, appearance.color);
        assert.equal(appearance.iconColor, appearance.color);
        assert.equal(appearance.fontFamily, '-apple-system, "system-ui", "Segoe UI", sans-serif');
        assert.equal(appearance.fontSize, "14px");
        assert.equal(appearance.fontWeight, "430");
        assert.equal(appearance.lineHeight, "20px");
        assert.equal(appearance.letterSpacing, "normal");
        assert.equal(appearance.fontSynthesisWeight, "none");
        const heading = await page
          .locator('[data-sidebar-pinned] [class*="heading"]')
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              family: style.fontFamily,
              size: style.fontSize,
              weight: style.fontWeight,
              line: style.lineHeight,
              color: style.color,
            };
          });
        assert.deepEqual(heading, {
          family: appearance.fontFamily,
          size: "14px",
          weight: "500",
          line: "21px",
          // This Chromium serializes native 0.495 alpha to its 8-bit 0.494 value.
          color: dark ? "rgba(255, 255, 255, 0.498)" : "rgba(26, 28, 31, 0.494)",
        });
        const navigation = await page
          .getByRole("button", { name: "New session", exact: true })
          .filter({ has: page.locator('[class*="newSessionLabel"]') })
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              family: style.fontFamily,
              weight: style.fontWeight,
              line: style.lineHeight,
              color: style.color,
            };
          });
        assert.deepEqual(navigation, {
          family: appearance.fontFamily,
          weight: "430",
          line: "21px",
          color: appearance.color,
        });
        assert.equal(appearance.iconWidth, 14);
        assert.equal(appearance.iconHeight, 14);
        assert.equal(appearance.artworkWidth, 14);
        assert.equal(appearance.viewBox, "0 0 24 24");
        const folder = page.getByRole("treeitem").filter({ hasText: /^project$/u });
        if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
        const project = await folder
          .locator('[class*="title"]')
          .first()
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              family: style.fontFamily,
              size: style.fontSize,
              weight: style.fontWeight,
              color: style.color,
              synthesis: style.getPropertyValue("font-synthesis-weight"),
            };
          });
        assert.deepEqual(project, {
          family: appearance.fontFamily,
          size: "14px",
          weight: "430",
          color: appearance.color,
          synthesis: "none",
        });
        const timestamp = await row
          .locator('[class*="time"]')
          .evaluate((element) => getComputedStyle(element).color);
        assert.equal(timestamp, heading.color);
        const brand = page.locator(
          '[data-row-key="session:claude"] [data-harness-id="claude-code"] svg',
        );
        await brand.waitFor();
        assert.equal(
          await brand.evaluate((element) => getComputedStyle(element).fill),
          "rgb(217, 119, 87)",
          "fixed Harness brand colors are not replaced by row typography",
        );
        if (!mobile) {
          await row.hover();
          assert.equal(
            await row
              .locator("[data-session-title]")
              .evaluate((element) => getComputedStyle(element).color),
            appearance.color,
          );
        }
        assert.deepEqual(errors, []);
        if (mobile) {
          // Selecting a workspace can close the existing phone drawer. Reopen it
          // normally, then observe the actual drawer bounds before capturing icons.
          if (await page.locator("[data-phone][data-sidebar-collapsed]").count())
            await page.getByRole("button", { name: "Open sidebar", exact: true }).last().click();
          await page.waitForFunction(() => {
            const drawer = document.querySelector('[class*="phoneDrawer"]');
            const box = drawer?.getBoundingClientRect();
            return box && box.left >= -0.5 && box.right <= window.innerWidth + 0.5;
          });
        }
        if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
          mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(
              process.env.CODEXHOST_TEST_SCREENSHOTS,
              `harness-${dark ? "dark" : "light"}-${mobile ? "touch" : "desktop"}.png`,
            ),
          });
        }
      },
    );
  }
