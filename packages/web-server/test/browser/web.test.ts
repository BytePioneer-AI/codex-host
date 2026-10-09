/** Keyless browser acceptance against the real Web composition and a scripted Harness. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";

import { chromium, type Page } from "playwright";

import { startServer } from "../support/server.ts";

const serverRoot = resolve(import.meta.dirname, "../..");
const composerLabel = "Describe what you want to build, / commands, @ files or sessions";

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.CODEXHOST_TEST_SCREENSHOTS;
  if (directory === undefined) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
}

for (const viewport of [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  it(
    `settings remain usable and persist at ${viewport.width}px`,
    { timeout: 60_000 },
    async (t) => {
      const url = await startServer(
        t,
        serverRoot,
        ["--import", "tsx", "src/main.ts"],
        ["--adapters", "test/fake-harness"],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport,
        isMobile: viewport.width < 600,
        hasTouch: viewport.width < 600,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.getByRole("textbox", { name: composerLabel, exact: true }).waitFor();
      if (viewport.width < 600)
        await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
      await dialog.getByRole("button", { name: "English", exact: true }).waitFor();
      for (const name of ["English", "Light", "Dark", "System", "Close"]) {
        const box = await dialog.getByRole("button", { name, exact: true }).boundingBox();
        assert.ok(box, `${name} has a visible box`);
        assert.ok(
          box.x >= 0 && box.x + box.width <= viewport.width,
          `${name} is not clipped horizontally`,
        );
      }
      // The section must get the phone's width, not the remainder of a desktop navigation rail.
      const section = dialog
        .getByText("Notifications", { exact: true })
        .locator("..")
        .locator("..");
      const bounds = await section.boundingBox();
      assert.ok(bounds && bounds.width >= Math.min(260, viewport.width - 64));
      assert.doesNotMatch(await dialog.innerText(), /DeepSeek|Open configuration file/u);
      await screenshot(page, `settings-${viewport.width}`);
      await dialog.getByRole("button", { name: "Dark", exact: true }).click();
      await dialog.getByRole("button", { name: "Dark", exact: true, pressed: true }).waitFor();
      await screenshot(page, `settings-dark-${viewport.width}`);
      await dialog.getByRole("button", { name: "Queue", exact: true }).scrollIntoViewIfNeeded();
      await screenshot(page, `settings-scrolled-${viewport.width}`);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.reload();
      await page.getByRole("textbox", { name: composerLabel, exact: true }).waitFor();
      if (viewport.width < 600)
        await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Dark", exact: true, pressed: true })
        .waitFor();
      assert.deepEqual(errors, []);
    },
  );
}

for (const width of [390, 1280]) {
  it(
    `separates Harness identity from its models and locks native history at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const url = await startServer(
        t,
        serverRoot,
        ["--import", "tsx", "src/main.ts"],
        ["--adapters", "test/fake-harness"],
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
      await page.goto(url);
      const harness = () =>
        page.getByRole("button", { name: "Select Harness, current Other Harness", exact: true });
      await page
        .getByRole("button", { name: "Select Harness, current Fake Harness", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Other Harness", exact: true }).waitFor();
      const bounds = await page.getByRole("menu").boundingBox();
      assert.ok(
        bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
        "Harness menu fits the viewport",
      );
      await screenshot(page, `harness-menu-${width}`);
      await page.getByRole("menuitem", { name: "Other Harness", exact: true }).click();
      await harness().waitFor();
      await page
        .getByRole("button", { name: "Select model, current Other Model", exact: true })
        .click();
      await page
        .getByRole("menuitem")
        .filter({ hasText: /^Model/u })
        .click();
      await page.getByRole("menuitemradio", { name: "Other Alternate", exact: true }).waitFor();
      assert.equal(
        await page.getByRole("menuitemradio", { name: "Fake Model", exact: true }).count(),
        0,
      );
      await screenshot(page, `harness-models-${width}`);
      await page.getByRole("menuitemradio", { name: "Other Alternate", exact: true }).click();
      await page
        .getByRole("button", { name: "Select model, current Other Alternate", exact: true })
        .waitFor();
      await page
        .getByRole("textbox", { name: composerLabel, exact: true })
        .fill("picker acceptance");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("echo: picker acceptance", { exact: true }).waitFor();
      await harness().click();
      await page
        .getByText(
          "This conversation is bound to its Harness. Start a new conversation to use another.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await page.getByRole("menuitem", { name: "Fake Harness", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("menuitem", { name: "Other Harness", exact: true }).isDisabled(),
        false,
      );
      await screenshot(page, `harness-bound-${width}`);
      await page.keyboard.press("Escape");
      await page.reload();
      await harness().waitFor();
      await page
        .getByRole("button", { name: "Select model, current Other Alternate", exact: true })
        .waitFor();
      assert.deepEqual(errors, []);
    },
  );
}

it(
  "a phone can send, reconnect, and reopen durable conversation history",
  { timeout: 60_000 },
  async (t) => {
    const url = await startServer(
      t,
      serverRoot,
      ["--import", "tsx", "src/main.ts"],
      ["--adapters", "test/fake-harness"],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByRole("textbox", { name: composerLabel, exact: true }).fill("mobile acceptance");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("echo: mobile acceptance", { exact: true }).waitFor();
    await screenshot(page, "mobile-conversation");
    await context.setOffline(true);
    await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
    await page.getByText("Disconnected", { exact: true }).waitFor();
    await screenshot(page, "mobile-disconnected");
    await context.setOffline(false);
    await page.getByText("Connected", { exact: true }).waitFor();
    await screenshot(page, "mobile-reconnected");
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await page
      .getByRole("textbox", {
        name: "Message or run a task, / commands, @ files or sessions",
        exact: true,
      })
      .fill("after reconnect");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("echo: after reconnect", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("echo: after reconnect", { exact: true }).waitFor();
    assert.equal(await page.getByText("echo: mobile acceptance", { exact: true }).count(), 1);
    assert.equal(await page.getByText("echo: after reconnect", { exact: true }).count(), 1);
    await screenshot(page, "mobile-history");
    assert.deepEqual(errors, []);
  },
);
