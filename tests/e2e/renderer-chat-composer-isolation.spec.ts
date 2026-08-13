import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

await build({
  entryPoints: [path.join(repositoryRoot, "packages/shared-contracts/src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
  outfile: path.join(repositoryRoot, "packages/shared-contracts/dist/index.js"),
});

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      installRendererBindingProbe({ enabledAgents: ["codex", "pi"], defaultAgent: "pi" });
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-chat-composer-isolation-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl" },
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Chat isolation E2E bundle was not generated");

async function installChatComposer(page: Page): Promise<void> {
  await page.setContent(`
    <!doctype html>
    <body>
      <form data-chat-composer>
        <div contenteditable="true" role="textbox">draft</div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
    </body>
  `);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => new Promise((resolve) => queueMicrotask(resolve)));
}

test("ordinary Chat composers remain untouched", async ({ page }) => {
  await installChatComposer(page);

  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-model-control]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-permission-mode-control]")).toHaveCount(0);
  await expect(page.locator("[data-chat-composer] button[type=submit]")).toBeEnabled();

  const results = await page.locator('[role="textbox"]').evaluate((editor) => {
    const dispatch = (event: Event) => {
      const accepted = editor.dispatchEvent(event);
      return { accepted, prevented: event.defaultPrevented };
    };
    return {
      backspace: dispatch(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      ),
      paste: dispatch(
        new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
      beforeInput: dispatch(
        new InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
          bubbles: true,
          cancelable: true,
        }),
      ),
    };
  });

  expect(results).toEqual({
    backspace: { accepted: true, prevented: false },
    paste: { accepted: true, prevented: false },
    beforeInput: { accepted: true, prevented: false },
  });
});
