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
  tabIndex = 0;
  disabled = false;
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

  focus(): void {}

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

describe("Renderer Codex Accounts page", () => {
  it("renders cached Accounts before live metadata refresh completes", async () => {
    const refresh = Promise.withResolvers<{
      accounts: Array<{
        accountId: string;
        label: string;
        email: string;
        codexHome: string;
        active: boolean;
        isDefault: boolean;
      }>;
    }>();
    const cachedAccount = {
      accountId: "default",
      label: "Default",
      codexHome: "/tmp/default",
      active: true,
      isDefault: true,
    };
    const client = {
      listCodexAccounts: vi.fn(async () => ({ accounts: [cachedAccount] })),
      refreshCodexAccounts: vi.fn(() => refresh.promise),
      createCodexAccount: vi.fn(),
      deleteCodexAccount: vi.fn(),
      activateCodexAccount: vi.fn(),
      startCodexAccountLogin: vi.fn(),
      cancelCodexAccountLogin: vi.fn(),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
    ).find(({ id }) => id === "accounts");
    if (!page) throw new Error("Accounts page is not registered");

    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });

    await vi.waitFor(() => expect(visibleText(content)).toContain("Default"));
    expect(client.refreshCodexAccounts).toHaveBeenCalledOnce();

    refresh.resolve({ accounts: [{ ...cachedAccount, email: "cached@example.com" }] });
    await vi.waitFor(() => expect(visibleText(content)).toContain("cached@example.com"));

    scope.dispose();
  });

  it("creates an isolated Account and starts sign-in without asking for a name", async () => {
    const createdAccount = {
      accountId: "work",
      label: "Codex Account",
      codexHome: "/tmp/work",
      active: false,
      isDefault: false,
    };
    const client = {
      listCodexAccounts: vi.fn(async () => ({ accounts: [] })),
      createCodexAccount: vi.fn(async () => ({ account: createdAccount })),
      deleteCodexAccount: vi.fn(),
      activateCodexAccount: vi.fn(),
      startCodexAccountLogin: vi.fn(async ({ accountId }: { accountId: string }) => ({
        accountId,
        loginId: "login-1",
        verificationUrl: "https://example.com/device",
        userCode: "ABCD-EFGH",
      })),
      cancelCodexAccountLogin: vi.fn(async () => ({ cancelled: true })),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
    ).find(({ id }) => id === "accounts");
    if (!page) throw new Error("Accounts page is not registered");

    const document = new FakeDocument();
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(client.listCodexAccounts).toHaveBeenCalledTimes(1));

    expect(descendants(content).some(({ tagName }) => tagName === "input")).toBe(false);
    const add = descendants(content).find(
      ({ tagName, children }) => tagName === "button" && children.includes("Add Account"),
    );
    add?.dispatch("click");

    await vi.waitFor(() => expect(client.createCodexAccount).toHaveBeenCalledWith({}));
    await vi.waitFor(() =>
      expect(client.startCodexAccountLogin).toHaveBeenCalledWith({ accountId: "work" }),
    );
    await vi.waitFor(() => expect(visibleText(content)).toContain("ABCD-EFGH"));

    scope.dispose();
  });

  it("allows deleting only non-default Accounts", async () => {
    const deleteCodexAccount = vi.fn(async ({ accountId }: { accountId: string }) => ({
      deletedAccountId: accountId,
    }));
    const client = {
      listCodexAccounts: vi.fn(async () => ({
        accounts: [
          {
            accountId: "default",
            label: "Default",
            codexHome: "/tmp/default",
            active: true,
            isDefault: true,
          },
          {
            accountId: "work",
            label: "Work",
            codexHome: "/tmp/work",
            active: false,
            isDefault: false,
          },
        ],
      })),
      createCodexAccount: vi.fn(),
      deleteCodexAccount,
      activateCodexAccount: vi.fn(),
      startCodexAccountLogin: vi.fn(),
      cancelCodexAccountLogin: vi.fn(),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
    ).find(({ id }) => id === "accounts");
    if (!page) throw new Error("Accounts page is not registered");

    const document = new FakeDocument();
    document.defaultView.confirm = vi.fn(() => true);
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(visibleText(content)).toContain("Work"));

    const deleteButtons = descendants(content).filter(
      ({ tagName, textContent }) => tagName === "button" && textContent === "Delete",
    );
    expect(deleteButtons).toHaveLength(1);
    deleteButtons[0]?.dispatch("click");
    expect(document.defaultView.confirm).toHaveBeenCalledWith(
      "Delete this Account and its local data? This cannot be undone.",
    );
    await vi.waitFor(() => expect(deleteCodexAccount).toHaveBeenCalledWith({ accountId: "work" }));
    await vi.waitFor(() => expect(visibleText(content)).not.toContain("Work"));
    expect(visibleText(content)).toContain("Default");

    scope.dispose();
  });

  it("hides login for valid Accounts and exposes device-code login for others", async () => {
    let active = "personal";
    const personal = { email: undefined as string | undefined };
    let loginCompleted:
      | ((result: {
          accountId: string;
          loginId: string;
          success: boolean;
          error: string | null;
        }) => void)
      | undefined;
    const listCodexAccounts = vi.fn(async () => ({
      accounts: [
        {
          accountId: "personal",
          label: "Personal",
          ...(personal.email ? { email: personal.email } : {}),
          codexHome: "/tmp/personal",
          active: active === "personal",
          isDefault: true,
        },
        {
          accountId: "work",
          label: "Work",
          email: "work@example.com",
          codexHome: "/tmp/work",
          active: active === "work",
          isDefault: false,
        },
      ],
    }));
    const loginStart = Promise.withResolvers<{
      accountId: string;
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }>();
    const client = {
      listCodexAccounts,
      refreshCodexAccounts: listCodexAccounts,
      createCodexAccount: vi.fn(),
      deleteCodexAccount: vi.fn(async ({ accountId }: { accountId: string }) => ({
        deletedAccountId: accountId,
      })),
      activateCodexAccount: vi.fn(async ({ accountId }: { accountId: string }) => {
        active = accountId;
        return {
          account: {
            accountId,
            label: "Work",
            codexHome: "/tmp/work",
            active: true,
            isDefault: false,
          },
        };
      }),
      startCodexAccountLogin: vi.fn(() => loginStart.promise),
      cancelCodexAccountLogin: vi.fn(async () => ({ cancelled: true })),
      subscribeCodexAccountLogin: vi.fn((listener: typeof loginCompleted) => {
        loginCompleted = listener;
        return () => undefined;
      }),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => null,
      () => null,
      () => client,
    ).find(({ id }) => id === "accounts");
    if (!page) throw new Error("Accounts page is not registered");

    const document = new FakeDocument();
    const openInBrowser = vi.fn(async () => undefined);
    (
      document.defaultView as Window & {
        electronBridge: { sendMessageFromView: typeof openInBrowser };
      }
    ).electronBridge = { sendMessageFromView: openInBrowser };
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    await vi.waitFor(() => expect(visibleText(content)).toContain("Personal"));
    expect(visibleText(content)).toContain("Existing tasks stay with their original Account");
    expect(visibleText(content)).toContain("Enable device code authorization for Codex");
    expect(visibleText(content)).not.toContain("token");
    expect(
      descendants(content).filter(
        ({ tagName, textContent }) => tagName === "button" && textContent === "Sign in",
      ),
    ).toHaveLength(1);

    const useWork = descendants(content).find(
      ({ tagName, textContent }) => tagName === "button" && textContent === "Use for new tasks",
    );
    useWork?.dispatch("click");
    await vi.waitFor(() =>
      expect(client.activateCodexAccount).toHaveBeenCalledWith({ accountId: "work" }),
    );
    await vi.waitFor(() => expect(visibleText(content)).toContain("Active"));

    const signIn = descendants(content).find(
      ({ tagName, textContent }) => tagName === "button" && textContent === "Sign in",
    );
    signIn?.dispatch("click");
    const signInButtons = descendants(content).filter(
      ({ tagName, textContent }) => tagName === "button" && textContent === "Sign in",
    );
    expect(signInButtons.every(({ disabled }) => disabled)).toBe(true);
    signInButtons.at(-1)?.dispatch("click");
    expect(client.startCodexAccountLogin).toHaveBeenCalledTimes(1);
    loginStart.resolve({
      accountId: "personal",
      loginId: "login-1",
      verificationUrl: "https://example.com/device",
      userCode: "ABCD-EFGH",
    });
    await vi.waitFor(() => expect(visibleText(content)).toContain("ABCD-EFGH"));
    expect(visibleText(content)).toContain("https://example.com/device");
    const verificationLink = descendants(content).find(
      ({ tagName, href }) => tagName === "a" && href === "https://example.com/device",
    );
    const preventDefault = vi.fn();
    verificationLink?.dispatch("click", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openInBrowser).toHaveBeenCalledWith({
      type: "open-in-browser",
      url: "https://example.com/device",
      initiator: "open_in_browser_bridge",
      openTarget: "external-browser",
      source: "manual",
    });
    expect(
      descendants(content).find(
        ({ tagName, textContent }) => tagName === "button" && textContent === "Sign in",
      )?.disabled,
    ).toBe(true);
    personal.email = "personal@example.com";
    const refreshAfterLogin = vi.mocked(document.defaultView.setTimeout).mock.calls.at(-1)?.[0];
    if (typeof refreshAfterLogin !== "function") {
      throw new Error("Account login refresh was not scheduled");
    }
    refreshAfterLogin();
    await vi.waitFor(() =>
      expect(
        descendants(content).some(
          ({ tagName, textContent }) => tagName === "button" && textContent === "Sign in",
        ),
      ).toBe(false),
    );
    expect(visibleText(content)).toContain("Sign-in completed");
    expect(visibleText(content)).not.toContain("ABCD-EFGH");
    expect(loginCompleted).toBeTypeOf("function");

    cleanup?.();
    scope.dispose();
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
