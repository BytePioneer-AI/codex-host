import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

test.beforeEach(async ({ page }) => {
  // The Renderer reads localStorage; about:blank does not provide an origin.
  await page.route("http://codexhost.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("http://codexhost.test/");
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
}

const unmodifiedInputResults = {
  backspace: { accepted: true, prevented: false },
  paste: { accepted: true, prevented: false },
  beforeInput: { accepted: true, prevented: false },
};

async function setOrbitComposer(page: Page, orbit: boolean): Promise<void> {
  await page.locator('[role="textbox"]').evaluate((editor, isOrbit) => {
    // Dot shares the Codex root marker and conversationId. Its cloud room
    // owner is well above the shared editor components in the React tree.
    let fiber: object = { memoizedProps: { isOrbit, conversationId: "dot-room" }, return: null };
    for (let depth = 0; depth < 80; depth += 1) fiber = { return: fiber };
    Object.defineProperty(editor, "__reactFiber$dot", { configurable: true, value: fiber });
  }, orbit);
}

async function nativeSubmitResults(page: Page): Promise<unknown> {
  return page.locator('[role="textbox"]').evaluate((editor) => {
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    const form = editor.closest("form");
    const send = form?.querySelector('button[type="submit"]');
    if (!form || !send) throw new Error("Missing fixture submission controls");
    // Observe propagation without navigating the fixture or submitting a real message.
    let received = 0;
    const receive = (event: Event) => {
      received += 1;
      event.preventDefault();
    };
    editor.addEventListener("keydown", receive, { once: true });
    form.addEventListener("submit", receive, { once: true });
    send.addEventListener("click", receive, { once: true });
    editor.dispatchEvent(enter);
    form.dispatchEvent(submit);
    send.dispatchEvent(click);
    return { received };
  });
}

test("dot cloud composers retain native submission despite the Codex root marker", async ({
  page,
}) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  await setOrbitComposer(page, true);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
  expect(await nativeSubmitResults(page)).toEqual({ received: 3 });
});

test("a mounted root becoming dot stops intercepting before the next scan", async ({ page }) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  await setOrbitComposer(page, false);
  await page.addScriptTag({ content: browserBundle });
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
  await setOrbitComposer(page, true);
  expect(await nativeSubmitResults(page)).toEqual({ received: 3 });
  // React changes produce DOM mutations; the same root must also lose all controls.
  await page.locator("form").evaluate((root) => root.setAttribute("aria-hidden", "false"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
  await setOrbitComposer(page, false);
  await page.locator("form").evaluate((root) => root.removeAttribute("aria-hidden"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
});

test("a pending ownership failure cannot block a root after it becomes dot", async ({ page }) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  await setOrbitComposer(page, false);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const binding = window.__codexhostRendererBindingProbeV1;
    if (!binding) throw new Error("Missing fixture binding");
    const unavailable = async () => {
      throw new Error("Unused fixture method");
    };
    const client = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "inspectThread")
            return async () => {
              await new Promise<void>((resolve) => {
                window.addEventListener("fixture:finish-ownership", () => resolve(), {
                  once: true,
                });
              });
              throw new Error("Cloud rooms are not Host Threads");
            };
          if (key === "currentHostId" || key === "clientForHost" || key === "knownHostIds")
            return undefined;
          if (typeof key === "string" && key.startsWith("subscribe")) return () => () => undefined;
          return unavailable;
        },
      },
    );
    binding.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      client as never,
    );
  });
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  await setOrbitComposer(page, true);
  // Complete the old request before cleanup. It must not render a new blocker.
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-ownership")));
  expect(await nativeSubmitResults(page)).toEqual({ received: 3 });
  await page.locator("form").evaluate((root) => root.setAttribute("aria-hidden", "false"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
});

test("ordinary Chat composers remain untouched", async ({ page }) => {
  await installChatComposer(page, browserBundle);

  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-model-control]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-permission-mode-control]")).toHaveCount(0);
  await expect(page.locator("[data-chat-composer] button[type=submit]")).toBeEnabled();

  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
});

for (const inline of [false, true]) {
  test(`a composer stops affecting input when its marker is removed (inline: ${inline})`, async ({
    page,
  }) => {
    await page.setContent(`
    <!doctype html>
    <body>
      ${inline ? '<section data-local-conversation-item-target-ids="item-1">' : ""}
      <form data-codex-composer-root data-mode="work">
        <div contenteditable="true" role="textbox">draft</div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
      ${inline ? "</section>" : ""}
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
}
