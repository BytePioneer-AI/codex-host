import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import type { mutationMayAffectComposer } from "../../packages/renderer-extension/src/renderer-binding-probe.js";
import type {
  mountComposerAgentControl,
  reconcileComposerNativeControls,
} from "../../packages/renderer-extension/src/renderer-composer-dom.js";
import type { installRendererSidebarAgentIcons } from "../../packages/renderer-extension/src/renderer-sidebar-agent-icons.js";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

type TestWindow = Window & {
  observerTest: {
    mutationMayAffectComposer: typeof mutationMayAffectComposer;
    mountComposerAgentControl: typeof mountComposerAgentControl;
    reconcileComposerNativeControls: typeof reconcileComposerNativeControls;
    installRendererSidebarAgentIcons: typeof installRendererSidebarAgentIcons;
  };
  sidebarScans: number;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mutationMayAffectComposer } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      import { mountComposerAgentControl, reconcileComposerNativeControls } from "./packages/renderer-extension/src/renderer-composer-dom.ts";
      import { installRendererSidebarAgentIcons } from "./packages/renderer-extension/src/renderer-sidebar-agent-icons.ts";
      window.observerTest = { mutationMayAffectComposer, mountComposerAgentControl, reconcileComposerNativeControls, installRendererSidebarAgentIcons };
    `,
    resolveDir: repositoryRoot,
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
if (!browserBundle) throw new Error("Observer regression bundle was not generated");

test("transcript updates skip sidebar scans and Composer reconciliation", async ({ page }) => {
  await page.setContent(`
    <aside>${Array.from({ length: 160 }, (_, i) => `<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="thread-${i}" data-app-action-sidebar-thread-host-id="local"><div data-thread-title-trigger><span data-thread-title>Thread ${i}</span></div></div>`).join("")}</aside>
    <section data-local-conversation-item-target-ids="item-1"><p>Response</p></section>
    <form data-codex-composer-root><textarea></textarea></form>
  `);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(async () => {
    const target = window as unknown as TestWindow;
    const query = document.querySelectorAll.bind(document);
    target.sidebarScans = 0;
    document.querySelectorAll = ((selector: string) => {
      if (selector === "[data-app-action-sidebar-thread-row]") target.sidebarScans += 1;
      return query(selector);
    }) as typeof document.querySelectorAll;
    target.observerTest.installRendererSidebarAgentIcons({
      getClient: () => null,
      getLocalAgent: () => "pi",
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    target.sidebarScans = 0;
  });
  await expect(page.locator("[data-codexhost-sidebar-agent-icon]")).toHaveCount(160);
  const result = await page.evaluate(async () => {
    const target = window as unknown as TestWindow;
    const transcript = document.querySelector("section");
    const composer = document.querySelector("form");
    const responseText = transcript?.querySelector("p")?.firstChild;
    if (!transcript || !composer || !responseText) throw new Error("Missing transcript fixture");
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      attributes: true,
      subtree: true,
    });
    for (let i = 0; i < 300; i += 1) transcript.append(document.createElement("span"));
    responseText.textContent = "Streamed response";
    transcript.setAttribute("hidden", "");
    const stream = observer.takeRecords().filter(target.observerTest.mutationMayAffectComposer);
    composer.append(document.createElement("button"));
    const input = observer.takeRecords().filter(target.observerTest.mutationMayAffectComposer);
    const inline = document.createElement("form");
    inline.setAttribute("data-codex-composer-root", "");
    transcript.append(inline);
    const inlineAdded = observer
      .takeRecords()
      .filter(target.observerTest.mutationMayAffectComposer);
    inline.remove();
    const inlineRemoved = observer
      .takeRecords()
      .filter(target.observerTest.mutationMayAffectComposer);
    observer.disconnect();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      stream: stream.length,
      input: input.length,
      inlineAdded: inlineAdded.length,
      inlineRemoved: inlineRemoved.length,
      scans: target.sidebarScans,
    };
  });
  expect(result).toEqual({ stream: 0, input: 1, inlineAdded: 1, inlineRemoved: 1, scans: 0 });
  await page.locator("aside").evaluate((aside) => {
    const wrapper = document.createElement("div");
    const first = aside.firstElementChild;
    if (!first) throw new Error("Missing sidebar fixture");
    const row = first.cloneNode(true) as Element;
    row.setAttribute("data-app-action-sidebar-thread-id", "new-thread");
    row.querySelector("[data-codexhost-sidebar-agent-icon]")?.remove();
    wrapper.append(row);
    aside.append(wrapper);
  });
  await expect(page.locator("[data-codexhost-sidebar-agent-icon]")).toHaveCount(161);
  expect(await page.evaluate(() => (window as unknown as TestWindow).sidebarScans)).toBeGreaterThan(
    0,
  );
});

test("restoring unchanged native attributes does not feed the observer", async ({ page }) => {
  await page.setContent(`
    <form data-codex-composer-root>
      <textarea></textarea>
      <div><button id="model" aria-hidden="false" aria-haspopup="menu" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning">Model</button><button type="submit">Send</button></div>
    </form>
  `);
  await page.addScriptTag({ content: browserBundle });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as TestWindow).observerTest;
    const composer = document.querySelector("form");
    const native = document.querySelector<HTMLButtonElement>("#model");
    const sendButton = document.querySelector<HTMLButtonElement>('[type="submit"]');
    if (!composer || !native || !sendButton) throw new Error("Missing native control fixture");
    const noop = () => {};
    const control = api.mountComposerAgentControl(
      composer,
      "composer-test",
      sendButton,
      ["codex", "pi"],
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
    );
    let notifications = 0;
    const observer = new MutationObserver(() => {
      notifications += 1;
      if (notifications < 100) api.reconcileComposerNativeControls(control, false, false);
    });
    observer.observe(native, { attributes: true, attributeFilter: ["hidden", "aria-hidden"] });
    api.reconcileComposerNativeControls(control, false, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    observer.disconnect();
    api.reconcileComposerNativeControls(control, true, true);
    const hidden = native.hidden && native.getAttribute("aria-hidden") === "true";
    api.reconcileComposerNativeControls(control, false, false);
    return {
      notifications,
      hidden,
      restored: !native.hidden && native.getAttribute("aria-hidden") === "false",
    };
  });
  expect(result).toEqual({ notifications: 0, hidden: true, restored: true });
});
