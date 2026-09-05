import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  type ThreadUsageInspection,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  DEEPSEEK_MODERN_SESSION_IMPORT_METHOD,
  DEEPSEEK_MODERN_SESSION_LIST_METHOD,
  HARNESS_INSPECT_METHOD,
  HARNESS_PLUGIN_LIST_METHOD,
  HARNESS_WEB_UI_OPEN_METHOD,
  THREAD_FORK_METHOD,
  THREAD_INSPECT_METHOD,
  THREAD_MODEL_SELECT_METHOD,
  THREAD_PERMISSION_MODE_SELECT_METHOD,
  THREAD_THINKING_SELECT_METHOD,
  THREAD_OWNERSHIP_LIST_METHOD,
  THREAD_TOKEN_USAGE_UPDATED_METHOD,
  THREAD_USAGE_INSPECT_METHOD,
  THREAD_USAGE_UPDATED_METHOD,
  UPDATE_CHECK_METHOD,
  UPDATE_START_METHOD,
  UPDATE_STATUS_METHOD,
  RendererDeepSeekSessionUnavailableError,
  createRendererModelClient,
  createThreadUsageSubscriptionRelay,
} from "../src/renderer-model-client.js";
import { RendererSessionImportUnavailableError } from "../src/renderer-session-import-client.js";


const piHarnessId = harnessIdSchema.parse("pi");
const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });
const high = harnessThinkingOptionIdSchema.parse("high");
const permissionModeId = harnessPermissionModeIdSchema.parse("auto");
const thinkingOptions = [
  { id: harnessThinkingOptionIdSchema.parse("off"), label: "Off" },
  { id: high, label: "High" },
];
const inspection = {
  status: "ready" as const,
  catalog: {
    models: [
      {
        ref: model,
        label: "provider / model",
        supportedThinkingOptionIds: thinkingOptions.map(({ id }) => id),
      },
    ],
    defaultModel: model,
    thinkingOptions,
    defaultThinkingOptionId: high,
  },
  capabilities: {
    configuration: {
      selectModel: true,
      selectThinkingOption: true,
      selectPermissionMode: false,
      permissionModeScope: "live" as const,
    },
    history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
  },
};

describe("Renderer fixed Model request client", () => {
  it("reads plugin descriptors from its own target and rejects backend or executable metadata", async () => {
    const sendLocal = vi
      .fn()
      .mockResolvedValue({ plugins: [{ id: "local-agent", name: "Local Agent", version: "1" }] });
    const sendRemote = vi
      .fn()
      .mockResolvedValue({ plugins: [{ id: "remote-agent", name: "Remote Agent", version: "2" }] });
    const local = createRendererModelClient([{ sendRequest: sendLocal }]);
    const remote = createRendererModelClient([{ sendRequest: sendRemote }]);
    expect(await local?.listHarnessPlugins?.()).toMatchObject({ plugins: [{ id: "local-agent" }] });
    expect(await remote?.listHarnessPlugins?.()).toMatchObject({
      plugins: [{ id: "remote-agent" }],
    });
    expect(sendLocal).toHaveBeenCalledExactlyOnceWith(HARNESS_PLUGIN_LIST_METHOD, {});
    expect(sendRemote).toHaveBeenCalledExactlyOnceWith(HARNESS_PLUGIN_LIST_METHOD, {});
    sendRemote.mockResolvedValue({
      plugins: [{ id: "remote-agent", name: "Remote", version: "1", icon: "javascript:alert(1)" }],
    });
    await expect(remote?.listHarnessPlugins?.()).rejects.toThrow();
    sendRemote.mockResolvedValue({
      plugins: [{ id: "remote-agent", name: "Remote", version: "1", entry: "/private/plugin.js" }],
    });
    await expect(remote?.listHarnessPlugins?.()).rejects.toThrow();
  });

  it("calls only the fixed inspect and select methods with validated params", async () => {
    let usageNotification: ((notification: unknown) => void) | undefined;
    const removeUsageNotification = vi.fn();
    const addNotificationCallback = vi.fn(
      (_method: string | readonly string[], callback: (notification: unknown) => void) => {
        usageNotification = callback;
        return removeUsageNotification;
      },
    );
    const sendRequest = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce(inspection)
      .mockResolvedValueOnce({
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        effectiveModel: model,
        effectiveThinkingOptionId: high,
        availableThinkingOptions: thinkingOptions,
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        locked: true,
      })
      .mockResolvedValueOnce({ threadId: "forked-thread" })
      .mockResolvedValueOnce({
        threads: [
          { threadId: "thread-1", owner: "external", harnessId: "pi" },
          { threadId: "official-thread", owner: "codex" },
        ],
      })
      .mockResolvedValueOnce({
        effectiveModel: model,
        effectiveThinkingOptionId: high,
        availableThinkingOptions: thinkingOptions,
      })
      .mockResolvedValueOnce({
        effectiveModel: model,
        effectiveThinkingOptionId: high,
        availableThinkingOptions: thinkingOptions,
      })
      .mockResolvedValueOnce({
        effectiveModel: model,
        effectivePermissionModeId: permissionModeId,
      })
      .mockResolvedValueOnce({
        threadId: "thread-1",
        usage: { cacheHitRatePercent: 99.9, totalCostUsd: 0.168 },
      })
      .mockResolvedValueOnce({
        threadId: "thread-1",
        usage: { cacheHitRatePercent: 97.9, totalCostUsd: 5.913 },
      })
      .mockResolvedValueOnce({
        currentVersion: "1.2.2",
        installation: "npm",
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: "Safer updates",
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
        status: null,
        error: null,
      })
      .mockResolvedValueOnce({
        status: {
          version: "1.2.3",
          installation: "npm",
          phase: "prepared",
          updatedAt: 10,
          error: null,
        },
      })
      .mockResolvedValueOnce({ status: null });
    const client = createRendererModelClient([{ addNotificationCallback, sendRequest }]);
    if (!client) throw new Error("Synthetic Model client was not created");
    expect(Object.keys(client).sort()).toEqual([
      "checkUpdate",
      "executeThreadCommand",
      "forkThread",
      "importHarnessSession",
      "inspectHarness",
      "inspectThread",
      "inspectThreadCommands",
      "inspectThreadUsage",
      "listHarnessSessions",
      "listSessionImportSources",
      "listHarnessPlugins",
      "listThreadOwnership",
      "openHarnessWebUi",
      "readUpdateStatus",
      "selectThreadModel",
      "selectThreadPermissionMode",
      "selectThreadThinking",
      "startUpdate",
      "subscribeThreadUsage",
    ]);

    await expect(client.inspectHarness({ harnessId: piHarnessId, refresh: true })).resolves.toEqual(
      inspection,
    );
    await expect(
      client.inspectThread({ threadId: hostThreadIdSchema.parse("thread-1") }),
    ).resolves.toMatchObject({
      owner: "external",
      harnessId: "pi",
      history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
      locked: true,
    });
    await expect(
      client.forkThread({
        threadId: hostThreadIdSchema.parse("thread-1"),
        lastTurnId: hostTurnIdSchema.parse("turn-1"),
      }),
    ).resolves.toEqual({ threadId: "forked-thread" });
    await expect(
      client.listThreadOwnership({
        threadIds: [
          hostThreadIdSchema.parse("thread-1"),
          hostThreadIdSchema.parse("official-thread"),
        ],
      }),
    ).resolves.toEqual({
      threads: [
        { threadId: "thread-1", owner: "external", harnessId: "pi" },
        { threadId: "official-thread", owner: "codex" },
      ],
    });
    await expect(
      client.selectThreadModel({
        threadId: hostThreadIdSchema.parse("thread-1"),
        model,
      }),
    ).resolves.toMatchObject({ effectiveModel: model, effectiveThinkingOptionId: high });
    await expect(
      client.selectThreadThinking({
        threadId: hostThreadIdSchema.parse("thread-1"),
        thinkingOptionId: high,
      }),
    ).resolves.toMatchObject({ effectiveModel: model, effectiveThinkingOptionId: high });
    expect(sendRequest).toHaveBeenNthCalledWith(1, HARNESS_INSPECT_METHOD, {
      harnessId: "pi",
      refresh: true,
    });
    expect(sendRequest).toHaveBeenNthCalledWith(2, THREAD_INSPECT_METHOD, {
      threadId: "thread-1",
    });
    expect(sendRequest).toHaveBeenNthCalledWith(3, THREAD_FORK_METHOD, {
      threadId: "thread-1",
      lastTurnId: "turn-1",
    });
    expect(sendRequest).toHaveBeenNthCalledWith(4, THREAD_OWNERSHIP_LIST_METHOD, {
      threadIds: ["thread-1", "official-thread"],
    });
    expect(sendRequest).toHaveBeenNthCalledWith(5, THREAD_MODEL_SELECT_METHOD, {
      threadId: "thread-1",
      model,
    });
    expect(sendRequest).toHaveBeenNthCalledWith(6, THREAD_THINKING_SELECT_METHOD, {
      threadId: "thread-1",
      thinkingOptionId: high,
    });
    await expect(
      client.selectThreadPermissionMode({
        threadId: hostThreadIdSchema.parse("thread-1"),
        permissionModeId,
      }),
    ).resolves.toMatchObject({ effectivePermissionModeId: permissionModeId });
    expect(sendRequest).toHaveBeenNthCalledWith(7, THREAD_PERMISSION_MODE_SELECT_METHOD, {
      threadId: "thread-1",
      permissionModeId,
    });
    await expect(
      client.inspectThreadUsage({
        threadId: hostThreadIdSchema.parse("thread-1"),
        refresh: "exact",
      }),
    ).resolves.toEqual({
      threadId: "thread-1",
      usage: { cacheHitRatePercent: 99.9, totalCostUsd: 0.168 },
    });
    expect(sendRequest).toHaveBeenNthCalledWith(8, THREAD_USAGE_INSPECT_METHOD, {
      threadId: "thread-1",
      refresh: "exact",
    });
    const onUsage = vi.fn();
    const unsubscribe = client.subscribeThreadUsage?.(onUsage);
    expect(addNotificationCallback).toHaveBeenCalledWith(
      [THREAD_TOKEN_USAGE_UPDATED_METHOD, THREAD_USAGE_UPDATED_METHOD],
      expect.any(Function),
    );
    usageNotification?.({
      method: THREAD_USAGE_UPDATED_METHOD,
      params: { threadId: "thread-1" },
    });
    usageNotification?.({
      method: THREAD_TOKEN_USAGE_UPDATED_METHOD,
      params: { threadId: "", turnId: "turn-1", tokenUsage: {} },
    });
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledOnce());
    expect(onUsage).toHaveBeenCalledWith({
      threadId: "thread-1",
      usage: { cacheHitRatePercent: 97.9, totalCostUsd: 5.913 },
    });
    unsubscribe?.();
    expect(removeUsageNotification).toHaveBeenCalledOnce();
    await expect(client.checkUpdate()).resolves.toMatchObject({ latestVersion: "1.2.3" });
    await expect(client.startUpdate()).resolves.toMatchObject({ status: { phase: "prepared" } });
    await expect(client.readUpdateStatus()).resolves.toEqual({ status: null });
    expect(sendRequest).toHaveBeenNthCalledWith(9, THREAD_USAGE_INSPECT_METHOD, {
      threadId: "thread-1",
    });
    expect(sendRequest).toHaveBeenNthCalledWith(10, UPDATE_CHECK_METHOD, {});
    expect(sendRequest).toHaveBeenNthCalledWith(11, UPDATE_START_METHOD, {});
    expect(sendRequest).toHaveBeenNthCalledWith(12, UPDATE_STATUS_METHOD, {});
  });

  it("uses only the fixed DSH Modern Session import methods and strict shapes", async () => {
    const sendRequest = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        candidates: [
          {
            nativeSessionId: "native-1",
            title: "Existing session",
            updatedAt: 1_000,
            cwd: "C:\\work",
            running: false,
          },
        ],
      })
      .mockResolvedValueOnce({ threadId: "thread-1" });
    const client = createRendererModelClient([{ sendRequest }]);
    if (
      !client?.listSessionImportSources ||
      !client.listHarnessSessions ||
      !client.importHarnessSession
    )
      throw new Error("Session import client missing");
    expect(await client.listSessionImportSources()).toEqual({
      harnesses: [{ harnessId: "pi", name: "Pi" }],
    });
    expect(await client.listHarnessSessions({ harnessId: piHarnessId })).toMatchObject({
      candidates: [{ nativeSessionId: "native-1", running: null }],
    });
    expect(
      await client.importHarnessSession({ harnessId: piHarnessId, nativeSessionId: "native-1" }),
    ).toEqual({ threadId: "thread-1" });
    expect(sendRequest.mock.calls).toEqual([
      ["codexhost/harness/session-import/sources", {}],
      ["codexhost/harness/session-import/list", { harnessId: "pi" }],
      ["codexhost/harness/session-import/import", { harnessId: "pi", nativeSessionId: "native-1" }],
    ]);
    for (const extra of [{ cwd: "C:\\injected" }, { locator: { sessionFile: "/injected" } }]) {
      await expect(
        client.importHarnessSession({
          harnessId: piHarnessId,
          nativeSessionId: "native-2",
          ...extra,
        }),
      ).rejects.toThrow();
    }
    expect(sendRequest).toHaveBeenCalledTimes(3);
  });

  it("coalesces an in-flight DSH Modern import across page mounts", async () => {
    const response = Promise.withResolvers<unknown>();
    const sendRequest = vi.fn(() => response.promise);
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client?.importHarnessSession) throw new Error("Session import client missing");
    const first = client.importHarnessSession({
      harnessId: piHarnessId,
      nativeSessionId: "native-1",
    });
    const remounted = client.importHarnessSession({
      harnessId: piHarnessId,
      nativeSessionId: "native-1",
    });
    const other = client.importHarnessSession({
      harnessId: harnessIdSchema.parse("deepseek-harness"),
      nativeSessionId: "native-1",
    });
    expect(sendRequest).toHaveBeenCalledTimes(2);
    response.resolve({ threadId: "thread-1" });
    await expect(first).resolves.toEqual({ threadId: "thread-1" });
    await expect(remounted).resolves.toEqual({ threadId: "thread-1" });
  });

  it("normalizes only stable unavailable DSH Modern response codes", async () => {
    const unavailable = Object.assign(new Error("private unavailable detail"), { code: -32076 });
    const unsupported = Object.assign(new Error("private unsupported detail"), { code: -32077 });
    const sendRequest = vi
      .fn()
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unsupported);
    const client = createRendererModelClient([{ sendRequest }]);
    if (
      !client?.listSessionImportSources ||
      !client.listHarnessSessions ||
      !client.importHarnessSession
    )
      throw new Error("Session import client missing");
    await expect(client.listSessionImportSources()).rejects.toBeInstanceOf(
      RendererSessionImportUnavailableError,
    );
    await expect(client.listHarnessSessions({ harnessId: piHarnessId })).rejects.toBeInstanceOf(
      RendererSessionImportUnavailableError,
    );
    await expect(
      client.importHarnessSession({ harnessId: piHarnessId, nativeSessionId: "native-1" }),
    ).rejects.toBeInstanceOf(RendererSessionImportUnavailableError);
  });

  it("keeps storage failures distinct from unsupported import and validates paging/search requests", async () => {
    const failure = Object.assign(new Error("private storage detail"), { code: -32077 });
    const sendRequest = vi.fn(async () => {
      throw failure;
    });
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client?.listHarnessSessions) throw new Error("Import client missing");
    await expect(
      client.listHarnessSessions({
        harnessId: piHarnessId,
        query: "needle",
        offset: 40,
        limit: 20,
      }),
    ).rejects.toBe(failure);
    expect(sendRequest).toHaveBeenCalledWith("codexhost/harness/session-import/list", {
      harnessId: "pi",
      query: "needle",
      offset: 40,
      limit: 20,
    });
    await expect(
      client.listHarnessSessions({ harnessId: piHarnessId, offset: -1 }),
    ).rejects.toThrow();
    await expect(
      client.listHarnessSessions({ harnessId: piHarnessId, limit: 0 }),
    ).rejects.toThrow();
    expect(sendRequest).toHaveBeenCalledOnce();
  });

  it("opens Harness Web through the pathless Host action", async () => {
    const sendRequest = vi.fn(() => Promise.resolve({}));
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client?.openHarnessWebUi) throw new Error("Harness Web UI client was not created");
    const harnessId = harnessIdSchema.parse("deepseek-harness");

    await expect(client.openHarnessWebUi({ harnessId })).resolves.toBeUndefined();
    expect(sendRequest).toHaveBeenCalledWith(HARNESS_WEB_UI_OPEN_METHOD, { harnessId });
    await expect(
      client.openHarnessWebUi({ harnessId, url: "http://127.0.0.1/?token=secret" } as never),
    ).rejects.toThrow();
    expect(sendRequest).toHaveBeenCalledOnce();
  });

  it("defers Usage notification registration until a request manager is available", () => {
    const relay = createThreadUsageSubscriptionRelay();
    const listener = vi.fn();
    const unsubscribe = relay.subscribe(listener);
    const unavailable = vi.fn(() => {
      throw new Error("Request manager is unavailable");
    });
    let notify: ((update: ThreadUsageInspection) => void) | undefined;
    const removeNotification = vi.fn();
    const subscribeThreadUsage = vi.fn((callback: typeof notify) => {
      notify = callback;
      return removeNotification;
    });

    expect(unavailable).not.toHaveBeenCalled();
    relay.connect({ subscribeThreadUsage: unavailable });
    relay.connect({ subscribeThreadUsage });
    expect(unavailable).toHaveBeenCalledOnce();
    expect(subscribeThreadUsage).toHaveBeenCalledOnce();
    notify?.({ threadId: hostThreadIdSchema.parse("thread-1"), usage: null });
    expect(listener).toHaveBeenCalledWith({ threadId: "thread-1", usage: null });

    unsubscribe();
    expect(removeNotification).toHaveBeenCalledOnce();
    relay.dispose();
  });

  it("fails closed when request manager ownership is absent or ambiguous", () => {
    expect(createRendererModelClient([])).toBeNull();
    expect(
      createRendererModelClient([{ sendRequest: vi.fn() }, { sendRequest: vi.fn() }]),
    ).toBeNull();
    expect(createRendererModelClient([{}])).toBeNull();
  });

  it("fails closed when Usage notifications cannot be attached", () => {
    const client = createRendererModelClient([{ sendRequest: vi.fn() }]);
    expect(client).not.toBeNull();
    expect(() => client?.subscribeThreadUsage?.(() => undefined)).toThrow(
      "Renderer Usage notification callback is unavailable",
    );
  });

  it("rejects a Thread inspection that leaks Native identity", async () => {
    const sendRequest = vi.fn(async () => ({
      owner: "external",
      harnessId: "pi",
      transportModelId: "codexhost/pi-native",
      locked: true,
      nativeSessionRef: { nativeSessionId: "private" },
    }));
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Synthetic Model client was not created");

    await expect(
      client.inspectThread({ threadId: hostThreadIdSchema.parse("thread-1") }),
    ).rejects.toThrow();
  });

  it("rejects ownership results that do not exactly match requested IDs", async () => {
    const sendRequest = vi.fn(async () => ({
      threads: [
        { threadId: "thread-2", owner: "codex" },
        { threadId: "thread-1", owner: "external", harnessId: "pi" },
      ],
    }));
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Synthetic Model client was not created");

    await expect(
      client.listThreadOwnership({
        threadIds: [hostThreadIdSchema.parse("thread-1"), hostThreadIdSchema.parse("thread-2")],
      }),
    ).rejects.toThrow("does not match");
  });

  it("rejects update results that expose privileged artifact data", async () => {
    const sendRequest = vi.fn(async () => ({
      currentVersion: "1.2.2",
      installation: "npm",
      latestVersion: "1.2.3",
      updateAvailable: true,
      installationAvailable: true,
      releaseNotes: "Safer updates",
      releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
      status: null,
      error: null,
      artifactUrl: "https://example.com/update.exe",
    }));
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Synthetic update client was not created");

    await expect(client.checkUpdate()).rejects.toThrow();
  });

  it("rejects a response that leaks undeclared native Model fields", async () => {
    const sendRequest = vi.fn(async () => ({
      ...inspection,
      catalog: {
        ...inspection.catalog,
        models: [
          {
            ref: model,
            label: "provider / model",
            provider: { baseUrl: "https://private.invalid", apiKey: "secret" },
          },
        ],
      },
    }));
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Synthetic Model client was not created");

    await expect(client.inspectHarness({ harnessId: piHarnessId })).rejects.toThrow();
  });
});
