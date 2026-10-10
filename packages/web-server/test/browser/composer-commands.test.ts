/** The composer launcher must not lose its entire roster to a duplicate /model. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function shot(page: Page, name: string) {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({
    path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `${name}.png`),
    animations: "disabled",
  });
}

for (const source of ["codexhost", "standalone"])
  for (const width of [390, 1280])
    it(`composer commands in ${source} at ${width}px`, { timeout: 60_000 }, async (t) => {
      const host = new FakeChHost();
      const args = ["--session-source", source];
      if (source === "codexhost") {
        host.add("existing-commands", "/computer/commands", "Existing commands thread");
        const debuggerServer = await startFakeChDebugger(host);
        t.after(() => debuggerServer.close());
        args.push("--ch-cdp", debuggerServer.endpoint);
      } else args.push("--adapters", "test/fake-harness");
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        args,
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 600,
        hasTouch: width < 600,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const plus = page.getByRole("button", {
        name: source === "codexhost" ? "Add files or run commands" : "Run commands",
        exact: true,
      });
      const menu = page.getByRole("listbox", { name: "Trigger suggestions", exact: true });
      const composer = page.getByRole("textbox", {
        name: "Describe what you want to build, / commands, @ files or sessions",
        exact: true,
      });
      await plus.waitFor();
      await shot(page, `commands-before-${source}-${width}`);
      await plus.click();
      await menu.getByRole("option", { name: /^Model\b/u }).waitFor();
      await shot(page, `commands-open-${source}-${width}`);
      assert.equal(await plus.getAttribute("aria-expanded"), "true");
      assert.equal(await menu.getByRole("option", { name: /^Model\b/u }).count(), 1);
      assert.equal(await menu.getByRole("option", { name: /^Permission\b/u }).count(), 1);
      assert.equal(
        await menu.getByRole("option", { name: /^File\b/u }).count(),
        source === "codexhost" ? 1 : 0,
      );
      assert.equal(await page.locator('input[type="file"]').isDisabled(), source !== "codexhost");
      if (source === "codexhost")
        assert.equal(
          await page.locator('input[type="file"]').getAttribute("accept"),
          null,
          "shared picker accepts arbitrary file types",
        );
      await plus.click();
      await menu.waitFor({ state: "hidden" });
      assert.equal(await plus.getAttribute("aria-expanded"), "false");
      await plus.press("Enter");
      await menu.waitFor();
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      await plus.click();
      await menu.waitFor();
      await composer.fill("a draft");
      await menu.waitFor({ state: "hidden" });
      assert.equal(await plus.getAttribute("aria-expanded"), "false");
      await composer.fill("/");
      await menu.getByRole("option", { name: /^Model\b/u }).click();
      const models = page.getByRole("listbox", { name: "/model matches", exact: true });
      await models.getByRole("option").first().waitFor();
      await shot(page, `commands-model-${source}-${width}`);
      await page.keyboard.press("Escape");
      await models.waitFor({ state: "hidden" });
      // Clear through the editor's keymap after the popup restores focus.
      // fill("") can mutate contenteditable DOM without updating Lexical.
      await composer.press("ControlOrMeta+A");
      await composer.press("Backspace");
      assert.equal((await composer.innerText()).trim(), "");
      await plus.click();
      await menu
        .getByRole("option", { name: /^Permission\b/u })
        .click({ timeout: 5_000 })
        .catch(async (error: unknown) => {
          await shot(page, `commands-permission-failure-${source}-${width}`);
          console.error(await page.locator("body").innerText(), errors);
          throw error;
        });
      const permissions = page.getByRole("listbox", { name: "/permission matches", exact: true });
      await permissions.getByRole("option", { name: "Ask", exact: true }).waitFor();
      await shot(page, `commands-permission-${source}-${width}`);
      await page.keyboard.press("Escape");
      await permissions.waitFor({ state: "hidden" });

      if (source === "codexhost") {
        const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true }).last();
        if (await sidebar.isVisible()) await sidebar.click();
        const folder = page.getByRole("treeitem").filter({ hasText: /^commands$/u });
        if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
        await page.getByRole("treeitem").filter({ hasText: "Existing commands thread" }).click();
        await page.getByText("existing CH answer", { exact: true }).waitFor();
        await plus.click();
        await menu.getByRole("option", { name: /^Model\b/u }).waitFor();
        await shot(page, `commands-existing-${width}`);
        assert.equal(
          host.requests.some((request) =>
            [
              "thread/start",
              "turn/start",
              "codexhost/thread/model/select",
              "codexhost/thread/permission-mode/select",
            ].includes(request.method),
          ),
          false,
          "opening menus does not mutate the native session",
        );
      }
      assert.deepEqual(errors, []);
    });
