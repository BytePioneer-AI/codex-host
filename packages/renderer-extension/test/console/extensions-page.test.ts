import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consoleGetMock = vi.fn();
const consolePostMock = vi.fn();

vi.mock("../../src/console/api.js", () => ({
  consoleGet: (...args: unknown[]) => consoleGetMock(...args),
  consolePost: (...args: unknown[]) => consolePostMock(...args),
}));

import { createExtensionsPage } from "../../src/console/pages/extensions.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  className = "";
  textContent = "";
  disabled = false;
  type = "";

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  addEventListener(): void {}

  contains(): boolean {
    return false;
  }

  append(...children: unknown[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: unknown[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeDocument {
  activeElement: unknown = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase(), this);
  }

  createTextNode(text: string): string {
    return text;
  }
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (!(node instanceof FakeElement)) return "";
  const nested = node.children.map(textOf).filter(Boolean).join(" ");
  return [node.textContent, nested].filter(Boolean).join(" ").trim();
}

const listing = {
  configuration: { revision: 1, enabled: ["sidebar-thread-tree"] },
  desktopConnected: true,
  diagnostics: [],
  extensions: [
    {
      id: "sidebar-thread-tree",
      enabled: true,
      status: { state: "running" },
      manifest: {
        manifestVersion: 2,
        id: "sidebar-thread-tree",
        name: { en: "Sidebar Thread Tree", "zh-CN": "侧栏委派树" },
        version: "0.1.0",
        description: { en: "Groups delegated Threads", "zh-CN": "归组委派的 Thread" },
        desktop: { apiVersion: 1, script: "desktop.js" },
        slots: ["sidebar.thread-badge", "sidebar.thread-layout"],
        categories: ["interface", "workflow"],
      },
    },
    {
      id: "sidebar-delegation-badges",
      enabled: true,
      status: { state: "conflict", conflictWith: "sidebar-thread-tree" },
      manifest: {
        manifestVersion: 2,
        id: "sidebar-delegation-badges",
        name: { en: "Delegation Badges", "zh-CN": "Delegation Badges" },
        version: "0.1.0",
        description: { en: "Shows child badges", "zh-CN": "显示子 Thread 角标" },
        desktop: { apiVersion: 1, script: "desktop.js" },
        slots: ["sidebar.thread-badge"],
      },
    },
  ],
};

beforeEach(() => {
  consoleGetMock.mockReset();
  consolePostMock.mockReset();
  vi.stubGlobal("window", {
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Console extensions page", () => {
  it("renders localized names, descriptions, and conflict occupant names", async () => {
    consoleGetMock.mockResolvedValue(listing);

    for (const [locale, expected] of [
      [
        "zh-CN",
        {
          title: "侧栏委派树",
          description: "归组委派的 Thread",
          legacyName: "Delegation Badges",
          conflict: "槽位占用者：侧栏委派树 (sidebar-thread-tree)",
        },
      ],
      [
        "en",
        {
          title: "Sidebar Thread Tree",
          description: "Groups delegated Threads",
          legacyName: "Delegation Badges",
          conflict: "Slot occupied by Sidebar Thread Tree (sidebar-thread-tree)",
        },
      ],
    ] as const) {
      const document = new FakeDocument();
      const content = document.createElement("div");
      const scope = new RendererSettingsPageScope();
      const page = createExtensionsPage(locale);
      const cleanup = page.mount({
        content: content as unknown as HTMLElement,
        signal: scope.signal,
        runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
      });

      await vi.waitFor(() => expect(textOf(content)).toContain(expected.title));
      const rendered = textOf(content);
      expect(rendered).toContain(expected.description);
      expect(rendered).toContain(expected.legacyName);
      expect(rendered).toContain(expected.conflict);

      scope.dispose();
      cleanup?.();
    }
  });
});
