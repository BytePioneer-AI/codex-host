import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Locator } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

// Exact native compose paths, not a similar pencil or a chat-plus substitute.
const composePaths = [
  "M8.16675 2.50127C8.53391 2.50127 8.83161 2.7992 8.83179 3.16631C8.83179 3.53358 8.53402 3.83135 8.16675 3.83135H5.83374C4.72836 3.83135 3.83197 4.72797 3.83179 5.8333V14.1663C3.83179 15.2718 4.72825 16.1683 5.83374 16.1683H14.1667C15.2722 16.1683 16.1687 15.2718 16.1687 14.1663V11.8333C16.1689 11.4662 16.4666 11.1683 16.8337 11.1683C17.2007 11.1684 17.4986 11.4663 17.4988 11.8333V14.1663C17.4988 16.0063 16.0068 17.4983 14.1667 17.4983H5.83374C3.99371 17.4983 2.50171 16.0063 2.50171 14.1663V5.8333C2.50189 3.99343 3.99382 2.50127 5.83374 2.50127H8.16675Z",
  "M13.4265 3.10381C14.3857 2.15908 15.9276 2.16466 16.8796 3.11651C17.8339 4.07106 17.8372 5.61827 16.8865 6.57647L11.7244 11.7786C11.3005 12.2058 10.7622 12.5027 10.1746 12.6321L7.78784 13.1565C7.20661 13.2842 6.6889 12.766 6.81714 12.1849L7.34253 9.80498C7.47294 9.21426 7.77197 8.67391 8.20288 8.24932L13.4265 3.10381ZM15.9392 4.05694C15.5038 3.62172 14.7988 3.61907 14.3601 4.05108L9.13647 9.19659C8.88861 9.44077 8.71644 9.75138 8.64136 10.0911L8.28979 11.6849L9.88843 11.3333C10.2265 11.2588 10.5362 11.0878 10.78 10.8421L15.9421 5.63897C16.3769 5.20075 16.3756 4.49352 15.9392 4.05694Z",
];

async function verifyCompose(svg: Locator, size: number) {
  await svg.waitFor({ state: "visible" });
  assert.deepEqual(
    await svg.evaluate((element) => ({
      viewBox: element.getAttribute("viewBox"),
      width: element.getAttribute("width"),
      height: element.getAttribute("height"),
      fill: element.getAttribute("fill"),
      paths: [...element.querySelectorAll("path")].map((path) => path.getAttribute("d")),
      hole: element.querySelectorAll("path")[1]?.getAttribute("fill-rule"),
    })),
    {
      viewBox: "0 0 20 20",
      width: String(size),
      height: String(size),
      fill: "currentColor",
      paths: composePaths,
      hole: "evenodd",
    },
  );
  assert.ok(
    await svg.evaluate(
      (element) => getComputedStyle(element).fill === getComputedStyle(element).color,
    ),
  );
}

it(
  "uses the exact compose icon for New Session in both themes and sidebar states",
  { timeout: 60000 },
  async (t) => {
    const host = new FakeChHost();
    host.add("icon-history", "/computer/icons", "Existing conversation");
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
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const newSession = page
      .getByRole("button", { name: "New session", exact: true })
      .filter({ has: page.locator('svg[viewBox="0 0 20 20"]') })
      .first();
    for (const theme of ["Dark", "Light"]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: theme, exact: true }).click();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await verifyCompose(newSession.locator("svg"), 18);
      const projectNew = page.getByRole("button", { name: "New session in icons", exact: true });
      await page
        .getByRole("treeitem")
        .filter({ hasText: /^icons$/u })
        .hover();
      await verifyCompose(projectNew.locator("svg"), 16);
      await verifyCompose(
        page
          .getByRole("treeitem", { name: "Recents", exact: true })
          .getByRole("button", { name: "New session", exact: true })
          .locator("svg"),
        16,
      );
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(
            process.env.CODEXHOST_TEST_SCREENSHOTS,
            `new-session-${theme.toLowerCase()}.png`,
          ),
        });
      }
      await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
      // The wide icon remains mounted during the fade. Observe the settled rail,
      // not an off-screen glyph midway through the sidebar transition.
      await page.waitForFunction(() => {
        const compose = [...document.querySelectorAll('button[aria-label="New session"]')].find(
          (button) => button.querySelector('svg[viewBox="0 0 20 20"]'),
        );
        return (
          compose?.textContent?.trim() === "" &&
          document.getAnimations().every((animation) => animation.playState !== "running")
        );
      });
      await verifyCompose(newSession.locator("svg"), 18);
      await newSession.click();
      await page.getByText("What should we build today?", { exact: true }).waitFor();
      await page
        .getByRole("textbox", {
          name: "Describe what you want to build, / commands, @ files or sessions",
          exact: true,
        })
        .waitFor();
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        await page.screenshot({
          path: join(
            process.env.CODEXHOST_TEST_SCREENSHOTS,
            `new-session-rail-${theme.toLowerCase()}.png`,
          ),
        });
      }
      await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
    }
    assert.deepEqual(errors, []);
  },
);
