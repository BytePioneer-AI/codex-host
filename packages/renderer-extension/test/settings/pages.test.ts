import {
  harnessIdSchema,
  hostThreadIdSchema,
  type HarnessSessionListParams,
  type UpdateCheckResult,
  type UpdateStatus,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
  isRendererSettingsIconName: () => true,
}));

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { createRendererModelClient } from "../../src/renderer-model-client.js";
import { RendererSessionImportUnavailableError } from "../../src/renderer-session-import-client.js";
const HARNESS_SESSION_LIST_METHOD = "codexhost/harness/session-import/list";
const HARNESS_SESSION_IMPORT_METHOD = "codexhost/harness/session-import/import";
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
  readonly style: Record<string, string> = {};
  readonly #listeners = new Map<string, (event?: unknown) => void>();
  className = "";
  hidden = false;
  href = "";
  rel = "";
  target = "";
  textContent = "";
  title = "";
  type = "";
  value = "";
  tabIndex = 0;
  disabled = false;
  focused = false;
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 0;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    this.#listeners.set(name, listener);
  }

  removeEventListener(name: string): void {
    this.#listeners.delete(name);
  }

  append(...children: unknown[]): void {
    this.children.push(...children);
  }

  dispatch(name: string, event?: unknown): void {
    this.#listeners.get(name)?.(event);
  }

  focus(): void {
    this.focused = true;
  }

  scrollBy(options: ScrollToOptions): void {
    this.scrollLeft += Number(options.left ?? 0);
    this.dispatch("scroll");
  }

  scrollIntoView(): void {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
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
  readonly defaultView: Window;

  constructor(platform = "MacIntel") {
    this.defaultView = {
      navigator: {
        clipboard: { writeText: this.clipboardWriteText },
        platform,
        userAgent: platform === "Win32" ? "Windows" : "Macintosh",
      },
      setTimeout: vi.fn(() => 0),
      clearTimeout: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function visibleText(root: FakeElement): string {
  return descendants(root)
    .map(({ textContent }) => textContent)
    .filter(Boolean)
    .join(" ");
}

describe("Renderer Connections page", () => {
  it("opens managed DSH Web only for the local Host and coalesces repeated clicks", async () => {
    const opened = deferred<undefined>();
    const diagnostics: RendererConnectionDiagnostics = {
      snapshot: () => ({
        adapter: { state: "ready", reason: "ready", modelUpdates: 1, hook: "request-bridge" },
        hosts: [
          {
            hostId: "local",
            active: true,
            agents: [
              {
                agent: "deepseek-harness",
                availability: "ready",
                error: null,
                webUiAvailable: true,
              },
            ],
          },
          {
            hostId: "remote-ssh-codex-managed:fixture",
            active: false,
            agents: [
              {
                agent: "deepseek-harness",
                availability: "ready",
                error: null,
                webUiAvailable: true,
              },
            ],
          },
        ],
      }),
      refresh: vi.fn(() => Promise.resolve()),
      openWebUi: vi.fn(() => opened.promise),
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

    const dshRow = descendants(content).find(
      ({ dataset }) => dataset.connectionItem === "deepseek-harness",
    );
    if (!dshRow) throw new Error("DeepSeek Harness row is not rendered");
    dshRow.dispatch("click", { target: null });
    const open = descendants(content).find(
      ({ dataset }) => dataset.connectionAction === "open-web-ui",
    );
    if (!open) throw new Error("DeepSeek Harness Web action is not rendered");
    expect(visibleNotesText(open)).toContain("打开 DeepSeek Harness Web");
    expect(descendants(content).some(({ href }) => href.includes("token="))).toBe(false);

    open.dispatch("click");
    open.dispatch("click");
    expect(diagnostics.openWebUi).toHaveBeenCalledOnce();
    expect(diagnostics.openWebUi).toHaveBeenCalledWith("local", "deepseek-harness");
    expect(open.disabled).toBe(true);
    opened.resolve(undefined);
    await vi.waitFor(() => expect(open.disabled).toBe(false));

    const remoteTab = descendants(content).find(
      ({ dataset }) => dataset.connectionHostTab === "remote-ssh-codex-managed:fixture",
    );
    if (!remoteTab) throw new Error("Remote Host tab is not rendered");
    remoteTab.dispatch("click");
    expect(
      descendants(content).find(({ dataset }) => dataset.connectionAction === "open-web-ui"),
    ).toBeUndefined();

    cleanup?.();
    scope.dispose();
  });

  it("renders Host tabs, install actions, and error details", async () => {
    const refreshRequest = deferred<undefined>();
    const diagnostics: RendererConnectionDiagnostics = {
      snapshot: vi.fn((): RendererConnectionSnapshot => ({
        adapter: {
          state: "ready",
          reason: "ready",
          modelUpdates: 1,
          hook: "request-bridge",
        },
        hosts: [
          {
            hostId: "local",
            active: true,
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
              {
                agent: "deepseek-harness",
                availability: "notInstalled",
                error: {
                  code: "notInstalled",
                  message: "DSH is not installed",
                  retryable: false,
                },
              },
            ],
          },
          {
            hostId: "remote-ssh-codex-managed:%E5%85%AC%E5%8F%B8",
            active: false,
            agents: [{ agent: "pi", availability: "ready", error: null }],
          },
        ],
      })),
      refresh: vi.fn(() => refreshRequest.promise),
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

    expect(visibleText(content)).toContain("本地");
    expect(
      descendants(content).filter((candidate) =>
        candidate.className.split(" ").includes("settings-connection-row__mark--logo"),
      ),
    ).toHaveLength(3);
    expect(visibleText(content)).toContain("CH");
    expect(visibleText(content)).toContain("公司");
    expect(visibleText(content)).toContain("pi exited with code 1");
    expect(visibleText(content)).toContain("~/.pi/agent/settings.json");
    expect(visibleText(content)).toContain("startup");
    const issueLink = descendants(content).find(
      ({ tagName, href }) =>
        tagName === "a" && href === "https://github.com/BytePioneer-AI/codex-host/issues/new",
    );
    expect(issueLink).toBeDefined();
    const copyButton = descendants(
      elementWithClass(content, "settings-connection-error-log-header"),
    ).find(({ tagName }) => tagName === "button");
    if (!copyButton) throw new Error("Copy error log button is not rendered");
    copyButton.dispatch("click");
    await vi.waitFor(() => expect(document.clipboardWriteText).toHaveBeenCalledOnce());
    expect(document.clipboardWriteText).toHaveBeenCalledWith(
      expect.stringContaining("host: local"),
    );
    await vi.waitFor(() => expect(visibleNotesText(content)).toContain("已复制"));
    const refresh = descendants(content).find(
      ({ tagName, dataset }) => tagName === "button" && dataset.connectionAction === "refresh",
    );
    if (!refresh) throw new Error("Connection refresh button is not rendered");
    refresh.dispatch("click");
    expect(refresh.disabled).toBe(true);
    expect(visibleNotesText(refresh)).toContain("正在诊断...");
    expect(diagnostics.refresh).toHaveBeenCalledWith();
    refreshRequest.resolve(undefined);
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    expect(visibleNotesText(refresh)).toContain("重新诊断连接");

    const installLink = descendants(content).find(
      ({ tagName, href }) =>
        tagName === "a" && href === "https://deepseek-harness.github.io/deepseek-harness/",
    );
    expect(installLink).toMatchObject({
      target: "_blank",
      rel: "noopener noreferrer",
    });

    expect(visibleText(content)).toContain("查看错误");
    const remoteTab = descendants(content).find(
      ({ tagName, dataset }) =>
        tagName === "button" &&
        dataset.connectionHostTab === "remote-ssh-codex-managed:%E5%85%AC%E5%8F%B8",
    );
    if (!remoteTab) throw new Error("Remote Host tab is not rendered");
    remoteTab.dispatch("click");
    const selectedPanel = descendants(content).find(
      ({ dataset }) => dataset.connectionHost === "remote-ssh-codex-managed:%E5%85%AC%E5%8F%B8",
    );
    expect(selectedPanel).toBeDefined();
    expect(visibleText(content)).not.toContain("pi exited with code 1");
    const selectedRemoteTab = descendants(content).find(
      ({ dataset, attributes }) =>
        dataset.connectionHostTab === "remote-ssh-codex-managed:%E5%85%AC%E5%8F%B8" &&
        attributes.get("aria-selected") === "true",
    );
    expect(selectedRemoteTab).toBeDefined();

    const hostTabs = elementWithClass(content, "settings-connection-host-tabs");
    hostTabs.clientWidth = 240;
    hostTabs.scrollWidth = 720;
    hostTabs.dispatch("scroll");
    const scrollRight = descendants(content).find(
      ({ dataset }) => dataset.connectionHostScroll === "right",
    );
    if (!scrollRight) throw new Error("Host scroll button is not rendered");
    expect(scrollRight.disabled).toBe(false);
    scrollRight.dispatch("click");
    expect(hostTabs.scrollLeft).toBeGreaterThan(0);

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

  it("shows only the Update action before an update starts and ignores stale success state", async () => {
    const client = {
      checkUpdate: vi.fn(async () => updateCheck(updateStatus("succeeded"))),
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
      const panel = elementWithClass(content, "settings-update-panel");
      expect(visibleText(panel)).toContain("更新");
      expect(visibleText(panel)).not.toContain("更新安装成功");
      expect(visibleText(panel)).not.toContain("有新版本可用");
    });
    expect(client.startUpdate).not.toHaveBeenCalled();

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

    const releaseLink = descendants(content).find(
      (candidate) =>
        candidate.tagName === "a" &&
        visibleNotesText(candidate).includes("Download from GitHub Releases"),
    );
    if (!releaseLink) throw new Error("GitHub Releases link is not rendered");
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
    expect(descendants(content)).toContain(releaseLink);
    expect(releaseLink.href).toBe(
      "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
    );

    cleanup?.();
    scope.dispose();
  });

  it.each([
    ["npm" as const, "Windows 暂不支持自动更新。请退出 codexhost，在终端运行以下命令完成更新。"],
    [
      "windows-installer" as const,
      "Windows 暂不支持自动更新。请下载并运行适用于当前系统的安装包。",
    ],
  ])("renders manual Windows updates for %s installations", async (installation, expected) => {
    const client = {
      checkUpdate: vi.fn(async () => ({ ...updateCheck(), installation })),
      startUpdate: vi.fn(),
      readUpdateStatus: vi.fn(async () => ({ status: null })),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("zh-CN"),
      () => client,
    ).find(({ id }) => id === "updates");
    if (!page) throw new Error("Updates page is not registered");

    const document = new FakeDocument("Win32");
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    await vi.waitFor(() => {
      expect(visibleText(content)).toContain(expected);
      expect(visibleText(elementWithClass(content, "settings-update-panel"))).toContain(
        "Windows 暂不支持自动更新",
      );
    });
    expect(
      descendants(elementWithClass(content, "settings-update-panel")).find(
        ({ tagName }) => tagName === "button",
      ),
    ).toBeUndefined();
    expect(client.startUpdate).not.toHaveBeenCalled();
    if (installation === "npm") {
      expect(visibleText(content)).toContain("npm install -g @codexhost/cli@latest");
    } else {
      const link = descendants(content).find(
        ({ tagName, href }) =>
          tagName === "a" &&
          href ===
            "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-windows-x64.exe",
      );
      expect(link).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
    }

    cleanup?.();
    scope.dispose();
  });

  it("renders the open-source project introduction on the About page", () => {
    const page = createDefaultRendererSettingsPages(rendererSettingsMessages("zh-CN")).find(
      ({ id }) => id === "about",
    );
    if (!page) throw new Error("About page is not registered");

    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    expect(visibleText(content)).toContain("在 Codex Desktop 中运行 Pi 和其他 Harness");
    expect(visibleText(content)).toContain(
      "我们认为 Codex Desktop 提供了目前最好的桌面开发交互体验",
    );
    expect(visibleText(content)).toContain("Claude Code 和 Pi Agent");
    expect(visibleText(content)).toContain("codexhost 是一个开源项目");
    expect(visibleText(content)).toContain("请给我们一个 Star");
    const repository = descendants(content).find(
      ({ tagName, href }) =>
        tagName === "a" && href === "https://github.com/BytePioneer-AI/codex-host",
    );
    expect(repository).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
    expect(visibleNotesText(repository as FakeElement)).toContain(
      "https://github.com/BytePioneer-AI/codex-host",
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
    const panel = elementWithClass(content, "settings-update-panel");
    const controls = elementWithClass(content, "settings-update-controls");
    const notes = elementWithClass(content, "settings-update-notes");
    const updateButton = descendants(panel).find(({ tagName }) => tagName === "button");
    if (!updateButton) throw new Error("Update command is not rendered");
    // Status and the update action come first; the manual fallback stays visible
    // right below it, and release notes render last.
    expect(content.children.indexOf(panel)).toBeLessThan(content.children.indexOf(controls));
    expect(content.children.indexOf(controls)).toBeLessThan(
      content.children.indexOf(elementWithClass(content, "settings-update-notes-section")),
    );
    expect(descendants(panel)).toContain(updateButton);
    expect(descendants(panel)).not.toContain(notes);
    expect(notes.children.map((child) => (child as FakeElement).tagName)).toEqual(["h2", "ul"]);
    expect(visibleNotesText(notes)).toContain("本次发布");
    expect(visibleNotesText(notes)).toContain("新增 Grok CLI adapter");
    expect(visibleNotesText(notes)).not.toContain("##");
    expect(visibleNotesText(notes)).not.toContain("- 新增");

    cleanup?.();
    scope.dispose();
  });
});

describe("Renderer Session Import page", () => {
  it("configures page size, searches all metadata, rejects stale searches and locks controls during import", async () => {
    const rows = Array.from({ length: 45 }, (_, index) => ({
      nativeSessionId: `session-${index}`,
      title: `Session ${index}`,
      cwd: "C:\\work",
      updatedAt: 1_000,
      running: null,
    }));
    const slow = deferred<{ candidates: typeof rows; total: number }>();
    const imported = deferred<{ threadId: ReturnType<typeof hostThreadIdSchema.parse> }>();
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [{ harnessId: harnessIdSchema.parse("pi"), name: "Pi" }],
      })),
      listHarnessSessions: vi.fn(
        async ({ query = "", offset = 0, limit = 20 }: HarnessSessionListParams) => {
          if (query === "slow") return slow.promise;
          const matched = rows.filter((row) =>
            row.title.toLowerCase().includes(query.toLowerCase()),
          );
          return { candidates: matched.slice(offset, offset + limit), total: matched.length };
        },
      ),
      importHarnessSession: vi.fn(() => imported.promise),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
      async () => undefined,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Import page missing");
    const content = new FakeDocument().createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    const action = (name: string): FakeElement => {
      const element = descendants(content).find(
        ({ dataset }) => dataset.sessionImportAction === name,
      );
      if (!element) throw new Error(`Missing control ${name}`);
      return element;
    };
    const visibleRows = () =>
      descendants(content).filter(({ dataset }) => dataset.sessionImportId !== undefined);
    const search = (query: string): void => {
      action("search-input").value = query;
      descendants(content)
        .find(({ tagName }) => tagName === "form")
        ?.dispatch("submit", { preventDefault: vi.fn() });
    };
    await vi.waitFor(() => expect(visibleRows()).toHaveLength(20));
    expect(action("previous").disabled).toBe(true);
    expect(action("page-summary").textContent).toBe("Page 1 of 3 · 45 sessions");
    action("next").dispatch("click");
    await vi.waitFor(() => expect(visibleRows()[0]?.dataset.sessionImportId).toBe("session-20"));
    action("next").dispatch("click");
    await vi.waitFor(() => expect(visibleRows()).toHaveLength(5));
    expect(action("next").disabled).toBe(true);
    action("previous").dispatch("click");
    await vi.waitFor(() =>
      expect(action("page-summary").textContent).toBe("Page 2 of 3 · 45 sessions"),
    );
    action("page-size").value = "50";
    action("page-size").dispatch("change");
    await vi.waitFor(() => expect(visibleRows()).toHaveLength(45));
    expect(client.listHarnessSessions).toHaveBeenLastCalledWith({
      harnessId: "pi",
      query: "",
      offset: 0,
      limit: 50,
    });
    search("slow");
    await vi.waitFor(() =>
      expect(client.listHarnessSessions).toHaveBeenLastCalledWith({
        harnessId: "pi",
        query: "slow",
        offset: 0,
        limit: 50,
      }),
    );
    search("SESSION 32");
    await vi.waitFor(() => expect(visibleRows()).toHaveLength(1));
    expect(visibleRows()[0]?.dataset.sessionImportId).toBe("session-32");
    slow.resolve({ candidates: rows, total: 45 });
    await slow.promise;
    await Promise.resolve();
    expect(visibleRows()).toHaveLength(1);
    expect(action("page-summary").textContent).toBe("Page 1 of 1 · 1 sessions");
    search("absent");
    await vi.waitFor(() => expect(visibleText(content)).toContain("No sessions match"));
    expect(action("previous").disabled).toBe(true);
    expect(action("next").disabled).toBe(true);
    search("Session 32");
    await vi.waitFor(() => expect(visibleRows()).toHaveLength(1));
    action("import").dispatch("click");
    expect(action("search-input").disabled).toBe(true);
    expect(action("page-size").disabled).toBe(true);
    search("absent"); // Synthetic submission must not invalidate a pending import.
    imported.resolve({ threadId: hostThreadIdSchema.parse("imported") });
    await vi.waitFor(() => expect(action("search-input").disabled).toBe(false));
    expect(client.listHarnessSessions).toHaveBeenLastCalledWith({
      harnessId: "pi",
      query: "Session 32",
      offset: 0,
      limit: 50,
    });
    scope.dispose();
  });

  it("returns to a valid page when refresh removes the current last page", async () => {
    const rows = Array.from({ length: 41 }, (_, index) => ({
      nativeSessionId: `row-${index}`,
      title: null,
      cwd: "C:\\work",
      updatedAt: 1,
      running: null,
    }));
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [{ harnessId: harnessIdSchema.parse("pi"), name: "Pi" }],
      })),
      listHarnessSessions: vi.fn(async ({ offset = 0, limit = 20 }: HarnessSessionListParams) => ({
        candidates: rows.slice(offset, offset + limit),
        total: rows.length,
      })),
      importHarnessSession: vi.fn(),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Import page missing");
    const content = new FakeDocument().createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    const control = (name: string) =>
      descendants(content).find(({ dataset }) => dataset.sessionImportAction === name);
    await vi.waitFor(() => expect(control("page-summary")?.textContent).toContain("Page 1 of 3"));
    control("next")?.dispatch("click");
    await vi.waitFor(() => expect(control("page-summary")?.textContent).toContain("Page 2 of 3"));
    control("next")?.dispatch("click");
    await vi.waitFor(() => expect(control("page-summary")?.textContent).toContain("Page 3 of 3"));
    rows.splice(1);
    control("refresh")?.dispatch("click");
    await vi.waitFor(() =>
      expect(control("page-summary")?.textContent).toBe("Page 1 of 1 · 1 sessions"),
    );
    expect(client.listHarnessSessions).toHaveBeenLastCalledWith({
      harnessId: "pi",
      query: "",
      offset: 0,
      limit: 20,
    });
    expect(
      descendants(content).filter(({ dataset }) => dataset.sessionImportId !== undefined),
    ).toHaveLength(1);
    scope.dispose();
  });

  it("discovers Harness options, ignores stale Harness results, and imports Pi with an activity warning", async () => {
    const oldList = deferred<{ candidates: []; total: number }>();
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
          { harnessId: harnessIdSchema.parse("pi"), name: "Pi" },
        ],
      })),
      listHarnessSessions: vi.fn(async ({ harnessId }: { harnessId: string }) =>
        harnessId === "deepseek-harness"
          ? oldList.promise
          : {
              total: 1,
              candidates: [
                {
                  nativeSessionId: "pi-session",
                  title: "Pi original",
                  cwd: "C:\\work",
                  running: null,
                  updatedAt: 1_000,
                },
              ],
            },
      ),
      importHarnessSession: vi.fn(async () => ({
        threadId: hostThreadIdSchema.parse("pi-imported"),
      })),
    };
    const open = vi.fn(async () => undefined);
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
      open,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Session import page missing");
    const content = new FakeDocument().createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    await vi.waitFor(() =>
      expect(client.listHarnessSessions).toHaveBeenCalledWith({
        harnessId: "deepseek-harness",
        query: "",
        offset: 0,
        limit: 20,
      }),
    );
    const options = descendants(content).filter(
      ({ dataset }) => dataset.sessionImportHarnessOption !== undefined,
    );
    expect(options.map(({ textContent }) => textContent)).toEqual(["DeepSeek Harness", "Pi"]);
    options[1]?.dispatch("click");
    await vi.waitFor(() => expect(visibleText(content)).toContain("Pi original"));
    oldList.resolve({ candidates: [], total: 0 });
    await oldList.promise;
    await Promise.resolve();
    expect(visibleText(content)).toContain("Pi original");
    expect(visibleText(content)).toContain("Activity unknown");
    expect(visibleText(content)).toContain("close the session in its native client");
    const button = descendants(content).find(
      ({ dataset }) => dataset.sessionImportAction === "import",
    );
    expect(button?.disabled).toBe(false);
    button?.dispatch("click");
    await vi.waitFor(() =>
      expect(client.importHarnessSession).toHaveBeenCalledWith({
        harnessId: "pi",
        nativeSessionId: "pi-session",
      }),
    );
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith("pi-imported", expect.any(AbortSignal)),
    );
    scope.dispose();
  });

  it("renders loading and empty states, ignores an older list, and recovers through Refresh", async () => {
    const candidate = {
      nativeSessionId: "recovered-session",
      title: "Recovered session",
      updatedAt: 1_700_000_000_000,
      cwd: "C:\\work",
      running: false,
    };
    const first = deferred<{ candidates: (typeof candidate)[]; total: number }>();
    const second = deferred<{ candidates: (typeof candidate)[]; total: number }>();
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
        .mockRejectedValueOnce(new Error("private list detail"))
        .mockResolvedValueOnce({ candidates: [candidate], total: 1 }),
      importHarnessSession: vi.fn(),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Session Import page is not registered");
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    const refresh = descendants(content).find(
      ({ dataset }) => dataset.sessionImportAction === "refresh",
    );
    if (!refresh) throw new Error("Session Import Refresh is not rendered");

    expect(refresh.disabled).toBe(true);
    expect(visibleNotesText(refresh)).toContain("Loading local sessions");
    expect(visibleText(content)).toContain("Loading local sessions");

    await vi.waitFor(() => expect(client.listHarnessSessions).toHaveBeenCalledOnce());
    // A synthetic second activation proves runLatest still rejects stale results even if
    // browser-level disabled handling is bypassed.
    refresh.dispatch("click");
    second.resolve({ candidates: [], total: 0 });
    await vi.waitFor(() => expect(visibleText(content)).toContain("No local sessions"));
    expect(refresh.disabled).toBe(false);

    first.resolve({
      total: 1,
      candidates: [{ ...candidate, nativeSessionId: "stale-session", title: "Ignored stale" }],
    });
    await first.promise;
    await Promise.resolve();
    expect(visibleText(content)).toContain("No local sessions");
    expect(visibleText(content)).not.toContain("Ignored stale");

    refresh.dispatch("click");
    await vi.waitFor(() => expect(visibleText(content)).toContain("could not be loaded"));
    expect(visibleText(content)).not.toContain("private list detail");

    refresh.dispatch("click");
    await vi.waitFor(() => expect(visibleText(content)).toContain("Recovered session"));
    expect(client.listHarnessSessions).toHaveBeenCalledTimes(4);
    scope.dispose();
  });

  it("lists local DSH Modern sessions and imports only an idle row", async () => {
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(async () => ({
        total: 2,
        candidates: [
          {
            nativeSessionId: "idle-session-identifier-that-is-long",
            title: "既有会话",
            updatedAt: 1_700_000_000_000,
            cwd: "C:\\work\\idle",
            running: false,
          },
          {
            nativeSessionId: "running-session",
            title: null,
            updatedAt: 1_700_000_001_000,
            cwd: "C:\\work\\running",
            running: true,
          },
        ],
      })),
      importHarnessSession: vi.fn(async () => ({
        threadId: hostThreadIdSchema.parse("imported-thread"),
      })),
    };
    const openImportedThread = vi.fn(async () => undefined);
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("zh-CN"),
      () => null,
      () => null,
      () => client,
      openImportedThread,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Session Import page is not registered");
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    await vi.waitFor(() =>
      expect(client.listHarnessSessions).toHaveBeenCalledWith({
        harnessId: "deepseek-harness",
        query: "",
        offset: 0,
        limit: 20,
      }),
    );
    await vi.waitFor(() => expect(visibleText(content)).toContain("既有会话"));
    expect(visibleText(content)).toContain("未命名会话");
    expect(visibleText(content)).toContain("运行中");
    const visualIdentity = descendants(content).find(
      ({ attributes, textContent }) =>
        attributes.get("aria-hidden") === "true" && textContent.startsWith("会话 ID:"),
    );
    expect(visualIdentity?.textContent).not.toContain("idle-session-identifier-that-is-long");
    expect(visualIdentity?.title).toBe("idle-session-identifier-that-is-long");
    expect(descendants(content).find(({ tagName }) => tagName === "h2")?.textContent).toBe(
      "会话导入",
    );
    expect(visibleText(content)).toContain(
      "可选 Harness 来自本地 Host。运行状态未知时，请先在原生客户端关闭该会话再导入，避免同时写入。",
    );
    const harnessSelector = descendants(content).find(
      ({ dataset }) => dataset.sessionImportHarness === "selector",
    );
    if (!harnessSelector) throw new Error("Session Import Harness selector is not rendered");
    const harnessOptions = descendants(harnessSelector).filter(
      ({ dataset }) => dataset.sessionImportHarnessOption !== undefined,
    );
    expect(harnessOptions.map(({ textContent }) => textContent)).toEqual(["DeepSeek Harness"]);
    expect(
      harnessOptions.filter(({ disabled }) => !disabled).map(({ textContent }) => textContent),
    ).toEqual(["DeepSeek Harness"]);
    expect(
      harnessOptions.find(({ attributes }) => attributes.get("aria-pressed") === "true")
        ?.textContent,
    ).toBe("DeepSeek Harness");
    for (const option of harnessOptions) option.dispatch("click");
    expect(client.listHarnessSessions).toHaveBeenCalledOnce();
    expect(client.importHarnessSession).not.toHaveBeenCalled();
    expect(
      descendants(content).find(
        ({ className, textContent }) =>
          className === "settings-visually-hidden" &&
          textContent.includes("idle-session-identifier-that-is-long"),
      )?.textContent,
    ).toContain("idle-session-identifier-that-is-long");
    expect(
      descendants(content).find(
        ({ className, textContent }) =>
          className === "settings-visually-hidden" && textContent.startsWith("运行中:"),
      )?.textContent,
    ).toBe("运行中: 请先在原生客户端关闭该会话，再刷新并导入。");

    const actions = descendants(content).filter(
      ({ dataset }) => dataset.sessionImportAction === "import",
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]?.disabled).toBe(false);
    expect(actions[1]?.disabled).toBe(true);
    actions[1]?.dispatch("click");
    expect(client.importHarnessSession).not.toHaveBeenCalled();
    actions[0]?.dispatch("click");
    expect(descendants(content)).toContain(actions[0]);
    expect(actions[0]?.getAttribute("aria-disabled")).toBe("true");
    expect(actions[0]?.getAttribute("aria-busy")).toBe("true");
    actions[0]?.dispatch("click");
    await vi.waitFor(() => expect(client.importHarnessSession).toHaveBeenCalledOnce());
    expect(client.importHarnessSession).toHaveBeenCalledWith({
      harnessId: "deepseek-harness",
      nativeSessionId: "idle-session-identifier-that-is-long",
    });
    await vi.waitFor(() =>
      expect(openImportedThread).toHaveBeenCalledWith("imported-thread", expect.any(AbortSignal)),
    );
    scope.dispose();
  });

  it("shows a localized focused error when import fails before commit", async () => {
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(async () => ({
        total: 1,
        candidates: [
          {
            nativeSessionId: "idle-session",
            title: "Import candidate",
            updatedAt: 1_700_000_000_000,
            cwd: "C:\\work",
            running: false,
          },
        ],
      })),
      importHarnessSession: vi.fn(async () => Promise.reject(new Error("private import detail"))),
    };
    const openImportedThread = vi.fn();
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
      openImportedThread,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Session Import page is not registered");
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(visibleText(content)).toContain("Import candidate"));

    descendants(content)
      .find(({ dataset }) => dataset.sessionImportAction === "import")
      ?.dispatch("click");

    await vi.waitFor(() => expect(visibleText(content)).toContain("could not be imported"));
    expect(elementWithClass(content, "settings-session-import-status").focused).toBe(true);
    expect(visibleText(content)).not.toContain("private import detail");
    expect(openImportedThread).not.toHaveBeenCalled();
    expect(
      descendants(content).find(({ dataset }) => dataset.sessionImportAction === "refresh")
        ?.disabled,
    ).toBe(false);
    scope.dispose();
  });

  it("coalesces import across page remount and lets only the current scope navigate", async () => {
    const imported = deferred<unknown>();
    const candidate = {
      nativeSessionId: "remounted-session",
      title: "Remounted session",
      updatedAt: 1_700_000_000_000,
      cwd: "C:\\work",
      running: false,
    };
    const sendRequest = vi.fn((method: string): Promise<unknown> => {
      if (method === HARNESS_SESSION_LIST_METHOD) {
        return Promise.resolve({ candidates: [candidate], total: 1 });
      }
      if (method === HARNESS_SESSION_IMPORT_METHOD) return imported.promise;
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const modelClient = createRendererModelClient([{ sendRequest }]);
    if (!modelClient?.listHarnessSessions || !modelClient.importHarnessSession) {
      throw new Error("DSH Modern Session client was not created");
    }
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: modelClient.listHarnessSessions,
      importHarnessSession: modelClient.importHarnessSession,
    };
    const navigated: string[] = [];
    const openImportedThread = vi.fn(async (threadId: string, signal: AbortSignal) => {
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      navigated.push(threadId);
    });
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
      openImportedThread,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Session Import page is not registered");

    const firstDocument = new FakeDocument();
    const firstContent = firstDocument.createElement("main");
    const firstScope = new RendererSettingsPageScope();
    page.mount({
      content: firstContent as unknown as HTMLElement,
      signal: firstScope.signal,
      runLatest: (operation, handlers) => firstScope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(visibleText(firstContent)).toContain("Remounted session"));
    descendants(firstContent)
      .find(({ dataset }) => dataset.sessionImportAction === "import")
      ?.dispatch("click");
    await vi.waitFor(() =>
      expect(
        sendRequest.mock.calls.filter(([method]) => method === HARNESS_SESSION_IMPORT_METHOD),
      ).toHaveLength(1),
    );
    const staleContent = visibleText(firstContent);
    firstScope.dispose();

    const currentDocument = new FakeDocument();
    const currentContent = currentDocument.createElement("main");
    const currentScope = new RendererSettingsPageScope();
    page.mount({
      content: currentContent as unknown as HTMLElement,
      signal: currentScope.signal,
      runLatest: (operation, handlers) => currentScope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(visibleText(currentContent)).toContain("Remounted session"));
    descendants(currentContent)
      .find(({ dataset }) => dataset.sessionImportAction === "import")
      ?.dispatch("click");
    expect(
      sendRequest.mock.calls.filter(([method]) => method === HARNESS_SESSION_IMPORT_METHOD),
    ).toHaveLength(1);

    imported.resolve({ threadId: "imported-thread" });
    await vi.waitFor(() => expect(navigated).toEqual(["imported-thread"]));
    expect(visibleText(firstContent)).toBe(staleContent);
    currentScope.dispose();
  });

  it("localizes unavailable and ordinary list failures without exposing their detail", async () => {
    const messages = rendererSettingsMessages("zh-CN");
    const document = new FakeDocument();
    for (const [error, expected] of [
      [new RendererSessionImportUnavailableError(), messages.sessionImportUnavailable],
      [new Error("private native failure detail"), messages.sessionImportLoadFailed],
    ] as const) {
      const client = {
        listSessionImportSources: vi.fn(async () => ({
          harnesses: [
            { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
          ],
        })),
        listHarnessSessions: vi.fn(async () => Promise.reject(error)),
        importHarnessSession: vi.fn(),
      };
      const page = createDefaultRendererSettingsPages(
        messages,
        () => null,
        () => null,
        () => client,
      ).find(({ id }) => id === "session-import");
      if (!page) throw new Error("Session Import page is not registered");
      const content = document.createElement("main");
      const scope = new RendererSettingsPageScope();
      page.mount({
        content: content as unknown as HTMLElement,
        signal: scope.signal,
        runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
      });

      await vi.waitFor(() => expect(visibleText(content)).toContain(expected));
      expect(visibleText(content)).not.toContain(error.message);
      scope.dispose();
    }
  });

  it("keeps project recovery actions after committed import navigation fails", async () => {
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(async () => ({
        total: 1,
        candidates: [
          {
            nativeSessionId: "idle-session",
            title: null,
            updatedAt: 1_700_000_000_000,
            cwd: "C:\\work",
            running: false,
          },
        ],
      })),
      importHarnessSession: vi.fn(async () => ({
        threadId: hostThreadIdSchema.parse("imported-thread"),
      })),
    };
    const openImportedThread = vi
      .fn()
      .mockRejectedValueOnce(new Error("private navigation detail"))
      .mockResolvedValueOnce(undefined);
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
      openImportedThread,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Session Import page is not registered");
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(visibleText(content)).toContain("Untitled session"));

    descendants(content)
      .find(({ dataset }) => dataset.sessionImportAction === "import")
      ?.dispatch("click");

    await vi.waitFor(() => expect(visibleText(content)).toContain("Session imported"));
    const recovery = elementWithClass(content, "settings-session-import-recovery");
    expect(recovery.focused).toBe(true);
    expect(visibleText(content)).toContain("C:\\work");
    expect(visibleText(content)).toContain("added as a project");
    expect(visibleText(content)).not.toContain("private navigation detail");

    const copyPath = descendants(content).find(
      ({ dataset }) => dataset.sessionImportAction === "copy-project-path",
    );
    if (!copyPath) throw new Error("Copy project path action is not rendered");
    copyPath.dispatch("click");
    await vi.waitFor(() => expect(document.clipboardWriteText).toHaveBeenCalledWith("C:\\work"));
    expect(visibleNotesText(copyPath)).toContain("Copied");

    const retry = descendants(content).find(
      ({ dataset }) => dataset.sessionImportAction === "retry-open",
    );
    if (!retry) throw new Error("Retry open action is not rendered");
    retry.dispatch("click");
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(
      descendants(content).find(({ dataset }) => dataset.sessionImportAction === "refresh")
        ?.disabled,
    ).toBe(true);
    await vi.waitFor(() => expect(openImportedThread).toHaveBeenCalledTimes(2));
    expect(client.importHarnessSession).toHaveBeenCalledOnce();
    scope.dispose();
  });

  it("shows an honest unavailable state without a local import client", () => {
    const page = createDefaultRendererSettingsPages(rendererSettingsMessages("en")).find(
      ({ id }) => id === "session-import",
    );
    if (!page) throw new Error("Session Import page is not registered");
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    expect(visibleText(content)).toContain("Session import is unavailable for this local Harness");
    expect(
      descendants(content).filter(({ dataset }) => dataset.sessionImportAction === "import"),
    ).toHaveLength(0);
    scope.dispose();
  });

  it("ignores a Session list that resolves after the settings page is disposed", async () => {
    const listed = deferred<{ candidates: never[]; total: number }>();
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(() => listed.promise),
      importHarnessSession: vi.fn(),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
    ).find(({ id }) => id === "session-import");
    if (!page) throw new Error("Session Import page is not registered");
    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    const before = visibleText(content);

    scope.dispose();
    listed.resolve({ candidates: [], total: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(visibleText(content)).toBe(before);
  });
});
