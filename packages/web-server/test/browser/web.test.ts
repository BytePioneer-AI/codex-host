/** Keyless browser acceptance against the real Web composition and a scripted Harness. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
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
      const brandMark = page.locator('svg[data-codexhost-mark="otter"]');
      await brandMark.first().waitFor();
      assert.equal(await brandMark.first().getAttribute("viewBox"), "0 0 384 384");
      assert.equal(await brandMark.first().locator("image, mask").count(), 0);
      assert.equal(await brandMark.first().locator("path").count(), 2);
      const brandAsset = readFileSync(
        resolve(
          serverRoot,
          "../../apps/web-ui/packages/client/ui-brand-official/src/assets/codexhost-otter.svg",
        ),
        "utf8",
      );
      for (const path of await brandMark.first().locator("path").all()) {
        const geometry = await path.getAttribute("d");
        assert.ok(geometry && brandAsset.includes(`d="${geometry}"`));
      }
      assert.equal(await brandMark.first().locator("path").first().getAttribute("fill"), "#082e59");
      assert.equal(await brandMark.first().locator("circle").isVisible(), false);
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
      assert.equal(await brandMark.first().locator("circle").isVisible(), true);
      assert.equal(await brandMark.first().locator("path").first().getAttribute("fill"), "#082e59");
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
        viewport: { width, height: width >= 600 ? 585 : 900 },
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
      const modelTrigger = page.getByRole("button", {
        name: "Select model, current Other Model, reasoning effort High",
        exact: true,
      });
      await modelTrigger.click();
      const thinking = page.getByRole("menu", { name: "Thinking", exact: true });
      await thinking
        .getByRole("menuitemradio", { name: "High", exact: true, checked: true })
        .waitFor();
      await thinking.getByRole("menuitem", { name: "Other Model", exact: true }).click();
      const models = page.getByRole("menu", { name: "Model", exact: true });
      const alternateModel = models.getByRole("menuitemradio", {
        name: "Other Alternate",
        exact: true,
      });
      await alternateModel.waitFor();
      await alternateModel.focus();
      const rowBackgrounds = await alternateModel.evaluate((element) => {
        const row = element.parentElement;
        const favorite = row?.querySelector<HTMLElement>("[aria-pressed]");
        if (row === null || favorite == null) throw new Error("Model row controls are missing");
        return {
          row: getComputedStyle(row).backgroundColor,
          model: getComputedStyle(element).backgroundColor,
          favorite: getComputedStyle(favorite).backgroundColor,
        };
      });
      assert.notEqual(rowBackgrounds.row, rowBackgrounds.model);
      assert.equal(rowBackgrounds.model, rowBackgrounds.favorite);
      assert.equal(await models.getByText("Other Harness", { exact: true }).count(), 0);
      if (width >= 600) {
        const modelPanel = page.getByRole("group", { name: "Model", exact: true });
        const [modelBounds, thinkingBounds, triggerBounds] = await Promise.all([
          modelPanel.boundingBox(),
          thinking.boundingBox(),
          modelTrigger.boundingBox(),
        ]);
        assert.ok(
          modelBounds && thinkingBounds && modelBounds.x + modelBounds.width <= thinkingBounds.x,
        );
        assert.ok(modelBounds.width >= 260 && modelBounds.width <= 268);
        assert.ok(triggerBounds && thinkingBounds);
        const triggerGap = triggerBounds.y - (thinkingBounds.y + thinkingBounds.height);
        assert.ok(triggerGap >= 4 && triggerGap <= 12, `Thinking card gap was ${triggerGap}px`);
      } else {
        assert.equal(await thinking.isVisible(), false);
        await page.getByRole("button", { name: "Back to Thinking", exact: true }).waitFor();
      }
      assert.equal(
        await page.getByRole("menuitemradio", { name: "Fake Model", exact: true }).count(),
        0,
      );
      const favorite = page.getByRole("menuitem", {
        name: "Favorite model Other Alternate",
        exact: true,
      });
      await favorite.click();
      await page
        .getByRole("menuitem", {
          name: "Remove model Other Alternate from favorites",
          exact: true,
        })
        .waitFor();
      await screenshot(page, `harness-models-${width}`);
      await page.getByRole("menuitemradio", { name: "Other Alternate", exact: true }).click();
      const alternateModelTrigger = page.getByRole("button", {
        name: "Select model, current Other Alternate, reasoning effort High",
        exact: true,
      });
      await alternateModelTrigger.waitFor();
      // The selection projection can update the caption before the RPC settles.
      await models.waitFor({ state: "hidden" });
      await thinking.waitFor({ state: "hidden" });
      assert.equal(await alternateModelTrigger.getAttribute("aria-expanded"), "false");
      assert.equal(
        await alternateModelTrigger.evaluate((element) => element === document.activeElement),
        true,
      );
      await alternateModelTrigger.click();
      await thinking.getByRole("menuitemradio", { name: "Low", exact: true }).click();
      await page
        .getByRole("button", {
          name: "Select model, current Other Alternate, reasoning effort Low",
          exact: true,
        })
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
        .getByRole("button", {
          name: "Select model, current Other Alternate, reasoning effort Low",
          exact: true,
        })
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
