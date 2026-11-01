import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountRendererModelPicker, renderRendererModelPicker } from "./packages/renderer-extension/src/renderer-model-picker.ts";
      const control = mountRendererModelPicker("favorites", (modelId) => {
        globalThis.selections += 1;
        view.selected = { id: modelId };
        renderRendererModelPicker(control, view, true, harnessId);
      }, () => {});
      let harnessId = "pi";
      globalThis.selections = 0;
      document.body.append(control.root);
      const view = { status: "ready", catalog: { models: [
        { ref: { id: "a" }, label: "Provider / Alpha" },
        { ref: { id: "b" }, label: "Provider / Beta" },
        { ref: { id: "c" }, label: "Provider / Gamma" },
      ], thinkingOptions: [] }, selected: { id: "a" } };
      globalThis.changeHarness = (id) => {
        harnessId = id;
        renderRendererModelPicker(control, view, true, id);
      };
      globalThis.changeHarness("pi");
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Model favorites test bundle was not generated");

test("favorites persist, reorder immediately, remain searchable and are Harness scoped", async ({
  page,
}) => {
  await page.route("http://favorites.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body style="display:flex;align-items:flex-end;height:100vh;margin:0"></body>',
    }),
  );
  await page.goto("http://favorites.test/");
  await page.addScriptTag({ content: bundle });
  const trigger = page.locator("[data-codexhost-model-control] > button");
  const menu = page.locator('[aria-label="Model"]');
  const models = menu.locator("button[data-model-id]");
  const ids = () =>
    models.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-model-id")));
  const betaStar = menu.locator('[data-favorite-model-id="b"]');
  await trigger.click();
  await betaStar.click();
  await expect(betaStar).toHaveAttribute("aria-pressed", "true");
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, "selections"))).toBe(0);
  expect(await ids()).toEqual(["b", "a", "c"]);
  await expect(betaStar).toBeFocused();
  await expect(betaStar).toHaveCSS("color", "rgb(245, 158, 11)");
  await expect(betaStar.locator("svg")).toHaveCSS("fill", "rgb(245, 158, 11)");
  await trigger.click();
  await trigger.click();
  expect(await ids()).toEqual(["b", "a", "c"]);
  await menu.getByRole("searchbox").fill("Gamma");
  await expect(menu.locator("button[data-model-id]:visible")).toHaveCount(1);
  await expect(menu.locator("button[data-favorite-model-id]:visible")).toHaveCount(1);
  await menu.getByRole("searchbox").fill("");
  await betaStar.focus();
  await page.keyboard.press("Space");
  await expect(betaStar).toHaveAttribute("aria-pressed", "false");
  await expect(menu).toBeVisible();
  expect(await ids()).toEqual(["a", "b", "c"]);
  await expect(betaStar).toBeFocused();
  await expect(betaStar.locator("svg")).toHaveCSS("fill", "none");
  await trigger.click();
  await trigger.click();
  expect(await ids()).toEqual(["a", "b", "c"]);
  await betaStar.click();
  await menu.locator('[data-model-id="b"]').click();
  await expect(trigger).toContainText("Provider / Beta");
  await trigger.click();
  await expect(menu.locator('[data-model-id="b"]')).toHaveAttribute("aria-checked", "true");
  await menu.locator('[data-model-id="c"]').click();
  await expect(trigger).toContainText("Provider / Gamma");
  await page.reload();
  await page.addScriptTag({ content: bundle });
  await trigger.click();
  expect(await ids()).toEqual(["b", "a", "c"]);
  await page.evaluate(() => Reflect.get(globalThis, "changeHarness")("claude"));
  await trigger.click();
  expect(await ids()).toEqual(["a", "b", "c"]);
  await expect(betaStar).toHaveAttribute("aria-pressed", "false");
  await menu.locator('[data-model-id="b"]').click();
  await expect(menu).toBeHidden();
  expect(await page.evaluate(() => Reflect.get(globalThis, "selections"))).toBe(1);
});
