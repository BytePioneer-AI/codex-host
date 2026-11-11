/** Settings integration with simulated browser install events, not an OS installation. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { expect } from "@playwright/test";
import { chromium } from "playwright";
import { startServer } from "../support/server.ts";

for (const width of [320, 1280]) {
  it(
    `offers PWA installation in General Settings at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        [],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript({
        content: `
        window.addEventListener("load", () => {
          const choice = Promise.withResolvers();
          const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
            userChoice: choice.promise,
            prompt: () => {
              document.documentElement.dataset.installPromptCount = String(
                Number(document.documentElement.dataset.installPromptCount ?? "0") + 1,
              );
              choice.resolve({ outcome: "dismissed" });
              return Promise.resolve();
            },
          });
          window.dispatchEvent(event);
          document.documentElement.dataset.installOfferCaptured = String(event.defaultPrevented);
        });
      `,
      });
      await page.goto(url);
      await page
        .getByRole("textbox", {
          name: "Describe what you want to build, / commands, @ files or sessions",
          exact: true,
        })
        .waitFor();
      assert.deepEqual(errors, []);
      await expect(page.locator("html")).toHaveAttribute("data-install-offer-captured", "true");
      assert.equal(await page.locator("html").getAttribute("data-install-prompt-count"), null);
      if (width < 600)
        await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      const general = settings.getByRole("region", { name: "App & notifications", exact: true });
      await expect(settings.getByRole("region").first()).toHaveAccessibleName(
        "App & notifications",
      );
      await expect(general.getByText("Notifications", { exact: true })).toHaveCount(1);
      await expect(settings.getByText("Install CodexHost app", { exact: true })).toHaveCount(1);
      const install = general.getByRole("button", { name: "Install app", exact: true });
      await install.scrollIntoViewIfNeeded();
      const box = await install.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width);
      assert.ok(box.height >= 44);
      await install.click();
      await expect(general).toContainText("Installation cancelled.");
      assert.equal(await page.locator("html").getAttribute("data-install-prompt-count"), "1");
      const help = general.getByRole("button", { name: "Installation guide", exact: true });
      await help.click();
      await expect(help).toHaveAttribute("aria-expanded", "true");
      await expect(general).toContainText("If opened inside WeChat or another app");
      await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
      await expect(general).toContainText("this browser has confirmed installation");
      await expect(help).toHaveCount(0);
      assert.deepEqual(errors, []);
    },
  );
}
