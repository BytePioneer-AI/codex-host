import type {
  DesktopExtensionMutationResult,
  DesktopExtensionsListResult,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => ({ classList: { add() {} } }),
  isRendererSettingsIconName: () => true,
}));

import { RendererMethodUnavailableError } from "../../src/renderer-request-sender.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import {
  createDesktopExtensionsSettingsPage,
  type RendererDesktopExtensionsClient,
} from "../../src/settings/desktop-extensions-page.js";
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

  focus(): void {}
}

class FakeDocument {
  readonly clipboardWriteText = vi.fn(async () => undefined);
  readonly defaultView: Window;
  visibilityState: DocumentVisibilityState = "visible";
  readonly #listeners = new Map<string, Set<() => void>>();

  constructor() {
    this.defaultView = {
      navigator: { clipboard: { writeText: this.clipboardWriteText } },
    } as unknown as Window;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase(), this);
  }

  addEventListener(name: string, listener: () => void): void {
    const bucket = this.#listeners.get(name) ?? new Set();
    bucket.add(listener);
    this.#listeners.set(name, bucket);
  }

  removeEventListener(name: string, listener: () => void): void {
    this.#listeners.get(name)?.delete(listener);
  }
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
          name: "Delegation Badges",
          version: "0.2.0",
          description: { en: "Shows child badges", "zh-CN": "显示子 Thread 角标" },
          desktopApi: 1,
          desktop: { script: "desktop.js" },
          slots: ["sidebar.thread-badge"],
          categories: ["sidebar"],
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
  it("registers desktop-extensions in default settings pages with bilingual labels", () => {
    const zhPage = createDefaultRendererSettingsPages(rendererSettingsMessages("zh-CN")).find(
      ({ id }) => id === "desktop-extensions",
    );
    const enPage = createDefaultRendererSettingsPages(rendererSettingsMessages("en")).find(
      ({ id }) => id === "desktop-extensions",
    );
    expect(zhPage?.label).toBe("Desktop 扩展");
    expect(enPage?.label).toBe("Desktop Extensions");
  });

  it("renders empty-state directory guidance in Chinese and English", async () => {
    const client: RendererDesktopExtensionsClient = {
      listDesktopExtensions: vi.fn(async () => ({
        configuration: { version: 1, revision: 0, enabled: [] },
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
    expect(textOf(zhMount.content)).toContain("等待 Desktop 连接");
    zhMount.dispose();

    const enMount = mountPage("en", () => client);
    await vi.waitFor(() =>
      expect(textOf(enMount.content)).toContain("No Desktop extensions found"),
    );
    expect(textOf(enMount.content)).toContain("$CODEXHOST_DATA_DIR/desktop-extensions/<id>/");
    enMount.dispose();
  });

  it("displays bilingual names, category badges, slot labels, attention-first groups, and disables invalid toggles", async () => {
    const client: RendererDesktopExtensionsClient = {
      listDesktopExtensions: vi.fn(async () => sampleList()),
      enableDesktopExtension: vi.fn(),
      disableDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    };
    const mounted = mountPage("zh-CN", () => client);
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const groups = descendants(mounted.content).filter(
      (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
    );
    expect(groups.map((group) => group.dataset.extensionGroup)).toEqual([
      "attention",
      "enabled",
      "disabled",
    ]);
    expect(
      groups.map((group) =>
        textOf(
          descendants(group).find((el) => el.className === "settings-extensions__group-title"),
        ),
      ),
    ).toEqual(["需要处理", "已启用", "未启用"]);

    const grids = descendants(mounted.content).filter(
      (element) => element.className === "settings-extensions-grid",
    );
    expect(grids).toHaveLength(3);

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

    const incompatibleSwitch = descendants(cards[0]!).find((el) => el.tagName === "input")!;
    const invalidSwitch = descendants(cards[1]!).find((el) => el.tagName === "input")!;
    expect(incompatibleSwitch.disabled).toBe(true);
    expect(invalidSwitch.disabled).toBe(true);
    expect(textOf(cards[0]!)).toContain("Desktop API 2 requires a newer codexhost");
    expect(textOf(cards[1]!)).toContain("Invalid manifest.json");

    const treeCard = cards[2]!;
    expect(textOf(treeCard)).toContain("侧栏委派树");
    expect(textOf(treeCard)).toContain("codexhost · v0.1.0");
    expect(textOf(treeCard)).toContain("归组委派的 Thread");
    expect(textOf(treeCard)).toContain("运行中");
    const treeCategoryChips = descendants(treeCard).filter((el) =>
      el.className.includes("settings-extensions-category-chip"),
    );
    expect(treeCategoryChips.map((chip) => textOf(chip))).toEqual(["侧栏", "多会话协作"]);
    // Compact card shows author · version but omits raw ID, slots, hash, and initial-letter avatar.
    expect(textOf(treeCard)).not.toContain("sidebar-thread-tree");
    expect(textOf(treeCard)).not.toContain("侧栏 Thread 布局");
    expect(textOf(treeCard)).not.toContain("侧栏 Thread 角标");
    expect(textOf(treeCard)).not.toContain(SAMPLE_TREE_HASH);
    expect(
      descendants(treeCard).filter((el) => el.className.includes("settings-extensions-slot-chip")),
    ).toHaveLength(0);
    expect(descendants(treeCard).filter((el) => el.className.includes("__icon"))).toHaveLength(0);

    const treeFooter = descendants(treeCard).find(
      (el) => el.className === "settings-extensions-card__footer",
    )!;
    expect(treeFooter).toBeDefined();
    expect(
      descendants(treeFooter).find((el) => el.tagName === "input" && el.type === "checkbox"),
    ).toBeDefined();

    const badgesCard = cards[3]!;
    expect(textOf(badgesCard)).toContain("Delegation Badges");
    expect(textOf(badgesCard)).toContain("v0.2.0");
    // Disabled cards omit redundant neutral status badges in header.
    expect(
      descendants(badgesCard).filter((el) => el.className.includes("settings-extensions-badge")),
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
    ).toEqual(["Needs Attention", "Enabled", "Disabled"]);
    const enTreeCard = descendants(enMount.content).find(
      (element) => element.dataset.extensionId === "sidebar-thread-tree",
    )!;
    expect(textOf(enTreeCard)).toContain("Sidebar Thread Tree");
    expect(textOf(enTreeCard)).toContain("Groups delegated Threads");
    expect(
      descendants(enTreeCard)
        .filter((el) => el.className.includes("settings-extensions-category-chip"))
        .map((chip) => textOf(chip)),
    ).toEqual(["Sidebar", "Workflow"]);
    enMount.dispose();
  });

  it("groups all attention, enabled, and disabled states in priority order and omits empty group headings", async () => {
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
            categories: ["composer"],
          },
        },
      ],
    };

    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => allStatesList),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("主侧栏布局"));

    const cards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(cards.map((card) => card.dataset.extensionId)).toEqual([
      "conflict-ext",
      "failed-ext",
      "waiting-ext",
      "running-ext",
      "disabled-ext",
    ]);
    // Inline conflict occupant name uses localized text and failed error stays exposed inline.
    expect(textOf(cards[0]!)).toContain("主侧栏布局 (running-ext)");
    expect(textOf(cards[1]!)).toContain("activate() threw TypeError");
    mounted.dispose();

    // When only running extensions exist, attention and disabled group headings are omitted.
    const onlyRunning = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => ({
        ...allStatesList,
        extensions: [allStatesList.extensions[3]!],
      })),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(onlyRunning.content)).toContain("主侧栏布局"));
    const renderedGroups = descendants(onlyRunning.content).filter(
      (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
    );
    expect(renderedGroups.map((group) => group.dataset.extensionGroup)).toEqual(["enabled"]);
    expect(textOf(onlyRunning.content)).not.toContain("需要处理");
    expect(textOf(onlyRunning.content)).not.toContain("未启用");
    onlyRunning.dispose();
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
            categories: ["workflow", "sidebar"],
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
      "侧栏",
      "外观主题",
      "多会话协作",
    ]);
    expect(findPills()[0]!.getAttribute("aria-pressed")).toBe("true");

    // Click "外观主题" -> only ext-theme remains and empty "已启用" group is omitted.
    findPills()[2]!.dispatch("click");
    expect(findPills()[2]!.getAttribute("aria-pressed")).toBe("true");
    const themeCards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(themeCards.map((card) => card.dataset.extensionId)).toEqual(["ext-theme"]);
    const themeGroups = descendants(mounted.content).filter(
      (element) => element.tagName === "section" && Boolean(element.dataset.extensionGroup),
    );
    expect(themeGroups.map((group) => group.dataset.extensionGroup)).toEqual(["disabled"]);

    // Click "全部" -> restores all 3 extensions.
    findPills()[0]!.dispatch("click");
    const restoredCards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(restoredCards.map((card) => card.dataset.extensionId)).toEqual([
      "ext-sidebar",
      "ext-theme",
      "ext-legacy",
    ]);
    mounted.dispose();

    // No filter bar is rendered when no extension declares categories.
    const uncategorized = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => ({
        ...categorizedList,
        extensions: [categorizedList.extensions[2]!],
      })),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() =>
      expect(textOf(uncategorized.content)).toContain("Uncategorized Extension"),
    );
    expect(
      descendants(uncategorized.content).filter((el) =>
        el.className.includes("settings-extensions__filters"),
      ),
    ).toHaveLength(0);
    uncategorized.dispose();
  });

  it("filters extensions live by Chinese/English name, ID, and description alongside category filters", async () => {
    const mounted = mountPage("zh-CN", () => ({
      listDesktopExtensions: vi.fn(async () => sampleList()),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    }));
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));

    const searchInput = descendants(mounted.content).find(
      (el) => el.tagName === "input" && el.type === "search",
    )!;
    const clearSearchButton = descendants(mounted.content).find((el) =>
      el.className.includes("settings-extensions__search-clear"),
    )!;
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

    const resetButton = descendants(mounted.content).find(
      (el) => el.tagName === "button" && textOf(el).includes("清除筛选"),
    )!;
    resetButton.dispatch("click");
    expect(searchInput.value).toBe("");
    expect(clearSearchButton.hidden).toBe(true);
    expect(cardIds()).toHaveLength(4);

    // Search input instance remains mounted across filtering so focus is preserved.
    const sameInput = descendants(mounted.content).find(
      (el) => el.tagName === "input" && el.type === "search",
    )!;
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

    const treeCard = descendants(mounted.content).find(
      (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
    )!;
    const treeSwitch = descendants(treeCard).find(
      (el) => el.tagName === "input" && el.type === "checkbox",
    )!;

    // Clicking the row switch stops propagation and does not open the detail modal.
    treeSwitch.dispatchBubbling("click");
    expect(findDetailDialog()).toBeUndefined();

    // Clicking the card row opens the centered detail modal.
    treeCard.dispatch("click");
    const dialog = findDetailDialog()!;
    expect(dialog).toBeDefined();
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.extensionId).toBe("sidebar-thread-tree");

    // Header: bilingual title, author, version, status badge, categories, GitHub link, and switch.
    expect(textOf(dialog)).toContain("侧栏委派树");
    expect(textOf(dialog)).toContain("作者：codexhost");
    expect(textOf(dialog)).toContain("v0.1.0");
    expect(textOf(dialog)).toContain("运行中");
    expect(textOf(dialog)).toContain("侧栏");
    expect(textOf(dialog)).toContain("多会话协作");

    const repoLink = descendants(dialog).find((el) => el.tagName === "a")!;
    expect(repoLink).toBeDefined();
    expect(repoLink.href).toBe("https://github.com/BytePioneer-AI/codex-host");
    expect(repoLink.target).toBe("_blank");
    expect(repoLink.rel).toBe("noopener noreferrer");
    expect(textOf(repoLink)).toContain("GitHub 仓库");

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

    const previewStage = descendants(dialog).find((el) =>
      el.className.includes("settings-extensions-detail-modal__preview"),
    )!;
    const previewImg = descendants(previewStage).find((el) => el.tagName === "img")!;
    expect(previewStage.hidden).toBe(true);

    const thumbButtons = descendants(dialog).filter((el) =>
      el.className.includes("settings-extensions-detail-modal__thumb"),
    );
    thumbButtons[0]!.dispatch("click");
    expect(previewStage.hidden).toBe(false);
    expect(previewImg.src).toBe(SAMPLE_SCREENSHOT_1);
    expect(thumbButtons[0]!.getAttribute("aria-pressed")).toBe("true");

    // Clicking the second thumbnail switches the large preview image.
    thumbButtons[1]!.dispatch("click");
    expect(previewImg.src).toBe(SAMPLE_SCREENSHOT_2);
    expect(thumbButtons[1]!.getAttribute("aria-pressed")).toBe("true");

    // First Escape closes the large preview while keeping the detail modal open.
    dialog.dispatch("keydown", { key: "Escape" });
    expect(previewStage.hidden).toBe(true);
    expect(dialog.open).toBe(true);

    // Technical details live inside the subtle bottom <details> disclosure.
    const techDisclosure = descendants(dialog).find((el) => el.tagName === "details")!;
    expect(techDisclosure).toBeDefined();
    expect(textOf(techDisclosure)).toContain("sidebar-thread-tree");
    expect(textOf(techDisclosure)).toContain("侧栏 Thread 布局");
    expect(textOf(techDisclosure)).toContain("侧栏 Thread 角标");
    expect(textOf(techDisclosure)).toContain(SAMPLE_TREE_HASH);

    // Second Escape closes the detail modal.
    dialog.dispatch("keydown", { key: "Escape" });
    expect(dialog.open).toBe(false);
    expect(findDetailDialog()).toBeUndefined();

    // Keyboard Enter on a row without `details` falls back to `description`, and backdrop click closes it.
    const badgesCard = descendants(mounted.content).find(
      (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-delegation-badges",
    )!;
    badgesCard.dispatch("keydown", { key: "Enter" });
    const badgesDialog = findDetailDialog()!;
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
    const enTreeCard = descendants(enMount.content).find(
      (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
    )!;
    enTreeCard.dispatch("keydown", { key: " " });
    const enDialog = descendants(enMount.content).find(
      (el) => el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
    )!;
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

    const treeCard = descendants(mounted.content).find(
      (el) => el.tagName === "article" && el.dataset.extensionId === "sidebar-thread-tree",
    )!;
    treeCard.dispatch("click");

    const dialog = descendants(mounted.content).find(
      (el) => el.tagName === "dialog" && el.className.includes("settings-extensions-detail-dialog"),
    )!;
    const modalSwitch = descendants(dialog).find(
      (el) => el.tagName === "input" && el.type === "checkbox",
    )!;
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

    // 5-second background poll updates modal status/switch live without closing the modal.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(3));
    expect(dialog.open).toBe(true);
    expect(modalSwitch.checked).toBe(true);
    expect(textOf(dialog)).toContain("等待 Desktop");
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
      descendants(mounted.content).find(
        (el) => el.tagName === "input" && el.getAttribute("aria-label")?.includes("侧栏委派树"),
      )!;

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
    switchesWhileBusy[0]!.dispatch("change");
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
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "input" && el.getAttribute("aria-label")?.includes("Delegation Badges"),
      )!;

    // 1) slot-conflict reports occupied slot and localized conflicting extension name
    const firstSwitch = findBadgeSwitch();
    firstSwitch.checked = true;
    firstSwitch.dispatch("change");

    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("侧栏委派树"));
    const banner = descendants(mounted.content).find((el) =>
      el.className.includes("settings-extensions__banner"),
    )!;
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

  it("requires confirmation before disabling all extensions and reports pending reload accurately", async () => {
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

    const recoveryButton = descendants(mounted.content).find(
      (el) => el.tagName === "button" && textOf(el).includes("禁用全部扩展并重载 Desktop 窗口"),
    )!;
    recoveryButton.dispatch("click");

    // Confirmation dialog opens; RPC is not sent until confirmed.
    expect(disableAllDesktopExtensionsAndReload).not.toHaveBeenCalled();
    const dialog = descendants(mounted.content).find((el) => el.tagName === "dialog")!;
    expect(dialog.open).toBe(true);
    const form = descendants(dialog).find((el) => el.tagName === "form")!;
    form.dispatch("submit");

    await vi.waitFor(() => expect(disableAllDesktopExtensionsAndReload).toHaveBeenCalledTimes(1));
    expect(disableAllDesktopExtensionsAndReload).toHaveBeenCalledWith({ expectedRevision: 4 });
    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(2));

    const banner = descendants(mounted.content).find((el) =>
      el.className.includes("settings-extensions__banner"),
    )!;
    expect(textOf(banner)).toBe("恢复指令已保存，等待 Desktop Controller 重载窗口。");
    mounted.dispose();
  });

  it("shows an unavailable state when the Host does not support Desktop extension RPCs", async () => {
    const mounted = mountPage("en", () => ({
      listDesktopExtensions: vi.fn(async () => {
        throw new RendererMethodUnavailableError("codexhost/desktop/extensions/list");
      }),
    }));
    await vi.waitFor(() =>
      expect(textOf(mounted.content)).toContain("Desktop extension management is unavailable"),
    );
    const recoveryButton = descendants(mounted.content).find(
      (el) => el.tagName === "button" && textOf(el).includes("Disable all extensions"),
    )!;
    expect(recoveryButton.disabled).toBe(true);
    mounted.dispose();
  });
});
