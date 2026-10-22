/** Responsive settings acceptance against the real Web gateway and a synthetic shared Host. */
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
      const url = await startServer(t, serverRoot, ["--import", "tsx", "src/main.ts"], []);
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
