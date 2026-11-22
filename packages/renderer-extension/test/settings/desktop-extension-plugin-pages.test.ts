// @vitest-environment jsdom
import { moduleEntry } from "../fixtures/desktop-extension-modules.js";
import {
  type HostExtensionPageApi,
  type HostExtensionsListResult,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtensionRuntimeApiV1 } from "../../src/desktop-extension-api.js";
import {
  installDesktopExtensionHost,
  type DesktopExtensionEntry,
} from "../../src/desktop-extension-host.js";
import { createRendererSettingsPageRegistry } from "../../src/settings/core.js";
import { createDesktopExtensionPluginPagesSource } from "../../src/settings/desktop-extension-settings-pages.js";
import {
  CONTENT_LOCALE_STORAGE_KEY,
  type HostExtensionValidItem,
} from "../../src/settings/desktop-extensions-shared.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { createDefaultRendererSettingsPages } from "../../src/settings/pages.js";
import { mountRendererSettingsShell } from "../../src/settings/shell.js";

const disposables: Array<() => void | Promise<void>> = [];
const iconDataUrl = "data:image/png;base64,iVBORw0KGgo=";

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected value to be defined");
  return value;
}

if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
}
if (typeof HTMLDialogElement.prototype.close !== "function") {
  HTMLDialogElement.prototype.close = function close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}

afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) await dispose();
  document.body.replaceChildren();
  window.localStorage.removeItem(CONTENT_LOCALE_STORAGE_KEY);
});

function schemaExtension(id = "schema-theme"): HostExtensionValidItem {
  const name = { en: "Schema Theme", "zh-CN": "声明式主题" };
  return {
    id,
    state: "valid",
    enabled: true,
    activationId: "00000000-0000-4000-8000-000000000001",
    digest: "a".repeat(64),
    installedAt: "2026-07-01T00:00:00.000Z",
    manifest: {
      manifestVersion: 2,
      id,
      name,
      description: name,
      version: "1.0.0",
      desktop: { apiVersion: 1, script: "desktop.js" },
      settingsSchema: [
        {
          key: "opacity",
          type: "range",
          label: { en: "Opacity", "zh-CN": "不透明度" },
          min: 0,
          max: 100,
          default: 80,
        },
      ],
    },
  };
}

function pageExtension(id = "pomodoro"): HostExtensionValidItem {
  const item = schemaExtension(id);
  return {
    ...item,
    iconDataUrl,
    manifest: {
      ...item.manifest,
      name: { en: "Pomodoro", "zh-CN": "番茄钟" },
      page: {
        apiVersion: 1,
        entry: "page/index.mjs",
        title: { en: "Focus Timer", "zh-CN": "专注番茄钟" },
      },
    },
  };
}

function listing(
  extensions: HostExtensionsListResult["extensions"],
  revision = 1,
): HostExtensionsListResult {
  return {
    revision,
    configuration: {
      revision,
      enabled: extensions.filter((ext) => ext.enabled).map((ext) => ext.id),
    },
    diagnostics: [],
    extensions,
  };
}

function legacyPage(id: string, version: string, cleanup: () => void): DesktopExtensionEntry {
  return {
    id,
    hash: version,
    slots: [],
    defineScript: (define) =>
      define({
        activate(api) {
          (api as DesktopExtensionRuntimeApiV1).settings.registerPage({
            title: { en: `Aurora ${version}`, "zh-CN": `极光 ${version}` },
            icon: "dashboard",
            mount(container, context) {
              container.textContent = `Custom Studio ${version} (${context.locale})`;
              return cleanup;
            },
          });
        },
      }),
  };
}

function createHarness(locale: "en" | "zh-CN" = "zh-CN") {
  const host = installDesktopExtensionHost(window);
  const unbind = host.bind({
    ready: () => true,
    sidebar: { rows: () => [], observe: () => () => undefined },
    watchTree: () => () => undefined,
    describe: () => undefined,
    openThread: vi.fn(),
  });
  let listResponse = listing([]);
  let storedValues: JsonObject = { opacity: 65 };
  let settingsRevision = 1;
  const desktopClient = {
    listHostExtensions: async () => listResponse,
    getHostExtensionSettings: async () => ({ settingsRevision, values: storedValues }),
    setHostExtensionSettings: vi.fn(async ({ values }: { values: JsonObject }) => {
      storedValues = values;
      return { settingsRevision: ++settingsRevision, values };
    }),
  };
  const mountedPages: Array<{ api: HostExtensionPageApi; cleanup: ReturnType<typeof vi.fn> }> = [];
  const modulesFor = (next: HostExtensionsListResult) =>
    next.extensions.flatMap((item) => {
      if (item.state !== "valid" || !item.enabled || !item.manifest.page) return [];
      return [
        moduleEntry("page", item, async () => ({
          namespace: {
            mount(root: HTMLElement, api: HostExtensionPageApi) {
              root.textContent = `Standalone ${api.hostTarget} page: ${item.activationId}/${item.digest}`;
              const cleanup = vi.fn();
              mountedPages.push({ api, cleanup });
              return cleanup;
            },
          },
        })),
      ];
    });

  const messages = rendererSettingsMessages(locale);
  const pluginPages = createDesktopExtensionPluginPagesSource({
    messages,
    getHost: () => host,
    getClient: () => desktopClient,
  });
  const pages = createDefaultRendererSettingsPages(
    messages,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => desktopClient,
    pluginPages,
  );
  const shell = mountRendererSettingsShell(
    createRendererSettingsPageRegistry(pages),
    document,
    messages,
    {
      pluginPages,
    },
  );
  disposables.push(
    () => host.disposeAll(),
    unbind,
    () => pluginPages.dispose?.(),
    () => shell.dispose(),
  );

  const shadow = must(shell.root.shadowRoot);
  const content = must(shadow.querySelector<HTMLElement>(".settings-page__content"));
  return {
    host,
    shell,
    pluginPages,
    desktopClient,
    mountedPages,
    content,
    setListing(next: HostExtensionsListResult) {
      listResponse = next;
      host.modules.replace(modulesFor(next));
    },
    sync(next: HostExtensionsListResult) {
      listResponse = next;
      pluginPages.syncInstalledExtensions?.(next.extensions, next.configuration.revision);
      host.modules.replace(modulesFor(next));
    },
    navSections() {
      return Array.from(
        shadow.querySelectorAll<HTMLElement>(".settings-nav-section-label"),
        (el) => ({
          id: el.dataset.navSection,
          text: el.textContent,
        }),
      );
    },
    navButton(id: string) {
      return shadow.querySelector<HTMLButtonElement>(`button[data-extension-id="${id}"]`);
    },
    async card(id: string) {
      return vi.waitFor(() =>
        must(content.querySelector<HTMLElement>(`article[data-extension-id="${id}"]`)),
      );
    },
  };
}

describe("Settings shell plugin pages", () => {
  it("mounts the standalone page instead of schema or legacy UI and updates it in place across generations", async () => {
    const harness = createHarness();
    const standalone = pageExtension();
    const legacyCleanup = vi.fn();
    await harness.host.reconcile([legacyPage(standalone.id, "v1", legacyCleanup)]);
    harness.sync(listing([standalone]));
    harness.shell.openSettings();

    expect(harness.navSections()).toEqual([
      { id: "general", text: "通用" },
      { id: "plugins", text: "插件页面" },
      { id: "other", text: "其他" },
    ]);
    const nav = must(harness.navButton(standalone.id));
    expect(nav.textContent).toBe("专注番茄钟");
    const icon = must(nav.querySelector("img"));
    expect([icon.src, icon.width, icon.height, icon.alt]).toEqual([iconDataUrl, 16, 16, ""]);
    nav.click();
    expect(nav.getAttribute("aria-current")).toBe("page");
    expect(harness.content.querySelector(".settings-extensions-page-view h1")?.textContent).toBe(
      "专注番茄钟",
    );
    expect(
      harness.content.querySelector(".settings-extensions-page-view__version")?.textContent,
    ).toBe("v1.0.0");
    expect(
      harness.content.querySelector(".settings-extensions-page-view img")?.getAttribute("src"),
    ).toBe(iconDataUrl);
    expect(
      harness.content.querySelector(
        "[data-action=page-back], [data-settings-mode], [role=tablist]",
      ),
    ).toBeNull();

    const shadow = await vi.waitFor(() =>
      must(harness.content.querySelector("[data-extension-page-host]")?.shadowRoot),
    );
    expect(shadow.textContent).toContain(
      `Standalone desktop page: ${standalone.activationId}/${standalone.digest}`,
    );
    expect(shadow.textContent).toContain("--cx-page-bg");
    const pageId = harness.shell.activePageId;

    // Identical polls and changes to a shadowed legacy registration leave the page running.
    harness.sync(listing([{ ...standalone }]));
    await harness.host.reconcile([legacyPage(standalone.id, "v2", legacyCleanup)]);
    expect(harness.content.querySelector("[data-extension-page-host]")?.shadowRoot).toBe(shadow);

    for (const [index, updated] of [
      { ...standalone, activationId: "00000000-0000-4000-8000-000000000002" },
      {
        ...standalone,
        activationId: "00000000-0000-4000-8000-000000000002",
        digest: "b".repeat(64),
      },
    ].entries()) {
      const old = must(harness.mountedPages.at(-1));
      harness.sync(listing([updated], index + 2));
      expect(old.api.signal.aborted).toBe(true);
      expect(old.cleanup).toHaveBeenCalledOnce();
      expect(harness.shell.activePageId).toBe(pageId);
      await vi.waitFor(() => expect(harness.mountedPages).toHaveLength(index + 2));
      expect(
        harness.content.querySelector("[data-extension-page-host]")?.shadowRoot?.textContent,
      ).toContain(`Standalone desktop page: ${updated.activationId}/${updated.digest}`);
    }

    const beforeReload = must(harness.mountedPages.at(-1));
    must(harness.content.querySelector<HTMLButtonElement>("[data-action=page-reload]")).click();
    expect(beforeReload.cleanup).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.mountedPages).toHaveLength(4));

    // The list can report uninstall before the legacy script is reclaimed.
    const beforeUninstall = must(harness.mountedPages.at(-1));
    harness.sync(listing([], 4));
    expect(beforeUninstall.api.signal.aborted).toBe(true);
    expect(beforeUninstall.cleanup).toHaveBeenCalledOnce();
    expect(legacyCleanup).not.toHaveBeenCalled();
    expect(harness.navButton(standalone.id)).toBeNull();
    expect(harness.shell.activePageId).toBe("desktop-extensions");
  });

  it("opens schema-only settings in the detail dialog without a sidebar entry", async () => {
    const harness = createHarness();
    const schemaOnly = schemaExtension();
    const onStorageChange = vi.fn();
    await harness.host.reconcile([
      {
        id: schemaOnly.id,
        hash: "v1",
        slots: [],
        settingsSchema: must(schemaOnly.manifest.settingsSchema),
        defineScript: (define) =>
          define({
            activate(api) {
              (api as DesktopExtensionRuntimeApiV1).storage.onChange(onStorageChange);
            },
          }),
      },
    ]);
    harness.setListing(listing([schemaOnly]));
    harness.shell.openSettings(undefined, "desktop-extensions");
    (await harness.card(schemaOnly.id)).click();
    expect(harness.navButton(schemaOnly.id)).toBeNull();
    expect(harness.navSections().map(({ id }) => id)).toEqual(["general", "other"]);
    const dialog = must(harness.content.querySelector("dialog[open]"));
    expect(dialog.querySelector("[data-action=open-page], [data-action=open-settings]")).toBeNull();
    const range = must(dialog.querySelector<HTMLInputElement>("input[type=range]"));
    await vi.waitFor(() => expect(range.value).toBe("65"));
    range.value = "90";
    range.dispatchEvent(new Event("change"));
    expect(harness.desktopClient.setHostExtensionSettings).toHaveBeenCalledWith({
      id: schemaOnly.id,
      expectedSettingsRevision: 1,
      values: { opacity: 90 },
    });
    await vi.waitFor(() => expect(onStorageChange).toHaveBeenCalledWith({ opacity: 90 }));
    expect(harness.shell.activePageId).toBe("desktop-extensions");
  });

  it("keeps legacy registered pages mountable and refreshes or disposes them with the legacy host", async () => {
    const harness = createHarness("en");
    const cleanupV1 = vi.fn();
    const cleanupV2 = vi.fn();
    const item = schemaExtension("aurora.dashboard");
    expect(harness.navSections().map(({ text }) => text)).toEqual(["General", "Other"]);
    await harness.host.reconcile([legacyPage(item.id, "v1", cleanupV1)]);
    harness.setListing(listing([item]));
    harness.shell.openSettings(undefined, "desktop-extensions");
    (await harness.card(item.id)).click();
    expect(harness.navSections().map(({ text }) => text)).toEqual([
      "General",
      "Plugin Pages",
      "Other",
    ]);
    must(
      harness.content.querySelector<HTMLButtonElement>("dialog[open] [data-action=open-settings]"),
    ).click();
    const pageId = must(harness.navButton(item.id)).dataset.pageId;
    expect(harness.shell.activePageId).toBe(pageId);
    expect(harness.content.textContent).toContain("Custom Studio v1 (en)");

    await harness.host.reconcile([legacyPage(item.id, "v2", cleanupV2)]);
    expect(cleanupV1).toHaveBeenCalledOnce();
    expect(harness.shell.activePageId).toBe(pageId);
    expect(harness.content.textContent).toContain("Custom Studio v2 (en)");

    await harness.host.reconcile([]);
    expect(cleanupV2).toHaveBeenCalledOnce();
    expect(harness.navButton(item.id)).toBeNull();
    expect(harness.shell.activePageId).toBe("desktop-extensions");
  });

  it.each(["card", "detail"] as const)(
    "routes Open Page from the %s to the selected sidebar page",
    async (entry) => {
      const harness = createHarness();
      const item = pageExtension();
      window.localStorage.setItem(CONTENT_LOCALE_STORAGE_KEY, "en");
      harness.setListing(listing([item]));
      harness.shell.openSettings(undefined, "desktop-extensions");
      const card = await harness.card(item.id);
      if (entry === "detail") card.click();
      const buttonScope =
        entry === "card" ? card : must(harness.content.querySelector("dialog[open]"));
      expect(buttonScope.querySelector("[data-action=open-settings]")).toBeNull();
      must(buttonScope.querySelector<HTMLButtonElement>("[data-action=open-page]")).click();

      const nav = must(harness.navButton(item.id));
      expect(harness.shell.activePageId).toBe(nav.dataset.pageId);
      expect(nav.getAttribute("aria-current")).toBe("page");
      expect(
        harness.content.querySelector("dialog[open], .settings-extensions__list-view"),
      ).toBeNull();
      expect(harness.content.querySelector("h1")?.textContent).toBe("Focus Timer");
      await vi.waitFor(() => expect(harness.mountedPages[0]?.api.locale).toBe("en"));
    },
  );

  it("uses the manifest name and puzzle icon as fallbacks and ignores stale snapshots after disable", async () => {
    const harness = createHarness();
    const base = pageExtension();
    const item: HostExtensionValidItem = {
      ...base,
      manifest: { ...base.manifest, page: { apiVersion: 1, entry: "page/index.mjs" } },
    };
    harness.sync(listing([item], 2));
    const nav = must(harness.navButton(item.id));
    must(nav.querySelector("img")).dispatchEvent(new Event("error"));
    expect(nav.querySelector("img")).toBeNull();
    expect(nav.querySelector("svg.codexhost-settings-icon")).not.toBeNull();
    expect(nav.textContent).toBe("番茄钟");
    harness.shell.openSettings(undefined, nav.dataset.pageId);
    await vi.waitFor(() => expect(harness.mountedPages).toHaveLength(1));

    harness.sync(listing([{ ...item, enabled: false }], 3));
    const { api, cleanup } = must(harness.mountedPages[0]);
    expect(api.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(harness.shell.activePageId).toBe("desktop-extensions");
    expect(harness.navButton(item.id)).toBeNull();

    harness.pluginPages.syncInstalledExtensions?.([item], 2);
    expect(harness.navButton(item.id)).toBeNull();
  });
});
