import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

test.beforeEach(async ({ page }) => {
  // Renderer startup reads localStorage, so synthetic fixtures need a stable app-like origin.
  await page.route("http://renderer.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("http://renderer.test/");
});

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
      const probe = installRendererBindingProbe({
        enabledAgents: ["codex", "pi"],
        defaultAgent: "codex",
      });
      let policyRebinding = false;
      let applyCalls = 0;
      probe.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        undefined,
        () => {
          applyCalls += 1;
          return !policyRebinding;
        },
        null,
      );
      globalThis.setSyntheticPolicyRebinding = (value) => { policyRebinding = value; };
      globalThis.readSyntheticApplyCalls = () => applyCalls;
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-chat-composer-isolation-e2e-entry.ts",
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
if (typeof browserBundle !== "string") {
  throw new Error("Renderer Chat isolation E2E bundle was not generated");
}

async function installChatComposer(page: Page, script: string): Promise<void> {
  await page.setContent(`
    <!doctype html>
    <body>
      <form data-chat-composer>
        <div contenteditable="true" role="textbox">draft</div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
    </body>
  `);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
}

async function dispatchInputIntents(page: Page): Promise<unknown> {
  return page.locator('[role="textbox"]').evaluate((editor) => {
    const dispatch = (event: Event) => {
      const accepted = editor.dispatchEvent(event);
      return { accepted, prevented: event.defaultPrevented };
    };
    return {
      letter: dispatch(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })),
      digit: dispatch(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true })),
      backspace: dispatch(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      ),
      beforeInput: dispatch(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: "a",
          bubbles: true,
          cancelable: true,
        }),
      ),
      paste: dispatch(
        new ClipboardEvent("paste", {
          clipboardData: new DataTransfer(),
          bubbles: true,
          cancelable: true,
        }),
      ),
      compositionStart: dispatch(
        new CompositionEvent("compositionstart", { data: "", bubbles: true, cancelable: true }),
      ),
      compositionBeforeInput: dispatch(
        new InputEvent("beforeinput", {
          inputType: "insertCompositionText",
          data: "中",
          bubbles: true,
          cancelable: true,
        }),
      ),
      compositionInput: dispatch(
        new InputEvent("input", {
          inputType: "insertCompositionText",
          data: "中",
          bubbles: true,
          cancelable: true,
        }),
      ),
      compositionEnd: dispatch(
        new CompositionEvent("compositionend", {
          data: "中",
          bubbles: true,
          cancelable: true,
        }),
      ),
    };
  });
}

const unmodifiedInputResults = {
  letter: { accepted: true, prevented: false },
  digit: { accepted: true, prevented: false },
  backspace: { accepted: true, prevented: false },
  beforeInput: { accepted: true, prevented: false },
  paste: { accepted: true, prevented: false },
  compositionStart: { accepted: true, prevented: false },
  compositionBeforeInput: { accepted: true, prevented: false },
  compositionInput: { accepted: true, prevented: false },
  compositionEnd: { accepted: true, prevented: false },
};

test("a Codex composer keeps draft typing usable while its Host policy rebinds", async ({
  page,
}) => {
  await page.setContent(`
    <!doctype html>
    <body>
      <form data-codex-composer-root>
        <div data-above-composer-portal></div>
        <div data-codex-composer contenteditable="true" role="textbox">draft</div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
    </body>
  `);
  await page.locator("[data-codex-composer-root]").evaluate((composer) => {
    const draft = { isManuallyChanged: false, modelSettings: null, serviceTier: null };
    const draftAtom = { get: () => draft };
    Object.defineProperty(composer, "__reactFiber$rebind", {
      configurable: true,
      value: {
        updateQueue: {
          memoCache: {
            data: [
              [{}, {}, "client-new-thread:rebind", draftAtom, undefined, draftAtom, draftAtom],
            ],
          },
        },
        return: null,
      },
    });
  });
  await page.addScriptTag({ content: browserBundle });
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);

  const callsBeforeRebind = await page.evaluate(() => {
    const read = Reflect.get(globalThis, "readSyntheticApplyCalls");
    if (typeof read !== "function") throw new Error("Synthetic apply counter is unavailable");
    const toggle = Reflect.get(globalThis, "setSyntheticPolicyRebinding");
    if (typeof toggle !== "function") throw new Error("Synthetic rebind toggle is unavailable");
    toggle(true);
    return read();
  });
  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const read = Reflect.get(globalThis, "readSyntheticApplyCalls");
        return typeof read === "function" ? read() : -1;
      }),
    )
    .toBeGreaterThan(callsBeforeRebind);

  const enter = await page.locator('[role="textbox"]').evaluate((editor) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    return { accepted: editor.dispatchEvent(event), prevented: event.defaultPrevented };
  });
  expect(enter).toEqual({ accepted: false, prevented: true });
});

test("ordinary Chat composers remain untouched", async ({ page }) => {
  await installChatComposer(page, browserBundle);

  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-model-control]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-permission-mode-control]")).toHaveCount(0);
  await expect(page.locator("[data-chat-composer] button[type=submit]")).toBeEnabled();

  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
});

test("a composer stops affecting input when the Codex marker is removed", async ({ page }) => {
  await page.setContent(`
    <!doctype html>
    <body>
      <form data-codex-composer-root data-mode="work">
        <div contenteditable="true" role="textbox">draft</div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
    </body>
  `);
  await page.addScriptTag({ content: browserBundle });
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);

  await page.locator("[data-mode=work]").evaluate((composer) => {
    composer.removeAttribute("data-codex-composer-root");
    composer.setAttribute("data-chat-composer", "true");
    composer.setAttribute("data-mode", "chat");
  });

  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator("[data-mode=chat] button[type=submit]")).toBeEnabled();
  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
});
