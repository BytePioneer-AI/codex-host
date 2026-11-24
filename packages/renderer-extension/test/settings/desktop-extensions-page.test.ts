import type {
  HostExtensionCatalogEntry,
  HostExtensionListItem,
  HostExtensionsCatalogResult,
  HostExtensionsListResult,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: (name: string, size?: number) => ({
    iconName: name,
    size,
    classList: { add() {} },
  }),
  isRendererSettingsIconName: () => true,
}));

import { RendererMethodUnavailableError } from "../../src/renderer-request-sender.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import {
  createDesktopExtensionsSettingsPage,
  type RendererDesktopExtensionsClient,
} from "../../src/settings/desktop-extensions-page.js";
import {
  createExtensionIconElement,
  formatExtensionStarCount,
} from "../../src/settings/desktop-extensions-shared.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { createDefaultRendererSettingsPages } from "../../src/settings/pages.js";

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

  get isConnected(): boolean {
    return Boolean(this.parent);
  }

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

  focus(): void {}
}

class FakeDocument {
  readonly clipboardWriteText = vi.fn(async () => undefined);
  readonly storage: Map<string, string>;
  readonly defaultView: Window;
  visibilityState: DocumentVisibilityState = "visible";
  readonly #listeners = new Map<string, Set<(event?: unknown) => void>>();

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
    this.defaultView = {
      navigator: { clipboard: { writeText: this.clipboardWriteText } },
      localStorage,
    } as unknown as Window;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase(), this);
  }

  createTextNode(text: string): string {
    return text;
  }

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    const bucket = this.#listeners.get(name) ?? new Set();
    bucket.add(listener);
    this.#listeners.set(name, bucket);
  }

  removeEventListener(name: string, listener: (event?: unknown) => void): void {
    this.#listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, event: Record<string, unknown> = {}): void {
    const payload = {
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const listener of [...(this.#listeners.get(name) ?? [])]) {
      listener(payload);
    }
  }
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
  storage?: Map<string, string>,
) {
  const document = new FakeDocument(storage);
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
    document,
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

const SAMPLE_TREE_DIGEST = "a".repeat(64);
const SAMPLE_BADGE_DIGEST = "b".repeat(64);
const SAMPLE_SCREENSHOT_1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const SAMPLE_SCREENSHOT_2 =
  "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";

function sampleList(overrides: Partial<HostExtensionsListResult> = {}): HostExtensionsListResult {
  return {
    revision: 4,
    configuration: { revision: 4, enabled: ["sidebar-thread-tree"] },
    diagnostics: [],
    extensions: [
      {
        state: "valid",
        id: "sidebar-thread-tree",
        activationId: "act-tree-1",
        digest: SAMPLE_TREE_DIGEST,
        installedAt: "2026-07-01T00:00:00.000Z",
        enabled: true,
        backendState: "running",
        screenshotDataUrls: [SAMPLE_SCREENSHOT_1, SAMPLE_SCREENSHOT_2],
        manifest: {
          manifestVersion: 2,
          id: "sidebar-thread-tree",
          name: { en: "Sidebar Thread Tree", "zh-CN": "侧栏委派树" },
          version: "0.1.0",
          description: { en: "Groups delegated Threads", "zh-CN": "归组委派的 Thread" },
          author: "codexhost",
          repository: "https://github.com/BytePioneer-AI/codex-host",
          details: {
            en: "Expand a parent Thread to inspect delegated children.\n\nGrouping stays local and leaves remote rows untouched.",
            "zh-CN": "在侧栏展开父 Thread 查看委派子任务。\n\n归组仅作用于本机列表，不影响远程行。",
          },
          screenshots: ["assets/tree-1.png", "assets/tree-2.webp"],
          categories: ["interface", "workflow"],
          slots: ["sidebar.thread-layout", "sidebar.thread-badge"],
          desktop: {
            apiVersion: 1,
            script: "desktop.js",
            style: "desktop.css",
          },
          web: {
            apiVersion: 1,
            entry: "web.mjs",
          },
          page: {
            apiVersion: 1,
            entry: "page.mjs",
            title: { en: "Tree Explorer", "zh-CN": "委派树视图" },
          },
          widget: { apiVersion: 1, entry: "widget/index.mjs" },
          backend: {
            apiVersion: 1,
            entry: "backend.mjs",
          },
        },
      },
      {
        state: "valid",
        id: "sidebar-delegation-badges",
        activationId: "act-badges-1",
        digest: SAMPLE_BADGE_DIGEST,
        installedAt: "2026-07-01T00:00:00.000Z",
        enabled: false,
        backendState: "none",
        manifest: {
          manifestVersion: 2,
          id: "sidebar-delegation-badges",
          name: { en: "Delegation Badges", "zh-CN": "Delegation Badges" },
          version: "0.2.0",
          description: { en: "Shows child badges", "zh-CN": "显示子 Thread 角标" },
          categories: ["interface"],
          slots: ["sidebar.thread-badge"],
          desktop: {
            apiVersion: 1,
            script: "desktop.js",
          },
        },
      },
      {
        state: "incompatible",
        id: "future-extension",
        enabled: false,
        error: "Desktop API 2 requires a newer codexhost",
      },
      {
        state: "invalid",
        id: "broken-extension",
        enabled: false,
        error: "Invalid manifest.json",
      },
    ],
    ...overrides,
  };
}

function sampleCatalog(extensions: HostExtensionCatalogEntry[]): HostExtensionsCatalogResult {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-02T00:00:00.000Z",
    catalogUrl: "https://example.com/catalog.v2.json",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    cached: false,
    extensions,
  };
}

function makeCatalogEntry(
  overrides: Partial<HostExtensionCatalogEntry>,
): HostExtensionCatalogEntry {
  return {
    id: "sample-ext",
    format: "codexhost",
    version: "1.0.0",
    name: { en: "Sample", "zh-CN": "示例" },
    description: { en: "Desc", "zh-CN": "描述" },
    author: "CodexHost",
    repository: "https://example.com/sample",
    categories: ["interface"],
    trustTier: "official",
    targets: ["desktop"],
    apis: { desktop: 1 },
    downloadUrl: "https://example.com/sample.zip",
    sha256: "a".repeat(64),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Unified Host extensions settings page", () => {
  it("formats GitHub star counts cleanly without trailing .0", () => {
    expect(formatExtensionStarCount(0)).toBe("0");
    expect(formatExtensionStarCount(42)).toBe("42");
    expect(formatExtensionStarCount(999)).toBe("999");
    expect(formatExtensionStarCount(1_000)).toBe("1k");
    expect(formatExtensionStarCount(1_200)).toBe("1.2k");
    expect(formatExtensionStarCount(1_250)).toBe("1.3k");
    expect(formatExtensionStarCount(10_000)).toBe("10k");
  });

  it("registers desktop-extensions as the second default settings page with Plugins bilingual labels", () => {
    const zhPages = createDefaultRendererSettingsPages(rendererSettingsMessages("zh-CN"));
    const enPages = createDefaultRendererSettingsPages(rendererSettingsMessages("en"));
    expect(zhPages.map(({ id }) => id).slice(0, 3)).toEqual([
      "connections",
      "desktop-extensions",
      "mobile-web",
    ]);
    expect(enPages.map(({ id }) => id).slice(0, 3)).toEqual([
      "connections",
      "desktop-extensions",
      "mobile-web",
    ]);
    expect(zhPages[1]?.label).toBe("插件");
    expect(enPages[1]?.label).toBe("Plugins");
  });

  it("renders custom extension icons, blocks unsafe protocols, falls back on image error, and maps all 6 categories", async () => {
    const validDataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const validHttpsUrl = "https://cdn.example.com/extensions/logo.png";

    const doc = new FakeDocument();
    const categoryCases = [
      {
        categories: ["appearance"] as const,
        expectedCategory: "appearance",
        expectedIcon: "palette",
      },
      {
        categories: ["interface"] as const,
        expectedCategory: "interface",
        expectedIcon: "layout-grid",
      },
      { categories: ["workflow"] as const, expectedCategory: "workflow", expectedIcon: "zap" },
      {
        categories: ["analytics"] as const,
        expectedCategory: "analytics",
        expectedIcon: "chart-column",
      },
      {
        categories: ["integrations"] as const,
        expectedCategory: "integrations",
        expectedIcon: "plug",
      },
      { categories: ["tools"] as const, expectedCategory: "tools", expectedIcon: "puzzle" },
      { categories: undefined, expectedCategory: "tools", expectedIcon: "puzzle" },
    ];
    for (const testCase of categoryCases) {
      const cardIcon = createExtensionIconElement({
        document: doc as unknown as Document,
        categories: testCase.categories,
        size: "card",
        alt: "Test",
      }) as unknown as FakeElement;
      expect(cardIcon.dataset.iconKind).toBe("fallback");
      expect(cardIcon.dataset.iconCategory).toBe(testCase.expectedCategory);
      expect(cardIcon.dataset.iconName).toBe(testCase.expectedIcon);
    }

    for (const unsafeUrl of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    ]) {
      const safeFallback = createExtensionIconElement({
        document: doc as unknown as Document,
        iconUrl: unsafeUrl,
        categories: ["workflow"],
        size: "detail",
        alt: "Unsafe",
      }) as unknown as FakeElement;
      expect(safeFallback.dataset.iconKind).toBe("fallback");
      expect(descendants(safeFallback).filter((el) => el.tagName === "img")).toHaveLength(0);
    }

    const degradingIcon = createExtensionIconElement({
      document: doc as unknown as Document,
      iconUrl: validHttpsUrl,
      categories: ["analytics"],
      size: "card",
      alt: "Broken Remote",
    }) as unknown as FakeElement;
    const brokenImg = must(descendants(degradingIcon).find((el) => el.tagName === "img"));
    brokenImg.dispatch("error");
    expect(degradingIcon.dataset.iconKind).toBe("fallback");

    const list = sampleList();
    const first = must(list.extensions[0]);
    const second = must(list.extensions[1]);
    const listWithIcons: HostExtensionsListResult = {
      ...list,
      extensions: [
        first.state === "valid" ? { ...first, iconDataUrl: validDataUrl } : first,
        second,
        ...list.extensions.slice(2),
      ],
    };
    const client: RendererDesktopExtensionsClient = {
      listHostExtensions: vi.fn(async () => listWithIcons),
      listHostExtensionCatalog: vi.fn(async (): Promise<HostExtensionsCatalogResult> => ({
        schemaVersion: 2,
        generatedAt: "2026-07-02T00:00:00.000Z",
        catalogUrl: "https://example.com/catalog.v2.json",
        fetchedAt: "2026-07-02T00:00:00.000Z",
        cached: false,
        extensions: [
          makeCatalogEntry({
            id: first.id,
            icon: "https://cdn.example.com/ignored-because-local-exists.png",
          }),
          makeCatalogEntry({
            id: second.id,
            categories: ["appearance"],
            trustTier: "community",
            icon: validHttpsUrl,
          }),
        ],
      })),
    };

    const mounted = mountPage("zh-CN", () => client);
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const firstCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === first.id,
      ),
    );
    expect(must(descendants(firstCard).find((el) => el.tagName === "img")).src).toBe(validDataUrl);

    const secondCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === second.id,
      ),
    );
    expect(must(descendants(secondCard).find((el) => el.tagName === "img")).src).toBe(
      validHttpsUrl,
    );
    mounted.dispose();
  });

  it("renders empty-state directory guidance in Chinese and English", async () => {
    const client: RendererDesktopExtensionsClient = {
      listHostExtensions: vi.fn(async () => ({
        revision: 0,
        configuration: { revision: 0, enabled: [] },
        diagnostics: [],
        extensions: [],
      })),
      recoverHostExtensions: vi.fn(),
    };
    const zhMount = mountPage("zh-CN", () => client);
    await vi.waitFor(() =>
      expect(textOf(zhMount.content)).toContain("$CODEXHOST_DATA_DIR/host-extensions/<id>/"),
    );
    expect(textOf(zhMount.content)).toContain("尚未安装插件");
    zhMount.dispose();

    const enMount = mountPage("en", () => client);
    await vi.waitFor(() => expect(textOf(enMount.content)).toContain("No plugins installed"));
    expect(textOf(enMount.content)).toContain("$CODEXHOST_DATA_DIR/host-extensions/<id>/");
    enMount.dispose();
  });

  it("displays capability badges, Open Page button, attention section, and disables invalid toggles", async () => {
    const client: RendererDesktopExtensionsClient = {
      listHostExtensions: vi.fn(async () => sampleList()),
      enableHostExtension: vi.fn(),
      disableHostExtension: vi.fn(),
      recoverHostExtensions: vi.fn(),
    };
    const mounted = mountPage("zh-CN", () => client);
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const groups = descendants(mounted.content).filter(
      (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
    );
    expect(groups.map((group) => group.dataset.extensionGroup)).toEqual(["attention"]);
    expect(textOf(must(groups[0]))).toContain("需要关注");

    const cards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(cards.map((card) => card.dataset.extensionId)).toEqual([
      "future-extension",
      "broken-extension",
      "sidebar-thread-tree",
      "sidebar-delegation-badges",
    ]);

    const attentionGrid = must(cards[0]?.parent);
    const normalGrid = must(cards[2]?.parent);
    expect(attentionGrid.parent).toBe(groups[0]);
    expect(cards[1]?.parent).toBe(attentionGrid);
    expect(cards[3]?.parent).toBe(normalGrid);
    expect(normalGrid.parent).toBe(groups[0]?.parent);

    const incompatibleSwitch = must(
      descendants(must(cards[0])).find((el) => el.tagName === "input"),
    );
    const invalidSwitch = must(descendants(must(cards[1])).find((el) => el.tagName === "input"));
    expect(incompatibleSwitch.disabled).toBe(true);
    expect(invalidSwitch.disabled).toBe(true);

    // The shared page and widget have separate badges; only the page adds an Open Page button.
    const treeCard = must(cards[2]);
    expect(textOf(descendants(treeCard).find((el) => el.dataset.platform === "both"))).toBe(
      "Codex Desktop · CH Web",
    );
    const treeBadges = descendants(treeCard)
      .filter((el) => el.dataset.capability)
      .map((el) => ({ kind: el.dataset.capability, text: textOf(el) }));
    expect(treeBadges).toEqual([
      { kind: "page", text: "独立页面" },
      { kind: "widget", text: "挂件" },
      { kind: "backend", text: "后台" },
    ]);
    const openPageBtn = must(
      descendants(treeCard).find(
        (el) => el.tagName === "button" && el.dataset.action === "open-page",
      ),
    );
    expect(textOf(openPageBtn)).toBe("打开页面");

    // The Desktop-only card has no Open Page button.
    const badgesCard = must(cards[3]);
    expect(textOf(descendants(badgesCard).find((el) => el.dataset.platform === "desktop"))).toBe(
      "仅 Codex Desktop",
    );
    expect(descendants(badgesCard).find((el) => el.dataset.action === "open-page")).toBeUndefined();

    mounted.dispose();
  });

  it("keeps enabled and disabled plugins in one ordered grid when a switch changes", async () => {
    const list = sampleList();
    const [tree, badges] = list.extensions;
    const disableHostExtension = vi.fn(async () => ({
      state: "saved" as const,
      configuration: { revision: 5, enabled: [] },
    }));
    const client: RendererDesktopExtensionsClient = {
      listHostExtensions: vi
        .fn<() => Promise<HostExtensionsListResult>>()
        .mockResolvedValueOnce({ ...list, extensions: [must(tree), must(badges)] })
        .mockResolvedValue({
          ...list,
          revision: 5,
          configuration: { revision: 5, enabled: [] },
          extensions: [must(badges), { ...must(tree), enabled: false }],
        }),
      disableHostExtension,
    };
    const mounted = mountPage("en", () => client);

    const assertUnifiedGrid = () => {
      const elements = descendants(mounted.content);
      const grids = elements.filter((el) => el.className === "settings-extensions-grid");
      expect(grids).toHaveLength(1);
      expect(elements.some((el) => el.dataset.extensionGroup)).toBe(false);
      const cards = descendants(must(grids[0])).filter((el) => el.tagName === "article");
      expect(cards.map((el) => el.dataset.extensionId)).toEqual([
        "sidebar-delegation-badges",
        "sidebar-thread-tree",
      ]);
      return must(descendants(must(cards[1])).find((el) => el.tagName === "input"));
    };
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("Sidebar Thread Tree"));
    const toggle = assertUnifiedGrid();
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatch("change");
    await vi.waitFor(() => {
      const updatedToggle = assertUnifiedGrid();
      expect(updatedToggle.checked).toBe(false);
      expect(updatedToggle.disabled).toBe(false);
    });
    expect(disableHostExtension).toHaveBeenCalledWith({
      id: "sidebar-thread-tree",
      expectedRevision: 4,
    });
    mounted.dispose();
  });

  it("filters installed plugins by platform, capability, and search query", async () => {
    const mounted = mountPage("zh-CN", () => ({
      listHostExtensions: vi.fn(async () => sampleList()),
      recoverHostExtensions: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const cardIds = () =>
      descendants(mounted.content)
        .filter((el) => el.tagName === "article" && Boolean(el.dataset.extensionId))
        .map((el) => el.dataset.extensionId);

    const desktopPill = must(
      descendants(mounted.content).find((el) => el.dataset.capabilityFilter === "desktop"),
    );
    expect(textOf(desktopPill)).toBe("Codex Desktop");
    desktopPill.dispatch("click");
    expect(cardIds()).toEqual(["sidebar-thread-tree", "sidebar-delegation-badges"]);

    const webPill = must(
      descendants(mounted.content).find((el) => el.dataset.capabilityFilter === "web"),
    );
    expect(textOf(webPill)).toBe("CH Web");
    webPill.dispatch("click");
    expect(cardIds()).toEqual(["sidebar-thread-tree"]);

    // Capability filter "page" shows only extensions declaring manifest.page.
    const pagePill = must(
      descendants(mounted.content).find((el) => el.dataset.capabilityFilter === "page"),
    );
    pagePill.dispatch("click");
    expect(cardIds()).toEqual(["sidebar-thread-tree"]);

    const widgetPill = must(
      descendants(mounted.content).find((el) => el.dataset.capabilityFilter === "widget"),
    );
    expect(textOf(widgetPill)).toBe("挂件");
    widgetPill.dispatch("click");
    expect(cardIds()).toEqual(["sidebar-thread-tree"]);

    // Capability filter "backend" shows only extensions declaring manifest.backend.
    const backendPill = must(
      descendants(mounted.content).find((el) => el.dataset.capabilityFilter === "backend"),
    );
    backendPill.dispatch("click");
    expect(cardIds()).toEqual(["sidebar-thread-tree"]);

    // Capability filter "all" restores all 4 entries.
    const allCapPill = must(
      descendants(mounted.content).find((el) => el.dataset.capabilityFilter === "all"),
    );
    allCapPill.dispatch("click");
    expect(cardIds()).toHaveLength(4);

    // Search query filters live across bilingual fields & IDs.
    const searchInput = must(
      descendants(mounted.content).find((el) => el.tagName === "input" && el.type === "search"),
    );
    searchInput.value = "子 Thread 角标";
    searchInput.dispatch("input");
    expect(cardIds()).toEqual(["sidebar-delegation-badges"]);

    searchInput.value = "nonexistent-keyword";
    searchInput.dispatch("input");
    expect(cardIds()).toEqual([]);
    const resetButton = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && textOf(el).includes("清除筛选"),
      ),
    );
    resetButton.dispatch("click");
    expect(cardIds()).toHaveLength(4);
    mounted.dispose();
  });

  it("preloads the Marketplace and updates an installed plugin directly from its card", async () => {
    const list = sampleList();
    const tree = must(list.extensions[0]);
    if (tree.state !== "valid") throw new Error("Expected the installed tree to be valid");
    const installed = {
      ...tree,
      activationId: "act-tree-2",
      digest: "c".repeat(64),
      manifest: { ...tree.manifest, version: "0.2.0" },
    };
    const pendingCatalog = deferred<HostExtensionsCatalogResult>();
    const pendingUpdate = deferred<typeof installed & { replaced: boolean }>();
    const client: RendererDesktopExtensionsClient = {
      listHostExtensions: vi
        .fn<() => Promise<HostExtensionsListResult>>()
        .mockResolvedValueOnce(list)
        .mockResolvedValue({ ...list, extensions: [installed, ...list.extensions.slice(1)] }),
      listHostExtensionCatalog: vi.fn(() => pendingCatalog.promise),
      updateHostExtension: vi.fn(() => pendingUpdate.promise),
    };
    const mounted = mountPage("zh-CN", () => client);
    const elements = () => descendants(mounted.content);
    const marketplaceTab = must(elements().find((el) => el.dataset.tab === "marketplace"));
    const installedTab = must(elements().find((el) => el.dataset.tab === "installed"));
    const treeCard = () =>
      must(elements().find((el) => el.tagName === "article" && el.dataset.extensionId === tree.id));
    const updateButton = () => descendants(treeCard()).find((el) => el.dataset.action === "update");
    expect(textOf(marketplaceTab)).toBe("市场");
    expect(client.listHostExtensionCatalog).toHaveBeenCalledWith({});
    await vi.waitFor(() => expect(textOf(treeCard())).toContain("侧栏委派树"));
    expect(installedTab.getAttribute("aria-selected")).toBe("true");
    expect(textOf(marketplaceTab)).toBe("市场");
    expect(updateButton()).toBeUndefined();

    pendingCatalog.resolve(sampleCatalog([makeCatalogEntry({ id: tree.id, version: "0.2.0" })]));
    await vi.waitFor(() => expect(textOf(marketplaceTab)).toBe("市场 (1)"));
    expect(installedTab.getAttribute("aria-description")).toBe("有插件可更新");
    expect(textOf(treeCard())).toContain("可更新 v0.2.0");
    const button = must(updateButton());
    expect(textOf(button)).toBe("更新");
    const pageButton = must(
      descendants(treeCard()).find((el) => el.dataset.action === "open-page"),
    );
    expect(button.parent).not.toBe(pageButton.parent);
    expect(button.dispatch("keydown", { key: "Enter" }).stopped).toBe(true);
    button.dispatchBubbling("click");
    expect(elements().some((el) => el.tagName === "dialog" && el.open)).toBe(false);
    expect(client.updateHostExtension).toHaveBeenCalledWith({
      id: tree.id,
      expectedDigest: tree.digest,
      expectedActivationId: tree.activationId,
      source: { type: "catalog", id: tree.id },
    });
    const updating = must(updateButton());
    expect(updating.disabled).toBe(true);
    expect(updating.getAttribute("aria-busy")).toBe("true");
    expect(textOf(updating)).toBe("更新中…");

    pendingUpdate.resolve({ ...installed, replaced: true });
    await vi.waitFor(() => expect(updateButton()).toBeUndefined());
    expect(installedTab.getAttribute("aria-description")).toBe("");
    expect(textOf(treeCard())).toContain("v0.2.0");
    mounted.dispose();
  });

  it("keeps a failed Marketplace prefetch off the installed tab and counts an empty catalog after retry", async () => {
    const listHostExtensionCatalog = vi
      .fn<() => Promise<HostExtensionsCatalogResult>>()
      .mockRejectedValueOnce(new Error("Catalog offline"))
      .mockResolvedValue(sampleCatalog([]));
    const mounted = mountPage("en", () => ({
      listHostExtensions: async () => sampleList(),
      listHostExtensionCatalog,
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("Sidebar Thread Tree"));
    expect(textOf(mounted.content)).not.toContain("Catalog offline");
    const marketplaceTab = must(
      descendants(mounted.content).find((el) => el.dataset.tab === "marketplace"),
    );
    expect(textOf(marketplaceTab)).toBe("Marketplace");
    marketplaceTab.dispatch("click");
    expect(textOf(mounted.content)).toContain("Catalog offline");
    const retry = must(
      descendants(mounted.content).find((el) => el.tagName === "button" && textOf(el) === "Retry"),
    );
    retry.dispatch("click");
    await vi.waitFor(() => expect(textOf(marketplaceTab)).toBe("Marketplace (0)"));
    expect(textOf(mounted.content)).not.toContain("Catalog offline");
    mounted.dispose();
  });

  it.each([
    {
      locale: "en",
      label: "Supported platforms",
      both: "Codex Desktop & CH Web",
      desktopOnly: "Codex Desktop Only",
      webOnly: "CH Web Only",
      notice: "Runs in CH Web only. You can still install or toggle it from Codex Desktop.",
    },
    {
      locale: "zh-CN",
      label: "适用平台",
      both: "Codex Desktop · CH Web",
      desktopOnly: "仅 Codex Desktop",
      webOnly: "仅 CH Web",
      notice: "此插件仅在 CH Web 界面生效，Codex Desktop 仅支持安装与启停管理。",
    },
  ] as const)("shows Marketplace platform filters and detail guidance in $locale", async (copy) => {
    const mounted = mountPage(copy.locale, () => ({
      listHostExtensions: async () => sampleList(),
      listHostExtensionCatalog: async () =>
        sampleCatalog([
          makeCatalogEntry({ id: "desktop-only" }),
          makeCatalogEntry({ id: "web-only", targets: ["web"], apis: { web: 1 } }),
          makeCatalogEntry({ id: "both", targets: ["desktop", "web"], apis: { page: 1 } }),
        ]),
    }));
    must(descendants(mounted.content).find((el) => el.dataset.tab === "marketplace")).dispatch(
      "click",
    );

    const cards = () => descendants(mounted.content).filter((el) => el.tagName === "article");
    await vi.waitFor(() => expect(cards()).toHaveLength(3));
    const checkPlatform = (id: string, platform: string, label: string, notice?: string) => {
      const card = must(cards().find((el) => el.dataset.extensionId === id));
      expect(textOf(descendants(card).find((el) => el.dataset.platform === platform))).toBe(label);
      card.dispatch("click");
      const dialog = must(descendants(mounted.content).find((el) => el.tagName === "dialog"));
      const platformRow = descendants(dialog).find((el) => el.className.endsWith("__platform-row"));
      expect(textOf(platformRow)).toBe(`${copy.label} ${label}`);
      const platformNotice = descendants(dialog).find((el) =>
        el.className.endsWith("__platform-notice"),
      );
      expect(textOf(platformNotice)).toBe(notice ?? "");
      dialog.close();
    };
    checkPlatform("desktop-only", "desktop", copy.desktopOnly);
    checkPlatform("web-only", "web", copy.webOnly, copy.notice);
    checkPlatform("both", "both", copy.both);

    for (const [filter, label] of [
      ["desktop", "Codex Desktop"],
      ["web", "CH Web"],
    ]) {
      const pill = must(
        descendants(mounted.content).find((el) => el.dataset.capabilityFilter === filter),
      );
      expect(textOf(pill)).toBe(label);
      pill.dispatch("click");
      expect(
        cards()
          .map((el) => el.dataset.extensionId)
          .sort(),
      ).toEqual(["both", `${filter}-only`]);
    }
    mounted.dispose();
  });

  it("opens detail modal, renders inline declarative settings with expectedSettingsRevision conflict handling, and toggles state", async () => {
    const settingsList: HostExtensionsListResult = {
      revision: 4,
      configuration: { revision: 4, enabled: ["sidebar-thread-tree"] },
      diagnostics: [],
      extensions: [
        {
          ...(must(sampleList().extensions[0]) as Extract<
            HostExtensionListItem,
            { state: "valid" }
          >),
          manifest: {
            ...(
              must(sampleList().extensions[0]) as Extract<HostExtensionListItem, { state: "valid" }>
            ).manifest,
            settingsSchema: [
              {
                key: "compact",
                type: "boolean",
                label: { en: "Compact mode", "zh-CN": "紧凑模式" },
                default: false,
              },
            ],
          },
        },
      ],
    };

    const getHostExtensionSettings = vi
      .fn()
      .mockResolvedValueOnce({ settingsRevision: 2, values: { compact: false } })
      .mockResolvedValueOnce({ settingsRevision: 3, values: { compact: true } });
    const setHostExtensionSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("settings revision conflict"))
      .mockResolvedValueOnce({ settingsRevision: 4, values: { compact: false } });

    const disableHostExtension = vi.fn(async () => ({
      state: "saved" as const,
      configuration: { revision: 5, enabled: [] },
    }));
    const listHostExtensions = vi
      .fn<() => Promise<HostExtensionsListResult>>()
      .mockResolvedValueOnce(settingsList)
      .mockResolvedValueOnce({
        ...settingsList,
        revision: 5,
        configuration: { revision: 5, enabled: [] },
        extensions: [{ ...must(settingsList.extensions[0]), enabled: false }],
      });

    const mounted = mountPage("zh-CN", () => ({
      listHostExtensions,
      disableHostExtension,
      enableHostExtension: vi.fn(),
      getHostExtensionSettings,
      setHostExtensionSettings,
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const treeCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    treeCard.dispatch("click");

    const dialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    expect(dialog.open).toBe(true);
    expect(descendants(dialog).filter((el) => el.dataset.action === "open-page")).toHaveLength(1);
    expect(descendants(dialog).some((el) => el.dataset.action === "open-settings")).toBe(false);
    await vi.waitFor(() => expect(getHostExtensionSettings).toHaveBeenCalledTimes(1));

    // Inline declarative setting toggle submits expectedSettingsRevision: 2, hits conflict, reloads rev 3.
    const settingToggle = must(
      descendants(dialog).find(
        (el) => el.tagName === "input" && el.type === "checkbox" && el.id.includes("compact"),
      ),
    );
    await vi.waitFor(() => expect(settingToggle.disabled).toBe(false));
    settingToggle.checked = true;
    settingToggle.dispatch("change");

    await vi.waitFor(() => expect(setHostExtensionSettings).toHaveBeenCalledTimes(1));
    expect(setHostExtensionSettings).toHaveBeenCalledWith({
      id: "sidebar-thread-tree",
      expectedSettingsRevision: 2,
      values: { compact: true },
    });
    await vi.waitFor(() => expect(getHostExtensionSettings).toHaveBeenCalledTimes(2));
    expect(textOf(dialog)).toContain("设置已在其他入口更新");

    // Toggle plugin enable switch inside modal.
    const modalToggle = must(
      descendants(dialog).find(
        (el) =>
          el.tagName === "input" &&
          el.type === "checkbox" &&
          el.getAttribute("aria-label")?.includes("侧栏委派树"),
      ),
    );
    modalToggle.checked = false;
    modalToggle.dispatch("change");
    await vi.waitFor(() => expect(disableHostExtension).toHaveBeenCalledTimes(1));
    expect(disableHostExtension).toHaveBeenCalledWith({
      id: "sidebar-thread-tree",
      expectedRevision: 4,
    });

    dialog.close();
    mounted.dispose();
  });

  it("opens a floating screenshot lightbox with keyboard navigation and Escape closing only the lightbox", async () => {
    const mounted = mountPage("zh-CN", () => ({
      listHostExtensions: vi.fn(async () => sampleList()),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
      ),
    ).dispatch("click");

    const detailDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    const thumbs = descendants(detailDialog).filter(
      (el) => el.className === "settings-extensions-detail-modal__thumb",
    );
    expect(thumbs).toHaveLength(2);
    must(thumbs[0]).dispatch("click");

    const lightbox = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "dialog" && el.className === "settings-extensions-lightbox",
      ),
    );
    const lightboxImg = must(
      descendants(lightbox).find((el) => el.className === "settings-extensions-lightbox__img"),
    );
    expect(lightbox.open).toBe(true);
    expect(lightboxImg.src).toBe(SAMPLE_SCREENSHOT_1);
    expect(textOf(lightbox)).toContain("1 / 2");

    lightbox.dispatch("keydown", { key: "ArrowRight" });
    expect(lightboxImg.src).toBe(SAMPLE_SCREENSHOT_2);
    expect(textOf(lightbox)).toContain("2 / 2");

    lightbox.dispatch("keydown", { key: "Escape" });
    expect(lightbox.open).toBe(false);
    expect(detailDialog.open).toBe(true);

    detailDialog.close();
    mounted.dispose();
  });

  it("handles revision-conflict with automatic reload and exposes directory copy + recovery in header more menu", async () => {
    const pendingDisable = deferred<{
      state: "revision-conflict";
      revision: number;
    }>();
    const listHostExtensions = vi
      .fn<() => Promise<HostExtensionsListResult>>()
      .mockResolvedValueOnce(sampleList())
      .mockResolvedValueOnce(
        sampleList({ revision: 7, configuration: { revision: 7, enabled: [] } }),
      )
      .mockResolvedValueOnce(
        sampleList({ revision: 8, configuration: { revision: 8, enabled: [] } }),
      );
    const disableHostExtension = vi.fn(() => pendingDisable.promise);
    const recoverHostExtensions = vi.fn(async () => ({
      state: "saved" as const,
      configuration: { revision: 8, enabled: [] },
    }));

    const mounted = mountPage("zh-CN", () => ({
      listHostExtensions,
      enableHostExtension: vi.fn(),
      disableHostExtension,
      recoverHostExtensions,
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const treeSwitch = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "input" && el.getAttribute("aria-label")?.includes("侧栏委派树"),
      ),
    );
    treeSwitch.checked = false;
    treeSwitch.dispatch("change");
    pendingDisable.resolve({ state: "revision-conflict", revision: 7 });

    await vi.waitFor(() => expect(listHostExtensions).toHaveBeenCalledTimes(2));
    const banner = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions__banner"),
      ),
    );
    expect(textOf(banner)).toContain("已自动刷新最新列表");

    // Header more menu: copy directory path ($CODEXHOST_DATA_DIR/host-extensions/) & trigger recovery dialog.
    const moreButton = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.action === "more-menu",
      ),
    );
    const moreMenu = must(
      descendants(mounted.content).find(
        (el) => el.getAttribute("role") === "menu" && el.dataset.menu === "more",
      ),
    );
    moreButton.dispatch("click");
    const copyItem = must(
      descendants(moreMenu).find((el) => el.dataset.action === "copy-directory"),
    );
    copyItem.dispatch("click");
    await vi.waitFor(() =>
      expect(mounted.document.clipboardWriteText).toHaveBeenCalledWith(
        "$CODEXHOST_DATA_DIR/host-extensions/",
      ),
    );

    moreButton.dispatch("click");
    const recoveryItem = must(
      descendants(moreMenu).find((el) => el.dataset.action === "open-recovery"),
    );
    recoveryItem.dispatch("click");
    const recoveryDialog = must(descendants(mounted.content).find((el) => el.tagName === "dialog"));
    const form = must(descendants(recoveryDialog).find((el) => el.tagName === "form"));
    form.dispatch("submit");

    await vi.waitFor(() => expect(recoverHostExtensions).toHaveBeenCalledTimes(1));
    expect(recoverHostExtensions).toHaveBeenCalledWith({ expectedRevision: 7 });
    mounted.dispose();
  });

  it("shows an unavailable state when the Host does not support unified extension RPCs", async () => {
    const mounted = mountPage("en", () => ({
      listHostExtensions: vi.fn(async () => {
        throw new RendererMethodUnavailableError("codexhost/extensions/list", undefined);
      }),
      recoverHostExtensions: vi.fn(),
    }));
    await vi.waitFor(() =>
      expect(textOf(mounted.content)).toContain("Plugin management is unavailable"),
    );
    const recoveryMenuItem = must(
      descendants(mounted.content).find((el) => el.dataset.action === "open-recovery"),
    );
    expect(recoveryMenuItem.disabled).toBe(true);
    mounted.dispose();
  });
});
