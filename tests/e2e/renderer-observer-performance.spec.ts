import { expect, test } from "@playwright/test";
import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
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
  sidebarReads: number;
  sidebarIcons: ReturnType<typeof installRendererSidebarAgentIcons>;
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
    <aside data-app-action-sidebar-scroll>${Array.from({ length: 1000 }, (_, i) => `<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="thread-${i}" data-app-action-sidebar-thread-host-id="local"><div data-thread-title-trigger><span data-thread-title>Thread ${i}</span></div></div>`).join("")}</aside>
    <section data-local-conversation-item-target-ids="item-1"><p>Response</p></section>
    <form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div></form>
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
    target.sidebarReads = 0;
    target.sidebarIcons = target.observerTest.installRendererSidebarAgentIcons({
      getClient: () => null,
      getLocalAgent: () => {
        target.sidebarReads += 1;
        return "pi";
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    target.sidebarScans = 0;
    target.sidebarReads = 0;
  });
  await expect(page.locator("[data-codexhost-sidebar-agent-icon]")).toHaveCount(1000);
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
    const editor = composer.querySelector('[contenteditable="true"]');
    if (!editor?.firstChild) throw new Error("Missing editor fixture");
    editor.firstChild.textContent = "IME text";
    editor.append(document.createElement("p"));
    const typing = observer.takeRecords().filter(target.observerTest.mutationMayAffectComposer);
    const inline = document.createElement("form");
    inline.setAttribute("data-codex-composer-root", "");
    transcript.append(inline);
    const inlineAdded = observer
      .takeRecords()
      .filter(target.observerTest.mutationMayAffectComposer);
    inline.removeAttribute("data-codex-composer-root");
    const identityRemoved = observer
      .takeRecords()
      .filter(target.observerTest.mutationMayAffectComposer);
    inline.setAttribute("data-codex-composer-root", "");
    const identityRestored = observer
      .takeRecords()
      .filter(target.observerTest.mutationMayAffectComposer);
    transcript.removeAttribute("hidden");
    const visibility = observer.takeRecords().filter(target.observerTest.mutationMayAffectComposer);
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
      typing: typing.length,
      identityRemoved: identityRemoved.length,
      identityRestored: identityRestored.length,
      visibility: visibility.length,
      inlineAdded: inlineAdded.length,
      inlineRemoved: inlineRemoved.length,
      scans: target.sidebarScans,
    };
  });
  expect(result).toEqual({
    stream: 0,
    input: 1,
    typing: 0,
    identityRemoved: 1,
    identityRestored: 1,
    visibility: 1,
    inlineAdded: 1,
    inlineRemoved: 1,
    scans: 0,
  });
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
  await expect(page.locator("[data-codexhost-sidebar-agent-icon]")).toHaveCount(1001);
  const appended = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const target = window as unknown as TestWindow;
    return { scans: target.sidebarScans, reads: target.sidebarReads };
  });
  expect(appended.scans).toBe(0);
  expect(appended.reads).toBeLessThanOrEqual(2); // only the new row and its own icon insertion

  // Replacing a title still repairs that row; detached rows can be reinserted and
  // keep participating in incremental observation without rescanning their peers.
  const repaired = await page.evaluate(async () => {
    const target = window as unknown as TestWindow;
    target.sidebarReads = 0;
    const row = document.querySelector("aside")?.firstElementChild;
    const trigger = row?.querySelector("[data-thread-title-trigger]");
    if (!row || !trigger) throw new Error("Missing sidebar row");
    trigger.innerHTML = "<span data-thread-title>Replaced title</span>";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const repaired = row.querySelectorAll("[data-codexhost-sidebar-agent-icon]").length;
    const reads = target.sidebarReads;
    row.remove();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    document.querySelector("aside")?.append(row);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      repaired,
      reads,
      reinserted: row.querySelectorAll("[data-codexhost-sidebar-agent-icon]").length,
      scans: target.sidebarScans,
    };
  });
  expect(repaired).toMatchObject({ repaired: 1, reinserted: 1, scans: 0 });
  expect(repaired.reads).toBeLessThanOrEqual(2);
  const cleanup = await page.evaluate(async () => {
    const target = window as unknown as TestWindow;
    const row = document.querySelector("aside")?.lastElementChild;
    if (!row) throw new Error("Missing reinserted row");
    row.removeAttribute("data-app-action-sidebar-thread-row");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const cleared = row.querySelectorAll("[data-codexhost-sidebar-agent-icon]").length;
    row.setAttribute("data-app-action-sidebar-thread-row", "");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const restored = row.querySelectorAll("[data-codexhost-sidebar-agent-icon]").length;
    target.sidebarIcons.dispose();
    return {
      cleared,
      restored,
      remaining: document.querySelectorAll("[data-codexhost-sidebar-agent-icon]").length,
    };
  });
  expect(cleanup).toEqual({ cleared: 0, restored: 1, remaining: 0 });
});

test("sidebar pagination and decoration skip Composer reconciliation, but Composer lifecycle changes still pass", async ({
  page,
}) => {
  await page.setContent(
    `<div data-app-action-sidebar-scroll><section data-app-action-sidebar-section><div data-app-action-sidebar-thread-row><span data-thread-title>Thread</span></div></section></div>`,
  );
  await page.addScriptTag({ content: browserBundle });
  const result = await page.evaluate(() => {
    const { mutationMayAffectComposer } = (window as unknown as TestWindow).observerTest;
    const sidebar = document.querySelector("[data-app-action-sidebar-scroll]");
    const section = sidebar?.querySelector("section");
    const row = section?.firstElementChild;
    const title = row?.querySelector("span");
    if (!sidebar || !section || !row || !title) throw new Error("Missing sidebar fixture");
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    const relevant = () => observer.takeRecords().filter(mutationMayAffectComposer).length;
    title.textContent = "New title";
    row.append(document.createElement("span"));
    const next = row.cloneNode(true) as Element;
    section.append(next);
    const loading = document.createElement("div");
    sidebar.append(loading);
    loading.remove();
    section.setAttribute("hidden", "");
    const sidebarOnly = relevant();
    const composer = document.createElement("form");
    composer.setAttribute("data-codex-composer-root", "");
    next.appendChild(composer);
    const composerAdded = relevant();
    section.removeAttribute("hidden");
    const ancestorVisibility = relevant();
    composer.append(document.createElement("button"));
    const composerControl = relevant();
    composer.removeAttribute("data-codex-composer-root");
    const identityRemoved = relevant();
    composer.setAttribute("data-codex-composer-root", "");
    relevant();
    next.remove();
    const composerRemoved = relevant();
    observer.disconnect();
    return {
      sidebarOnly,
      composerAdded,
      ancestorVisibility,
      composerControl,
      identityRemoved,
      composerRemoved,
    };
  });
  expect(result).toEqual({
    sidebarOnly: 0,
    composerAdded: 1,
    ancestorVisibility: 1,
    composerControl: 1,
    identityRemoved: 1,
    composerRemoved: 1,
  });
});

test("unchanged plugin refresh preserves the open Harness picker", async ({ page }) => {
  await page.setContent(`
    <form data-codex-composer-root>
      <textarea></textarea><div><button type="submit">Send</button></div>
    </form>
  `);
  await page.addScriptTag({ content: browserBundle });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as TestWindow).observerTest;
    const composer = document.querySelector("form");
    const sendButton = document.querySelector<HTMLButtonElement>('[type="submit"]');
    if (!composer || !sendButton) throw new Error("Missing Composer fixture");
    const noop = () => {};
    const plugins: HarnessPluginDescriptor[] = [
      { id: "pi" as HarnessPluginDescriptor["id"], name: "Pi", version: "1.0.0" },
    ];
    let refresh = () => {};
    const control = api.mountComposerAgentControl(
      composer,
      "composer-plugin-refresh",
      sendButton,
      ["codex", "pi"],
      noop,
      noop,
      () => queueMicrotask(() => refresh()),
      noop,
      noop,
      noop,
      noop,
    );
    control.setPlugins(plugins);
    const original = control.picker;
    // Opening the picker refreshes accounts, which renders a new catalog array.
    refresh = () => control.setPlugins([...plugins]);
    original.trigger.click();
    await Promise.resolve();
    const preservedArray = control.picker === original && original.menu.matches(":popover-open");
    // Remote presentation fallback and refreshed responses can also clone descriptors.
    control.setPlugins(structuredClone(plugins));
    const preservedDescriptors =
      control.picker === original && original.menu.matches(":popover-open");
    control.setPlugins(plugins.map((plugin) => ({ ...plugin, name: "Updated Pi" })));
    const updated =
      control.picker !== original && control.picker.menu.textContent?.includes("Updated Pi");
    control.setPlugins([]);
    const removed = control.picker.agents.length === 1 && control.picker.agents[0] === "codex";
    return { preservedArray, preservedDescriptors, updated, removed };
  });
  expect(result).toEqual({
    preservedArray: true,
    preservedDescriptors: true,
    updated: true,
    removed: true,
  });
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
