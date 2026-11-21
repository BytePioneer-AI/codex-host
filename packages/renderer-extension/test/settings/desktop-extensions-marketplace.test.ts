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
  stars: 1200,
  downloads: 3200,
  categories: ["interface", "workflow", "tools"],
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
  categories: ["interface"],
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
  stars: 42,
  downloads: 480,
  categories: ["appearance"],
  trustTier: "community",
  screenshots: ["https://cdn.example.com/nord-1.webp"],
  downloadUrl: "https://github.com/alice-dev/nord-palette/releases/download/v1/nord.zip",
  sha256: HASH_C,
  slots: [],
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function sampleInstalledList(
  overrides: Partial<DesktopExtensionsListResult> = {},
): DesktopExtensionsListResult {
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
          categories: ["interface", "workflow"],
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
          categories: ["interface"],
        },
      },
    ],
    ...overrides,
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

    // Installed tab uses a single flat 3-column grid with minimalist 3-row cards:
    // borderless official shield icon (no green pill), top-right toggle, and subtle update cue in bottom metadata.
    const installedGrids = descendants(mounted.content).filter(
      (el) => el.className === "settings-extensions-grid",
    );
    expect(installedGrids).toHaveLength(1);
    const treeInstalledCard = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "article" &&
          el.className === "settings-extensions-card" &&
          el.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    const badgesInstalledCard = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "article" &&
          el.className === "settings-extensions-card" &&
          el.dataset.extensionId === "sidebar-delegation-badges",
      ),
    );
    expect(treeInstalledCard).toBeDefined();
    const treeVerified = must(
      descendants(treeInstalledCard).find(
        (el) => el.className === "settings-extensions-card__verified",
      ),
    );
    expect(treeVerified).toBeDefined();
    expect(treeVerified.getAttribute("aria-label")).toBe("官方");
    expect(
      descendants(treeInstalledCard).filter((el) =>
        el.className.includes("settings-extensions-trust-badge"),
      ),
    ).toHaveLength(0);
    expect(textOf(treeInstalledCard)).toContain("codexhost · v0.1.0");
    expect(textOf(treeInstalledCard)).toContain("可更新");
    const installedStarLink = must(
      descendants(treeInstalledCard).find(
        (el) => el.tagName === "a" && el.dataset.action === "open-repository",
      ),
    );
    expect(installedStarLink).toBeDefined();
    expect(installedStarLink.href).toBe("https://github.com/BytePioneer-AI/codex-host");
    expect(textOf(installedStarLink)).toBe("1.2k");
    const installedDownloads = must(
      descendants(treeInstalledCard).find(
        (el) => el.tagName === "span" && el.dataset.metric === "downloads",
      ),
    );
    expect(installedDownloads).toBeDefined();
    expect(textOf(installedDownloads)).toBe("3.2k");
    expect(installedDownloads.getAttribute("aria-label")).toBe("下载量：3.2k");
    // Clicking the card star link stops propagation and does not open the detail modal.
    installedStarLink.dispatchBubbling("click");
    expect(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-detail-dialog"),
      ),
    ).toBeUndefined();
    expect(textOf(badgesInstalledCard)).not.toContain("可更新");
    const badgesStarLink = must(
      descendants(badgesInstalledCard).find(
        (el) => el.tagName === "a" && el.dataset.action === "open-repository",
      ),
    );
    expect(badgesStarLink).toBeDefined();
    expect(textOf(badgesStarLink)).toBe("");
    // Catalog entry without downloads renders no downloads metric and never shows fake "0".
    expect(
      descendants(badgesInstalledCard).find((el) => el.dataset.metric === "downloads"),
    ).toBeUndefined();
    expect(
      descendants(treeInstalledCard).filter((el) => el.className.includes("__icon")),
    ).toHaveLength(0);

    // Switch to Marketplace tab.
    const marketTab = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    );
    marketTab.dispatch("click");
    expect(marketTab.getAttribute("aria-selected")).toBe("true");

    // Fallback notice renders clean localized Chinese without leaking raw English backend error text.
    const fallbackNotice = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-market__notice"),
      ),
    );
    expect(fallbackNotice).toBeDefined();
    expect(textOf(fallbackNotice)).toContain(
      "远端市场目录暂不可达。你仍可通过链接或 ZIP 安装扩展。",
    );
    expect(textOf(fallbackNotice)).not.toContain("offline");

    // 3 marketplace cards share the exact same 3-row card layout:
    // borderless official shield icon, top-right action button, and plain middot categories (max 2, no blue chips).
    expect(
      descendants(mounted.content).filter((el) => el.className === "settings-extensions-grid"),
    ).toHaveLength(1);
    const findMarketCards = () =>
      descendants(mounted.content).filter(
        (el) =>
          el.tagName === "article" &&
          el.className === "settings-extensions-card" &&
          el.dataset.cardKind === "marketplace",
      );
    const marketCards = findMarketCards();
    expect(marketCards.map((card) => card.dataset.extensionId)).toEqual([
      "sidebar-thread-tree",
      "sidebar-delegation-badges",
      "nord-palette",
    ]);
    expect(
      marketCards.every(
        (card) =>
          descendants(card).filter(
            (el) =>
              el.className.includes("settings-extensions-category-chip") ||
              el.className.includes("settings-extensions-trust-badge") ||
              el.className === "settings-extensions-card__footer",
          ).length === 0,
      ),
    ).toBe(true);

    const treeMarketCard = must(marketCards[0]);
    expect(
      descendants(treeMarketCard).find(
        (el) => el.className === "settings-extensions-card__verified",
      ),
    ).toBeDefined();
    expect(textOf(treeMarketCard)).toContain("codexhost · v0.2.0");
    const treeMarketStarLink = must(
      descendants(treeMarketCard).find(
        (el) => el.tagName === "a" && el.dataset.action === "open-repository",
      ),
    );
    expect(treeMarketStarLink.href).toBe("https://github.com/BytePioneer-AI/codex-host");
    expect(textOf(treeMarketStarLink)).toBe("1.2k");
    const treeMarketDownloads = must(
      descendants(treeMarketCard).find(
        (el) => el.tagName === "span" && el.dataset.metric === "downloads",
      ),
    );
    expect(treeMarketDownloads).toBeDefined();
    expect(textOf(treeMarketDownloads)).toBe("3.2k");
    treeMarketStarLink.dispatchBubbling("click");
    expect(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-detail-dialog"),
      ),
    ).toBeUndefined();
    expect(
      textOf(
        must(
          descendants(treeMarketCard).find(
            (el) => el.className === "settings-extensions-card__categories-text",
          ),
        ),
      ),
    ).toBe("界面增强 · 效率与协作");
    expect(textOf(treeMarketCard)).toContain("更新");
    expect(textOf(treeMarketCard)).not.toContain("sidebar.thread-layout");

    const badgesMarketCard = must(marketCards[1]);
    expect(textOf(badgesMarketCard)).toContain("已安装");
    expect(
      descendants(badgesMarketCard).find((el) => el.dataset.metric === "downloads"),
    ).toBeUndefined();

    const themeMarketCard = must(marketCards[2]);
    expect(
      descendants(themeMarketCard).find(
        (el) => el.className === "settings-extensions-card__verified",
      ),
    ).toBeUndefined();
    expect(textOf(themeMarketCard)).toContain("alice-dev · v1.0.0");
    expect(
      textOf(
        must(
          descendants(themeMarketCard).find(
            (el) => el.className === "settings-extensions-card__categories-text",
          ),
        ),
      ),
    ).toBe("外观主题");
    expect(textOf(themeMarketCard)).toContain("安装");

    // Category filter works on Marketplace tab.
    const appearancePill = must(
      descendants(mounted.content).find(
        (el) =>
          el.className.includes("settings-extensions-filter-pill") &&
          el.dataset.category === "appearance",
      ),
    );
    appearancePill.dispatch("click");
    const filteredCards = findMarketCards();
    expect(filteredCards.map((c) => c.dataset.extensionId)).toEqual(["nord-palette"]);

    // Clear category pill, then search by author and category name.
    const allPill = must(
      descendants(mounted.content).find(
        (el) =>
          el.className.includes("settings-extensions-filter-pill") && el.dataset.category === "all",
      ),
    );
    allPill.dispatch("click");

    const searchInput = must(
      descendants(mounted.content).find((el) => el.tagName === "input" && el.type === "search"),
    );
    searchInput.value = "alice-dev";
    searchInput.dispatch("input");
    expect(findMarketCards().map((c) => c.dataset.extensionId)).toEqual(["nord-palette"]);

    // Refresh button on Marketplace tab sends forceRefresh: true and clears fallback notice.
    const refreshButton = must(
      descendants(mounted.content).find((el) => el.className.includes("settings-remote__refresh")),
    );
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
    const marketTab = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    );
    marketTab.dispatch("click");

    // 1) Open community catalog item detail modal before installing: shows community notice and safe HTTPS screenshot only, omitting technical metadata.
    const themeCard = must(
      descendants(mounted.content).find(
        (el) =>
          el.className === "settings-extensions-card" &&
          el.dataset.cardKind === "marketplace" &&
          el.dataset.extensionId === "nord-palette",
      ),
    );
    themeCard.dispatch("click");
    const detailDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    expect(detailDialog.open).toBe(true);
    expect(textOf(detailDialog)).toContain("社区扩展，启用前建议先查看源码仓库");
    const themeRepoLink = must(
      descendants(detailDialog).find(
        (el) =>
          el.tagName === "a" && el.className.includes("settings-extensions-detail-modal__repo"),
      ),
    );
    expect(themeRepoLink).toBeDefined();
    expect(themeRepoLink.href).toBe("https://github.com/alice-dev/nord-palette");
    expect(textOf(themeRepoLink)).toContain("GitHub 仓库");
    expect(textOf(themeRepoLink)).toContain("42");
    const themeDetailDownloads = must(
      descendants(detailDialog).find(
        (el) => el.tagName === "span" && el.dataset.metric === "downloads",
      ),
    );
    expect(themeDetailDownloads).toBeDefined();
    expect(textOf(themeDetailDownloads)).toBe("480");
    expect(themeDetailDownloads.getAttribute("aria-label")).toBe("下载量：480");
    expect(descendants(detailDialog).find((el) => el.tagName === "details")).toBeUndefined();
    expect(textOf(detailDialog)).not.toContain(HASH_C);
    expect(textOf(detailDialog)).not.toContain("nord-palette");
    expect(textOf(detailDialog)).not.toContain("技术信息");
    const modalImages = descendants(detailDialog).filter(
      (el) =>
        el.tagName === "img" && !el.className.includes("settings-extensions-detail-modal__preview"),
    );
    expect(modalImages.map((img) => img.src)).toEqual(["https://cdn.example.com/nord-1.webp"]);
    detailDialog.close();

    // 2) Click Install directly on the marketplace card: stops propagation (no modal), shows loading text & disables button.
    const installButton = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "button" &&
          el.dataset.action === "install" &&
          el.dataset.extensionId === "nord-palette",
      ),
    );
    installButton.dispatchBubbling("click");
    expect(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-detail-dialog"),
      ),
    ).toBeUndefined();
    expect(installDesktopExtension).toHaveBeenCalledWith({
      source: { type: "catalog", id: "nord-palette" },
    });

    const busyInstallButton = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "button" &&
          el.dataset.action === "install" &&
          el.dataset.extensionId === "nord-palette",
      ),
    );
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
    const treeMarketCard = must(
      descendants(mounted.content).find(
        (el) =>
          el.className === "settings-extensions-card" &&
          el.dataset.cardKind === "marketplace" &&
          el.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    treeMarketCard.dispatch("click");
    const treeDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    const treeRepoLink = must(
      descendants(treeDialog).find(
        (el) =>
          el.tagName === "a" && el.className.includes("settings-extensions-detail-modal__repo"),
      ),
    );
    expect(textOf(treeRepoLink)).toContain("1.2k");
    const treeDetailDownloads = must(
      descendants(treeDialog).find(
        (el) => el.tagName === "span" && el.dataset.metric === "downloads",
      ),
    );
    expect(textOf(treeDetailDownloads)).toBe("3.2k");
    const treeImgs = descendants(treeDialog).filter(
      (el) =>
        el.tagName === "img" && !el.className.includes("settings-extensions-detail-modal__preview"),
    );
    expect(treeImgs.map((img) => img.src)).toEqual(["https://cdn.example.com/tree-preview.png"]);
    const updateModalButton = must(
      descendants(treeDialog).find(
        (el) => el.tagName === "button" && el.dataset.action === "update",
      ),
    );
    expect(textOf(updateModalButton)).toBe("更新到 v0.2.0");
    updateModalButton.dispatch("click");

    await vi.waitFor(() => expect(installDesktopExtension).toHaveBeenCalledTimes(2));
    expect(textOf(mounted.content)).toContain("已将“侧栏委派树”更新至 v0.2.0");
    treeDialog.close();

    // 4) Open installed nord-palette detail modal and test inline uninstall confirmation (cancel then confirm).
    const installedTab = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "installed",
      ),
    );
    installedTab.dispatch("click");
    const nordRow = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "nord-palette",
      ),
    );
    nordRow.dispatch("click");

    const nordDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    const uninstallBtn = must(
      descendants(nordDialog).find(
        (el) => el.tagName === "button" && el.dataset.action === "uninstall",
      ),
    );
    uninstallBtn.dispatch("click");
    expect(uninstallDesktopExtension).not.toHaveBeenCalled();

    // Cancel restores normal uninstall button.
    const cancelUninstallBtn = must(
      descendants(nordDialog).find(
        (el) => el.tagName === "button" && el.dataset.action === "cancel-uninstall",
      ),
    );
    cancelUninstallBtn.dispatch("click");
    expect(
      descendants(nordDialog).find(
        (el) => el.tagName === "button" && el.dataset.action === "uninstall",
      ),
    ).toBeDefined();

    // Click uninstall again, then confirm.
    must(
      descendants(nordDialog).find(
        (el) => el.tagName === "button" && el.dataset.action === "uninstall",
      ),
    ).dispatch("click");
    const confirmUninstallBtn = must(
      descendants(nordDialog).find(
        (el) => el.tagName === "button" && el.dataset.action === "confirm-uninstall",
      ),
    );
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

  it("imports via GitHub repository URL and local .zip upload without SHA-256 input or client-side 5 MiB limit", async () => {
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
    must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    ).dispatch("click");

    const openImportButton = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.action === "open-import",
      ),
    );
    openImportButton.dispatch("click");

    const findImportDialog = () =>
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-import-dialog"),
      );

    // 1) GitHub repository URL import without dialog subtitle or SHA-256 input.
    const urlDialog = must(findImportDialog());
    expect(urlDialog.open).toBe(true);
    expect(textOf(urlDialog)).not.toContain("支持通过 GitHub 仓库或 Release 链接安装");
    expect(textOf(urlDialog)).toContain("GitHub 仓库链接");
    expect(textOf(urlDialog)).not.toContain("SHA-256");
    expect(
      descendants(urlDialog).find((el) => el.dataset.importField === "sha256"),
    ).toBeUndefined();
    expect(descendants(urlDialog).find((el) => el.tagName === "details")).toBeUndefined();

    const urlInput = must(descendants(urlDialog).find((el) => el.dataset.importField === "url"));
    expect(urlInput.placeholder).toBe("https://github.com/owner/repo");
    const form = must(descendants(urlDialog).find((el) => el.tagName === "form"));

    urlInput.value = "https://github.com/example/custom-widget";
    form.dispatch("submit");

    await vi.waitFor(() => expect(findImportDialog()).toBeUndefined());
    expect(installDesktopExtension).toHaveBeenCalledTimes(1);
    expect(installDesktopExtension).toHaveBeenCalledWith({
      source: {
        type: "url",
        url: "https://github.com/example/custom-widget",
      },
    });
    const installedTab = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "installed",
      ),
    );
    expect(installedTab.getAttribute("aria-selected")).toBe("true");
    expect(textOf(mounted.content)).toContain("已安装“自定义组件”（v0.3.0），可按需开启。");

    // 2) Local .zip upload: no 5 MiB hint or client-side size block; accepts >5 MiB metadata and sends base64.
    openImportButton.dispatch("click");
    const zipDialog = must(findImportDialog());
    const zipModeTab = must(
      descendants(zipDialog).find(
        (el) => el.tagName === "button" && el.dataset.importMode === "zip",
      ),
    );
    zipModeTab.dispatch("click");

    expect(textOf(zipDialog)).toContain("点击选择或拖拽 .zip 文件");
    expect(textOf(zipDialog)).not.toContain("5 MiB");
    expect(textOf(zipDialog)).not.toContain("manifest.json");

    const fileInput = must(descendants(zipDialog).find((el) => el.dataset.importField === "zip"));
    const zipForm = must(descendants(zipDialog).find((el) => el.tagName === "form"));

    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    const largeZipFile = {
      name: "custom-widget.zip",
      size: DESKTOP_EXTENSION_ZIP_MAX_BYTES + 1,
      arrayBuffer: vi.fn(async () => zipBytes.buffer),
    };
    fileInput.files = [largeZipFile];
    fileInput.dispatch("change");
    expect(textOf(zipDialog)).toContain("custom-widget.zip");
    expect(textOf(zipDialog)).not.toContain("5 MiB");

    zipForm.dispatch("submit");
    await vi.waitFor(() => expect(findImportDialog()).toBeUndefined());
    expect(largeZipFile.arrayBuffer).toHaveBeenCalledTimes(1);
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

  it("clears transient feedback banners when switching tabs and only surfaces raw catalog errors when non-fallback listing is empty", async () => {
    const listDesktopExtensions = vi
      .fn<() => Promise<DesktopExtensionsListResult>>()
      .mockResolvedValueOnce(sampleInstalledList())
      .mockResolvedValueOnce({
        ...sampleInstalledList(),
        configuration: { version: 1, revision: 4, enabled: [] },
        extensions: sampleInstalledList().extensions.map((item) =>
          item.id === "sidebar-thread-tree"
            ? { ...item, enabled: false, status: { state: "disabled" } }
            : item,
        ),
      });
    const disableDesktopExtension = vi.fn(async () => ({
      state: "saved" as const,
      configuration: { version: 1 as const, revision: 4, enabled: [] },
    }));
    const listDesktopExtensionCatalog = vi
      .fn<() => Promise<DesktopExtensionsCatalogResult>>()
      .mockResolvedValueOnce(
        sampleCatalog({
          source: "fallback",
          error: "Catalog request failed: HTTP 404",
        }),
      )
      .mockResolvedValueOnce(
        sampleCatalog({
          source: "remote",
          error: "upstream timeout",
          extensions: [],
        }),
      );

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions,
      listDesktopExtensionCatalog,
      disableDesktopExtension,
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (3)"));

    // Disable an extension on the Installed tab so the green success feedback banner appears.
    const treeSwitch = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "input" && el.getAttribute("aria-label")?.includes("侧栏委派树"),
      ),
    );
    treeSwitch.checked = false;
    treeSwitch.dispatch("change");

    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(2));
    const banner = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions__banner"),
      ),
    );
    expect(banner.hidden).toBe(false);
    expect(textOf(banner)).toBe("已禁用“侧栏委派树”。");

    // Switching to Marketplace clears the stale feedback banner.
    const marketTab = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    );
    marketTab.dispatch("click");
    expect(banner.hidden).toBe(true);
    expect(textOf(banner)).toBe("");

    // Fallback notice keeps clean localized copy without raw English backend error text.
    const fallbackNotice = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-market__notice"),
      ),
    );
    expect(textOf(fallbackNotice)).toContain(
      "远端市场目录暂不可达。你仍可通过链接或 ZIP 安装扩展。",
    );
    expect(textOf(fallbackNotice)).not.toContain("HTTP 404");

    // When source is not fallback and the catalog is empty with an error, surface the error notice.
    const refreshButton = must(
      descendants(mounted.content).find((el) => el.className.includes("settings-remote__refresh")),
    );
    refreshButton.dispatch("click");
    await vi.waitFor(() => expect(listDesktopExtensionCatalog).toHaveBeenCalledTimes(2));
    const errorNotice = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions-market__notice"),
      ),
    );
    expect(errorNotice).toBeDefined();
    expect(textOf(errorNotice)).toContain("无法加载扩展市场：upstream timeout");

    // Switching back to Installed keeps the feedback banner cleared.
    const installedTab = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "installed",
      ),
    );
    installedTab.dispatch("click");
    expect(banner.hidden).toBe(true);

    mounted.dispose();
  });

  it("re-renders Marketplace cards, category pills, and detail modal when switching extension content language", async () => {
    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleInstalledList()),
      listDesktopExtensionCatalog: vi.fn(async () => sampleCatalog()),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (3)"));

    must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    ).dispatch("click");
    expect(textOf(mounted.content)).toContain("极光配色");

    const localeButton = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.action === "content-locale-menu",
      ),
    );
    const localeMenu = must(
      descendants(mounted.content).find(
        (el) => el.getAttribute("role") === "menu" && el.dataset.menu === "content-locale",
      ),
    );
    localeButton.dispatch("click");
    must(descendants(localeMenu).find((el) => el.dataset.contentLocale === "en")).dispatch("click");

    expect(textOf(localeButton)).toBe("EN");
    const themeCard = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "article" &&
          el.dataset.cardKind === "marketplace" &&
          el.dataset.extensionId === "nord-palette",
      ),
    );
    expect(textOf(themeCard)).toContain("Nord Palette");
    expect(textOf(themeCard)).toContain("Calm Arctic palette for sidebar.");
    expect(
      textOf(
        must(
          descendants(themeCard).find(
            (el) => el.className === "settings-extensions-card__categories-text",
          ),
        ),
      ),
    ).toBe("Appearance");

    const pillLabels = descendants(mounted.content)
      .filter((el) => el.className.includes("settings-extensions-filter-pill"))
      .map((pill) => textOf(pill));
    expect(pillLabels).toEqual(["All", "Appearance", "Interface", "Workflow", "Tools"]);

    themeCard.dispatch("click");
    const detailDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    expect(textOf(detailDialog)).toContain("Nord Palette");
    expect(textOf(detailDialog)).toContain("Community theme tuned for dark mode.");
    detailDialog.close();

    mounted.dispose();
  });

  it("hides the category filter bar completely and resets selection when Marketplace entries declare no categories", async () => {
    const uncategorizedCatalog = sampleCatalog({
      extensions: [
        { ...CATALOG_TREE, categories: undefined },
        { ...CATALOG_THEME, categories: undefined },
      ],
    });
    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleInstalledList()),
      listDesktopExtensionCatalog: vi.fn(async () => uncategorizedCatalog),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (2)"));

    // Select a category on the Installed tab first.
    const findWorkflowPill = () =>
      must(
        descendants(mounted.content).find(
          (el) =>
            el.className.includes("settings-extensions-filter-pill") &&
            el.dataset.category === "workflow",
        ),
      );
    findWorkflowPill().dispatch("click");
    expect(findWorkflowPill().getAttribute("aria-pressed")).toBe("true");

    // Switch to Marketplace where no entries declare categories: filter bar is hidden completely
    // (not even "全部"), selectedCategory resets to all, and both cards remain visible.
    must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    ).dispatch("click");

    const categorySlot = must(
      descendants(mounted.content).find(
        (el) => el.className === "settings-extensions__category-slot",
      ),
    );
    expect(categorySlot.hidden).toBe(true);
    expect(
      descendants(mounted.content).filter((el) =>
        el.className.includes("settings-extensions__filters"),
      ),
    ).toHaveLength(0);
    expect(
      descendants(mounted.content).filter((el) =>
        el.className.includes("settings-extensions-filter-pill"),
      ),
    ).toHaveLength(0);
    expect(textOf(categorySlot)).toBe("");

    const marketCards = descendants(mounted.content).filter(
      (el) =>
        el.tagName === "article" &&
        el.className === "settings-extensions-card" &&
        el.dataset.cardKind === "marketplace",
    );
    expect(marketCards.map((card) => card.dataset.extensionId)).toEqual([
      "sidebar-thread-tree",
      "nord-palette",
    ]);

    mounted.dispose();
  });

  it("renders https marketplace icons, rejects unsafe icon protocols, degrades on image error, and uses Import plugin dialog titles", async () => {
    const iconCatalog = sampleCatalog({
      extensions: [
        { ...CATALOG_TREE, icon: "https://cdn.example.com/icons/tree.png" },
        { ...CATALOG_THEME, icon: "javascript:alert(1)" },
      ],
    });
    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleInstalledList({ extensions: [] })),
      listDesktopExtensionCatalog: vi.fn(async () => iconCatalog),
      installDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("市场 (2)"));

    // Import button and dialog title use "导入插件".
    const importButton = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.action === "open-import",
      ),
    );
    expect(textOf(importButton)).toBe("导入插件");
    importButton.dispatch("click");
    const importDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-import-dialog"),
      ),
    );
    expect(textOf(importDialog)).toContain("导入插件");
    importDialog.close();

    // Switch to Marketplace tab and verify icons.
    must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.tab === "marketplace",
      ),
    ).dispatch("click");

    const treeCard = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "article" &&
          el.dataset.cardKind === "marketplace" &&
          el.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    const treeIcon = must(
      descendants(treeCard).find((el) => el.className.includes("settings-extensions-icon--card")),
    );
    expect(treeIcon.dataset.iconKind).toBe("image");
    const treeImg = must(descendants(treeIcon).find((el) => el.tagName === "img"));
    expect(treeImg.src).toBe("https://cdn.example.com/icons/tree.png");

    // Simulate broken remote icon image -> gracefully degrades to category vector icon.
    treeImg.dispatch("error");
    expect(treeIcon.dataset.iconKind).toBe("fallback");
    expect(treeIcon.dataset.iconName).toBe("layout-grid");
    expect(descendants(treeIcon).filter((el) => el.tagName === "img")).toHaveLength(0);

    // Unsafe protocol on theme card is blocked and renders appearance palette fallback.
    const themeCard = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "article" &&
          el.dataset.cardKind === "marketplace" &&
          el.dataset.extensionId === "nord-palette",
      ),
    );
    const themeIcon = must(
      descendants(themeCard).find((el) => el.className.includes("settings-extensions-icon--card")),
    );
    expect(themeIcon.dataset.iconKind).toBe("fallback");
    expect(themeIcon.dataset.iconCategory).toBe("appearance");
    expect(themeIcon.dataset.iconName).toBe("palette");
    expect(descendants(themeIcon).filter((el) => el.tagName === "img")).toHaveLength(0);

    // Marketplace detail modal renders the 44px detail icon.
    treeCard.dispatch("click");
    const detailDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    const detailIcon = must(
      descendants(detailDialog).find((el) =>
        el.className.includes("settings-extensions-icon--detail"),
      ),
    );
    expect(detailIcon.dataset.iconKind).toBe("image");
    expect(must(descendants(detailIcon).find((el) => el.tagName === "img")).src).toBe(
      "https://cdn.example.com/icons/tree.png",
    );
    detailDialog.close();
    mounted.dispose();

    // English import button & dialog title use "Import plugin".
    const enMounted = mountPage("en", () => ({
      listDesktopExtensions: vi.fn(async () => sampleInstalledList({ extensions: [] })),
      installDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(enMounted.content)).toContain("Import plugin"));
    must(
      descendants(enMounted.content).find(
        (el) => el.tagName === "button" && el.dataset.action === "open-import",
      ),
    ).dispatch("click");
    const enImportDialog = must(
      descendants(enMounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-import-dialog"),
      ),
    );
    expect(textOf(enImportDialog)).toContain("Import plugin");
    enImportDialog.close();
    enMounted.dispose();
  });
});
