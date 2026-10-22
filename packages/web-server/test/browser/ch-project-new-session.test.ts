import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

for (const mobile of [false, true]) {
  it(
    `project New Session opens a draft from an existing conversation (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      host.add("project-history", "/computer/project", "Existing conversation");
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
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
      if (mobile) await openSidebar.last().click();
      const project = page.getByRole("treeitem").filter({ hasText: /^project$/u });
      if ((await project.getAttribute("aria-expanded")) === "false") await project.click();
      await page.locator('[data-row-key="session:project-history"]').click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      if (mobile) await openSidebar.last().click();
      else await project.hover();
      await page.getByRole("button", { name: "New session in project", exact: true }).click();
      await page.getByText("What should we build today?", { exact: true }).waitFor();
      await page
        .locator("[data-conversation-content]")
        .getByRole("button", { name: "Choose workspace", exact: true })
        .getByText("project", { exact: true })
        .waitFor();
      assert.equal(await page.getByText("existing CH answer", { exact: true }).count(), 0);
      assert.equal(
        host.requests.some((request) => request.method === "thread/start"),
        false,
      );
      await page.locator('[contenteditable="true"]').fill("First project message");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("CH response: First project message", { exact: true }).waitFor();
      if (mobile) await openSidebar.last().click();
      else await project.hover();
      await page.getByRole("button", { name: "New session in project", exact: true }).click();
      await page.getByText("What should we build today?", { exact: true }).waitFor();
      assert.equal(
        await page.getByText("CH response: First project message", { exact: true }).count(),
        0,
      );
      assert.deepEqual(errors, []);
    },
  );
}
