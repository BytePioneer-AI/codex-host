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
  checked = false;
  disabled = false;
  open = false;
  parent: FakeElement | undefined;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  get isConnected(): boolean {
    return Boolean(this.parent);
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

  dispatch(name: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) {
      listener({ preventDefault() {}, ...event });
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
        status: { state: "running" },
        manifest: {
          manifestVersion: 1,
          id: "sidebar-thread-tree",
          name: "Sidebar Thread Tree",
          version: "0.1.0",
          description: { en: "Groups delegated Threads", "zh-CN": "归组委派的 Thread" },
          desktopApi: 1,
          desktop: { script: "desktop.js", style: "desktop.css" },
          slots: ["sidebar.thread-layout", "sidebar.thread-badge"],
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
      expect(textOf(zhMount.content)).toContain("$CODEXHOST_DATA_DIR/extensions/<id>/"),
    );
    expect(textOf(zhMount.content)).toContain("尚未发现 Desktop 扩展");
    expect(textOf(zhMount.content)).toContain("等待 Desktop 连接");
    zhMount.dispose();

    const enMount = mountPage("en", () => client);
    await vi.waitFor(() =>
      expect(textOf(enMount.content)).toContain("No Desktop extensions found"),
    );
    expect(textOf(enMount.content)).toContain("$CODEXHOST_DATA_DIR/extensions/<id>/");
    enMount.dispose();
  });

  it("displays extension cards, status badges, slot labels, and disables incompatible/invalid toggles", async () => {
    const client: RendererDesktopExtensionsClient = {
      listDesktopExtensions: vi.fn(async () => sampleList()),
      enableDesktopExtension: vi.fn(),
      disableDesktopExtension: vi.fn(),
      disableAllDesktopExtensionsAndReload: vi.fn(),
    };
    const mounted = mountPage("zh-CN", () => client);
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("Sidebar Thread Tree"));

    const cards = descendants(mounted.content).filter(
      (element) => element.tagName === "article" && Boolean(element.dataset.extensionId),
    );
    expect(cards.map((card) => card.dataset.extensionId)).toEqual([
      "sidebar-thread-tree",
      "sidebar-delegation-badges",
      "future-extension",
      "broken-extension",
    ]);

    const treeCard = cards[0]!;
    expect(textOf(treeCard)).toContain("v0.1.0");
    expect(textOf(treeCard)).toContain("归组委派的 Thread");
    expect(textOf(treeCard)).toContain("侧栏 Thread 布局");
    expect(textOf(treeCard)).toContain("侧栏 Thread 角标");
    expect(textOf(treeCard)).toContain("运行中");

    const incompatibleSwitch = descendants(cards[2]!).find((el) => el.tagName === "input")!;
    const invalidSwitch = descendants(cards[3]!).find((el) => el.tagName === "input")!;
    expect(incompatibleSwitch.disabled).toBe(true);
    expect(invalidSwitch.disabled).toBe(true);
    expect(textOf(cards[2]!)).toContain("Desktop API 2 requires a newer codexhost");
    expect(textOf(cards[3]!)).toContain("Invalid manifest.json");
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
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("Sidebar Thread Tree"));

    const findTreeSwitch = () =>
      descendants(mounted.content).find(
        (el) =>
          el.tagName === "input" && el.getAttribute("aria-label")?.includes("Sidebar Thread Tree"),
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
    const switchesWhileBusy = descendants(mounted.content).filter((el) => el.tagName === "input");
    expect(switchesWhileBusy.every((el) => el.disabled)).toBe(true);
    switchesWhileBusy[0]!.dispatch("change");
    expect(disableDesktopExtension).toHaveBeenCalledTimes(1);

    pendingDisable.resolve({
      state: "saved",
      configuration: { version: 1, revision: 5, enabled: [] },
    });

    await vi.waitFor(() => expect(listDesktopExtensions).toHaveBeenCalledTimes(2));
    expect(textOf(mounted.content)).toContain("已禁用“Sidebar Thread Tree”。");
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

    // 1) slot-conflict reports occupied slot and conflicting extension name
    const firstSwitch = findBadgeSwitch();
    firstSwitch.checked = true;
    firstSwitch.dispatch("change");

    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("Sidebar Thread Tree"));
    const banner = descendants(mounted.content).find((el) =>
      el.className.includes("settings-extensions__banner"),
    )!;
    expect(banner.hidden).toBe(false);
    expect(textOf(banner)).toContain("sidebar.thread-badge");
    expect(textOf(banner)).toContain("Sidebar Thread Tree (sidebar-thread-tree)");
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
    await vi.waitFor(() => expect(textOf(mounted.content)).toContain("Sidebar Thread Tree"));

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
