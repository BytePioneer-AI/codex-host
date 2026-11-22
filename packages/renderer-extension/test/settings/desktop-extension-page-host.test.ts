// @vitest-environment jsdom
import {
  HOST_EXTENSION_PAGE_API_VERSION,
  HOST_EXTENSION_PAGE_CSS_VARIABLES,
  type HostExtensionPageApi,
  type HostExtensionsListResult,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDesktopExtensionHost } from "../../src/desktop-extension-host.js";
import { moduleEntry } from "../fixtures/desktop-extension-modules.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { createDesktopExtensionPageHost } from "../../src/settings/desktop-extension-page-host.js";
import {
  createDesktopExtensionsSettingsPage,
  type RendererDesktopExtensionsClient,
} from "../../src/settings/desktop-extensions-page.js";
import type { HostExtensionValidItem } from "../../src/settings/desktop-extensions-shared.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

function must<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function makePageItem(overrides: Partial<HostExtensionValidItem> = {}): HostExtensionValidItem {
  return {
    state: "valid",
    id: "notes-board",
    activationId: "act-notes-1",
    digest: "d".repeat(64),
    installedAt: "2026-07-01T00:00:00.000Z",
    enabled: true,
    backendState: "running",
    manifest: {
      manifestVersion: 2,
      id: "notes-board",
      name: { en: "Notes Board", "zh-CN": "笔记看板" },
      version: "1.2.0",
      description: { en: "Cross-platform notes page", "zh-CN": "跨端笔记独立页面" },
      categories: ["workflow"],
      page: {
        apiVersion: 1,
        entry: "page/index.mjs",
        style: "page/style.css",
        title: { en: "Notes Workspace", "zh-CN": "笔记工作台" },
      },
      backend: {
        apiVersion: 1,
        entry: "backend/index.mjs",
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  delete window.__codexhostDesktopExtensionsV1;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Desktop standalone extension page host", () => {
  it("waits for the injected generation and mounts page.entry + page.style in Shadow DOM with CSS variables, full HostExtensionPageApi, and cleans up on close/disable/generation change", async () => {
    const readHostExtensionAsset = vi.fn(async ({ path }: { path: string }) => {
      if (path === "page/style.css") {
        return {
          mimeType: "text/css",
          base64: toBase64(".note-card { color: var(--cx-page-accent); }"),
          digest: "d".repeat(64),
        };
      }
      return {
        mimeType: "image/png",
        base64: "iVBORw0KGgo=",
        digest: "d".repeat(64),
      };
    });

    let storedSettings: JsonObject = { theme: "warm" };
    let settingsRev = 1;
    const getHostExtensionSettings = vi.fn(async () => ({
      settingsRevision: settingsRev,
      values: { ...storedSettings },
    }));
    const setHostExtensionSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("settings revision conflict"))
      .mockImplementation(async ({ values }: { values: JsonObject }) => {
        settingsRev += 1;
        storedSettings = { ...values };
        return { settingsRevision: settingsRev, values: { ...storedSettings } };
      });
    const invokeHostExtensionBackend = vi.fn(async ({ method, params }) => ({
      result: { ok: true, method, params },
    }));

    const disposerV1 = vi.fn();
    const disposerV2 = vi.fn();
    const capturedApis: HostExtensionPageApi[] = [];
    const importModule = vi
      .fn()
      .mockResolvedValueOnce({
        mount(root: HTMLElement, api: HostExtensionPageApi) {
          capturedApis.push(api);
          const heading = root.ownerDocument.createElement("h3");
          heading.className = "note-card";
          heading.textContent = `Mounted v1 (${api.hostTarget})`;
          root.append(heading);
          return disposerV1;
        },
      })
      .mockResolvedValueOnce({
        mount(root: HTMLElement, api: HostExtensionPageApi) {
          capturedApis.push(api);
          const heading = root.ownerDocument.createElement("h3");
          heading.textContent = "Mounted v2";
          root.append(heading);
          return disposerV2;
        },
      });

    const host = document.createElement("div");
    document.body.append(host);
    const parentAbort = new AbortController();
    const onClose = vi.fn();

    const controller = createDesktopExtensionPageHost({
      document,
      host,
      signal: parentAbort.signal,
      messages: rendererSettingsMessages("zh-CN"),
      getClient: () => ({
        readHostExtensionAsset,
        getHostExtensionSettings,
        setHostExtensionSettings,
        invokeHostExtensionBackend,
      }),
      onClose,
    });

    const itemV1 = makePageItem();
    const runtime = installDesktopExtensionHost(window);
    const create = async () => ({ namespace: await importModule() });
    controller.open(itemV1);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(importModule).not.toHaveBeenCalled();
    await runtime.reconcile([], [moduleEntry("page", itemV1, create)]);
    await vi.waitFor(() => expect(capturedApis).toHaveLength(1));
    // Only page.style is read via asset RPC; page.entry came from the injected table.
    expect(readHostExtensionAsset).toHaveBeenCalledTimes(1);
    expect(readHostExtensionAsset).toHaveBeenCalledWith({
      id: "notes-board",
      activationId: "act-notes-1",
      digest: "d".repeat(64),
      path: "page/style.css",
    });

    // Verify Shadow DOM contains HOST_EXTENSION_PAGE_CSS_VARIABLES + page.style CSS + mounted DOM.
    const shadowHost = must(
      host.querySelector<HTMLElement>("[data-extension-page-host='notes-board']"),
    );
    const shadowRoot = must(shadowHost.shadowRoot, "page shadowRoot");
    const styleText = Array.from(shadowRoot.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    for (const cssVar of Object.values(HOST_EXTENSION_PAGE_CSS_VARIABLES)) {
      expect(styleText).toContain(cssVar);
    }
    expect(styleText).toContain(".note-card { color: var(--cx-page-accent); }");
    expect(shadowRoot.textContent).toContain("Mounted v1 (desktop)");

    // Verify HostExtensionPageApi contract surface.
    const api = must(capturedApis[0]);
    expect(api.id).toBe("notes-board");
    expect(api.apiVersion).toBe(HOST_EXTENSION_PAGE_API_VERSION);
    expect(api.hostTarget).toBe("desktop");
    expect(api.locale).toBe("zh-CN");
    expect(api.signal.aborted).toBe(false);

    // assets.url returns data: URL fetched via codexhost/extensions/asset.
    await expect(api.assets.url("assets/icon.png")).resolves.toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );

    // storage.get / set (with revision conflict auto-retry) / onChange.
    const onStorageChange = vi.fn();
    api.storage.onChange(onStorageChange);
    await expect(api.storage.get()).resolves.toEqual({ theme: "warm" });
    await expect(api.storage.set({ theme: "cool" })).resolves.toEqual({ theme: "cool" });
    expect(setHostExtensionSettings).toHaveBeenCalledTimes(2);
    expect(onStorageChange).toHaveBeenCalledWith({ theme: "cool" });

    // External settings change pushes to page subscribers.
    controller.notifySettingsChanged("notes-board", { theme: "midnight" }, 5);
    expect(onStorageChange).toHaveBeenLastCalledWith({ theme: "midnight" });

    // backend.invoke delegates to codexhost/extensions/backend/invoke when manifest.backend exists.
    await expect(api.backend.invoke("notes.list", { limit: 10 })).resolves.toEqual({
      ok: true,
      method: "notes.list",
      params: { limit: 10 },
    });

    // Generation change (new activationId) aborts v1 signal, calls disposerV1, and remounts v2.
    const itemV2 = makePageItem({ activationId: "act-notes-2" });
    await runtime.reconcile([], [moduleEntry("page", itemV2, create)]);
    expect(api.signal.aborted).toBe(true);
    controller.sync([itemV2]);
    await vi.waitFor(() => expect(capturedApis).toHaveLength(2));
    expect(api.signal.aborted).toBe(true);
    expect(disposerV1).toHaveBeenCalledTimes(1);
    expect(disposerV2).not.toHaveBeenCalled();

    // Disabling the extension via sync() aborts v2 signal, calls disposerV2, and invokes onClose.
    const apiV2 = must(capturedApis[1]);
    controller.sync([makePageItem({ activationId: "act-notes-2", enabled: false })]);
    expect(apiV2.signal.aborted).toBe(true);
    expect(disposerV2).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(controller.isOpen).toBe(false);

    controller.dispose();
  });

  it("discards a waiting sidebar page when its settings scope is aborted", async () => {
    const host = document.createElement("div");
    const scope = new RendererSettingsPageScope();
    const item = makePageItem();
    const mount = vi.fn();
    const runtime = installDesktopExtensionHost(window);
    const create = vi.fn(async () => ({ namespace: { mount } }));
    const controller = createDesktopExtensionPageHost({
      document,
      host,
      signal: scope.signal,
      messages: rendererSettingsMessages("en"),
      getClient: () => ({
        readHostExtensionAsset: async () => ({
          mimeType: "text/css",
          base64: "",
          digest: item.digest,
        }),
      }),
    });
    controller.open(item);
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector("[data-action=page-back]")).toBeNull();

    scope.dispose();
    await runtime.reconcile([], [moduleEntry("page", item, create)]);
    expect(create).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(host.childElementCount).toBe(0);
    controller.dispose();
  });

  it("mounts without readHostExtensionAsset when page.style is omitted, rejects backend.invoke clearly without manifest.backend, and isolates mount errors", async () => {
    const invokeHostExtensionBackend = vi.fn();

    let capturedApi: HostExtensionPageApi | null = null;
    const create = vi.fn(async () => ({
      namespace: {
        mount(_root: HTMLElement, api: HostExtensionPageApi) {
          if (capturedApi) throw new Error("Module mount failed");
          capturedApi = api;
        },
      },
    }));

    const noBackendItem = makePageItem({
      id: "pure-page",
      activationId: "act-pure-1",
      digest: "e".repeat(64),
      manifest: {
        manifestVersion: 2,
        id: "pure-page",
        name: { en: "Pure Page", "zh-CN": "纯页面" },
        version: "1.0.0",
        description: { en: "No backend", "zh-CN": "无后台" },
        page: { apiVersion: 1, entry: "page.mjs" },
      },
    });

    const runtime = installDesktopExtensionHost(window);
    await runtime.reconcile([], [moduleEntry("page", noBackendItem, create)]);
    const listResult: HostExtensionsListResult = {
      revision: 1,
      configuration: { revision: 1, enabled: ["pure-page"] },
      diagnostics: [],
      extensions: [noBackendItem],
    };

    // Intentionally omit readHostExtensionAsset to prove page without page.style mounts cleanly.
    const client: RendererDesktopExtensionsClient = {
      listHostExtensions: vi.fn(async () => listResult),
      invokeHostExtensionBackend,
    };

    const content = document.createElement("div");
    document.body.append(content);
    const scope = new RendererSettingsPageScope();
    const page = createDesktopExtensionsSettingsPage(rendererSettingsMessages("en"), () => client);
    const cleanup = page.mount({
      content,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    await vi.waitFor(() => expect(content.textContent).toContain("Pure Page"));
    const openPageButton = must(
      content.querySelector<HTMLButtonElement>('button[data-action="open-page"]'),
    );
    openPageButton.click();

    await vi.waitFor(() => expect(capturedApi).not.toBeNull());
    await expect(must<HostExtensionPageApi>(capturedApi).backend.invoke("ping")).rejects.toThrow(
      /does not declare a backend/i,
    );
    expect(invokeHostExtensionBackend).not.toHaveBeenCalled();

    // Reload mounts the cached namespace again and reports a mount error.
    const reloadButton = must(
      content.querySelector<HTMLButtonElement>('button[data-action="page-reload"]'),
    );
    reloadButton.click();
    await vi.waitFor(() => expect(content.textContent).toContain("Module mount failed"));
    expect(runtime.modules.status()["pure-page:page"]).toMatchObject({
      state: "failed",
      error: "Module mount failed",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(content.querySelector('[role="alert"]')).not.toBeNull();

    // Clicking back returns cleanly to the unified list view.
    const backButton = must(
      content.querySelector<HTMLButtonElement>('button[data-action="page-back"]'),
    );
    backButton.click();
    expect(content.querySelector<HTMLElement>(".settings-extensions__list-view")?.hidden).toBe(
      false,
    );

    scope.dispose();
    cleanup?.();
  });
});
