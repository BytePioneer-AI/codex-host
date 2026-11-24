import type {
  HostExtensionCatalogEntry,
  HostExtensionsCatalogResult,
  HostExtensionsListResult,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => ({ classList: { add() {} } }),
  isRendererSettingsIconName: () => true,
}));

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import {
  createDesktopExtensionsSettingsPage,
  type RendererDesktopExtensionsClient,
} from "../../src/settings/desktop-extensions-page.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly #listeners = new Map<string, Array<(event?: unknown) => void>>();
  id = "";
  className = "";
  hidden = false;
  textContent = "";
  title = "";
  type = "";
  value = "";
  placeholder = "";
  accept = "";
  files: ArrayLike<unknown> | null = null;
  checked = false;
  disabled = false;
  open = false;
  href = "";
  target = "";
  rel = "";
  src = "";
  alt = "";
  loading = "";
  tabIndex = -1;
  parent: FakeElement | undefined;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  contains(target: unknown): boolean {
    let cursor = target instanceof FakeElement ? target : undefined;
    while (cursor) {
      if (cursor === this) return true;
      cursor = cursor.parent;
    }
    return false;
  }

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    const existing = this.#listeners.get(name) ?? [];
    existing.push(listener);
    this.#listeners.set(name, existing);
  }

  removeEventListener(name: string, listener: (event?: unknown) => void): void {
    const existing = this.#listeners.get(name);
    if (!existing) return;
    this.#listeners.set(
      name,
      existing.filter((item) => item !== listener),
    );
  }

  dispatch(name: string, event: Record<string, unknown> = {}): { stopped: boolean } {
    let stopped = false;
    const payload = {
      target: this,
      preventDefault() {},
      stopPropagation() {
        stopped = true;
      },
      ...event,
    };
    for (const listener of [...(this.#listeners.get(name) ?? [])]) {
      listener(payload);
    }
    return { stopped };
  }

  dispatchBubbling(name: string, event: Record<string, unknown> = {}): void {
    let stopped = false;
    const payload = {
      target: this,
      preventDefault() {},
      stopPropagation() {
        stopped = true;
      },
      ...event,
    };
    for (const listener of [...(this.#listeners.get(name) ?? [])]) {
      listener(payload);
    }
    let cursor = this.parent;
    while (cursor && !stopped) {
      for (const listener of [...(cursor.#listeners.get(name) ?? [])]) {
        listener(payload);
      }
      cursor = cursor.parent;
    }
  }

  append(...children: unknown[]): void {
    for (const child of children) {
      if (child instanceof FakeElement) {
        child.remove();
        child.parent = this;
      }
      this.children.push(child);
    }
  }

  replaceChildren(...children: unknown[]): void {
    for (const existing of this.children) {
      if (existing instanceof FakeElement) existing.parent = undefined;
    }
    this.children.length = 0;
    this.append(...children);
  }

  remove(): void {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.parent = undefined;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }

  click(): void {
    this.dispatch("click");
  }

  focus(): void {}
}

class FakeDocument {
  readonly storage: Map<string, string>;
  readonly defaultView: Window;
  visibilityState: DocumentVisibilityState = "visible";

  constructor(storage: Map<string, string> = new Map()) {
    this.storage = storage;
    const localStorage = {
      getItem: (key: string) => this.storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        this.storage.set(key, String(value));
      },
      removeItem: (key: string) => {
        this.storage.delete(key);
      },
    };
    this.defaultView = { localStorage } as unknown as Window;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase(), this);
  }

  createTextNode(text: string): string {
    return text;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function must<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (!(node instanceof FakeElement)) return "";
  if (node.hidden) return "";
  const nested = node.children.map(textOf).filter(Boolean).join(" ");
  return [node.textContent, nested].filter(Boolean).join(" ").trim();
}

function mountPage(
  locale: "en" | "zh-CN",
  getClient: () => RendererDesktopExtensionsClient | null,
) {
  const document = new FakeDocument();
  const content = document.createElement("div");
  const scope = new RendererSettingsPageScope();
  const page = createDesktopExtensionsSettingsPage(rendererSettingsMessages(locale), getClient);
  const cleanup = page.mount({
    content: content as unknown as HTMLElement,
    signal: scope.signal,
    runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
  });
  return {
    content,
    dispose() {
      scope.dispose();
      cleanup?.();
    },
  };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const CATALOG_TREE: HostExtensionCatalogEntry = {
  format: "codexhost",
  id: "sidebar-thread-tree",
  version: "0.2.0",
  name: { en: "Sidebar Thread Tree", "zh-CN": "侧栏委派树" },
  description: { en: "Groups delegated Threads below parent.", "zh-CN": "在侧栏归组委派子任务。" },
  details: {
    en: "Group delegated Threads cleanly.\n\nSupports live status indicators.",
    "zh-CN": "清晰归组委派子任务。\n\n支持实时状态指示。",
  },
  author: "codexhost",
  repository: "https://github.com/BytePioneer-AI/codex-host",
  stars: 1200,
  downloads: 3200,
  categories: ["interface", "workflow"],
  trustTier: "official",
  targets: ["desktop", "web"],
  apis: { desktop: 1, web: 1, page: 1 },
  screenshots: ["https://cdn.example.com/tree-preview.png", "javascript:alert(1)"],
  downloadUrl: "https://github.com/BytePioneer-AI/registry/releases/download/v1/tree.zip",
  sha256: HASH_A,
};

const CATALOG_THEME: HostExtensionCatalogEntry = {
  format: "codexhost",
  id: "nord-palette",
  version: "1.0.0",
  name: { en: "Nord Palette", "zh-CN": "极光配色" },
  description: { en: "Calm Arctic palette for sidebar.", "zh-CN": "清爽的北欧侧栏配色主题。" },
  details: { en: "Community theme tuned for dark mode.", "zh-CN": "社区维护的暗色主题配色。" },
  author: "alice-dev",
  repository: "https://github.com/alice-dev/nord-palette",
  stars: 42,
  downloads: 480,
  categories: ["appearance"],
  trustTier: "community",
  targets: ["web"],
  apis: { web: 1, backend: 1 },
  screenshots: ["https://cdn.example.com/nord-1.webp"],
  downloadUrl: "https://github.com/alice-dev/nord-palette/releases/download/v1/nord.zip",
  sha256: HASH_C,
};

function sampleInstalledList(
  overrides: Partial<HostExtensionsListResult> = {},
): HostExtensionsListResult {
  return {
    revision: 3,
    configuration: { revision: 3, enabled: ["sidebar-thread-tree"] },
    diagnostics: [],
    extensions: [
      {
        state: "valid",
        id: "sidebar-thread-tree",
        activationId: "act-tree-1",
        digest: HASH_A,
        installedAt: "2026-07-01T00:00:00.000Z",
        enabled: true,
        manifest: {
          manifestVersion: 2,
          id: "sidebar-thread-tree",
          name: { en: "Sidebar Thread Tree", "zh-CN": "侧栏委派树" },
          version: "0.1.0",
          description: { en: "Groups delegated Threads.", "zh-CN": "在侧栏归组委派子任务。" },
          author: "codexhost",
          repository: "https://github.com/BytePioneer-AI/codex-host",
          categories: ["interface", "workflow"],
          desktop: { apiVersion: 1, script: "desktop.js" },
          web: { apiVersion: 1, entry: "web.mjs" },
          page: { apiVersion: 1, entry: "page.mjs" },
        },
      },
    ],
    ...overrides,
  };
}

function sampleCatalog(
  overrides: Partial<HostExtensionsCatalogResult> = {},
): HostExtensionsCatalogResult {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-02T00:00:00.000Z",
    catalogUrl: "https://example.com/catalog.v2.json",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    cached: false,
    extensions: [CATALOG_TREE, CATALOG_THEME],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Unified Host extensions marketplace and 3-source import modal", () => {
  it("renders unified catalog.v2 entries across targets with capability badges, filters, install, update, and uninstall", async () => {
    const installedAfterAdd: HostExtensionsListResult = {
      ...sampleInstalledList(),
      revision: 4,
      configuration: { revision: 4, enabled: ["sidebar-thread-tree"] },
      extensions: [
        ...sampleInstalledList().extensions,
        {
          state: "valid",
          id: "nord-palette",
          activationId: "act-nord-1",
          digest: HASH_C,
          installedAt: "2026-07-02T00:00:00.000Z",
          enabled: false,
          manifest: {
            manifestVersion: 2,
            id: "nord-palette",
            name: CATALOG_THEME.name,
            version: "1.0.0",
            description: CATALOG_THEME.description,
            author: CATALOG_THEME.author,
            repository: CATALOG_THEME.repository,
            categories: ["appearance"],
            web: { apiVersion: 1, entry: "web.mjs" },
            backend: { apiVersion: 1, entry: "backend.mjs" },
          },
        },
      ],
    };

    const listHostExtensions = vi
      .fn<() => Promise<HostExtensionsListResult>>()
      .mockResolvedValueOnce(sampleInstalledList())
      .mockResolvedValueOnce(installedAfterAdd)
      .mockResolvedValueOnce(installedAfterAdd)
      .mockResolvedValueOnce(sampleInstalledList());

    const installHostExtension = vi.fn(async () => ({
      id: "nord-palette",
      activationId: "act-nord-1",
      digest: HASH_C,
      installedAt: "2026-07-02T00:00:00.000Z",
      manifest: {
        manifestVersion: 2 as const,
        id: "nord-palette",
        name: CATALOG_THEME.name,
        version: "1.0.0",
        description: CATALOG_THEME.description,
        web: { apiVersion: 1 as const, entry: "web.mjs" },
      },
      replaced: false,
    }));

    const updateHostExtension = vi.fn(async () => ({
      id: "sidebar-thread-tree",
      activationId: "act-tree-2",
      digest: HASH_B,
      installedAt: "2026-07-02T00:00:00.000Z",
      manifest: {
        manifestVersion: 2 as const,
        id: "sidebar-thread-tree",
        name: CATALOG_TREE.name,
        version: "0.2.0",
        description: CATALOG_TREE.description,
        desktop: { apiVersion: 1 as const, script: "desktop.js" },
      },
      replaced: true,
    }));

    const uninstallHostExtension = vi.fn(async () => ({
      id: "nord-palette",
      removed: true,
      configuration: { revision: 5, enabled: ["sidebar-thread-tree"] },
    }));

    const mounted = mountPage("zh-CN", () => ({
      listHostExtensions,
      listHostExtensionCatalog: vi.fn(async () => sampleCatalog()),
      installHostExtension,
      updateHostExtension,
      uninstallHostExtension,
    }));

    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (2)"));
    const marketTab = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    );
    marketTab.dispatch("click");

    // Marketplace shows both cross-platform and Web+Backend entries with capability badges.
    const findMarketCards = () =>
      descendants(mounted.content).filter(
        (el) => el.tagName === "article" && el.dataset.cardKind === "marketplace",
      );
    expect(findMarketCards().map((c) => c.dataset.extensionId)).toEqual([
      "sidebar-thread-tree",
      "nord-palette",
    ]);

    // Capability filter "backend" filters Marketplace to nord-palette only.
    const backendPill = must(
      descendants(mounted.content).find((el) => el.dataset.capabilityFilter === "backend"),
    );
    backendPill.dispatch("click");
    expect(findMarketCards().map((c) => c.dataset.extensionId)).toEqual(["nord-palette"]);

    // Reset capability filter to all.
    must(descendants(mounted.content).find((el) => el.dataset.capabilityFilter === "all")).dispatch(
      "click",
    );

    // Install nord-palette directly from Marketplace card.
    const installButton = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "button" &&
          el.dataset.action === "install" &&
          el.dataset.extensionId === "nord-palette",
      ),
    );
    installButton.dispatchBubbling("click");
    await vi.waitFor(() => expect(listHostExtensions).toHaveBeenCalledTimes(2));
    expect(installHostExtension).toHaveBeenCalledWith({
      source: { type: "catalog", id: "nord-palette" },
    });

    // Update sidebar-thread-tree sends expectedDigest & expectedActivationId.
    const updateButton = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "button" &&
          el.dataset.action === "update" &&
          el.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    updateButton.dispatchBubbling("click");
    await vi.waitFor(() => expect(listHostExtensions).toHaveBeenCalledTimes(3));
    expect(updateHostExtension).toHaveBeenCalledWith({
      id: "sidebar-thread-tree",
      expectedDigest: HASH_A,
      expectedActivationId: "act-tree-1",
      source: { type: "catalog", id: "sidebar-thread-tree" },
    });

    // Switch to Installed tab, open nord-palette detail modal, and confirm uninstall.
    must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "installed",
      ),
    ).dispatch("click");
    const nordCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "nord-palette",
      ),
    );
    nordCard.dispatch("click");
    const dialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    must(descendants(dialog).find((el) => el.dataset.action === "uninstall")).dispatch("click");
    must(descendants(dialog).find((el) => el.dataset.action === "confirm-uninstall")).dispatch(
      "click",
    );
    await vi.waitFor(() =>
      expect(uninstallHostExtension).toHaveBeenCalledWith({
        id: "nord-palette",
        expectedDigest: HASH_C,
      }),
    );
    mounted.dispose();
  });

  it("supports GitHub repository, local .zip, and local directory import sources", async () => {
    const installHostExtension = vi.fn(async () => ({
      id: "custom-widget",
      activationId: "act-custom-1",
      digest: HASH_B,
      installedAt: "2026-07-02T00:00:00.000Z",
      manifest: {
        manifestVersion: 2 as const,
        id: "custom-widget",
        name: { en: "Custom Widget", "zh-CN": "自定义组件" },
        version: "0.3.0",
        description: { en: "Custom", "zh-CN": "自定义" },
        page: { apiVersion: 1 as const, entry: "page.mjs" },
      },
      replaced: false,
    }));

    const mounted = mountPage("zh-CN", () => ({
      listHostExtensions: vi.fn(async () => sampleInstalledList()),
      listHostExtensionCatalog: vi.fn(async () => sampleCatalog()),
      installHostExtension,
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("已安装 (1)"));

    const openImport = () =>
      must(descendants(mounted.content).find((el) => el.dataset.action === "open-import")).dispatch(
        "click",
      );
    const findImportDialog = () =>
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-import-dialog"),
      );

    // 1) GitHub URL -> parsed into HostExtensionInstallSource { type: "github", repository, ref, subpath }
    openImport();
    const ghDialog = must(findImportDialog());
    const ghInput = must(descendants(ghDialog).find((el) => el.dataset.importField === "github"));
    ghInput.value = "https://github.com/example/custom-widget/tree/main/packages/widget";
    must(descendants(ghDialog).find((el) => el.tagName === "form")).dispatch("submit");
    await vi.waitFor(() => expect(findImportDialog()).toBeUndefined());
    expect(installHostExtension).toHaveBeenLastCalledWith({
      source: {
        type: "github",
        repository: "example/custom-widget",
        ref: "main",
        subpath: "packages/widget",
      },
    });

    // 2) Local .zip -> sends { type: "zip", base64 }
    openImport();
    const zipDialog = must(findImportDialog());
    must(descendants(zipDialog).find((el) => el.dataset.importMode === "zip")).dispatch("click");
    const fileInput = must(descendants(zipDialog).find((el) => el.dataset.importField === "zip"));
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    fileInput.files = [
      {
        name: "custom-widget.zip",
        size: zipBytes.byteLength,
        arrayBuffer: vi.fn(async () => zipBytes.buffer),
      },
    ];
    fileInput.dispatch("change");
    must(descendants(zipDialog).find((el) => el.tagName === "form")).dispatch("submit");
    await vi.waitFor(() => expect(findImportDialog()).toBeUndefined());
    expect(installHostExtension).toHaveBeenLastCalledWith({
      source: { type: "zip", base64: "UEsDBAEC" },
    });

    // 3) Local directory -> sends { type: "localDir", localDir }
    openImport();
    const dirDialog = must(findImportDialog());
    must(descendants(dirDialog).find((el) => el.dataset.importMode === "localDir")).dispatch(
      "click",
    );
    const dirInput = must(
      descendants(dirDialog).find((el) => el.dataset.importField === "localDir"),
    );
    dirInput.value = "/Users/dev/my-plugin";
    must(descendants(dirDialog).find((el) => el.tagName === "form")).dispatch("submit");
    await vi.waitFor(() => expect(findImportDialog()).toBeUndefined());
    expect(installHostExtension).toHaveBeenLastCalledWith({
      source: { type: "localDir", localDir: "/Users/dev/my-plugin" },
    });

    mounted.dispose();
  });

  it("hides stars and zero downloads on cards and hides zero stars or downloads in detail modal", async () => {
    const zeroEntry: HostExtensionCatalogEntry = {
      ...CATALOG_THEME,
      id: "zero-metrics",
      name: { en: "Zero Metrics", "zh-CN": "零指标插件" },
      stars: 0,
      downloads: 0,
    };
    const positiveEntry: HostExtensionCatalogEntry = {
      ...CATALOG_TREE,
      id: "popular-ext",
      name: { en: "Popular Ext", "zh-CN": "热门插件" },
      stars: 12,
      downloads: 88,
    };

    const mounted = mountPage("zh-CN", () => ({
      listHostExtensions: vi.fn(async () => sampleInstalledList({ extensions: [] })),
      listHostExtensionCatalog: vi.fn(async () =>
        sampleCatalog({ extensions: [zeroEntry, positiveEntry] }),
      ),
    }));

    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (2)"));
    must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    ).dispatch("click");

    const zeroCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "zero-metrics",
      ),
    );
    const popularCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "popular-ext",
      ),
    );

    // Cards never render stars; downloads render only when > 0.
    expect(
      descendants(zeroCard).some((el) => el.className.includes("settings-extensions-card__star")),
    ).toBe(false);
    expect(descendants(zeroCard).some((el) => el.dataset.metric === "downloads")).toBe(false);
    expect(
      descendants(popularCard).some((el) =>
        el.className.includes("settings-extensions-card__star"),
      ),
    ).toBe(false);
    const popularDownloads = must(
      descendants(popularCard).find((el) => el.dataset.metric === "downloads"),
    );
    expect(textOf(popularDownloads)).toContain("88");

    // Detail modal hides ★ 0 and downloads: 0, while keeping the GitHub repo link.
    zeroCard.dispatch("click");
    const zeroDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    const zeroRepoLink = must(
      descendants(zeroDialog).find((el) =>
        el.className.includes("settings-extensions-detail-modal__repo"),
      ),
    );
    expect(textOf(zeroRepoLink)).toContain("GitHub");
    expect(
      descendants(zeroDialog).some((el) =>
        el.className.includes("settings-extensions-detail-modal__repo-stars"),
      ),
    ).toBe(false);
    expect(descendants(zeroDialog).some((el) => el.dataset.metric === "downloads")).toBe(false);
    zeroDialog.dispatch("cancel");

    // Detail modal shows ★ N and downloads when both are > 0.
    popularCard.dispatch("click");
    const popularDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    const repoStars = must(
      descendants(popularDialog).find((el) =>
        el.className.includes("settings-extensions-detail-modal__repo-stars"),
      ),
    );
    expect(textOf(repoStars)).toContain("12");
    const modalDownloads = must(
      descendants(popularDialog).find((el) => el.dataset.metric === "downloads"),
    );
    expect(textOf(modalDownloads)).toContain("88");

    mounted.dispose();
  });
});
