import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "uses CH icon presentation in rows and picker across light/dark themes",
  { timeout: 60000 },
  async (t) => {
    const pi = JSON.parse(
      readFileSync(new URL("../../../adapters/pi/manifest.json", import.meta.url), "utf8"),
    );
    const claude = JSON.parse(
      readFileSync(new URL("../../../adapters/claude-code/manifest.json", import.meta.url), "utf8"),
    );
    const host = new FakeChHost();
    host.add("pi-history", "/computer/icons", "Pi history");
    host.add("colored-history", "/computer/icons", "Colored history");
    const original = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "codexhost/harness/plugins/list") {
        const base = await original<{ plugins: Array<Record<string, unknown>> }>(method, params);
        return {
          plugins: [
            { ...base.plugins[0], id: "fake", name: "Pi Fixture", iconStyle: pi.iconStyle },
            {
              ...base.plugins[0],
              id: "colored",
              name: "Colored Fixture",
              iconStyle: claude.iconStyle,
            },
            {
              ...base.plugins[0],
              id: "bitmap",
              name: "Bitmap Fixture",
              iconStyle: { background: "#ffffff", borderRadius: 25, paddingRatio: 0.2 },
            },
          ],
        } as T;
      }
      if (method === "codexhost/thread/ownership/list")
        return {
          threads: (params.threadIds as string[]).map((id) => ({
            threadId: id,
            owner: "external",
            harnessId: id === "colored-history" ? "colored" : "fake",
          })),
        } as T;
      return original<T>(method, params);
    };
    const debuggerServer = await startFakeChDebugger(host);
    t.after(() => debuggerServer.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debuggerServer.endpoint],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    let metadataRequests = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (req) => {
      if (req.url().endsWith("/harness-icons/presentation.json")) metadataRequests++;
    });
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const folder = page.getByRole("treeitem").filter({ hasText: /^icons$/u });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    const piRow = page
        .locator('[data-row-key="session:pi-history"]')
        .getByRole("img", { name: "Pi Fixture", exact: true }),
      coloredRow = page
        .locator('[data-row-key="session:colored-history"]')
        .getByRole("img", { name: "Colored Fixture", exact: true });
    await piRow.locator('svg[viewBox="0 0 24 24"]').waitFor();
    assert.deepEqual(
      await piRow
        .locator("svg path")
        .evaluateAll((paths) => paths.map((path) => path.getAttribute("d"))),
      pi.iconStyle.vector.paths.map((path: { d: string }) => path.d),
    );
    const seenColors: string[] = [];
    for (const theme of ["Dark", "Light"]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: theme, exact: true }).click();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      const appearance = await piRow.locator("svg").evaluate((svg) => ({
        fill: getComputedStyle(svg).fill,
        color: getComputedStyle(svg).color,
        width: svg.getBoundingClientRect().width,
      }));
      assert.equal(appearance.fill, appearance.color);
      assert.equal(appearance.width, 16);
      seenColors.push(appearance.fill);
      assert.equal(
        await coloredRow.locator("svg").evaluate((svg) => getComputedStyle(svg).fill),
        "rgb(217, 119, 87)",
      );
      const trigger = page.getByRole("button", {
        name: "Select Harness, current Pi Fixture",
        exact: true,
      });
      await trigger.click();
      const option = page.getByRole("menuitem", { name: "Pi Fixture", exact: true });
      assert.equal(
        await option.locator("svg").first().getAttribute("viewBox"),
        pi.iconStyle.vector.viewBox,
      );
      const bitmap = page
        .getByRole("menuitem", { name: "Bitmap Fixture", exact: true })
        .locator("img");
      await bitmap.waitFor();
      assert.deepEqual(
        await bitmap.evaluate((image) => ({
          padding: getComputedStyle(image).padding,
          background: getComputedStyle(image).backgroundColor,
          radius: getComputedStyle(image).borderRadius,
        })),
        { padding: "4px", background: "rgb(255, 255, 255)", radius: "25%" },
      );
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(
            process.env.CODEXHOST_TEST_SCREENSHOTS,
            `harness-icons-${theme.toLowerCase()}.png`,
          ),
        });
      }
      await page.keyboard.press("Escape");
    }
    assert.notEqual(seenColors[0], seenColors[1]);
    assert.equal(metadataRequests, 1, "Do not fetch metadata per row or picker item");
    assert.deepEqual(errors, []);
  },
);
