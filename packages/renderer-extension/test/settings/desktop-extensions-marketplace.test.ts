import {
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  type DesktopExtensionCatalogEntry,
  type DesktopExtensionsCatalogResult,
  type DesktopExtensionsInstallResult,
  type DesktopExtensionsListResult,
  type DesktopExtensionsUninstallResult,
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
    let cursor: FakeElement | undefined = this;
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
  readonly defaultView = {} as Window;
  visibilityState: DocumentVisibilityState = "visible";

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase(), this);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const CATALOG_TREE: DesktopExtensionCatalogEntry = {
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
  categories: ["sidebar", "workflow", "tools"],
  trustTier: "official",
  screenshots: ["https://cdn.example.com/tree-preview.png", "javascript:alert(1)"],
  downloadUrl: "https://github.com/BytePioneer-AI/registry/releases/download/v1/tree.zip",
  sha256: HASH_A,
  slots: ["sidebar.thread-layout", "sidebar.thread-badge"],
  updatedAt: "2026-06-15T00:00:00.000Z",
};

const CATALOG_BADGES: DesktopExtensionCatalogEntry = {
  id: "sidebar-delegation-badges",
  version: "0.1.0",
  name: { en: "Delegation Badges", "zh-CN": "侧栏委派角标" },
  description: { en: "Shows child badges beside icons.", "zh-CN": "在图标旁展示子任务角标。" },
  author: "codexhost",
  repository: "https://github.com/BytePioneer-AI/codex-host",
  categories: ["sidebar"],
  trustTier: "official",
  downloadUrl: "https://github.com/BytePioneer-AI/registry/releases/download/v1/badges.zip",
  sha256: HASH_B,
  slots: ["sidebar.thread-badge"],
  updatedAt: "2026-05-01T00:00:00.000Z",
};

const CATALOG_THEME: DesktopExtensionCatalogEntry = {
  id: "nord-palette",
  version: "1.0.0",
  name: { en: "Nord Palette", "zh-CN": "极光配色" },
  description: { en: "Calm Arctic palette for sidebar.", "zh-CN": "清爽的北欧侧栏配色主题。" },
  details: { en: "Community theme tuned for dark mode.", "zh-CN": "社区维护的暗色主题配色。" },
  author: "alice-dev",
  repository: "https://github.com/alice-dev/nord-palette",
  categories: ["appearance"],
  trustTier: "community",
  screenshots: ["https://cdn.example.com/nord-1.webp"],
  downloadUrl: "https://github.com/alice-dev/nord-palette/releases/download/v1/nord.zip",
  sha256: HASH_C,
  slots: [],
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function sampleInstalledList(): DesktopExtensionsListResult {
  return {
    configuration: { version: 1, revision: 3, enabled: ["sidebar-thread-tree"] },
    desktopConnected: true,
    diagnostics: [],
    extensions: [
      {
        id: "sidebar-thread-tree",
        enabled: true,
        status: { state: "running", hash: HASH_A },
        manifest: {
          manifestVersion: 1,
          id: "sidebar-thread-tree",
          name: { en: "Sidebar Thread Tree", "zh-CN": "侧栏委派树" },
          version: "0.1.0",
          description: { en: "Groups delegated Threads.", "zh-CN": "在侧栏归组委派子任务。" },
          author: "codexhost",
          repository: "https://github.com/BytePioneer-AI/codex-host",
          desktopApi: 1,
          desktop: { script: "desktop.js" },
          slots: ["sidebar.thread-layout", "sidebar.thread-badge"],
          categories: ["sidebar", "workflow"],
        },
      },
      {
        id: "sidebar-delegation-badges",
        enabled: false,
        status: { state: "disabled" },
        manifest: {
          manifestVersion: 1,
          id: "sidebar-delegation-badges",
          name: { en: "Delegation Badges", "zh-CN": "侧栏委派角标" },
          version: "0.1.0",
          description: { en: "Shows child badges.", "zh-CN": "在图标旁展示子任务角标。" },
          desktopApi: 1,
          desktop: { script: "desktop.js" },
          slots: ["sidebar.thread-badge"],
          categories: ["sidebar"],
        },
      },
    ],
  };
}

function sampleCatalog(
  overrides: Partial<DesktopExtensionsCatalogResult> = {},
): DesktopExtensionsCatalogResult {
  return {
    catalogUrl: "https://example.com/catalog.json",
    source: "remote",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    cached: false,
    extensions: [CATALOG_TREE, CATALOG_BADGES, CATALOG_THEME],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Desktop extensions marketplace, detail actions, and import modal", () => {
  it("switches between Installed and Marketplace tabs with counts, update badges, fallback notice, trust badges, category filter, and search", async () => {
    const listDesktopExtensionCatalog = vi
      .fn()
      .mockResolvedValueOnce(
        sampleCatalog({
          source: "fallback",
          error: "offline",
        }),
      )
      .mockResolvedValueOnce(sampleCatalog({ source: "remote" }));

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleInstalledList()),
      listDesktopExtensionCatalog,
      installDesktopExtension: vi.fn(),
      uninstallDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));

    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (3)"));
    expect(textOf(mounted.content)).toContain("已安装 (2)");

    // Installed tab shows lightweight update badge for sidebar-thread-tree (0.1.0 -> 0.2.0), not for badges (0.1.0 == 0.1.0).
    const treeInstalledRow = descendants(mounted.content).find(
      (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
    )!;
    const badgesInstalledRow = descendants(mounted.content).find(
      (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-delegation-badges",
    )!;
    expect(textOf(treeInstalledRow)).toContain("可更新");
    expect(textOf(badgesInstalledRow)).not.toContain("可更新");

    // Switch to Marketplace tab.
    const marketTab = descendants(mounted.content).find(
      (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
    )!;
    marketTab.dispatch("click");
    expect(marketTab.getAttribute("aria-selected")).toBe("true");

    // Fallback notice is shown above the grid and does not block browsing cards.
    const fallbackNotice = descendants(mounted.content).find((el) =>
      el.className.includes("settings-extensions-market__notice"),
    )!;
    expect(fallbackNotice).toBeDefined();
    expect(textOf(fallbackNotice)).toContain("内置官方目录");
    expect(textOf(fallbackNotice)).toContain("offline");

    // 3 marketplace cards rendered with official/community badges, max 2 categories + overflow, and zero slot chips.
    const findMarketCards = () =>
      descendants(mounted.content).filter(
        (el) => el.tagName === "article" && el.className === "settings-extensions-market-card",
      );
    const marketCards = findMarketCards();
    expect(marketCards.map((card) => card.dataset.extensionId)).toEqual([
      "sidebar-thread-tree",
      "sidebar-delegation-badges",
      "nord-palette",
    ]);

    const treeMarketCard = marketCards[0]!;
    expect(textOf(treeMarketCard)).toContain("官方");
    expect(textOf(treeMarketCard)).toContain("codexhost · v0.2.0");
    expect(textOf(treeMarketCard)).toContain("+1");
    expect(textOf(treeMarketCard)).toContain("更新");
    expect(textOf(treeMarketCard)).not.toContain("sidebar.thread-layout");
    expect(
      descendants(treeMarketCard).filter((el) =>
        el.className.includes("settings-extensions-slot-chip"),
      ),
    ).toHaveLength(0);

    const badgesMarketCard = marketCards[1]!;
    expect(textOf(badgesMarketCard)).toContain("已安装");

    const themeMarketCard = marketCards[2]!;
    expect(textOf(themeMarketCard)).toContain("社区");
    expect(textOf(themeMarketCard)).toContain("alice-dev · v1.0.0");
    expect(textOf(themeMarketCard)).toContain("安装");

    // Category filter works on Marketplace tab.
    const appearancePill = descendants(mounted.content).find(
      (el) =>
        el.className.includes("settings-extensions-filter-pill") &&
        el.dataset.category === "appearance",
    )!;
    appearancePill.dispatch("click");
    const filteredCards = findMarketCards();
    expect(filteredCards.map((c) => c.dataset.extensionId)).toEqual(["nord-palette"]);

    // Clear category pill, then search by author and category name.
    const allPill = descendants(mounted.content).find(
      (el) =>
        el.className.includes("settings-extensions-filter-pill") && el.dataset.category === "all",
    )!;
    allPill.dispatch("click");

    const searchInput = descendants(mounted.content).find(
      (el) => el.tagName === "input" && el.type === "search",
    )!;
    searchInput.value = "alice-dev";
    searchInput.dispatch("input");
    expect(findMarketCards().map((c) => c.dataset.extensionId)).toEqual(["nord-palette"]);

    // Refresh button on Marketplace tab sends forceRefresh: true and clears fallback notice.
    const refreshButton = descendants(mounted.content).find((el) =>
      el.className.includes("settings-remote__refresh"),
    )!;
    refreshButton.dispatch("click");
    await vi.waitFor(() => expect(listDesktopExtensionCatalog).toHaveBeenCalledTimes(2));
    expect(listDesktopExtensionCatalog).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-market__notice"),
      ),
    ).toBeUndefined();

    mounted.dispose();
  });

  it("installs and updates from Marketplace cards without opening detail modal, and supports detail modal uninstall with inline confirmation", async () => {
    const pendingInstall = deferred<DesktopExtensionsInstallResult>();
    const afterInstallThemeList: DesktopExtensionsListResult = {
      ...sampleInstalledList(),
      extensions: [
        ...sampleInstalledList().extensions,
        {
          id: "nord-palette",
          enabled: false,
          status: { state: "disabled" },
          manifest: {
            manifestVersion: 1,
            id: "nord-palette",
            name: CATALOG_THEME.name,
            version: "1.0.0",
            description: CATALOG_THEME.description,
            author: CATALOG_THEME.author,
            repository: CATALOG_THEME.repository,
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: [],
            categories: ["appearance"],
          },
        },
      ],
    };
    const afterUpdateTreeList: DesktopExtensionsListResult = {
      ...afterInstallThemeList,
      extensions: afterInstallThemeList.extensions.map((item) =>
        item.id === "sidebar-thread-tree" && item.manifest
          ? { ...item, manifest: { ...item.manifest, version: "0.2.0" } }
          : item,
      ),
    };
    const afterUninstallThemeList: DesktopExtensionsListResult = {
      ...afterUpdateTreeList,
      extensions: afterUpdateTreeList.extensions.filter((item) => item.id !== "nord-palette"),
    };

    const installDesktopExtension = vi
      .fn()
      .mockImplementationOnce(() => pendingInstall.promise)
      .mockResolvedValueOnce({
        extensionId: "sidebar-thread-tree",
        version: "0.2.0",
        replaced: true,
        installedPath: "/tmp/ext/sidebar-thread-tree",
        list: afterUpdateTreeList,
      } satisfies DesktopExtensionsInstallResult);

    const uninstallDesktopExtension = vi.fn(
      async (): Promise<DesktopExtensionsUninstallResult> => ({
        removedId: "nord-palette",
        list: afterUninstallThemeList,
      }),
    );

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleInstalledList()),
      listDesktopExtensionCatalog: vi.fn(async () => sampleCatalog()),
      installDesktopExtension,
      uninstallDesktopExtension,
      enableDesktopExtension: vi.fn(),
      disableDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));

    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (3)"));
    const marketTab = descendants(mounted.content).find(
      (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
    )!;
    marketTab.dispatch("click");

    // 1) Open community catalog item detail modal before installing: shows community notice, safe HTTPS screenshot only, and SHA-256 in tech details.
    const themeCard = descendants(mounted.content).find(
      (el) =>
        el.className.includes("settings-extensions-market-card") &&
        el.dataset.extensionId === "nord-palette",
    )!;
    themeCard.dispatch("click");
    const detailDialog = descendants(mounted.content).find(
      (el) => el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
    )!;
    expect(detailDialog.open).toBe(true);
    expect(textOf(detailDialog)).toContain("社区扩展，启用前建议先查看源码仓库");
    expect(textOf(detailDialog)).toContain(HASH_C);
    const modalImages = descendants(detailDialog).filter(
      (el) =>
        el.tagName === "img" && !el.className.includes("settings-extensions-detail-modal__preview"),
    );
    expect(modalImages.map((img) => img.src)).toEqual(["https://cdn.example.com/nord-1.webp"]);
    detailDialog.close();

    // 2) Click Install directly on the marketplace card: stops propagation (no modal), shows loading text & disables button.
    const installButton = descendants(mounted.content).find(
      (el) =>
        el.tagName === "button" &&
        el.dataset.action === "install" &&
        el.dataset.extensionId === "nord-palette",
    )!;
    installButton.dispatchBubbling("click");
    expect(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-detail-dialog"),
      ),
    ).toBeUndefined();
    expect(installDesktopExtension).toHaveBeenCalledWith({
      source: { type: "catalog", id: "nord-palette" },
    });

    const busyInstallButton = descendants(mounted.content).find(
      (el) =>
        el.tagName === "button" &&
        el.dataset.action === "install" &&
        el.dataset.extensionId === "nord-palette",
    )!;
    expect(busyInstallButton.disabled).toBe(true);
    expect(textOf(busyInstallButton)).toBe("安装中…");

    pendingInstall.resolve({
      extensionId: "nord-palette",
      version: "1.0.0",
      replaced: false,
      installedPath: "/tmp/ext/nord-palette",
      list: afterInstallThemeList,
    });
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("已安装 (3)"));

    // 3) Update sidebar-thread-tree from detail modal (which merges installed + catalog, blocks javascript: screenshot URL).
    const treeMarketCard = descendants(mounted.content).find(
      (el) =>
        el.className.includes("settings-extensions-market-card") &&
        el.dataset.extensionId === "sidebar-thread-tree",
    )!;
    treeMarketCard.dispatch("click");
    const treeDialog = descendants(mounted.content).find(
      (el) => el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
    )!;
    const treeImgs = descendants(treeDialog).filter(
      (el) =>
        el.tagName === "img" && !el.className.includes("settings-extensions-detail-modal__preview"),
    );
    expect(treeImgs.map((img) => img.src)).toEqual(["https://cdn.example.com/tree-preview.png"]);
    const updateModalButton = descendants(treeDialog).find(
      (el) => el.tagName === "button" && el.dataset.action === "update",
    )!;
    expect(textOf(updateModalButton)).toBe("更新到 v0.2.0");
    updateModalButton.dispatch("click");

    await vi.waitFor(() => expect(installDesktopExtension).toHaveBeenCalledTimes(2));
    expect(textOf(mounted.content)).toContain("已将“侧栏委派树”更新至 v0.2.0");
    treeDialog.close();

    // 4) Open installed nord-palette detail modal and test inline uninstall confirmation (cancel then confirm).
    const installedTab = descendants(mounted.content).find(
      (el) => el.tagName === "button" && el.dataset.tab === "installed",
    )!;
    installedTab.dispatch("click");
    const nordRow = descendants(mounted.content).find(
      (el) => el.tagName === "article" && el.dataset.extensionId === "nord-palette",
    )!;
    nordRow.dispatch("click");

    const nordDialog = descendants(mounted.content).find(
      (el) => el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
    )!;
    const uninstallBtn = descendants(nordDialog).find(
      (el) => el.tagName === "button" && el.dataset.action === "uninstall",
    )!;
    uninstallBtn.dispatch("click");
    expect(uninstallDesktopExtension).not.toHaveBeenCalled();

    // Cancel restores normal uninstall button.
    const cancelUninstallBtn = descendants(nordDialog).find(
      (el) => el.tagName === "button" && el.dataset.action === "cancel-uninstall",
    )!;
    cancelUninstallBtn.dispatch("click");
    expect(
      descendants(nordDialog).find(
        (el) => el.tagName === "button" && el.dataset.action === "uninstall",
      ),
    ).toBeDefined();

    // Click uninstall again, then confirm.
    descendants(nordDialog)
      .find((el) => el.tagName === "button" && el.dataset.action === "uninstall")!
      .dispatch("click");
    const confirmUninstallBtn = descendants(nordDialog).find(
      (el) => el.tagName === "button" && el.dataset.action === "confirm-uninstall",
    )!;
    confirmUninstallBtn.dispatch("click");

    await vi.waitFor(() => expect(uninstallDesktopExtension).toHaveBeenCalledTimes(1));
    expect(uninstallDesktopExtension).toHaveBeenCalledWith({ id: "nord-palette" });
    expect(textOf(mounted.content)).toContain("已卸载“极光配色”");
    expect(textOf(mounted.content)).toContain("已安装 (2)");
    expect(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-detail-dialog"),
      ),
    ).toBeUndefined();

    mounted.dispose();
  });

  it("imports via GitHub URL (with optional SHA-256) and local .zip upload, and blocks >5 MiB packages client-side", async () => {
    const importedList: DesktopExtensionsListResult = {
      ...sampleInstalledList(),
      extensions: [
        ...sampleInstalledList().extensions,
        {
          id: "custom-widget",
          enabled: false,
          status: { state: "disabled" },
          manifest: {
            manifestVersion: 1,
            id: "custom-widget",
            name: { en: "Custom Widget", "zh-CN": "自定义组件" },
            version: "0.3.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: [],
          },
        },
      ],
    };

    const installDesktopExtension = vi.fn(async (): Promise<DesktopExtensionsInstallResult> => ({
      extensionId: "custom-widget",
      version: "0.3.0",
      replaced: false,
      installedPath: "/tmp/ext/custom-widget",
      list: importedList,
    }));

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleInstalledList()),
      listDesktopExtensionCatalog: vi.fn(async () => sampleCatalog()),
      installDesktopExtension,
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));

    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (3)"));

    // Start from Marketplace tab to verify successful import switches back to Installed tab.
    descendants(mounted.content)
      .find((el) => el.tagName === "button" && el.dataset.tab === "marketplace")!
      .dispatch("click");

    const openImportButton = descendants(mounted.content).find(
      (el) => el.tagName === "button" && el.dataset.action === "open-import",
    )!;
    openImportButton.dispatch("click");

    const findImportDialog = () =>
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-import-dialog"),
      );

    // 1) GitHub URL import with optional SHA-256.
    const urlDialog = findImportDialog()!;
    expect(urlDialog.open).toBe(true);
    const urlInput = descendants(urlDialog).find((el) => el.dataset.importField === "url")!;
    const shaInput = descendants(urlDialog).find((el) => el.dataset.importField === "sha256")!;
    const form = descendants(urlDialog).find((el) => el.tagName === "form")!;

    urlInput.value = "https://github.com/example/custom-widget";
    shaInput.value = HASH_A.toUpperCase();
    form.dispatch("submit");

    await vi.waitFor(() => expect(findImportDialog()).toBeUndefined());
    expect(installDesktopExtension).toHaveBeenCalledTimes(1);
    expect(installDesktopExtension).toHaveBeenCalledWith({
      source: {
        type: "url",
        url: "https://github.com/example/custom-widget",
        expectedSha256: HASH_A,
      },
    });
    const installedTab = descendants(mounted.content).find(
      (el) => el.tagName === "button" && el.dataset.tab === "installed",
    )!;
    expect(installedTab.getAttribute("aria-selected")).toBe("true");
    expect(textOf(mounted.content)).toContain("已安装“自定义组件”（v0.3.0），可按需开启。");

    // 2) Local .zip upload: reject > 5 MiB client-side without calling RPC, then accept valid .zip and send base64.
    openImportButton.dispatch("click");
    const zipDialog = findImportDialog()!;
    const zipModeTab = descendants(zipDialog).find(
      (el) => el.tagName === "button" && el.dataset.importMode === "zip",
    )!;
    zipModeTab.dispatch("click");

    const fileInput = descendants(zipDialog).find((el) => el.dataset.importField === "zip")!;
    const zipForm = descendants(zipDialog).find((el) => el.tagName === "form")!;

    // Oversized file (> 5 MiB) is blocked immediately on selection.
    const tooBigFile = {
      name: "huge-ext.zip",
      size: DESKTOP_EXTENSION_ZIP_MAX_BYTES + 1,
      arrayBuffer: vi.fn(),
    };
    fileInput.files = [tooBigFile];
    fileInput.dispatch("change");
    expect(textOf(zipDialog)).toContain("5 MiB");
    expect(tooBigFile.arrayBuffer).not.toHaveBeenCalled();

    zipForm.dispatch("submit");
    expect(installDesktopExtension).toHaveBeenCalledTimes(1);

    // Valid small .zip file is base64-encoded and submitted.
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    const validFile = {
      name: "custom-widget.zip",
      size: zipBytes.byteLength,
      arrayBuffer: vi.fn(async () => zipBytes.buffer),
    };
    fileInput.files = [validFile];
    fileInput.dispatch("change");
    expect(textOf(zipDialog)).toContain("custom-widget.zip");

    zipForm.dispatch("submit");
    await vi.waitFor(() => expect(findImportDialog()).toBeUndefined());
    expect(installDesktopExtension).toHaveBeenCalledTimes(2);
    expect(installDesktopExtension).toHaveBeenLastCalledWith({
      source: {
        type: "zip-base64",
        fileName: "custom-widget.zip",
        contentBase64: "UEsDBAEC",
      },
    });

    mounted.dispose();
  });
});
