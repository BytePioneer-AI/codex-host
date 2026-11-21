import { harnessIdSchema } from "@codexhost/shared-contracts";
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
  installRendererSettingsRailTrigger: vi.fn(() => ({
    root: null,
    refresh: triggerRefresh,
    setSelected: vi.fn(),
    setUpdateAvailable: triggerSetUpdateAvailable,
    dispose: vi.fn(),
  })),
}));

import { installRendererSettingsLifecycle } from "../src/renderer-settings-lifecycle.js";
import { createDefaultRendererSettingsPages } from "../src/settings/pages.js";
import { installRendererSettingsShell } from "../src/settings/shell.js";

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

type UpdateClientStub = ReturnType<typeof updateClient>;

function updateClient(check: () => Promise<UpdateCheckResult | null>) {
  return { checkUpdate: vi.fn(check), startUpdate: vi.fn(), readUpdateStatus: vi.fn() };
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

  function installWithClients(clients: { current: UpdateClientStub }) {
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;
    return installRendererSettingsLifecycle(ownerWindow, {
      getUpdateClient: () => clients.current,
    });
  }

  it("treats a null update check as final and clears the indicator", async () => {
    vi.useFakeTimers();
    const client = updateClient(async () => null);
    const lifecycle = installWithClients({ current: client });
    await vi.advanceTimersByTimeAsync(0);
    expect(triggerSetUpdateAvailable).toHaveBeenLastCalledWith(false);

    for (let index = 0; index < 20; index += 1) lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it.each([
    ["a structured error", async () => failedUpdateCheck()],
    ["a rejected request", async () => Promise.reject(new Error("unavailable"))],
  ])("stops refresh-driven checks after retries are exhausted by %s", async (_, check) => {
    vi.useFakeTimers();
    const clients = { current: updateClient(check) };
    const failing = clients.current;
    const lifecycle = installWithClients(clients);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing.checkUpdate).toHaveBeenCalledTimes(5);

    for (let index = 0; index < 20; index += 1) lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing.checkUpdate).toHaveBeenCalledTimes(5);

    clients.current = updateClient(async () => ({
      ...failedUpdateCheck(),
      latestVersion: "0.3.3",
      updateAvailable: true,
      error: null,
    }));
    lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients.current.checkUpdate).toHaveBeenCalledTimes(1);
    expect(triggerSetUpdateAvailable).toHaveBeenLastCalledWith(true);

    for (let index = 0; index < 20; index += 1) lifecycle.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients.current.checkUpdate).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it("passes the local statistics transport to settings pages", () => {
    const requestUsageStatistics = vi.fn(async () => ({}));
    const usageStatisticsHosts = vi.fn(async () => []);
    const desktopExtensionsClient = { listHostExtensions: vi.fn() };
    const delegationClient = { inspectHarness: vi.fn() };
    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: {},
      setTimeout,
      clearTimeout,
    } as unknown as Window;
    const lifecycle = installRendererSettingsLifecycle(ownerWindow, {
      requestUsageStatistics,
      usageStatisticsHosts,
      getDesktopExtensionsClient: () => desktopExtensionsClient,
      getDelegationClient: () => delegationClient,
    });
    const call = vi.mocked(createDefaultRendererSettingsPages).mock.calls.at(-1);
    expect(call?.[8]).toBe(requestUsageStatistics);
    expect(call?.[9]).toBe(usageStatisticsHosts);
    expect(call?.[11]?.()).toBe(desktopExtensionsClient);
    expect(call?.[13]?.()).toBe(delegationClient);
    lifecycle.dispose();
  });

  it("binds Session import to its narrow client and closes only after navigation", async () => {
    const events: string[] = [];
    const client = {
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(),
      importHarnessSession: vi.fn(),
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
    const getClient = call?.[4];
    const open = call?.[5];
    if (!getClient || !open) throw new Error("Session Import settings seams were not installed");

    expect(getClient()).toBe(client);
    await open(
      hostThreadIdSchema.parse("imported-thread"),
      new AbortController().signal,
      "remote-1",
    );

    expect(openImportedThread).toHaveBeenCalledWith(
      "imported-thread",
      expect.any(AbortSignal),
      "remote-1",
    );
    expect(events).toEqual(["opened", "closed"]);
    lifecycle.dispose();
  });

  it("keeps Session import navigation independent from the schedules router", async () => {
    const openImportedThread = vi.fn(async () => undefined);
    const openSchedules = vi.fn(async (): Promise<void> => {
      throw new Error("Native schedule navigation is unavailable");
    });
    const lifecycle = installRendererSettingsLifecycle(
      {
        navigator: { languages: ["en"] },
        document: {},
        setTimeout,
        clearTimeout,
      } as unknown as Window,
      {
        openImportedThread,
        harnessSchedules: {
          openSchedules,
        },
      },
    );
    const call = vi.mocked(createDefaultRendererSettingsPages).mock.calls.at(-1);
    const importOpen = call?.[5];
    const scheduleOpen = call?.[10]?.openSchedules;
    if (!importOpen || !scheduleOpen) throw new Error("Settings navigation was not installed");
    const signal = new AbortController().signal;
    await expect(scheduleOpen(signal)).rejects.toThrow("Native schedule navigation is unavailable");
    expect(shellClose).not.toHaveBeenCalled();
    expect(openImportedThread).not.toHaveBeenCalled();
    openSchedules.mockResolvedValueOnce(undefined);
    await scheduleOpen(signal);
    expect(shellClose).toHaveBeenCalledOnce();
    await importOpen(hostThreadIdSchema.parse("imported-thread"), signal);
    expect(openImportedThread).toHaveBeenCalledOnce();
    expect(openImportedThread.mock.calls[0]?.slice(0, 2)).toEqual(["imported-thread", signal]);
    expect(openSchedules).toHaveBeenCalledTimes(2);
    expect(shellClose).toHaveBeenCalledTimes(2);
    lifecycle.dispose();
  });

  it("periodically syncs installed Host extensions while Settings is open and stops on close", async () => {
    vi.useFakeTimers();
    const title = { en: "Ext A", "zh-CN": "扩展 A" };
    const extension = {
      id: "ext-a",
      state: "valid",
      activationId: "00000000-0000-4000-8000-000000000000",
      digest: "a".repeat(64),
      installedAt: "2026-01-01T00:00:00.000Z",
      manifest: {
        manifestVersion: 2,
        id: "ext-a",
        name: title,
        description: title,
        version: "1.0.0",
        desktop: { apiVersion: 1, script: "desktop.js" },
        settingsSchema: [
          {
            key: "flag",
            type: "boolean",
            label: { en: "Flag", "zh-CN": "开关" },
            default: true,
          },
        ],
      },
    } as const;
    const listHostExtensions = vi
      .fn()
      .mockResolvedValueOnce({
        revision: 1,
        configuration: { revision: 1, enabled: [extension.id] },
        diagnostics: [],
        extensions: [{ ...extension, enabled: true }],
      })
      .mockResolvedValueOnce({
        revision: 2,
        configuration: { revision: 2, enabled: [] },
        diagnostics: [],
        extensions: [{ ...extension, enabled: false }],
      });

    const ownerWindow = {
      navigator: { languages: ["en"] },
      document: { visibilityState: "visible" },
      setTimeout,
      clearTimeout,
    } as unknown as Window;

    const lifecycle = installRendererSettingsLifecycle(ownerWindow, {
      getDesktopExtensionsClient: () => ({ listHostExtensions }),
    });

    const shellCall = vi.mocked(installRendererSettingsShell).mock.calls.at(-1);
    const shellOptions = shellCall?.[3];
    const pluginPages = shellOptions?.pluginPages;
    if (!shellOptions?.onOpenChange || !pluginPages) {
      throw new Error("Expected shell onOpenChange and pluginPages options");
    }

    // Opening Settings triggers an immediate sync and registers ext-a's declarative page.
    shellOptions.onOpenChange(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(listHostExtensions).toHaveBeenCalledTimes(1);
    expect(pluginPages.hasPageForExtension("ext-a")).toBe(true);

    // Periodic sync detects external disable while Settings remains open and removes ext-a.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listHostExtensions).toHaveBeenCalledTimes(2);
    expect(pluginPages.hasPageForExtension("ext-a")).toBe(false);

    // Closing Settings stops further periodic polling.
    shellOptions.onOpenChange(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(listHostExtensions).toHaveBeenCalledTimes(2);

    lifecycle.dispose();
  });
});
