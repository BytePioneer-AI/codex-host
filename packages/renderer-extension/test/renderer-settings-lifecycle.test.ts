import { hostThreadIdSchema, type UpdateCheckResult } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const triggerRefresh = vi.fn(() => true);
const triggerSetUpdateAvailable = vi.fn();
const shellClose = vi.fn();

vi.mock("../src/codex-locale-adapter.js", () => ({
  readCodexLocaleSettings: vi.fn(async () => ({ preferredLocale: "en" })),
}));

vi.mock("../src/settings/localization.js", () => ({
  rendererSettingsMessages: vi.fn(() => ({})),
  resolveRendererSettingsLocale: vi.fn((languageTags: readonly string[]) =>
    languageTags[0]?.toLowerCase().startsWith("zh") ? "zh-CN" : "en",
  ),
}));

vi.mock("../src/settings/pages.js", () => ({
  createDefaultRendererSettingsPages: vi.fn(() => []),
}));

vi.mock("../src/settings/shell.js", () => ({
  installRendererSettingsShell: vi.fn(() => ({
    supported: true,
    open: false,
    activePageId: undefined,
    openSettings: vi.fn(),
    close: shellClose,
    dispose: vi.fn(),
  })),
}));

vi.mock("../src/settings/trigger.js", () => ({
  installRendererSettingsHeaderTrigger: vi.fn(() => ({
    root: null,
    refresh: triggerRefresh,
    setUpdateAvailable: triggerSetUpdateAvailable,
    dispose: vi.fn(),
  })),
}));

import { installRendererSettingsLifecycle } from "../src/renderer-settings-lifecycle.js";
import { createDefaultRendererSettingsPages } from "../src/settings/pages.js";

function failedUpdateCheck(): UpdateCheckResult {
  return {
    currentVersion: "0.3.2",
    installation: "npm",
    latestVersion: null,
    updateAvailable: false,
    installationAvailable: false,
    releaseNotes: null,
    releaseNotesUrl: null,
    status: null,
    error: "Update metadata is temporarily unavailable",
  };
}

describe("Renderer Settings lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("notifies consumers when the resolved Codex locale changes", async () => {
    const onLocaleChange = vi.fn();
    const ownerWindow = {
      navigator: { languages: ["zh-CN"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;

    const lifecycle = installRendererSettingsLifecycle(ownerWindow, { onLocaleChange });
    await Promise.resolve();
    await Promise.resolve();

    expect(onLocaleChange).toHaveBeenCalledWith("en");
    lifecycle.dispose();
  });

  it("does not bypass update backoff when DOM reconciliation refreshes repeatedly", async () => {
    vi.useFakeTimers();
    const checkUpdate = vi.fn(async () => failedUpdateCheck());
    const client = {
      checkUpdate,
      startUpdate: vi.fn(),
      readUpdateStatus: vi.fn(),
    };
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;

    const lifecycle = installRendererSettingsLifecycle(ownerWindow, {
      getUpdateClient: () => client,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 50; index += 1) lifecycle.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(checkUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkUpdate).toHaveBeenCalledTimes(2);

    lifecycle.dispose();
  });

  it("binds Session import to its narrow client and closes only after navigation", async () => {
    const events: string[] = [];
    const client = {
      listDeepSeekModernSessions: vi.fn(),
      importDeepSeekModernSession: vi.fn(),
    };
    const openImportedThread = vi.fn(async () => {
      events.push("opened");
    });
    shellClose.mockImplementation(() => events.push("closed"));
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;
    const lifecycle = installRendererSettingsLifecycle(ownerWindow, {
      getSessionImportClient: () => client,
      openImportedThread,
    });
    const call = vi.mocked(createDefaultRendererSettingsPages).mock.calls.at(-1);
    const getClient = call?.[3];
    const open = call?.[4];
    if (!getClient || !open) throw new Error("Session Import settings seams were not installed");

    expect(getClient()).toBe(client);
    await open(hostThreadIdSchema.parse("imported-thread"), new AbortController().signal);

    expect(openImportedThread).toHaveBeenCalledWith("imported-thread", expect.any(AbortSignal));
    expect(events).toEqual(["opened", "closed"]);
    lifecycle.dispose();
  });
});
