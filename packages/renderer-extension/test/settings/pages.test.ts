import type { UpdateCheckResult, UpdateStatus } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
  isRendererSettingsIconName: () => true,
}));

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import {
  CODEXHOST_RELEASES_LATEST_URL,
  createDefaultRendererSettingsPages,
} from "../../src/settings/pages.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "../../src/settings/pages.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly #listeners = new Map<string, () => void>();
  className = "";
  hidden = false;
  href = "";
  rel = "";
  target = "";
  textContent = "";
  type = "";

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  addEventListener(name: string, listener: () => void): void {
    this.#listeners.set(name, listener);
  }

  append(...children: unknown[]): void {
    this.children.push(...children);
  }

  dispatch(name: string): void {
    this.#listeners.get(name)?.();
  }

  replaceChildren(...children: unknown[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeDocument {
  readonly clipboardWriteText = vi.fn(async () => undefined);
  readonly defaultView = {
    navigator: { clipboard: { writeText: this.clipboardWriteText } },
    setTimeout: vi.fn(() => 0),
    clearTimeout: vi.fn(),
  } as unknown as Window;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function visibleNotesText(root: FakeElement): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (node) parts.push(node);
      return;
    }
    if (!(node instanceof FakeElement)) return;
    if (node.children.length === 0) {
      if (node.textContent) parts.push(node.textContent);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return parts.join(" ");
}

function elementWithClass(root: FakeElement, className: string): FakeElement {
  const element = descendants(root).find((candidate) =>
    candidate.className.split(" ").includes(className),
  );
  if (!element) throw new Error(`Missing .${className}`);
  return element;
}

function updateCheck(status: UpdateStatus | null = null): UpdateCheckResult {
  return {
    currentVersion: "1.2.2",
    installation: "npm",
    latestVersion: "1.2.3",
    updateAvailable: true,
    installationAvailable: true,
    releaseNotes: "Safer updates",
    releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
    status,
    error: null,
  };
}

function updateStatus(
  phase: UpdateStatus["phase"],
  installation: UpdateStatus["installation"] = "npm",
): UpdateStatus {
  return {
    version: "1.2.3",
    installation,
    phase,
    updatedAt: 1_700_000_000,
    error: null,
  };
}

function visibleText(root: FakeElement): string {
  return descendants(root)
    .map(({ textContent }) => textContent)
    .filter(Boolean)
    .join(" ");
}

describe("Renderer Connections page", () => {
  it("renders failed Agent checks with their diagnostic reason and refreshes", async () => {
    const diagnostics: RendererConnectionDiagnostics = {
      snapshot: vi.fn((): RendererConnectionSnapshot => ({
        adapter: {
          state: "ready",
          reason: "ready",
          modelUpdates: 1,
          hook: "request-bridge",
        },
        agents: [
          {
            agent: "pi",
            availability: "error",
            error: {
              code: "processExited",
              message: "pi exited with code 1",
              retryable: true,
              stage: "startup",
              durationMs: 120,
              stderrTail: "check ~/.pi/agent/settings.json",
            },
          },
        ],
      })),
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("zh-CN"),
      () => null,
      () => diagnostics,
    ).find(({ id }) => id === "connections");
    if (!page) throw new Error("Connections page is not registered");

    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    expect(visibleText(content)).toContain("pi exited with code 1");
    expect(visibleText(content)).toContain("~/.pi/agent/settings.json");
    expect(visibleText(content)).toContain("startup");
    const toggle = elementWithClass(content, "settings-connection-details-toggle");
    const details = descendants(content).find(
      (candidate) =>
        candidate.className.split(" ").includes("settings-connection-details") &&
        candidate.hidden === false,
    );
    if (!details) throw new Error("Expanded connection details are not rendered");
    expect(details.hidden).toBe(false);
    toggle.dispatch("click");
    expect(details.hidden).toBe(true);
    toggle.dispatch("click");
    expect(details.hidden).toBe(false);
    const refresh = descendants(content).find(
      ({ tagName, dataset }) => tagName === "button" && dataset.connectionAction === "refresh",
    );
    if (!refresh) throw new Error("Connection refresh button is not rendered");
    refresh.dispatch("click");
    await vi.waitFor(() => expect(diagnostics.refresh).toHaveBeenCalledWith());
    const copyAll = descendants(content).find(
      ({ tagName, dataset }) => tagName === "button" && dataset.connectionAction === "copy-all",
    );
    if (!copyAll) throw new Error("Copy-all diagnostics button is not rendered");
    copyAll.dispatch("click");
    await vi.waitFor(() => expect(document.clipboardWriteText).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(visibleNotesText(content)).toContain("已复制"));

    cleanup?.();
  });
});

describe("Renderer Updates page", () => {
  it.each([
    [updateStatus("prepared"), "正在准备更新..."],
    [updateStatus("waiting-for-exit"), "正在等待应用退出..."],
    [updateStatus("installing"), "正在通过 npm 安装..."],
    [updateStatus("installing", "windows-installer"), "正在安装更新..."],
    [updateStatus("restarting"), "正在重启以完成更新..."],
    [updateStatus("succeeded"), "更新安装成功。"],
    [updateStatus("failed"), "更新失败。"],
  ])("renders a distinct localized update status for $0.phase", async (status, expected) => {
    const client = {
      checkUpdate: vi.fn(async () => updateCheck(status)),
      startUpdate: vi.fn(),
      readUpdateStatus: vi.fn(async () => ({ status })),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("zh-CN"),
      () => client,
    ).find(({ id }) => id === "updates");
    if (!page) throw new Error("Updates page is not registered");

    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    await vi.waitFor(() => {
      expect(visibleText(elementWithClass(content, "settings-update-panel"))).toContain(expected);
    });

    cleanup?.();
    scope.dispose();
  });

  it("keeps a manual GitHub Releases download available before discovery and after update failure", async () => {
    const client = {
      checkUpdate: vi.fn(async () => updateCheck()),
      startUpdate: vi.fn(async () => {
        throw new Error("download failed");
      }),
      readUpdateStatus: vi.fn(async () => ({ status: null })),
    };
    const page = createDefaultRendererSettingsPages(undefined, () => client).find(
      ({ id }) => id === "updates",
    );
    if (!page) throw new Error("Updates page is not registered");

    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    const releaseLink = elementWithClass(content, "settings-update-link");
    expect(releaseLink.href).toBe(CODEXHOST_RELEASES_LATEST_URL);
    expect(releaseLink.target).toBe("_blank");
    expect(releaseLink.rel).toBe("noopener noreferrer");

    await vi.waitFor(() => {
      expect(releaseLink.href).toBe(
        "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
      );
    });

    const panel = elementWithClass(content, "settings-update-panel");
    const updateButton = descendants(panel).find(({ tagName }) => tagName === "button");
    if (!updateButton) throw new Error("Update command is not rendered");
    updateButton.dispatch("click");

    await vi.waitFor(() => {
      expect(panel.dataset.updateState).toBe("failed");
    });
    expect(elementWithClass(content, "settings-update-link")).toBe(releaseLink);
    expect(releaseLink.href).toBe(
      "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
    );

    cleanup?.();
    scope.dispose();
  });

  it("renders GitHub Release notes as structured Markdown", async () => {
    const client = {
      checkUpdate: vi.fn(async () => ({
        ...updateCheck(),
        releaseNotes: "## 本次发布\n\n- 新增 Grok CLI adapter\n- 集成 DeepSeek Harness",
      })),
      startUpdate: vi.fn(),
      readUpdateStatus: vi.fn(async () => ({ status: null })),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("zh-CN"),
      () => client,
    ).find(({ id }) => id === "updates");
    if (!page) throw new Error("Updates page is not registered");

    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    await vi.waitFor(() => {
      expect(elementWithClass(content, "settings-update-notes").children[0]).toMatchObject({
        tagName: "h2",
      });
    });
    const notes = elementWithClass(content, "settings-update-notes");
    expect(notes.children.map((child) => (child as FakeElement).tagName)).toEqual(["h2", "ul"]);
    expect(visibleNotesText(notes)).toContain("本次发布");
    expect(visibleNotesText(notes)).toContain("新增 Grok CLI adapter");
    expect(visibleNotesText(notes)).not.toContain("##");
    expect(visibleNotesText(notes)).not.toContain("- 新增");

    cleanup?.();
    scope.dispose();
  });
});
