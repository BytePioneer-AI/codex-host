// @vitest-environment jsdom
import type {
  DesktopExtensionSettingField,
  DesktopExtensionsListResult,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopExtensionBridge,
  DesktopExtensionRuntimeApiV1,
  DesktopExtensionSettingsPageContext,
} from "../../src/desktop-extension-api.js";
import {
  createDesktopExtensionHost,
  type DesktopExtensionEntry,
} from "../../src/desktop-extension-host.js";
import { createDesktopExtensionPluginPagesSource } from "../../src/settings/desktop-extension-settings-pages.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { createDefaultRendererSettingsPages } from "../../src/settings/pages.js";
import { createRendererSettingsPageRegistry } from "../../src/settings/core.js";
import {
  mountRendererSettingsShell,
  type RendererSettingsShell,
} from "../../src/settings/shell.js";

const disposables: Array<() => void | Promise<void>> = [];

if (typeof HTMLDialogElement !== "undefined") {
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
}

afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) {
    await dispose();
  }
  document.body.replaceChildren();
});

const SAMPLE_SCHEMA: readonly DesktopExtensionSettingField[] = [
  {
    key: "enabledBlur",
    type: "boolean",
    label: { en: "Enable blur", "zh-CN": "开启毛玻璃" },
    description: { en: "Soften window backdrop", "zh-CN": "柔化窗口背景" },
    default: true,
  },
  {
    key: "wallpaperUrl",
    type: "string",
    label: { en: "Wallpaper path", "zh-CN": "壁纸路径" },
    placeholder: { en: "assets/bg.png", "zh-CN": "assets/bg.png" },
    default: "assets/default.png",
  },
  {
    key: "refreshInterval",
    type: "number",
    label: { en: "Refresh interval", "zh-CN": "刷新间隔" },
    min: 5,
    max: 120,
    step: 5,
    default: 30,
  },
  {
    key: "opacity",
    type: "range",
    label: { en: "Backdrop opacity", "zh-CN": "背景透明度" },
    min: 0,
    max: 100,
    step: 5,
    default: 80,
  },
  {
    key: "preset",
    type: "select",
    label: { en: "Color preset", "zh-CN": "配色预设" },
    options: [
      { value: "nord", label: { en: "Nord", "zh-CN": "极光北欧" } },
      { value: "solar", label: { en: "Solar", "zh-CN": "暖阳" } },
    ],
    default: "nord",
  },
];

function createHarness(locale: "en" | "zh-CN" = "zh-CN") {
  const host = createDesktopExtensionHost(document);
  let settingsStore: Record<string, Record<string, unknown>> = {
    "schema-theme": {
      enabledBlur: false,
      wallpaperUrl: "assets/custom.png",
      refreshInterval: 60,
      opacity: 65,
      preset: "solar",
    },
  };
  let listResponse: DesktopExtensionsListResult = {
    configuration: { version: 1, revision: 1, enabled: [] },
    desktopConnected: true,
    diagnostics: [],
    extensions: [],
  };

  const readAsset = vi.fn(async (_id: string, path: string) => ({
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${path}`,
  }));
  const getSettings = vi.fn(async (id: string) => settingsStore[id] ?? {});
  const setSettings = vi.fn(async (id: string, values: Record<string, unknown>) => {
    settingsStore = { ...settingsStore, [id]: { ...values } };
    return settingsStore[id]!;
  });
  const invokeBackend = vi.fn(async (id: string, method: string, params?: unknown) => ({
    id,
    method,
    params,
  }));

  const bridge: DesktopExtensionBridge = {
    ready: () => true,
    sidebar: { rows: () => [], observe: () => () => undefined },
    watchTree: () => () => undefined,
    describe: () => undefined,
    openThread: vi.fn(),
    readAsset,
    getSettings,
    setSettings,
    invokeBackend,
  };
  const unbind = host.bind(bridge);

  const desktopClient = {
    listDesktopExtensions: vi.fn(async () => listResponse),
    readDesktopExtensionAsset: vi.fn(({ id, path }: { id: string; path: string }) =>
      readAsset(id, path),
    ),
    getDesktopExtensionSettings: vi.fn(async ({ id }: { id: string }) => ({
      values: await getSettings(id),
    })),
    setDesktopExtensionSettings: vi.fn(
      async ({ id, values }: { id: string; values: Record<string, unknown> }) => ({
        values: await setSettings(id, values),
      }),
    ),
    invokeDesktopExtensionBackend: vi.fn(
      async ({ id, method, params }: { id: string; method: string; params?: unknown }) => ({
        result: await invokeBackend(id, method, params),
      }),
    ),
  };

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
  const registry = createRendererSettingsPageRegistry(pages);
  const shell: RendererSettingsShell = mountRendererSettingsShell(registry, document, messages, {
    pluginPages,
  });

  disposables.push(
    () => shell.dispose(),
    () => pluginPages.dispose?.(),
    () => unbind(),
    () => host.disposeAll(),
  );

  return {
    host,
    shell,
    pluginPages,
    desktopClient,
    setSettings,
    getSettings,
    setListResponse(next: DesktopExtensionsListResult) {
      listResponse = next;
    },
    navSections() {
      return Array.from(
        shell.root.shadowRoot!.querySelectorAll<HTMLElement>(".settings-nav-section-label"),
      ).map((el) => ({ id: el.dataset.navSection, text: el.textContent }));
    },
    navButtons() {
      return Array.from(
        shell.root.shadowRoot!.querySelectorAll<HTMLButtonElement>("button.settings-nav-button"),
      );
    },
    contentRoot() {
      return shell.root.shadowRoot!.querySelector<HTMLElement>(".settings-page__content")!;
    },
  };
}

describe("Settings shell dynamic Plugins section and declarative schema form", () => {
  it("hides the Plugins section when empty, inserts it between General and Other when registered, mounts custom page, and falls back on disable", async () => {
    const harness = createHarness("zh-CN");
    harness.shell.openSettings(undefined, "desktop-extensions");

    // Empty state: Plugins section is completely hidden.
    expect(harness.navSections()).toEqual([
      { id: "general", text: "通用" },
      { id: "other", text: "其他" },
    ]);

    let mountedContext: DesktopExtensionSettingsPageContext | null = null;
    const cleanup = vi.fn();
    const customEntry: DesktopExtensionEntry = {
      id: "aurora.dashboard",
      hash: "h1",
      slots: [],
      defineScript: (define) =>
        define({
          activate(api) {
            (api as DesktopExtensionRuntimeApiV1).settings.registerPage({
              title: { en: "Aurora Studio", "zh-CN": "极光看板" },
              icon: "dashboard",
              mount(container, context) {
                mountedContext = context;
                const heading = container.ownerDocument.createElement("h2");
                heading.textContent = `Custom Studio (${context.locale})`;
                container.append(heading);
                return cleanup;
              },
            });
          },
        }),
    };

    await harness.host.reconcile([customEntry]);

    // Plugins section now sits cleanly between General and Other.
    expect(harness.navSections()).toEqual([
      { id: "general", text: "通用" },
      { id: "plugins", text: "插件" },
      { id: "other", text: "其他" },
    ]);
    const pluginButton = harness
      .navButtons()
      .find((btn) => btn.dataset.extensionId === "aurora.dashboard")!;
    expect(pluginButton).toBeDefined();
    expect(pluginButton.textContent).toBe("极光看板");

    // Clicking the plugin nav button mounts the custom page with full context.
    pluginButton.click();
    expect(harness.shell.activePageId).toBe(pluginButton.dataset.pageId);
    expect(harness.contentRoot().textContent).toContain("Custom Studio (zh-CN)");
    expect(mountedContext).not.toBeNull();
    await expect(mountedContext!.assets.readDataUrl("hero.png")).resolves.toEqual({
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,hero.png",
    });
    await expect(mountedContext!.backend.invoke("ping", { n: 1 })).resolves.toEqual({
      id: "aurora.dashboard",
      method: "ping",
      params: { n: 1 },
    });

    // Disabling the extension removes the Plugins section, cleans up the custom page, and falls back to desktop-extensions.
    await harness.host.reconcile([]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(harness.navSections()).toEqual([
      { id: "general", text: "通用" },
      { id: "other", text: "其他" },
    ]);
    expect(harness.shell.activePageId).toBe("desktop-extensions");
  });

  it("auto-generates a native preference form from manifest.settingsSchema, saves changes to storage, and jumps from detail modal Open settings button", async () => {
    const harness = createHarness("zh-CN");
    const onStorageChange = vi.fn();

    // Register a running extension that listens to storage updates but does NOT call registerPage().
    await harness.host.reconcile([
      {
        id: "schema-theme",
        hash: "h-schema",
        slots: ["appearance.theme"],
        name: { en: "Schema Theme", "zh-CN": "声明式主题" },
        settingsSchema: SAMPLE_SCHEMA,
        defineScript: (define) =>
          define({
            activate(api) {
              (api as DesktopExtensionRuntimeApiV1).storage.onChange(onStorageChange);
            },
          }),
      },
    ]);

    harness.setListResponse({
      configuration: { version: 1, revision: 2, enabled: ["schema-theme"] },
      desktopConnected: true,
      diagnostics: [],
      extensions: [
        {
          id: "schema-theme",
          enabled: true,
          status: { state: "running" },
          manifest: {
            manifestVersion: 1,
            id: "schema-theme",
            name: { en: "Schema Theme", "zh-CN": "声明式主题" },
            version: "1.0.0",
            description: { en: "Declarative theme", "zh-CN": "声明式主题扩展" },
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: ["appearance.theme"],
            settingsSchema: [...SAMPLE_SCHEMA],
          },
        },
      ],
    });

    harness.shell.openSettings(undefined, "desktop-extensions");
    await vi.waitFor(() => expect(harness.contentRoot().textContent).toContain("声明式主题"));

    // Open extension detail modal -> verify "打开设置" button appears and jumps directly to the plugin page.
    const card = harness
      .contentRoot()
      .querySelector<HTMLElement>('article[data-extension-id="schema-theme"]')!;
    card.click();

    const detailDialog = harness
      .contentRoot()
      .querySelector<HTMLDialogElement>("dialog.settings-extensions-detail-dialog")!;
    expect(detailDialog).not.toBeNull();
    const openSettingsButton = detailDialog.querySelector<HTMLButtonElement>(
      'button[data-action="open-settings"]',
    )!;
    expect(openSettingsButton).not.toBeNull();
    expect(openSettingsButton.textContent).toContain("打开设置");

    openSettingsButton.click();
    const expectedPageId = harness.pluginPages.getPageIdForExtension("schema-theme");
    expect(harness.shell.activePageId).toBe(expectedPageId);

    // Wait for initial storage values to hydrate the auto-generated form controls.
    await vi.waitFor(() => {
      const textInput = harness
        .contentRoot()
        .querySelector<HTMLInputElement>('input[data-setting-key="wallpaperUrl"]');
      expect(textInput?.value).toBe("assets/custom.png");
    });

    const boolInput = harness
      .contentRoot()
      .querySelector<HTMLInputElement>('input[data-setting-key="enabledBlur"]')!;
    const numberInput = harness
      .contentRoot()
      .querySelector<HTMLInputElement>('input[data-setting-key="refreshInterval"]')!;
    const rangeInput = harness
      .contentRoot()
      .querySelector<HTMLInputElement>('input[data-setting-key="opacity"]')!;
    const selectInput = harness
      .contentRoot()
      .querySelector<HTMLSelectElement>('select[data-setting-key="preset"]')!;

    expect(boolInput.checked).toBe(false);
    expect(numberInput.value).toBe("60");
    expect(rangeInput.value).toBe("65");
    expect(selectInput.value).toBe("solar");

    // Mutate range slider and select -> persists via RPC and fans out to extension's api.storage.onChange.
    rangeInput.value = "90";
    rangeInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(onStorageChange).toHaveBeenCalledWith(expect.objectContaining({ opacity: 90 })),
    );
    expect(harness.setSettings).toHaveBeenLastCalledWith(
      "schema-theme",
      expect.objectContaining({ opacity: 90, preset: "solar" }),
    );

    selectInput.value = "nord";
    selectInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(harness.setSettings).toHaveBeenCalledTimes(2));
    expect(harness.setSettings).toHaveBeenLastCalledWith(
      "schema-theme",
      expect.objectContaining({ opacity: 90, preset: "nord" }),
    );
  });
});
