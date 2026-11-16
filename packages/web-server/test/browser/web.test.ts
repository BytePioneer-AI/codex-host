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
      const wordmark = page.locator('svg[data-codexhost-wordmark="codexhost"]');
      await wordmark.waitFor();
      assert.equal(await wordmark.getAttribute("aria-label"), "CodexHost");
      assert.equal(await wordmark.getAttribute("viewBox"), "0 0 102 17");
      const codexWord = wordmark.locator('g[data-codexhost-word="codex"]');
      const hostWord = wordmark.locator('g[data-codexhost-word="host"]');
      assert.equal(await codexWord.locator("path").count(), 5);
      const hostPlate = hostWord.locator("rect");
      const hostLabel = hostWord.locator("text");
      assert.equal(await hostWord.locator("path").count(), 0);
      assert.equal(await hostPlate.count(), 1);
      assert.equal(await hostPlate.getAttribute("rx"), "2");
      assert.equal(await hostLabel.textContent(), "HOST");
      assert.equal(await wordmark.locator("image").count(), 0);
      await wordmark.scrollIntoViewIfNeeded();
      const wordmarkBox = await wordmark.boundingBox();
      assert.ok(wordmarkBox && wordmarkBox.width === 127);
      assert.ok(wordmarkBox.x >= 0 && wordmarkBox.x + wordmarkBox.width <= viewport.width);
      const codexBox = await codexWord.boundingBox();
      const hostBox = await hostWord.boundingBox();
      assert.ok(codexBox && hostBox);
      const wordGap = hostBox.x - (codexBox.x + codexBox.width);
      assert.ok(wordGap > 10 && wordGap < 12, "the badge is separated from the codex wordmark");
      const plateBox = await hostPlate.boundingBox();
      const labelBox = await hostLabel.boundingBox();
      assert.ok(plateBox && labelBox);
      assert.ok(plateBox.y >= codexBox.y, "HOST stays beside codex rather than above it");
      assert.ok(plateBox.height / codexBox.height > 0.99, "HOST retains its full badge size");
      assert.ok(labelBox.x >= plateBox.x);
      assert.ok(labelBox.x + labelBox.width <= plateBox.x + plateBox.width);
      const lightInk = await wordmark.evaluate((element) => getComputedStyle(element).fill);
      assert.equal(lightInk, await wordmark.evaluate((element) => getComputedStyle(element).color));
      for (const path of await codexWord.locator("path").all()) {
        assert.equal(await path.evaluate((element) => getComputedStyle(element).fill), lightInk);
      }
      assert.equal(
        await hostPlate.evaluate((element) => getComputedStyle(element).fill),
        "rgb(17, 19, 24)",
      );
      assert.equal(
        await hostLabel.evaluate((element) => getComputedStyle(element).fill),
        "rgb(255, 255, 255)",
      );
      await screenshot(page, `brand-${viewport.width}`);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
      await dialog.getByRole("button", { name: "English", exact: true }).waitFor();
      const display = dialog.getByRole("region", { name: "Display & language", exact: true });
      await display.getByRole("button", { name: "English", exact: true }).waitFor();
      const languages = page.getByRole("group", { name: "Language / 语言", exact: true });
      await languages
        .getByRole("button", { name: "English", exact: true, pressed: true })
        .waitFor();
      await languages.getByRole("button", { name: "中文", exact: true }).click();
      await languages.getByRole("button", { name: "中文", exact: true, pressed: true }).waitFor();
      await page.getByRole("region", { name: "显示与语言", exact: true }).waitFor();
      await languages.getByRole("button", { name: "English", exact: true }).click();
      await languages
        .getByRole("button", { name: "English", exact: true, pressed: true })
        .waitFor();
      for (const name of ["Light", "Dark", "System"]) {
        assert.equal(await display.getByRole("button", { name, exact: true }).count(), 1);
      }
      await dialog
        .getByRole("region", { name: "Interaction & reading", exact: true })
        .getByText("Work details", { exact: true })
        .waitFor();
      for (const name of ["中文", "English", "Light", "Dark", "System", "Close"]) {
        const box = await dialog.getByRole("button", { name, exact: true }).boundingBox();
        assert.ok(box, `${name} has a visible box`);
        assert.ok(
          box.x >= 0 && box.x + box.width <= viewport.width,
          `${name} is not clipped horizontally`,
        );
      }
      const section = dialog.getByRole("region", { name: "App & notifications", exact: true });
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
      const darkInk = await wordmark.evaluate((element) => getComputedStyle(element).fill);
      assert.notEqual(darkInk, lightInk);
      assert.equal(darkInk, await wordmark.evaluate((element) => getComputedStyle(element).color));
      for (const path of await codexWord.locator("path").all()) {
        assert.equal(await path.evaluate((element) => getComputedStyle(element).fill), darkInk);
      }
      assert.equal(
        await hostPlate.evaluate((element) => getComputedStyle(element).fill),
        "rgb(242, 243, 245)",
      );
      assert.equal(
        await hostLabel.evaluate((element) => getComputedStyle(element).fill),
        "rgb(21, 21, 23)",
      );
      await screenshot(page, `brand-dark-${viewport.width}`);
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
