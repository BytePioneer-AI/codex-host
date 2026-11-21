import type {
  DesktopExtensionMutationResult,
  DesktopExtensionsCatalogResult,
  DesktopExtensionsListResult,
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

const SAMPLE_TREE_HASH = "a".repeat(64);
const SAMPLE_SCREENSHOT_1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const SAMPLE_SCREENSHOT_2 =
  "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";

function sampleList(
  overrides: Partial<DesktopExtensionsListResult> = {},
): DesktopExtensionsListResult {
  return {
    configuration: { version: 1, revision: 4, enabled: ["sidebar-thread-tree"] },
    desktopConnected: true,
    diagnostics: [],
    extensions: [
      {
        id: "sidebar-thread-tree",
        enabled: true,
        status: { state: "running", hash: SAMPLE_TREE_HASH },
        screenshotDataUrls: [SAMPLE_SCREENSHOT_1, SAMPLE_SCREENSHOT_2],
        manifest: {
          manifestVersion: 1,
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
          desktopApi: 1,
          desktop: { script: "desktop.js", style: "desktop.css" },
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
          name: "Delegation Badges",
          version: "0.2.0",
          description: { en: "Shows child badges", "zh-CN": "显示子 Thread 角标" },
          desktopApi: 1,
          desktop: { script: "desktop.js" },
          slots: ["sidebar.thread-badge"],
          categories: ["interface"],
        },
      },
      {
        id: "future-extension",
        enabled: false,
        status: {
          state: "incompatible",
          error: "Desktop API 2 requires a newer codexhost",
        },
      },
      {
        id: "broken-extension",
        enabled: false,
        status: {
          state: "invalid",
          error: "Invalid manifest.json",
        },
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Desktop extensions settings page", () => {
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

  it("renders custom extension icons, blocks unsafe protocols, falls back on image error, and maps all 6 categories to Lucide vector icons", async () => {
    const validDataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const validHttpsUrl = "https://cdn.example.com/extensions/logo.png";

    // 1) All 6 categories + uncategorized fallback map cleanly to their rounded vector icon & category tone.
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
      expect(cardIcon.className).toContain("settings-extensions-icon--card");
      expect(cardIcon.dataset.iconKind).toBe("fallback");
      expect(cardIcon.dataset.iconCategory).toBe(testCase.expectedCategory);
      expect(cardIcon.dataset.iconName).toBe(testCase.expectedIcon);
      expect((cardIcon.children[0] as { iconName?: string; size?: number }).iconName).toBe(
        testCase.expectedIcon,
      );
      expect((cardIcon.children[0] as { size?: number }).size).toBe(16);
    }

    // 2) Unsafe protocols (javascript:, file:, data:image/svg+xml) are rejected and fall back to vector icons.
    for (const unsafeUrl of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PGh0bWw+",
    ]) {
      const safeFallback = createExtensionIconElement({
        document: doc as unknown as Document,
        iconUrl: unsafeUrl,
        categories: ["workflow"],
        size: "detail",
        alt: "Unsafe",
      }) as unknown as FakeElement;
      expect(safeFallback.className).toContain("settings-extensions-icon--detail");
      expect(safeFallback.dataset.iconKind).toBe("fallback");
      expect(safeFallback.dataset.iconName).toBe("zap");
      expect(descendants(safeFallback).filter((el) => el.tagName === "img")).toHaveLength(0);
    }

    // 3) Image load failure (error event) degrades gracefully to the category vector icon without broken <img>.
    const degradingIcon = createExtensionIconElement({
      document: doc as unknown as Document,
      iconUrl: validHttpsUrl,
      categories: ["analytics"],
      size: "card",
      alt: "Broken Remote",
    }) as unknown as FakeElement;
    expect(degradingIcon.dataset.iconKind).toBe("image");
    const brokenImg = must(descendants(degradingIcon).find((el) => el.tagName === "img"));
    expect(brokenImg.src).toBe(validHttpsUrl);
    brokenImg.dispatch("error");
    expect(degradingIcon.dataset.iconKind).toBe("fallback");
    expect(degradingIcon.dataset.iconName).toBe("chart-column");
    expect(descendants(degradingIcon).filter((el) => el.tagName === "img")).toHaveLength(0);

    // 4) Installed cards prefer local iconDataUrl, fall back to catalog icon, then category vector icon; detail modal mirrors it.
    const list = sampleList();
    const first = must(list.extensions[0]);
    const second = must(list.extensions[1]);
    const listWithIcons: DesktopExtensionsListResult = {
      ...list,
      extensions: [{ ...first, iconDataUrl: validDataUrl }, second, ...list.extensions.slice(2)],
    };
    const client: RendererDesktopExtensionsClient = {
      listDesktopExtensions: vi.fn(async () => listWithIcons),
      listDesktopExtensionCatalog: vi.fn(async (): Promise<DesktopExtensionsCatalogResult> => ({
        catalogUrl: "https://example.com/catalog.json",
        source: "remote",
        fetchedAt: "2026-07-02T00:00:00.000Z",
        cached: false,
        extensions: [
          {
            id: first.id,
            name: { en: "Sidebar Thread Tree", "zh-CN": "侧栏委派树" },
            description: { en: "Desc", "zh-CN": "描述" },
            version: "1.0.0",
            author: "CodexHost",
            categories: ["interface"],
            slots: ["sidebar.thread-layout"],
            trustTier: "official",
            repository: "https://example.com/tree",
            icon: "https://cdn.example.com/ignored-because-local-exists.png",
            downloadUrl: "https://example.com/tree.zip",
            sha256: "a".repeat(64),
          },
          {
            id: second.id,
            name: { en: "Nord Dark", "zh-CN": "Nord 深色" },
            description: { en: "Desc", "zh-CN": "描述" },
            version: "1.0.0",
            author: "Community",
            categories: ["appearance"],
            slots: ["appearance.theme"],
            trustTier: "community",
            repository: "https://example.com/nord",
            icon: validHttpsUrl,
            downloadUrl: "https://example.com/nord.zip",
            sha256: "b".repeat(64),
          },
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
    const firstIcon = must(
      descendants(firstCard).find((el) => el.className.includes("settings-extensions-icon--card")),
    );
    expect(firstIcon.dataset.iconKind).toBe("image");
    expect(must(descendants(firstIcon).find((el) => el.tagName === "img")).src).toBe(validDataUrl);

    const secondCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === second.id,
      ),
    );
    const secondIcon = must(
      descendants(secondCard).find((el) => el.className.includes("settings-extensions-icon--card")),
    );
    expect(secondIcon.dataset.iconKind).toBe("image");
    expect(must(descendants(secondIcon).find((el) => el.tagName === "img")).src).toBe(
      validHttpsUrl,
    );

    // Detail modal renders a 44px detail icon matching the installed priority.
    firstCard.dispatch("click");
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
    expect(must(descendants(detailIcon).find((el) => el.tagName === "img")).src).toBe(validDataUrl);
    detailDialog.close();
    mounted.dispose();
  });

  it("renders empty-state directory guidance in Chinese and English", async () => {
    const client: RendererDesktopExtensionsClient = {
      listDesktopExtensions: vi.fn(async () => ({
        configuration: { version: 1 as const, revision: 0, enabled: [] },
        desktopConnected: false,
        diagnostics: [],
        extensions: [],
      })),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    };
    const zhMount = mountPage("zh-CN", () => client);
    await vi.waitFor(() =>
      expect(textOf(zhMount.content)).toContain("$CODEXHOST_DATA_DIR/desktop-extensions/<id>/"),
    );
    expect(textOf(zhMount.content)).toContain("尚未发现 Desktop 扩展");
    expect(textOf(zhMount.content)).toContain("Desktop 未连接");
    expect(textOf(zhMount.content)).not.toContain("管理本机 Codex Desktop 主窗口的可选界面扩展");
    expect(
      descendants(zhMount.content).find((el) => el.className === "settings-page-description"),
    ).toBeUndefined();
    zhMount.dispose();

    const enMount = mountPage("en", () => client);
    await vi.waitFor(() =>
      expect(textOf(enMount.content)).toContain("No Desktop extensions found"),
    );
    expect(textOf(enMount.content)).toContain("Desktop disconnected");
    expect(textOf(enMount.content)).toContain("$CODEXHOST_DATA_DIR/desktop-extensions/<id>/");
    expect(textOf(enMount.content)).not.toContain("Manage optional UI extensions");
    enMount.dispose();
  });

  it("displays minimalist 3-row cards, top-right toggles, plain middot categories, attention-only section, and disables invalid toggles", async () => {
    const client: RendererDesktopExtensionsClient = {
      listDesktopExtensions: vi.fn(async () => sampleList()),
      enableDesktopExtension: vi.fn(),
      disableDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    };
    const mounted = mountPage("zh-CN", () => client);
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    // Bottom directory bar and emergency recovery banner are removed; connected state stays clean without a badge.
    expect(
      descendants(mounted.content).find((el) => el.className === "settings-extensions__meta"),
    ).toBeUndefined();
    expect(
      descendants(mounted.content).find((el) => el.className === "settings-extensions-recovery"),
    ).toBeUndefined();
    const header = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions__header"),
      ),
    );
    const connectionBadge = must(
      descendants(header).find((el) => el.className === "settings-extensions__connection"),
    );
    expect(connectionBadge.hidden).toBe(true);
    expect(textOf(header)).not.toContain("Desktop 已连接");
    expect(textOf(header)).not.toContain("Desktop 未连接");

    // Only Needs Attention gets a section heading; normal extensions share one flat 3-column grid.
    const groups = descendants(mounted.content).filter(
      (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
    );
    expect(groups.map((group) => group.dataset.extensionGroup)).toEqual(["attention"]);
    expect(
      groups.map((group) =>
        textOf(
          descendants(group).find((el) => el.className === "settings-extensions__group-title"),
        ),
      ),
    ).toEqual(["需关注"]);

    const grids = descendants(mounted.content).filter(
      (element) => element.className === "settings-extensions-grid",
    );
    expect(grids).toHaveLength(2);

    const cards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(cards.map((card) => card.dataset.extensionId)).toEqual([
      "future-extension",
      "broken-extension",
      "sidebar-thread-tree",
      "sidebar-delegation-badges",
    ]);
    expect(cards.every((card) => card.className === "settings-extensions-card")).toBe(true);

    const incompatibleSwitch = must(
      descendants(must(cards[0])).find((el) => el.tagName === "input"),
    );
    const invalidSwitch = must(descendants(must(cards[1])).find((el) => el.tagName === "input"));
    expect(incompatibleSwitch.disabled).toBe(true);
    expect(invalidSwitch.disabled).toBe(true);
    expect(textOf(must(cards[0]))).toContain("Desktop API 2 requires a newer codexhost");
    expect(textOf(must(cards[1]))).toContain("Invalid manifest.json");

    // Row 1 (top): title + toggle on right; Row 2: description; Row 3: borderless meta line with plain middot categories.
    const treeCard = must(cards[2]);
    expect(textOf(treeCard)).toContain("侧栏委派树");
    expect(textOf(treeCard)).toContain("codexhost · v0.1.0");
    expect(textOf(treeCard)).toContain("归组委派的 Thread");
    const treeTop = must(
      descendants(treeCard).find((el) => el.className === "settings-extensions-card__top"),
    );
    expect(
      descendants(treeTop).find((el) => el.tagName === "input" && el.type === "checkbox"),
    ).toBeDefined();
    expect(
      descendants(treeCard).find((el) => el.className === "settings-extensions-card__footer"),
    ).toBeUndefined();
    expect(
      descendants(treeCard).filter((el) =>
        el.className.includes("settings-extensions-category-chip"),
      ),
    ).toHaveLength(0);
    expect(
      descendants(treeCard).filter((el) => el.className.includes("settings-extensions-badge")),
    ).toHaveLength(0);
    const treeCategoriesText = must(
      descendants(treeCard).find(
        (el) => el.className === "settings-extensions-card__categories-text",
      ),
    );
    expect(textOf(treeCategoriesText)).toBe("界面增强 · 效率与协作");
    expect(textOf(treeCard)).not.toContain("sidebar-thread-tree");
    expect(textOf(treeCard)).not.toContain(SAMPLE_TREE_HASH);
    expect(descendants(treeCard).filter((el) => el.className.includes("__icon"))).toHaveLength(0);

    // Disabled card omits redundant "未启用" text, status dot, and footer divider.
    const badgesCard = must(cards[3]);
    expect(textOf(badgesCard)).toContain("Delegation Badges");
    expect(textOf(badgesCard)).toContain("v0.2.0");
    expect(textOf(badgesCard)).not.toContain("未启用");
    expect(
      descendants(badgesCard).filter((el) =>
        el.className.includes("settings-extensions-card__status-dot"),
      ),
    ).toHaveLength(0);
    mounted.dispose();

    const enMount = mountPage("en", () => client);
    await vi.waitFor(() => expect(textOf(enMount.content)).toContain("Sidebar Thread Tree"));
    const enGroups = descendants(enMount.content).filter(
      (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
    );
    expect(
      enGroups.map((group) =>
        textOf(
          descendants(group).find((el) => el.className === "settings-extensions__group-title"),
        ),
      ),
    ).toEqual(["Needs Attention"]);
    const enTreeCard = must(
      descendants(enMount.content).find(
        (element) => element.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    expect(textOf(enTreeCard)).toContain("Sidebar Thread Tree");
    expect(textOf(enTreeCard)).toContain("Groups delegated Threads");
    expect(
      textOf(
        must(
          descendants(enTreeCard).find(
            (el) => el.className === "settings-extensions-card__categories-text",
          ),
        ),
      ),
    ).toBe("Interface · Workflow");
    enMount.dispose();
  });

  it("puts attention items first and flattens enabled + disabled extensions into one grid with enabled sorted before disabled", async () => {
    const allStatesList: DesktopExtensionsListResult = {
      configuration: {
        version: 1,
        revision: 2,
        enabled: ["running-ext", "waiting-ext", "failed-ext", "conflict-ext"],
      },
      desktopConnected: true,
      diagnostics: [],
      extensions: [
        {
          id: "disabled-ext",
          enabled: false,
          status: { state: "disabled" },
          manifest: {
            manifestVersion: 1,
            id: "disabled-ext",
            name: { en: "Disabled Tool", "zh-CN": "未启用工具" },
            version: "1.0.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: [],
            categories: ["tools"],
          },
        },
        {
          id: "waiting-ext",
          enabled: true,
          status: { state: "waiting" },
          manifest: {
            manifestVersion: 1,
            id: "waiting-ext",
            name: { en: "Waiting Theme", "zh-CN": "等待中的外观" },
            version: "1.0.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: [],
            categories: ["appearance"],
          },
        },
        {
          id: "conflict-ext",
          enabled: true,
          status: { state: "conflict", conflictWith: "running-ext" },
          manifest: {
            manifestVersion: 1,
            id: "conflict-ext",
            name: { en: "Conflict Layout", "zh-CN": "冲突布局" },
            version: "1.0.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: ["sidebar.thread-layout"],
          },
        },
        {
          id: "running-ext",
          enabled: true,
          status: { state: "running" },
          manifest: {
            manifestVersion: 1,
            id: "running-ext",
            name: { en: "Primary Layout", "zh-CN": "主侧栏布局" },
            version: "1.0.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: ["sidebar.thread-layout"],
          },
        },
        {
          id: "failed-ext",
          enabled: true,
          status: { state: "failed", error: "activate() threw TypeError" },
          manifest: {
            manifestVersion: 1,
            id: "failed-ext",
            name: { en: "Broken Composer", "zh-CN": "异常输入框" },
            version: "1.0.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: [],
            categories: ["analytics"],
          },
        },
      ],
    };

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => allStatesList),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("主侧栏布局"));

    const groupsWithAttention = descendants(mounted.content).filter(
      (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
    );
    expect(groupsWithAttention.map((group) => group.dataset.extensionGroup)).toEqual(["attention"]);

    const cards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(cards.slice(0, 2).map((card) => card.dataset.extensionId)).toEqual([
      "conflict-ext",
      "failed-ext",
    ]);
    // Enabled normal items come before disabled items in the flat grid.
    expect(
      cards
        .slice(2, 4)
        .map((card) => card.dataset.extensionId)
        .sort(),
    ).toEqual(["running-ext", "waiting-ext"]);
    expect(must(cards[4]).dataset.extensionId).toBe("disabled-ext");
    // Inline conflict occupant name uses localized text and failed error stays exposed inline.
    expect(textOf(must(cards[0]))).toContain("主侧栏布局 (running-ext)");
    expect(textOf(must(cards[1]))).toContain("activate() threw TypeError");
    mounted.dispose();

    // When only normal (enabled + disabled) extensions exist, zero group headings are rendered
    // and all cards sit in a single 3-column grid with enabled sorted before disabled.
    const healthyOnly = mountPage("en", () => ({
      listDesktopExtensions: vi.fn(async () => ({
        ...allStatesList,
        extensions: [
          must(allStatesList.extensions[0]), // disabled-ext
          must(allStatesList.extensions[1]), // waiting-ext (enabled, "Waiting Theme")
          must(allStatesList.extensions[3]), // running-ext (enabled, "Primary Layout")
        ],
      })),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(healthyOnly.content)).toContain("Primary Layout"));
    expect(
      descendants(healthyOnly.content).filter(
        (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
      ),
    ).toHaveLength(0);
    expect(
      descendants(healthyOnly.content).filter(
        (element) => element.className === "settings-extensions-grid",
      ),
    ).toHaveLength(1);
    expect(
      descendants(healthyOnly.content)
        .filter((element) => element.tagName === "article" && Boolean(element.dataset.extensionId))
        .map((card) => card.dataset.extensionId),
    ).toEqual(["running-ext", "waiting-ext", "disabled-ext"]);
    expect(textOf(healthyOnly.content)).not.toContain("Needs Attention");
    healthyOnly.dispose();
  });

  it("renders category filter pills only when categories exist and filters cards accurately", async () => {
    const categorizedList: DesktopExtensionsListResult = {
      configuration: { version: 1, revision: 1, enabled: ["ext-sidebar"] },
      desktopConnected: true,
      diagnostics: [],
      extensions: [
        {
          id: "ext-sidebar",
          enabled: true,
          status: { state: "running" },
          manifest: {
            manifestVersion: 1,
            id: "ext-sidebar",
            name: { en: "Sidebar Tree", "zh-CN": "侧栏树" },
            version: "0.1.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: ["sidebar.thread-layout"],
            categories: ["workflow", "interface"],
          },
        },
        {
          id: "ext-theme",
          enabled: false,
          status: { state: "disabled" },
          manifest: {
            manifestVersion: 1,
            id: "ext-theme",
            name: { en: "Nord Theme", "zh-CN": "极光主题" },
            version: "0.1.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: [],
            categories: ["appearance"],
          },
        },
        {
          id: "ext-legacy",
          enabled: false,
          status: { state: "disabled" },
          manifest: {
            manifestVersion: 1,
            id: "ext-legacy",
            name: "Uncategorized Extension",
            version: "0.1.0",
            desktopApi: 1,
            desktop: { script: "desktop.js" },
            slots: [],
          },
        },
      ],
    };

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => categorizedList),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏树"));

    const findPills = () =>
      descendants(mounted.content).filter((el) =>
        el.className.includes("settings-extensions-filter-pill"),
      );
    expect(findPills().map((pill) => textOf(pill))).toEqual([
      "全部",
      "外观主题",
      "界面增强",
      "效率与协作",
    ]);
    expect(must(findPills()[0]).getAttribute("aria-pressed")).toBe("true");

    // Click "外观主题" -> only ext-theme remains in a flat grid without group headings.
    must(findPills()[1]).dispatch("click");
    expect(must(findPills()[1]).getAttribute("aria-pressed")).toBe("true");
    const themeCards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(themeCards.map((card) => card.dataset.extensionId)).toEqual(["ext-theme"]);
    const themeGroups = descendants(mounted.content).filter(
      (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
    );
    expect(themeGroups).toHaveLength(0);

    // Click "全部" -> restores all 3 extensions (enabled first, then disabled sorted by name).
    must(findPills()[0]).dispatch("click");
    const restoredCards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(restoredCards.map((card) => card.dataset.extensionId)).toEqual([
      "ext-sidebar",
      "ext-theme",
      "ext-legacy",
    ]);
    mounted.dispose();

    // No filter bar (not even "全部") is rendered when no extension declares categories.
    const uncategorized = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => ({
        ...categorizedList,
        extensions: [must(categorizedList.extensions[2])],
      })),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() =>
      expect(textOf(uncategorized.content)).toContain("Uncategorized Extension"),
    );
    const categorySlot = must(
      descendants(uncategorized.content).find(
        (el) => el.className === "settings-extensions__category-slot",
      ),
    );
    expect(categorySlot.hidden).toBe(true);
    expect(
      descendants(uncategorized.content).filter((el) =>
        el.className.includes("settings-extensions__filters"),
      ),
    ).toHaveLength(0);
    expect(
      descendants(uncategorized.content).filter((el) =>
        el.className.includes("settings-extensions-filter-pill"),
      ),
    ).toHaveLength(0);
    expect(textOf(categorySlot)).toBe("");
    uncategorized.dispose();
  });

  it("filters extensions live by Chinese/English name, ID, and description alongside category filters", async () => {
    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleList()),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const searchInput = must(
      descendants(mounted.content).find((el) => el.tagName === "input" && el.type === "search"),
    );
    const clearSearchButton = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions__search-clear"),
      ),
    );
    const cardIds = () =>
      descendants(mounted.content)
        .filter((el) => el.tagName === "article" && Boolean(el.dataset.extensionId))
        .map((el) => el.dataset.extensionId);

    expect(clearSearchButton.hidden).toBe(true);

    // Match English name while locale is zh-CN.
    searchInput.value = "Thread Tree";
    searchInput.dispatch("input");
    expect(clearSearchButton.hidden).toBe(false);
    expect(cardIds()).toEqual(["sidebar-thread-tree"]);

    // Match Chinese description.
    searchInput.value = "子 Thread 角标";
    searchInput.dispatch("input");
    expect(cardIds()).toEqual(["sidebar-delegation-badges"]);

    // Match extension ID (including manifest-less invalid entries).
    searchInput.value = "broken-extension";
    searchInput.dispatch("input");
    expect(cardIds()).toEqual(["broken-extension"]);

    // Non-matching query shows empty-search state with reset action.
    searchInput.value = "nonexistent-keyword";
    searchInput.dispatch("input");
    expect(cardIds()).toEqual([]);
    expect(textOf(mounted.content)).toContain("未找到匹配的扩展");

    const resetButton = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && textOf(el).includes("清除筛选"),
      ),
    );
    resetButton.dispatch("click");
    expect(searchInput.value).toBe("");
    expect(clearSearchButton.hidden).toBe(true);
    expect(cardIds()).toHaveLength(4);

    // Search input instance remains mounted across filtering so focus is preserved.
    const sameInput = must(
      descendants(mounted.content).find((el) => el.tagName === "input" && el.type === "search"),
    );
    expect(sameInput).toBe(searchInput);
    mounted.dispose();
  });

  it("opens extension detail modal on row click or keyboard, ignores switch click bubbling, and renders metadata, GitHub link, details, screenshots, and Esc dismissal", async () => {
    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleList()),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const findDetailDialog = () =>
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      );

    const treeCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    const treeSwitch = must(
      descendants(treeCard).find((el) => el.tagName === "input" && el.type === "checkbox"),
    );

    // Clicking the row switch stops propagation and does not open the detail modal.
    treeSwitch.dispatchBubbling("click");
    expect(findDetailDialog()).toBeUndefined();

    // Unlisted local extension with repository renders a clickable star icon link without fake "0",
    // and clicking it stops propagation instead of opening the detail modal.
    const treeStarLink = must(
      descendants(treeCard).find(
        (el) => el.tagName === "a" && el.dataset.action === "open-repository",
      ),
    );
    expect(treeStarLink).toBeDefined();
    expect(treeStarLink.href).toBe("https://github.com/BytePioneer-AI/codex-host");
    expect(treeStarLink.target).toBe("_blank");
    expect(treeStarLink.rel).toBe("noopener noreferrer");
    expect(textOf(treeStarLink)).toBe("");
    expect(treeStarLink.getAttribute("aria-label")).toBe("GitHub 仓库");
    expect(descendants(treeCard).find((el) => el.dataset.metric === "downloads")).toBeUndefined();
    treeStarLink.dispatchBubbling("click");
    expect(findDetailDialog()).toBeUndefined();

    // Clicking the card row opens the centered detail modal.
    treeCard.dispatch("click");
    const dialog = must(findDetailDialog());
    expect(dialog).toBeDefined();
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.extensionId).toBe("sidebar-thread-tree");

    // Header: bilingual title, author, version, status badge, categories, GitHub link, and switch.
    expect(textOf(dialog)).toContain("侧栏委派树");
    expect(textOf(dialog)).toContain("作者：codexhost");
    expect(textOf(dialog)).toContain("v0.1.0");
    expect(textOf(dialog)).toContain("运行中");
    expect(textOf(dialog)).toContain("界面增强");
    expect(textOf(dialog)).toContain("效率与协作");

    const repoLink = must(descendants(dialog).find((el) => el.tagName === "a"));
    expect(repoLink).toBeDefined();
    expect(repoLink.href).toBe("https://github.com/BytePioneer-AI/codex-host");
    expect(repoLink.target).toBe("_blank");
    expect(repoLink.rel).toBe("noopener noreferrer");
    expect(textOf(repoLink)).toContain("GitHub 仓库");
    expect(
      descendants(repoLink).find((el) =>
        el.className.includes("settings-extensions-detail-modal__repo-stars"),
      ),
    ).toBeUndefined();
    expect(descendants(dialog).find((el) => el.dataset.metric === "downloads")).toBeUndefined();

    // Multi-paragraph localized details.
    const paragraphs = descendants(dialog).filter((el) =>
      el.className.includes("settings-extensions-detail-modal__paragraph"),
    );
    expect(paragraphs.map((p) => textOf(p))).toEqual([
      "在侧栏展开父 Thread 查看委派子任务。",
      "归组仅作用于本机列表，不影响远程行。",
    ]);

    // Screenshot gallery + interactive large preview.
    const galleryImages = descendants(dialog).filter(
      (el) =>
        el.tagName === "img" && !el.className.includes("settings-extensions-detail-modal__preview"),
    );
    expect(galleryImages.map((img) => img.src)).toEqual([SAMPLE_SCREENSHOT_1, SAMPLE_SCREENSHOT_2]);

    const previewStage = must(
      descendants(dialog).find((el) =>
        el.className.includes("settings-extensions-detail-modal__preview"),
      ),
    );
    const previewImg = must(descendants(previewStage).find((el) => el.tagName === "img"));
    expect(previewStage.hidden).toBe(true);

    const thumbButtons = descendants(dialog).filter((el) =>
      el.className.includes("settings-extensions-detail-modal__thumb"),
    );
    must(thumbButtons[0]).dispatch("click");
    expect(previewStage.hidden).toBe(false);
    expect(previewImg.src).toBe(SAMPLE_SCREENSHOT_1);
    expect(must(thumbButtons[0]).getAttribute("aria-pressed")).toBe("true");

    // Clicking the second thumbnail switches the large preview image.
    must(thumbButtons[1]).dispatch("click");
    expect(previewImg.src).toBe(SAMPLE_SCREENSHOT_2);
    expect(must(thumbButtons[1]).getAttribute("aria-pressed")).toBe("true");

    // First Escape closes the large preview while keeping the detail modal open.
    dialog.dispatch("keydown", { key: "Escape" });
    expect(previewStage.hidden).toBe(true);
    expect(dialog.open).toBe(true);

    // Healthy extension detail modal stays clean without technical metadata or diagnostic alert.
    expect(descendants(dialog).find((el) => el.tagName === "details")).toBeUndefined();
    const healthyAlert = must(
      descendants(dialog).find((el) =>
        el.className.includes("settings-extensions-detail-modal__alert"),
      ),
    );
    expect(healthyAlert.hidden).toBe(true);
    expect(textOf(dialog)).not.toContain("技术信息");
    expect(textOf(dialog)).not.toContain("sidebar-thread-tree");
    expect(textOf(dialog)).not.toContain("侧栏 Thread 布局");
    expect(textOf(dialog)).not.toContain("侧栏 Thread 角标");
    expect(textOf(dialog)).not.toContain(SAMPLE_TREE_HASH);
    expect(textOf(dialog)).not.toContain("SHA-256");

    // Second Escape closes the detail modal.
    dialog.dispatch("keydown", { key: "Escape" });
    expect(dialog.open).toBe(false);
    expect(findDetailDialog()).toBeUndefined();

    // Unhealthy extension detail modal surfaces diagnostic alert without technical disclosure.
    const brokenCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "broken-extension",
      ),
    );
    brokenCard.dispatch("click");
    const brokenDialog = must(findDetailDialog());
    expect(brokenDialog.open).toBe(true);
    const brokenAlert = must(
      descendants(brokenDialog).find((el) =>
        el.className.includes("settings-extensions-detail-modal__alert"),
      ),
    );
    expect(brokenAlert.hidden).toBe(false);
    expect(brokenAlert.dataset.tone).toBe("danger");
    expect(textOf(brokenAlert)).toContain("Invalid manifest.json");
    expect(descendants(brokenDialog).find((el) => el.tagName === "details")).toBeUndefined();
    brokenDialog.close();
    expect(findDetailDialog()).toBeUndefined();

    // Keyboard Enter on a row without `details` falls back to `description`, and backdrop click closes it.
    const badgesCard = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-delegation-badges",
      ),
    );
    badgesCard.dispatch("keydown", { key: "Enter" });
    const badgesDialog = must(findDetailDialog());
    expect(badgesDialog.open).toBe(true);
    expect(textOf(badgesDialog)).toContain("显示子 Thread 角标");
    expect(descendants(badgesDialog).filter((el) => el.tagName === "a")).toHaveLength(0);
    badgesDialog.dispatch("click", { target: badgesDialog });
    expect(badgesDialog.open).toBe(false);
    expect(findDetailDialog()).toBeUndefined();
    mounted.dispose();

    // English locale renders English details, GitHub label, and blocks unsafe repository protocols.
    const unsafeRepoList = sampleList({
      extensions: sampleList().extensions.map((item) =>
        item.id === "sidebar-thread-tree" && item.manifest
          ? {
              ...item,
              manifest: {
                ...item.manifest,
                repository: "javascript:alert(1)",
              },
            }
          : item,
      ),
    });
    const enMount = mountPage("en", () => ({
      listDesktopExtensions: vi.fn(async () => unsafeRepoList),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(enMount.content)).toContain("Sidebar Thread Tree"));
    const enTreeCard = must(
      descendants(enMount.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    // Unsafe repository protocol is blocked on the card star link as well.
    expect(descendants(enTreeCard).filter((el) => el.tagName === "a")).toHaveLength(0);
    enTreeCard.dispatch("keydown", { key: " " });
    const enDialog = must(
      descendants(enMount.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    expect(enDialog.open).toBe(true);
    expect(textOf(enDialog)).toContain("By codexhost");
    expect(textOf(enDialog)).toContain("Expand a parent Thread to inspect delegated children.");
    expect(textOf(enDialog)).toContain("Grouping stays local and leaves remote rows untouched.");
    expect(descendants(enDialog).filter((el) => el.tagName === "a")).toHaveLength(0);
    enMount.dispose();
  });

  it("toggles extension state from inside the detail modal and stays open across 5s polling updates", async () => {
    vi.useFakeTimers();
    const listDesktopExtensions = vi
      .fn<() => Promise<DesktopExtensionsListResult>>()
      .mockResolvedValueOnce(sampleList())
      .mockResolvedValueOnce(
        sampleList({
          configuration: { version: 1, revision: 5, enabled: [] },
          extensions: sampleList().extensions.map((item) =>
            item.id === "sidebar-thread-tree"
              ? { ...item, enabled: false, status: { state: "disabled" } }
              : item,
          ),
        }),
      )
      .mockResolvedValueOnce(
        sampleList({
          configuration: { version: 1, revision: 6, enabled: ["sidebar-thread-tree"] },
          extensions: sampleList().extensions.map((item) =>
            item.id === "sidebar-thread-tree"
              ? { ...item, enabled: true, status: { state: "waiting" } }
              : item,
          ),
        }),
      );
    const disableDesktopExtension = vi.fn(async (): Promise<DesktopExtensionMutationResult> => ({
      state: "saved",
      configuration: { version: 1, revision: 5, enabled: [] },
    }));

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions,
      enableDesktopExtension: vi.fn(),
      disableDesktopExtension,
      disableAllDesktopExtensionsAndReload: vi.fn(),
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
    const modalSwitch = must(
      descendants(dialog).find((el) => el.tagName === "input" && el.type === "checkbox"),
    );
    expect(modalSwitch.checked).toBe(true);

    // Toggle off from inside the detail modal.
    modalSwitch.checked = false;
    modalSwitch.dispatch("change");

    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(2));
    expect(disableDesktopExtension).toHaveBeenCalledWith({
      id: "sidebar-thread-tree",
      expectedRevision: 4,
    });
    expect(dialog.open).toBe(true);
    expect(modalSwitch.checked).toBe(false);
    expect(textOf(dialog)).toContain("未启用");

    // 5-second background poll updates modal status/switch live without closing the modal
    // or needlessly rebuilding unchanged Markdown details DOM.
    const paragraphBeforePoll = descendants(dialog).find((el) =>
      el.className.includes("settings-extensions-detail-modal__paragraph"),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(3));
    expect(dialog.open).toBe(true);
    expect(modalSwitch.checked).toBe(true);
    expect(textOf(dialog)).toContain("等待 Desktop");
    const paragraphAfterPoll = descendants(dialog).find((el) =>
      el.className.includes("settings-extensions-detail-modal__paragraph"),
    );
    expect(paragraphAfterPoll).toBe(paragraphBeforePoll);
    mounted.dispose();
  });

  it("passes expectedRevision, blocks duplicate clicks while mutating, and updates state on save", async () => {
    const pendingDisable = deferred<DesktopExtensionMutationResult>();
    const listDesktopExtensions = vi
      .fn<() => Promise<DesktopExtensionsListResult>>()
      .mockResolvedValueOnce(sampleList())
      .mockResolvedValueOnce(
        sampleList({
          configuration: { version: 1, revision: 5, enabled: [] },
          extensions: sampleList().extensions.map((item) =>
            item.id === "sidebar-thread-tree"
              ? { ...item, enabled: false, status: { state: "disabled" } }
              : item,
          ),
        }),
      );
    const disableDesktopExtension = vi.fn(() => pendingDisable.promise);
    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions,
      enableDesktopExtension: vi.fn(),
      disableDesktopExtension,
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const findTreeSwitch = () =>
      must(
        descendants(mounted.content).find(
          (el) => el.tagName === "input" && el.getAttribute("aria-label")?.includes("侧栏委派树"),
        ),
      );

    const initialSwitch = findTreeSwitch();
    initialSwitch.checked = false;
    initialSwitch.dispatch("change");

    expect(disableDesktopExtension).toHaveBeenCalledTimes(1);
    expect(disableDesktopExtension).toHaveBeenCalledWith({
      id: "sidebar-thread-tree",
      expectedRevision: 4,
    });

    // All switches stay disabled while a mutation is in flight to prevent duplicate clicks.
    const switchesWhileBusy = descendants(mounted.content).filter(
      (el) => el.tagName === "input" && el.type === "checkbox",
    );
    expect(switchesWhileBusy.every((el) => el.disabled)).toBe(true);
    must(switchesWhileBusy[0]).dispatch("change");
    expect(disableDesktopExtension).toHaveBeenCalledTimes(1);

    pendingDisable.resolve({
      state: "saved",
      configuration: { version: 1, revision: 5, enabled: [] },
    });

    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(2));
    expect(textOf(mounted.content)).toContain("已禁用“侧栏委派树”。");
    expect(findTreeSwitch().checked).toBe(false);
    mounted.dispose();
  });

  it("handles slot-conflict and revision-conflict with clear feedback and automatic reload", async () => {
    const listDesktopExtensions = vi
      .fn<() => Promise<DesktopExtensionsListResult>>()
      .mockResolvedValueOnce(sampleList())
      .mockResolvedValueOnce(
        sampleList({
          configuration: { version: 1, revision: 9, enabled: ["sidebar-thread-tree"] },
        }),
      );
    const enableDesktopExtension = vi
      .fn()
      .mockResolvedValueOnce({
        state: "slot-conflict",
        conflictWith: "sidebar-thread-tree",
      } satisfies DesktopExtensionMutationResult)
      .mockResolvedValueOnce({
        state: "revision-conflict",
        revision: 9,
      } satisfies DesktopExtensionMutationResult);

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions,
      enableDesktopExtension,
      disableDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("Delegation Badges"));

    const findBadgeSwitch = () =>
      must(
        descendants(mounted.content).find(
          (el) =>
            el.tagName === "input" && el.getAttribute("aria-label")?.includes("Delegation Badges"),
        ),
      );

    // 1) slot-conflict reports occupied slot and localized conflicting extension name
    const firstSwitch = findBadgeSwitch();
    firstSwitch.checked = true;
    firstSwitch.dispatch("change");

    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));
    const banner = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions__banner"),
      ),
    );
    expect(banner.hidden).toBe(false);
    expect(textOf(banner)).toContain("sidebar.thread-badge");
    expect(textOf(banner)).toContain("侧栏委派树 (sidebar-thread-tree)");
    expect(findBadgeSwitch().checked).toBe(false);

    // 2) revision-conflict automatically reloads latest list and asks user to retry
    const secondSwitch = findBadgeSwitch();
    secondSwitch.checked = true;
    secondSwitch.dispatch("change");

    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(2));
    expect(textOf(banner)).toContain("已自动刷新最新列表");
    mounted.dispose();
  });

  it("exposes directory path copy and emergency recovery inside the header more menu, with Esc/outside close and confirmation dialog", async () => {
    const listDesktopExtensions = vi
      .fn<() => Promise<DesktopExtensionsListResult>>()
      .mockResolvedValueOnce(sampleList())
      .mockResolvedValueOnce(
        sampleList({
          configuration: { version: 1, revision: 5, enabled: [] },
          extensions: sampleList().extensions.map((item) =>
            item.id === "sidebar-thread-tree"
              ? { ...item, enabled: false, status: { state: "disabled" } }
              : item,
          ),
        }),
      );
    const disableAllDesktopExtensionsAndReload = vi.fn(
      async (): Promise<DesktopExtensionMutationResult> => ({
        state: "saved",
        configuration: {
          version: 1,
          revision: 5,
          enabled: [],
          reloadToken: "11111111-1111-4111-8111-111111111111",
        },
      }),
    );

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions,
      enableDesktopExtension: vi.fn(),
      disableDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload,
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

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
    expect(moreMenu.hidden).toBe(true);
    expect(moreButton.getAttribute("aria-expanded")).toBe("false");

    // Open menu -> Escape closes it; open again -> outside click closes it.
    moreButton.dispatch("click");
    expect(moreMenu.hidden).toBe(false);
    expect(moreButton.getAttribute("aria-expanded")).toBe("true");
    mounted.document.dispatch("keydown", { key: "Escape" });
    expect(moreMenu.hidden).toBe(true);

    moreButton.dispatch("click");
    expect(moreMenu.hidden).toBe(false);
    mounted.document.dispatch("click", { target: mounted.content });
    expect(moreMenu.hidden).toBe(true);

    // Copy extensions directory path from menu.
    moreButton.dispatch("click");
    const copyMenuItem = must(
      descendants(moreMenu).find(
        (el) => el.tagName === "button" && el.dataset.action === "copy-directory",
      ),
    );
    expect(textOf(copyMenuItem)).toContain("复制扩展目录路径");
    expect(textOf(copyMenuItem)).toContain("$CODEXHOST_DATA_DIR/desktop-extensions/");
    copyMenuItem.dispatch("click");
    expect(moreMenu.hidden).toBe(true);
    await vi.waitFor(() =>
      expect(mounted.document.clipboardWriteText).toHaveBeenCalledWith(
        "$CODEXHOST_DATA_DIR/desktop-extensions/",
      ),
    );
    const banner = must(
      descendants(mounted.content).find((el) =>
        el.className.includes("settings-extensions__banner"),
      ),
    );
    expect(textOf(banner)).toBe("已复制扩展目录路径。");

    // Trigger emergency recovery from menu -> opens confirmation dialog.
    moreButton.dispatch("click");
    const recoveryMenuItem = must(
      descendants(moreMenu).find(
        (el) => el.tagName === "button" && el.dataset.action === "open-recovery",
      ),
    );
    expect(textOf(recoveryMenuItem)).toContain("禁用全部扩展并重载 Desktop");
    recoveryMenuItem.dispatch("click");
    expect(moreMenu.hidden).toBe(true);

    // Confirmation dialog opens; RPC is not sent until confirmed.
    expect(disableAllDesktopExtensionsAndReload).not.toHaveBeenCalled();
    const dialog = must(descendants(mounted.content).find((el) => el.tagName === "dialog"));
    expect(dialog.open).toBe(true);
    const form = must(descendants(dialog).find((el) => el.tagName === "form"));
    form.dispatch("submit");

    await vi.waitFor(() => expect(disableAllDesktopExtensionsAndReload).toHaveBeenCalledTimes(1));
    expect(disableAllDesktopExtensionsAndReload).toHaveBeenCalledWith({ expectedRevision: 4 });
    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(2));
    expect(textOf(banner)).toBe("恢复指令已保存，等待 Desktop Controller 重载窗口。");
    mounted.dispose();
  });

  it("switches extension content language live across cards, filter pills, and detail modal, and persists to localStorage", async () => {
    const storage = new Map<string, string>();
    const client: RendererDesktopExtensionsClient = {
      listDesktopExtensions: vi.fn(async () => sampleList()),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    };
    const mounted = mountPage("zh-CN", () => client, storage);
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

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

    // Defaults to Follow system (zh-CN shell -> "中").
    expect(textOf(localeButton)).toBe("中");
    expect(localeMenu.hidden).toBe(true);

    // Mutually exclusive with the "..." menu and dismissible via Escape / outside click.
    moreButton.dispatch("click");
    expect(moreMenu.hidden).toBe(false);
    localeButton.dispatch("click");
    expect(localeMenu.hidden).toBe(false);
    expect(moreMenu.hidden).toBe(true);
    mounted.document.dispatch("keydown", { key: "Escape" });
    expect(localeMenu.hidden).toBe(true);

    localeButton.dispatch("click");
    mounted.document.dispatch("click", { target: mounted.content });
    expect(localeMenu.hidden).toBe(true);

    // Switch to English -> updates cards, category filter pills, and detail modal while keeping shell Chinese.
    localeButton.dispatch("click");
    const enOption = must(descendants(localeMenu).find((el) => el.dataset.contentLocale === "en"));
    enOption.dispatch("click");
    expect(localeMenu.hidden).toBe(true);
    expect(textOf(localeButton)).toBe("EN");
    expect(storage.get("codexhost.desktopExtensions.contentLocale")).toBe("en");
    expect(enOption.getAttribute("aria-checked")).toBe("true");
    // Shell controls remain Chinese.
    expect(textOf(mounted.content)).toContain("导入插件");

    const filterLabels = () =>
      descendants(mounted.content)
        .filter((el) => el.className.includes("settings-extensions-filter-pill"))
        .map((pill) => textOf(pill));
    expect(filterLabels()).toEqual(["All", "Interface", "Workflow"]);

    const treeCardEn = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
      ),
    );
    expect(textOf(treeCardEn)).toContain("Sidebar Thread Tree");
    expect(textOf(treeCardEn)).toContain("Groups delegated Threads");
    expect(
      textOf(
        must(
          descendants(treeCardEn).find(
            (el) => el.className === "settings-extensions-card__categories-text",
          ),
        ),
      ),
    ).toBe("Interface · Workflow");

    // Detail modal reflects the selected English content locale.
    treeCardEn.dispatch("click");
    const detailDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
      ),
    );
    expect(textOf(detailDialog)).toContain("Sidebar Thread Tree");
    expect(textOf(detailDialog)).toContain("Expand a parent Thread to inspect delegated children.");
    expect(
      descendants(detailDialog)
        .filter((el) => el.className.includes("settings-extensions-category-chip"))
        .map((chip) => textOf(chip)),
    ).toEqual(["Interface", "Workflow"]);
    detailDialog.close();

    // Switch back to Simplified Chinese, then Follow system.
    localeButton.dispatch("click");
    must(descendants(localeMenu).find((el) => el.dataset.contentLocale === "zh-CN")).dispatch(
      "click",
    );
    expect(textOf(localeButton)).toBe("中");
    expect(storage.get("codexhost.desktopExtensions.contentLocale")).toBe("zh-CN");
    expect(filterLabels()).toEqual(["全部", "界面增强", "效率与协作"]);

    localeButton.dispatch("click");
    must(descendants(localeMenu).find((el) => el.dataset.contentLocale === "system")).dispatch(
      "click",
    );
    expect(textOf(localeButton)).toBe("中");
    expect(storage.get("codexhost.desktopExtensions.contentLocale")).toBe("system");
    mounted.dispose();

    // Persisted "en" preference is restored automatically on next mount.
    storage.set("codexhost.desktopExtensions.contentLocale", "en");
    const restored = mountPage("zh-CN", () => client, storage);
    await vi.waitFor(() => expect(textOf(restored.content)).toContain("Sidebar Thread Tree"));
    const restoredLocaleBtn = must(
      descendants(restored.content).find(
        (el) => el.tagName === "button" && el.dataset.action === "content-locale-menu",
      ),
    );
    expect(textOf(restoredLocaleBtn)).toBe("EN");
    restored.dispose();
  });

  it("opens the Create plugin modal with a copyable AI prompt and registry submission links", async () => {
    const client = {
      listDesktopExtensions: vi.fn(async () => sampleList()),
    };
    const mounted = mountPage("zh-CN", () => client);
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const createButton = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.action === "open-create",
      ),
    );
    expect(textOf(createButton)).toBe("制作插件");
    createButton.dispatch("click");

    const createDialog = must(
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "dialog" && el.className.includes("settings-extensions-create-dialog"),
      ),
    );
    expect(createDialog.open).toBe(true);
    const promptTextarea = must(
      descendants(createDialog).find(
        (el) => el.tagName === "textarea" && el.dataset.createField === "prompt",
      ),
    );
    expect(promptTextarea.value).toContain("codexhost-add-desktop-extension/SKILL.md");
    expect(promptTextarea.value).toContain("BytePioneer-AI/codexhost-extensions-registry");

    const skillLink = must(
      descendants(createDialog).find(
        (el) => el.tagName === "a" && el.dataset.createLink === "skill",
      ),
    );
    expect(skillLink.href).toBe(
      "https://github.com/BytePioneer-AI/codex-host/blob/main/.agents/skills/codexhost-add-desktop-extension/SKILL.md",
    );
    expect(skillLink.target).toBe("_blank");
    expect(skillLink.rel).toBe("noopener noreferrer");

    const submitLink = must(
      descendants(createDialog).find(
        (el) => el.tagName === "a" && el.dataset.createLink === "submit",
      ),
    );
    expect(submitLink.href).toBe(
      "https://github.com/BytePioneer-AI/codexhost-extensions-registry/issues/new/choose",
    );
    expect(submitLink.target).toBe("_blank");
    expect(submitLink.rel).toBe("noopener noreferrer");

    const copyPromptButton = must(
      descendants(createDialog).find(
        (el) => el.tagName === "button" && el.dataset.action === "copy-create-prompt",
      ),
    );
    copyPromptButton.dispatch("click");
    await vi.waitFor(() =>
      expect(mounted.document.clipboardWriteText).toHaveBeenCalledWith(promptTextarea.value),
    );
    expect(textOf(copyPromptButton)).toBe("已复制");

    createDialog.close();
    mounted.dispose();
  });

  it("shows an unavailable state when the Host does not support Desktop extension RPCs", async () => {
    const mounted = mountPage("en", () => ({
      listDesktopExtensions: vi.fn(async () => {
        throw new RendererMethodUnavailableError("codexhost/desktop/extensions/list", {
          code: -32601,
        });
      }),
    }));
    await vi.waitFor(() =>
      expect(textOf(mounted.content)).toContain("Desktop extension management is unavailable"),
    );
    const recoveryMenuItem = must(
      descendants(mounted.content).find(
        (el) => el.tagName === "button" && el.dataset.action === "open-recovery",
      ),
    );
    expect(recoveryMenuItem.disabled).toBe(true);
    mounted.dispose();
  });
});
