import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import {
        mountComposerAgentControl,
        reconcileComposerNativeControls,
        disposeComposerAgentControl,
      } from "./packages/renderer-extension/src/renderer-composer-dom.ts";

      globalThis.setupNativeModels = (kind, ambiguous = false) => {
        const modelButton = () => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Native Model";
          button.setAttribute("aria-haspopup", "menu");
          button.setAttribute("data-composer-navigation-target", "reasoning");
          if (kind === "legacy") button.setAttribute("data-codex-intelligence-trigger", "true");
          else Object.defineProperty(button, "__reactFiber$fixture", {
            value: { memoizedProps: {}, return: { memoizedProps: {
              onSelectModel() {}, onCommitPower() {}, reasoningEffort: "high", powerSelections: [],
            }, return: null } },
          });
          return button;
        };
        const controls = ["first", "second"].map(id => {
          const composer = document.createElement("div");
          composer.id = id;
          composer.setAttribute("data-codex-composer-root", "true");
          const editor = document.createElement("div");
          editor.contentEditable = "true";
          editor.setAttribute("role", "textbox");
          const toolbar = document.createElement("div");
          const send = document.createElement("button");
          send.type = "submit";
          send.textContent = "Send";
          toolbar.append(modelButton(), send);
          if (ambiguous && id === "first") toolbar.prepend(modelButton());
          composer.append(editor, toolbar);
          document.body.append(composer);
          const noop = () => {};
          return mountComposerAgentControl(
            composer, id, send, ["codex", "pi"], noop, noop, noop, noop, noop, noop, noop,
          );
        });
        globalThis.nativeModelFixture = {
          select(index, external) {
            reconcileComposerNativeControls(controls[index], external, external);
          },
          replace() {
            const previous = controls[0].nativeModelControl.element;
            previous.replaceWith(modelButton());
            this.select(0, true);
            return { hidden: previous.hidden, ariaHidden: previous.getAttribute("aria-hidden") };
          },
          dispose(index) { disposeComposerAgentControl(controls[index]); },
        };
        globalThis.nativeModelFixture.select(0, true);
        globalThis.nativeModelFixture.select(1, false);
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Native Model regression bundle was not generated");

for (const kind of ["legacy", "power"]) {
  test(`${kind} native Models hide, restore and survive replacement per Composer`, async ({
    page,
  }) => {
    await page.setContent("<!doctype html><body></body>");
    await page.addScriptTag({ content: browserBundle });
    await page.evaluate((kind) => Reflect.get(globalThis, "setupNativeModels")(kind), kind);
    const first = page.locator('#first button[data-composer-navigation-target="reasoning"]');
    const second = page.locator('#second button[data-composer-navigation-target="reasoning"]');
    await expect(first).toBeHidden();
    await expect(first).toHaveAttribute("aria-hidden", "true");
    await expect(second).toBeVisible();

    await page.evaluate(() => {
      const fixture = Reflect.get(globalThis, "nativeModelFixture");
      fixture.select(0, false);
      fixture.select(1, true);
    });
    await expect(first).toBeVisible();
    await expect(first).not.toHaveAttribute("aria-hidden");
    await expect(second).toBeHidden();

    const restoredPrevious = await page.evaluate(() => {
      const fixture = Reflect.get(globalThis, "nativeModelFixture");
      fixture.select(0, true);
      return fixture.replace();
    });
    expect(restoredPrevious).toEqual({ hidden: false, ariaHidden: null });
    await expect(first).toBeHidden();
    await expect(first).toHaveAttribute("aria-hidden", "true");
    await expect(second).toBeHidden();

    await page.evaluate(() => Reflect.get(globalThis, "nativeModelFixture").dispose(0));
    await expect(first).toBeVisible();
    await expect(first).not.toHaveAttribute("aria-hidden");
    await expect(second).toBeHidden();
    await page.evaluate(() => Reflect.get(globalThis, "nativeModelFixture").dispose(1));
    await expect(second).toBeVisible();
  });
}

test("ambiguous native power Model menus are not hidden", async ({ page }) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupNativeModels")("power", true));
  const candidates = page.locator('#first button[data-composer-navigation-target="reasoning"]');
  await expect(candidates).toHaveCount(2);
  await expect(candidates.nth(0)).toBeVisible();
  await expect(candidates.nth(1)).toBeVisible();
});
