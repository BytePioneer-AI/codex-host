/** Native permission and sidebar identity acceptance, with scripted CLI-free Harnesses only. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { startServer } from "../support/server.ts";

const root = resolve(import.meta.dirname, "../..");
const composer = "Describe what you want to build, / commands, @ files or sessions";
async function shot(page: Page, name: string) {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({
    path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `${name}.png`),
    animations: name.startsWith("native-rejection") ? "allow" : "disabled",
  });
}
async function sidebar(page: Page) {
  const open = page.getByRole("button", { name: "Open sidebar", exact: true }).last();
  if (await open.isVisible()) await open.click();
}
for (const width of [390, 1280])
  it(
    `native permissions and durable row identities at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const url = await startServer(
        t,
        root,
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
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      const ask = () =>
        page.getByRole("button", { name: "Access mode, current: Ask", exact: true });
      await ask().click();
      await page.getByRole("menuitem").filter({ hasText: /^Yolo/ }).waitFor();
      assert.equal(
        await page.getByText("Skip native permission checks", { exact: true }).count(),
        1,
      );
      await shot(page, `native-modes-${width}`);
      await page.getByRole("menuitem").filter({ hasText: /^Yolo/ }).click();
      const dialog = page.getByRole("dialog", { name: "Enable Yolo?", exact: true });
      await dialog.waitFor();
      assert.equal(
        await dialog.getByRole("button", { name: "Enable mode", exact: true }).isDisabled(),
        true,
      );
      await shot(page, `native-risk-${width}`);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await ask().waitFor();
      await page.getByRole("textbox", { name: composer, exact: true }).fill("native fake");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("echo: native fake", { exact: true }).waitFor();
      await ask().click();
      await page.getByRole("menuitem", { name: "Rejected mode", exact: true }).click();
      await page
        .getByText("Permission switch failed: Native permission refusal", { exact: true })
        .waitFor();
      await ask().waitFor();
      await shot(page, `native-rejection-${width}`);
      await sidebar(page);
      await page.getByRole("img", { name: "Fake Harness", exact: true }).waitFor();
      await page
        .getByRole("button", { name: "New session", exact: true })
        .filter({ hasText: "New Session" })
        .click();
      await page
        .getByRole("button", { name: "Select Harness, current Fake Harness", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Other Harness", exact: true }).click();
      const auto = () =>
        page.getByRole("button", { name: "Access mode, current: Native Auto", exact: true });
      await auto().click();
      await page.getByText("Native classifier, not a DSH review.", { exact: true }).waitFor();
      assert.equal(await page.getByText(/Auto review/).count(), 0);
      assert.equal(await page.getByRole("menuitem").filter({ hasText: /^Ask$/ }).count(), 0);
      await shot(page, `native-other-modes-${width}`);
      await page.keyboard.press("Escape");
      await page.getByRole("textbox", { name: composer, exact: true }).fill("native other");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("echo: native other", { exact: true }).waitFor();
      assert.equal(
        await auto().isDisabled(),
        true,
        "creation-only native modes lock after opening",
      );
      await shot(page, `native-locked-${width}`);
      await sidebar(page);
      for (const name of ["Fake Harness", "Other Harness"]) {
        const icon = page.getByRole("img", { name, exact: true });
        await icon.waitFor();
        assert.equal(
          await icon.locator("img").getAttribute("src"),
          `/harness-icons/${name === "Fake Harness" ? "fake" : "other"}`,
        );
        assert.equal(
          await icon.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth > 0),
          true,
        );
      }
      await shot(page, `native-sidebar-${width}`);
      await page.getByRole("treeitem").filter({ hasText: "native fake" }).click();
      await ask().waitFor();
      await ask().click();
      await page.getByRole("menuitem").filter({ hasText: /^Yolo/ }).waitFor();
      assert.equal(
        await page.getByText("Native classifier, not a DSH review.", { exact: true }).count(),
        0,
      );
      await shot(page, `native-session-isolation-${width}`);
      await page.keyboard.press("Escape");
      await page.reload();
      await ask().waitFor();
      await sidebar(page);
      await page.getByRole("img", { name: "Fake Harness", exact: true }).waitFor();
      await page.getByRole("img", { name: "Other Harness", exact: true }).waitFor();
      await shot(page, `native-sidebar-restored-${width}`);
      assert.deepEqual(errors, []);
    },
  );
