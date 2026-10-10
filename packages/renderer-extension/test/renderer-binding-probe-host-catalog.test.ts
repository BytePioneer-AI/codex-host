import {
  harnessIdSchema,
  harnessPluginDescriptorSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import type * as RendererComposerDom from "../src/renderer-composer-dom.js";
import {
  isRendererModelPickerDisabled,
  rendererModelSelectionFailed,
  type RendererModelControlView,
} from "../src/renderer-model-picker.js";
import type { RendererRequestOptions } from "../src/renderer-request-sender.js";
import type { installRendererSidebarAgentIcons } from "../src/renderer-sidebar-agent-icons.js";
import type { RendererConnectionDiagnostics } from "../src/settings/connections-page.js";
import type { RendererSessionImportClient } from "../src/settings/session-import-page.js";
import type * as VersionedRendererAdapter from "../src/versioned-renderer-adapter.js";

const testState = vi.hoisted(() => ({
  composer: null as unknown as Element,
  editor: null as unknown as Element,
  sendButton: null as unknown as HTMLButtonElement,
  renderedModelViews: [] as RendererModelControlView[],
  selectModel: null as null | ((modelId: string) => void),
  selectThinking: null as null | ((thinkingOptionId: string) => void),
  getConnectionDiagnostics: null as null | (() => RendererConnectionDiagnostics | null),
  getSessionImportClient: null as null | (() => RendererSessionImportClient | null),
  sidebarOptions: null as null | Parameters<typeof installRendererSidebarAgentIcons>[0],
  sidebarRefresh: vi.fn(),
  documentListeners: new Map<string, EventListener>(),
  modelTarget: ["conversation", "thread-a"] as readonly unknown[],
  prewarmClears: 0,
  notifyMutations: null as null | ((records: MutationRecord[]) => void),
  animationFrames: [] as FrameRequestCallback[],
}));

vi.mock("../src/renderer-composer-dom.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererComposerDom>();
  return {
    ...original,
    composerForEditor: () => testState.composer,
    composerForElement: () => testState.composer,
    editorForElement: (element: Element) =>
      element === testState.editor || element === testState.composer ? testState.editor : null,
    eventElement: () => testState.composer,
    mountComposerAgentControl: (
      ...args: Parameters<typeof RendererComposerDom.mountComposerAgentControl>
    ) => {
      testState.selectModel = args[7];
      testState.selectThinking = args[8];
      return {
        composer: testState.composer,
        composerId: "composer-1",
        setPlugins: vi.fn(),
        root: { isConnected: true, remove: vi.fn() },
        picker: { root: { isConnected: true } },
        modelPicker: { root: { isConnected: true }, trigger: {} },
        permissionModePicker: { root: { isConnected: true } },
        nativeModelControl: null,
        nativePermissionModeControl: null,
        nativeContextUsageControl: null,
        nativePermissionModeControlVerified: false,
        credits: { anchor: null, place: vi.fn(), root: { remove: vi.fn() } },
        usage: null,
        harnessCommands: {
          setCommands: vi.fn(),
          setExecuting: vi.fn(),
          setLocale: vi.fn(),
          placeBefore: vi.fn(),
          dispose: vi.fn(),
        },
        sendButton: testState.sendButton,
        sendDisabledBeforeSwitch: null,
      };
    },
    renderComposerAgentControl: (
      _control: unknown,
      _selection: unknown,
      _adapter: unknown,
      _switching: unknown,
      _availability: unknown,
      modelView: RendererModelControlView,
    ) => {
      testState.renderedModelViews.push({ ...modelView });
    },
    reconcileComposerNativeControls: vi.fn(),
    disposeComposerAgentControl: vi.fn(),
    sendButtonWithin: () => testState.sendButton,
  };
});

vi.mock("../src/versioned-renderer-adapter.js", async (importOriginal) => {
  const original = await importOriginal<typeof VersionedRendererAdapter>();
  return {
    ...original,
    findComposerModelTarget: () => testState.modelTarget,
    waitForRendererDraftPrewarmPolicy: async () => ({
      clear: async () => {
        testState.prewarmClears += 1;
      },
    }),
  };
});

vi.mock("../src/renderer-sidebar-agent-icons.js", () => ({
  SIDEBAR_THREAD_ROW_SELECTOR: "[data-app-action-sidebar-thread-row]",
  installRendererSidebarAgentIcons: (
    options: Parameters<typeof installRendererSidebarAgentIcons>[0],
  ) => {
    testState.sidebarOptions = options;
    return { refresh: testState.sidebarRefresh, dispose: vi.fn() };
  },
}));

vi.mock("../src/renderer-settings-lifecycle.js", () => ({
  installRendererSettingsLifecycle: (
    _window: unknown,
    options: {
      getConnectionDiagnostics(): RendererConnectionDiagnostics | null;
      getSessionImportClient(): RendererSessionImportClient | null;
    },
  ) => {
    testState.getConnectionDiagnostics = options.getConnectionDiagnostics;
    testState.getSessionImportClient = options.getSessionImportClient;
    return {
      locale: "en",
      refresh: vi.fn(),
      dispose: vi.fn(),
    };
  },
}));

async function listHarnessPlugins() {
  return {
    plugins: ["pi", "claude-code", "deepseek-harness"].map((id) => ({
      id,
      name: id,
      version: "1",
    })),
  };
}

function readyInspection(modelId = "claude-model-v1.b3B1cw") {
  const model = harnessModelRefSchema.parse({ id: modelId });
  return {
    status: "ready" as const,
    catalog: {
      models: [{ ref: model, label: modelId }],
      defaultModel: model,
      thinkingOptions: [],
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: false,
        selectPermissionMode: false,
        permissionModeScope: "live" as const,
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
    },
  };
}

function emptyInspection() {
  return {
    status: "ready" as const,
    catalog: { models: [], thinkingOptions: [] },
    capabilities: {
      configuration: {
        selectModel: false,
        selectThinkingOption: false,
        selectPermissionMode: false,
        permissionModeScope: "live" as const,
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
    },
  };
}

function installFakeBrowser(): void {
  const listeners = new EventTarget();
  class FakeElement {
    readonly nodeType = 1;
    closest(): Element | null {
      return null;
    }
    querySelector(): Element | null {
      return null;
    }
  }
  const composer = Object.assign(new FakeElement(), {
    isConnected: true,
    matches: (selector: string) => selector === "[data-codex-composer-root]",
    querySelectorAll: (selector: string) => (selector === "button" ? [testState.sendButton] : []),
    querySelector: (selector: string) => (selector.includes("textarea") ? testState.editor : null),
  }) as unknown as Element;
  const editor = Object.assign(new FakeElement(), {
    closest: () => composer,
  }) as unknown as Element;
  const sendButton = {
    type: "submit",
    disabled: false,
    parentElement: null,
    getAttribute: () => null,
  } as unknown as HTMLButtonElement;
  testState.composer = composer;
  testState.editor = editor;
  testState.sendButton = sendButton;
  testState.renderedModelViews = [];
  testState.selectModel = null;
  testState.selectThinking = null;
  testState.getConnectionDiagnostics = null;
  testState.getSessionImportClient = null;
  testState.documentListeners.clear();
  testState.modelTarget = ["conversation", "thread-a"];
  testState.prewarmClears = 0;
  testState.notifyMutations = null;
  testState.animationFrames = [];
  const window_ = {
    addEventListener: listeners.addEventListener.bind(listeners),
    removeEventListener: listeners.removeEventListener.bind(listeners),
    dispatchEvent: listeners.dispatchEvent.bind(listeners),
    setTimeout,
    clearTimeout,
    open: vi.fn(),
  };
  const document_ = {
    documentElement: {},
    body: {},
    activeElement: null,
    querySelectorAll: (selector: string) => (selector.includes("textarea") ? [editor] : []),
    querySelector: () => null,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      testState.documentListeners.set(type, listener);
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("window", window_);
  vi.stubGlobal("document", document_);
  vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    testState.animationFrames.push(callback),
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: MutationCallback) {
        testState.notifyMutations = (records) => callback(records, this);
      }
      takeRecords(): MutationRecord[] {
        return [];
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "CustomEvent",
    class extends Event {
      constructor(
        type: string,
        readonly init?: CustomEventInit,
      ) {
        super(type);
      }
    },
  );
}

afterEach(() => {
  const api = (
    globalThis.window as unknown as {
      __codexhostRendererBindingProbeV1?: { dispose(): void };
    }
  ).__codexhostRendererBindingProbeV1;
  api?.dispose();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Renderer binding Host-scoped Claude catalogs", () => {
  it("loads remote sidebar artwork before any Composer opens on that Host", async () => {
    installFakeBrowser();
    const plugin = harnessPluginDescriptorSchema.parse({
      id: "remote-only",
      name: "Remote plugin",
      version: "1",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      iconStyle: {
        vector: { viewBox: "0 0 24 24", color: "currentColor", paths: [{ d: "M0 0h4v4z" }] },
      },
    });
    const local = {
      listHarnessPlugins: vi.fn(async () => ({ plugins: [] })),
      inspectThread: vi.fn(async () => ({ owner: "codex", locked: true })),
      inspectThreadUsage: vi.fn(async () => ({ threadId: "thread-a", usage: null })),
    };
    const remote = {
      listHarnessPlugins: vi.fn(async () => ({ plugins: [plugin] })),
      inspectHarness: vi.fn(async () => readyInspection()),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({});
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      {
        currentHostId: () => "local",
        knownHostIds: () => ["local", "remote"],
        clientForHost: (host: string) => (host === "local" ? local : remote),
      } as never,
    );
    try {
      await vi.waitFor(() => expect(local.listHarnessPlugins).toHaveBeenCalledOnce());
      expect(remote.listHarnessPlugins).not.toHaveBeenCalled();
      const getPlugins = testState.sidebarOptions?.getPlugins;
      assert(getPlugins);
      expect(getPlugins("remote")).toBeUndefined();
      await vi.waitFor(() => expect(getPlugins("remote")).toEqual([plugin]));
      expect(remote.listHarnessPlugins).toHaveBeenCalledOnce();
      expect(getPlugins("local")).toEqual([]);
    } finally {
      probe.dispose();
    }
  });

  it("keeps main-branch styling for an identical old remote image without replacing metadata", async () => {
    installFakeBrowser();
    const localPlugin = harnessPluginDescriptorSchema.parse({
      id: "pi",
      name: "Local Pi",
      version: "new",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      iconStyle: {
        vector: { viewBox: "0 0 24 24", color: "currentColor", paths: [{ d: "M0 0h4v4z" }] },
      },
    });
    const remotePlugin = {
      ...localPlugin,
      name: "Remote Pi",
      version: "old",
      iconStyle: undefined,
    };
    const local = {
      listHarnessPlugins: async () => ({ plugins: [localPlugin] }),
      inspectHarness: async () => readyInspection(),
      inspectThread: async () => ({ owner: "codex", locked: true }),
      inspectThreadUsage: async () => ({ threadId: "thread-a", usage: null }),
    };
    const remote = {
      listHarnessPlugins: async () => ({ plugins: [remotePlugin] }),
      inspectHarness: async () => readyInspection(),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({});
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      {
        currentHostId: () => "local",
        knownHostIds: () => ["local", "remote"],
        clientForHost: (host: string) => (host === "local" ? local : remote),
      } as never,
    );
    try {
      const getPlugins = testState.sidebarOptions?.getPlugins;
      assert(getPlugins);
      await vi.waitFor(() =>
        expect(getPlugins("remote")).toEqual([
          { ...remotePlugin, iconStyle: localPlugin.iconStyle },
        ]),
      );
      expect(
        testState
          .getConnectionDiagnostics?.()
          ?.snapshot()
          .hosts.find(({ hostId }) => hostId === "remote")?.agents[0]?.plugin,
      ).toEqual({
        ...remotePlugin,
        iconStyle: localPlugin.iconStyle,
      });
    } finally {
      probe.dispose();
    }
  });

  it("discovers session plugins per Host, excludes usage-only plugins and supports an empty directory", async () => {
    installFakeBrowser();
    let localPlugins = [
      { id: "unseen-local", name: "Local plugin", version: "1" },
      { id: "codex-usage", name: "Codex usage", version: "1", kind: "usage" as const },
    ];
    const local = {
      listHarnessPlugins: async () => ({ plugins: localPlugins }),
      inspectHarness: vi.fn(async () => readyInspection()),
      inspectThread: vi.fn(async () => ({ owner: "codex", locked: true })),
      inspectThreadUsage: vi.fn(async () => ({ threadId: "thread-a", usage: null })),
    };
    const remote = {
      listHarnessPlugins: async () => ({
        plugins: [{ id: "unseen-remote", name: "Remote plugin", version: "2" }],
      }),
      inspectHarness: vi.fn(async () => readyInspection()),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({});
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      {
        currentHostId: () => "local",
        knownHostIds: () => ["local", "remote"],
        clientForHost: (host: string) => (host === "local" ? local : remote),
        subscribeThreadUsage: () => () => undefined,
      } as never,
    );
    try {
      const diagnostics = testState.getConnectionDiagnostics?.();
      assert(diagnostics);
      await diagnostics.refresh();
      const hosts = diagnostics.snapshot().hosts;
      expect(hosts.find(({ hostId }) => hostId === "local")?.agents).toMatchObject([
        { agent: "unseen-local", plugin: { name: "Local plugin" }, availability: "ready" },
      ]);
      expect(hosts.find(({ hostId }) => hostId === "remote")?.agents).toMatchObject([
        { agent: "unseen-remote", plugin: { name: "Remote plugin" }, availability: "ready" },
      ]);
      expect(local.inspectHarness.mock.calls.flat()).not.toContainEqual(
        expect.objectContaining({ harnessId: "codex-usage" }),
      );
      expect(remote.inspectHarness).toHaveBeenCalledWith(
        { harnessId: "unseen-remote", refresh: true },
        { priority: "background" },
      );
      localPlugins = [];
      await diagnostics.refresh("local");
      expect(diagnostics.snapshot().hosts.find(({ hostId }) => hostId === "local")?.agents).toEqual(
        [],
      );
      expect(probe.lockedSelection()?.agent).toBe("codex");
    } finally {
      probe.dispose();
    }
  });
  it.each([
    { pendingHarness: "pi", modelFirst: true },
    { pendingHarness: "claude-code", modelFirst: true },
    { pendingHarness: "claude-code", modelFirst: false },
  ] as const)(
    "loads the current remote Model while $pendingHarness is queued (Model completes first: $modelFirst)",
    async ({ pendingHarness, modelFirst }) => {
      installFakeBrowser();
      const pending = Promise.withResolvers<ReturnType<typeof readyInspection>>();
      const catalog = Promise.withResolvers<ReturnType<typeof readyInspection>>();
      if (modelFirst) catalog.resolve(readyInspection());
      const local = {
        listHarnessPlugins,
        inspectHarness: vi.fn(async () => readyInspection()),
      };
      const remote = {
        listHarnessPlugins,
        inspectHarness: vi.fn(
          async (input: { harnessId: string }, options?: RendererRequestOptions) => {
            if (!options) return catalog.promise;
            return input.harnessId === pendingHarness ? pending.promise : readyInspection();
          },
        ),
        inspectThread: vi.fn(async () => ({
          owner: "external" as const,
          harnessId: "claude-code",
          transportModelId:
            "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
          effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
          history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
          locked: true,
        })),
        inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
        inspectThreadUsage: vi.fn(async () => ({ threadId: "thread-a", usage: null })),
      };
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({
        enabledAgents: ["codex", "pi", "claude-code"],
        defaultAgent: "codex",
      });
      try {
        probe.setAdapter(
          { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
          undefined,
          undefined,
          {
            ...remote,
            currentHostId: () => "remote-host",
            clientForHost: (hostId: string) => (hostId === "local" ? local : remote),
            subscribeThreadUsage: () => () => undefined,
          } as never,
        );
        await vi.waitFor(() => {
          expect(probe.lockedSelection()?.agent).toBe("claude-code");
          expect(remote.inspectHarness).toHaveBeenCalledWith({ harnessId: "claude-code" });
          expect(testState.renderedModelViews.at(-1)).toMatchObject({
            status: modelFirst ? "ready" : "loading",
          });
        });
        expect(remote.inspectHarness).toHaveBeenCalledWith(
          { harnessId: "pi", refresh: false },
          { priority: "background" },
        );
        expect(remote.inspectHarness).toHaveBeenCalledWith(
          { harnessId: "claude-code", refresh: false },
          { priority: "background" },
        );
        expect(local.inspectHarness).toHaveBeenCalledWith(
          { harnessId: "pi", refresh: false },
          { priority: "background" },
        );
        expect(remote.inspectThread).toHaveBeenCalledWith({ threadId: "thread-a" });
        expect(probe.status().availability[pendingHarness]).toBe("checking");
        const foregroundCalls = () =>
          remote.inspectHarness.mock.calls.filter(([, options]) => options === undefined).length;
        expect(foregroundCalls()).toBe(1);
        const renderedBeforeDiscovery = testState.renderedModelViews.length;
        pending.resolve(readyInspection());
        await vi.waitFor(() => expect(probe.status().availability[pendingHarness]).toBe("ready"));
        expect(foregroundCalls()).toBe(1);
        if (modelFirst) {
          expect(testState.renderedModelViews.slice(renderedBeforeDiscovery)).not.toContainEqual(
            expect.objectContaining({ status: "loading" }),
          );
        }
        catalog.resolve(readyInspection());
        await vi.waitFor(() =>
          expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "ready" }),
        );
      } finally {
        probe.dispose();
        pending.resolve(readyInspection());
        catalog.resolve(readyInspection());
      }
    },
  );

  it("waits for Host ownership rather than probing local when the route is unknown", async () => {
    installFakeBrowser();
    const inspectHarness = vi.fn(async () => {
      throw new Error("Renderer Model request manager is unavailable");
    });
    const modelControl = {
      currentHostId: () => null,
      clientForHost: vi.fn(() => null),
      inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "pi"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );
    await Promise.resolve();
    const diagnostics = testState.getConnectionDiagnostics?.();
    expect(diagnostics?.snapshot().hosts.find(({ hostId }) => hostId === "local")?.agents).toEqual(
      [],
    ); // An unresolved Host has no invented plugin directory.
    expect(inspectHarness).not.toHaveBeenCalled();
  });
  it("includes discovered remote Hosts when the active Composer route is ambiguous", async () => {
    installFakeBrowser();
    const local = { listHarnessPlugins, inspectHarness: vi.fn(async () => readyInspection()) };
    const remote = { listHarnessPlugins, inspectHarness: vi.fn(async () => readyInspection()) };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "pi"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      {
        currentHostId: () => null,
        knownHostIds: () => ["local", "remote-ssh-discovered:linux"],
        clientForHost: (hostId: string) => (hostId === "local" ? local : remote),
      } as never,
    );
    const diagnostics = testState.getConnectionDiagnostics?.();
    await diagnostics?.refresh();
    expect(remote.inspectHarness).toHaveBeenCalledWith(
      { harnessId: "pi", refresh: true },
      expect.anything(),
    );
    expect(diagnostics?.snapshot().hosts.map(({ hostId }) => hostId)).toEqual([
      "local",
      "remote-ssh-discovered:linux",
    ]);
    expect(
      diagnostics?.snapshot().hosts[1]?.agents.find(({ agent }) => agent === "pi"),
    ).toMatchObject({ availability: "ready", error: null });
  });

  it("reports a disconnected Host and ignores its late availability reply without affecting local", async () => {
    installFakeBrowser();
    const pending = Promise.withResolvers<ReturnType<typeof readyInspection>>();
    const local = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => readyInspection()),
      inspectThread: vi.fn(async () => ({ owner: "codex", locked: true })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({ threadId: "thread-a", usage: null })),
      subscribeThreadUsage: () => () => undefined,
    };
    const remote = {
      ...local,
      inspectHarness: vi.fn(async (input: { harnessId: string }) =>
        input.harnessId === "pi" ? pending.promise : readyInspection(),
      ),
    };
    let connected = true;
    const modelControl = {
      ...remote,
      currentHostId: () => "remote-ssh-discovered:linux",
      clientForHost: (hostId: string) => (hostId === "local" ? local : connected ? remote : null),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "pi"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );
    await vi.waitFor(() => expect(remote.inspectHarness).toHaveBeenCalled());
    connected = false;
    const diagnostics = testState.getConnectionDiagnostics?.();
    await diagnostics?.refresh();
    pending.resolve(readyInspection());
    await Promise.resolve();
    await Promise.resolve();
    const hosts = diagnostics?.snapshot().hosts;
    expect(
      hosts
        ?.find(({ hostId }) => hostId === "remote-ssh-discovered:linux")
        ?.agents.find(({ agent }) => agent === "pi"),
    ).toMatchObject({ availability: "error", error: { code: "unavailable", retryable: true } });
    expect(
      hosts?.find(({ hostId }) => hostId === "local")?.agents.find(({ agent }) => agent === "pi"),
    ).toMatchObject({ availability: "ready", error: null });
  });

  it("skips editor text/IME mutations but retains visibility and structural reconciliation", async () => {
    installFakeBrowser();
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const { reconcileComposerNativeControls } = await import("../src/renderer-composer-dom.js");
    installRendererBindingProbe({ enabledAgents: ["codex"], defaultAgent: "codex" });
    const notify = testState.notifyMutations;
    assert(notify);
    const reconcile = vi.mocked(reconcileComposerNativeControls);
    const flushFrame = () => {
      for (const callback of testState.animationFrames.splice(0)) callback(performance.now());
    };
    reconcile.mockClear();
    const text = { nodeType: 3, parentElement: testState.editor } as unknown as Text;
    const mutation = (type: MutationRecordType, target: Node) =>
      ({ type, target, addedNodes: [], removedNodes: [] }) as unknown as MutationRecord;

    // Text replacement and rich-text paragraph edits are also childList changes.
    for (let index = 0; index < 10; index += 1) {
      notify([mutation("characterData", text), mutation("childList", testState.editor)]);
      await Promise.resolve();
    }
    expect(reconcile).not.toHaveBeenCalled();
    expect(testState.animationFrames).toHaveLength(0);

    notify([mutation("attributes", testState.editor)]);
    notify([mutation("attributes", testState.editor)]);
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();
    expect(testState.animationFrames).toHaveLength(1);
    flushFrame();
    expect(reconcile).toHaveBeenCalledTimes(1);
    reconcile.mockClear();

    // Replacement/removal happens on the editor's parent, outside its contents.
    const parent = Object.assign(Object.create(Element.prototype), { nodeType: 1 });
    notify([mutation("childList", parent)]);
    flushFrame();
    expect(reconcile).toHaveBeenCalledTimes(1);
    reconcile.mockClear();

    // Never drop a real structural change mixed into the same observer batch.
    notify([
      mutation("characterData", text),
      mutation("childList", parent),
      mutation("childList", testState.editor),
    ]);
    flushFrame();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not refresh sidebar ownership during unchanged Host reconciliation, but refreshes on a Host switch", async () => {
    installFakeBrowser();
    let hostId = "local";
    const host = {
      listHarnessPlugins: async () => ({ plugins: [] }),
      inspectThread: vi.fn(async () => ({ owner: "codex", locked: true })),
      inspectThreadCommands: async () => ({ commands: [] }),
      inspectThreadUsage: async () => ({ threadId: "thread-a", usage: null }),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({ enabledAgents: ["codex"], defaultAgent: "codex" });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      { currentHostId: () => hostId, clientForHost: () => host } as never,
    );
    const getAgent = testState.sidebarOptions?.getLocalAgent;
    assert(getAgent);
    await vi.waitFor(() =>
      expect(getAgent({ hostId: "local", threadId: "thread-a", draftId: null })).toBe("codex"),
    );
    const notify = testState.notifyMutations;
    assert(notify);
    const reconcile = () => {
      notify([
        {
          type: "attributes",
          target: testState.editor,
          addedNodes: [],
          removedNodes: [],
        } as unknown as MutationRecord,
      ]);
      for (const callback of testState.animationFrames.splice(0)) callback(performance.now());
    };
    testState.sidebarRefresh.mockClear();
    for (let index = 0; index < 10; index += 1) reconcile();
    expect(testState.sidebarRefresh).not.toHaveBeenCalled();

    hostId = "remote";
    reconcile();
    expect(testState.sidebarRefresh).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(getAgent({ hostId: "remote", threadId: "thread-a", draftId: null })).toBe("codex"),
    );
  });

  it("refreshes sidebar ownership when a mounted Host disconnects or replaces its client without changing Host ID", async () => {
    installFakeBrowser();
    const unsubscribe = vi.fn();
    const host = {
      listHarnessPlugins: async () => ({ plugins: [] }),
      inspectThread: async () => ({ owner: "codex", locked: true }),
      inspectThreadCommands: async () => ({ commands: [] }),
      inspectThreadUsage: async () => ({ threadId: "thread-a", usage: null }),
      subscribeThreadUsage: vi.fn(() => unsubscribe),
    };
    let client: typeof host | null = host;
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({ enabledAgents: ["codex"], defaultAgent: "codex" });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      { currentHostId: () => "local", clientForHost: () => client } as never,
    );
    await vi.waitFor(() =>
      expect(
        testState.sidebarOptions?.getLocalAgent?.({
          hostId: "local",
          threadId: "thread-a",
          draftId: null,
        }),
      ).toBe("codex"),
    );
    const notify = testState.notifyMutations;
    assert(notify);
    const reconcile = () => {
      notify([
        {
          type: "attributes",
          target: testState.editor,
          addedNodes: [],
          removedNodes: [],
        } as unknown as MutationRecord,
      ]);
      for (const callback of testState.animationFrames.splice(0)) callback(performance.now());
    };
    for (const next of [null, { ...host }]) {
      testState.sidebarRefresh.mockClear();
      client = next;
      reconcile();
      expect(testState.sidebarRefresh).toHaveBeenCalledOnce();
      testState.sidebarRefresh.mockClear();
      reconcile();
      expect(testState.sidebarRefresh).not.toHaveBeenCalled();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(host.subscribeThreadUsage).toHaveBeenCalledTimes(2);
  });

  it("does not rediscover the request route for unrelated sidebar rows", async () => {
    installFakeBrowser();
    const host = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => readyInspection()),
      inspectThread: vi.fn(async () => ({ owner: "codex", locked: true })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
      subscribeThreadUsage: () => () => undefined,
    };
    const currentHostId = vi.fn(() => "local");
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({ enabledAgents: ["codex"], defaultAgent: "codex" });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      { ...host, currentHostId, clientForHost: () => host } as never,
    );
    const getAgent = testState.sidebarOptions?.getLocalAgent;
    assert(getAgent);
    await vi.waitFor(() =>
      expect(getAgent({ hostId: "local", threadId: "thread-a", draftId: null })).toBe("codex"),
    );
    currentHostId.mockClear();
    for (let index = 0; index < 77; index += 1) {
      expect(
        getAgent({ hostId: "local", threadId: `unrelated-${index}`, draftId: null }),
      ).toBeNull();
    }
    expect(currentHostId).not.toHaveBeenCalled();
    expect(getAgent({ hostId: "local", threadId: "thread-a", draftId: null })).toBe("codex");
    expect(currentHostId).toHaveBeenCalledTimes(1);
    currentHostId.mockReturnValue("remote-host");
    expect(getAgent({ hostId: "local", threadId: "thread-a", draftId: null })).toBeNull();
  });

  it("keeps the latest catalog selectable until a locked Thread explicitly replaces its missing Model", async () => {
    installFakeBrowser();
    const oldModel = harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" });
    const inspection = {
      ...readyInspection("claude-model-v1.c29ubmV0"),
      permissionModes: {
        modes: [{ id: "bypassPermissions", label: "Bypass permissions" }],
        defaultModeId: "bypassPermissions",
      },
    };
    inspection.capabilities.configuration.selectThinkingOption = true;
    inspection.capabilities.configuration.selectPermissionMode = true;
    const newModel = inspection.catalog.defaultModel;
    let resolveSelection!: (state: { effectiveModel: typeof newModel }) => void;
    const host = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => inspection),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: oldModel,
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
      selectThreadModel: vi
        .fn()
        .mockRejectedValueOnce(new Error("Model selection failed"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSelection = resolve;
            }),
        ),
      subscribeThreadUsage: () => () => undefined,
    };
    const modelControl = {
      ...host,
      currentHostId: () => "local",
      clientForHost: () => host,
    };
    const applyAgent = vi.fn(() => true);
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      applyAgent,
      modelControl as never,
    );
    const expectSubmissionBlocked = (blocked: boolean) => {
      const preventDefault = vi.fn();
      const stopImmediatePropagation = vi.fn();
      const submit = testState.documentListeners.get("submit");
      assert(submit);
      submit({
        target: testState.composer,
        preventDefault,
        stopImmediatePropagation,
      } as unknown as Event);
      expect(preventDefault).toHaveBeenCalledTimes(blocked ? 1 : 0);
      expect(stopImmediatePropagation).toHaveBeenCalledTimes(blocked ? 1 : 0);
    };
    const expectRecoverableView = (error: string, selectionRejected: boolean) => {
      const view = testState.renderedModelViews.at(-1);
      assert(view);
      expect(view).toMatchObject({
        status: "error",
        catalog: inspection.catalog,
        selected: oldModel,
        thinkingSelectionSupported: true,
        error,
      });
      expect(isRendererModelPickerDisabled(view)).toBe(false);
      // Only a rejected user choice pops the picker notice; a catalog mismatch does not.
      expect(rendererModelSelectionFailed(view)).toBe(selectionRejected);
      expect(view.selectionRejected).toBe(selectionRejected ? "model" : undefined);
      expect(typeof view.selectionErrorId).toBe(selectionRejected ? "number" : "undefined");
      expect(probe.lockedSelection()?.model).toEqual(oldModel);
      expectSubmissionBlocked(true);
    };

    await vi.waitFor(() => {
      expectRecoverableView("Existing Thread Model is absent from the current Catalog", false);
    });
    expect(host.selectThreadModel).not.toHaveBeenCalled();
    expect(applyAgent).not.toHaveBeenCalled();

    const selectModel = testState.selectModel;
    assert(selectModel);
    selectModel(newModel.id);
    await vi.waitFor(() => expectRecoverableView("Model selection failed", true));
    expect(host.selectThreadModel).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-a",
      model: newModel,
    });

    selectModel(newModel.id);
    expect(testState.renderedModelViews.at(-1)).toMatchObject({
      status: "selecting",
      selected: oldModel,
    });
    expect(testState.renderedModelViews.at(-1)).not.toHaveProperty("selectionRejected");
    expect(probe.lockedSelection()?.model).toEqual(oldModel);
    expectSubmissionBlocked(true);
    resolveSelection({ effectiveModel: newModel });
    await vi.waitFor(() => {
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        catalog: inspection.catalog,
        selected: newModel,
      });
    });
    expect(testState.renderedModelViews.at(-1)).not.toHaveProperty("selectionRejected");
    expect(testState.renderedModelViews.at(-1)).not.toHaveProperty("selectionErrorId");
    expect(host.selectThreadModel).toHaveBeenCalledTimes(2);
    expect(probe.lockedSelection()?.model).toEqual(newModel);
    expectSubmissionBlocked(false);
    expect(applyAgent).not.toHaveBeenCalled();
  });

  it("marks each rejected Thinking choice with a new notice id and keeps the confirmed option", async () => {
    installFakeBrowser();
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" });
    const high = harnessThinkingOptionIdSchema.parse("high");
    const ultracode = harnessThinkingOptionIdSchema.parse("ultracode");
    const inspection = readyInspection(model.id);
    inspection.capabilities.configuration.selectThinkingOption = true;
    const catalog = {
      ...inspection.catalog,
      models: [{ ref: model, label: "Haiku", supportedThinkingOptionIds: [high, ultracode] }],
      thinkingOptions: [
        { id: high, label: "High" },
        { id: ultracode, label: "Ultracode" },
      ],
      defaultThinkingOptionId: high,
    };
    const rejection =
      "Claude Code reports Ultracode is unavailable for the selected Model; choose another Model or Thinking option";
    const host = {
      inspectHarness: vi.fn(async () => ({ ...inspection, catalog })),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@high",
        effectiveModel: model,
        effectiveThinkingOptionId: high,
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
      selectThreadThinking: vi.fn(async () => {
        throw new Error(rejection);
      }),
      subscribeThreadUsage: () => () => undefined,
    };
    const modelControl = {
      ...host,
      currentHostId: () => "local",
      clientForHost: () => host,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      vi.fn(() => true),
      modelControl as never,
    );
    await vi.waitFor(() => {
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        selected: model,
        selectedThinkingOptionId: high,
      });
    });

    const rejectedView = async (): Promise<RendererModelControlView> => {
      const selectThinking = testState.selectThinking;
      assert(selectThinking);
      const rendered = testState.renderedModelViews.length;
      selectThinking(ultracode);
      await vi.waitFor(() => {
        expect(testState.renderedModelViews.length).toBeGreaterThan(rendered);
        expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "error" });
      });
      const view = testState.renderedModelViews.at(-1);
      assert(view);
      expect(view).toMatchObject({
        status: "error",
        selected: model,
        selectedThinkingOptionId: high,
        error: rejection,
        selectionRejected: "thinking",
      });
      expect(rendererModelSelectionFailed(view)).toBe(true);
      expect(isRendererModelPickerDisabled(view)).toBe(false);
      return view;
    };

    const first = await rejectedView();
    const second = await rejectedView();
    expect(host.selectThreadThinking).toHaveBeenCalledTimes(2);
    expect(host.selectThreadThinking).toHaveBeenLastCalledWith({
      threadId: "thread-a",
      thinkingOptionId: ultracode,
    });
    // Same choice, same message: only the id tells the picker to show the notice again.
    expect(second.selectionErrorId).toBeGreaterThan(first.selectionErrorId ?? Infinity);
  });

  it("routes Session import to local while the current Composer Host is remote", async () => {
    installFakeBrowser();
    const local = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => readyInspection()),
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(async () => ({ candidates: [] })),
      importHarnessSession: vi.fn(async () => ({ threadId: "local-thread" })),
    };
    const remote = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => readyInspection()),
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(),
      importHarnessSession: vi.fn(),
    };
    const modelControl = {
      ...remote,
      currentHostId: () => "remote-1",
      clientForHost: vi.fn((hostId: string) => (hostId === "local" ? local : remote)),
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "deepseek-harness"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    const client = testState.getSessionImportClient?.();
    if (!client) throw new Error("Local Session import client was not installed");
    await client.listSessionImportSources();
    await client.listHarnessSessions({ harnessId: harnessIdSchema.parse("pi") });
    await client.importHarnessSession({
      harnessId: harnessIdSchema.parse("pi"),
      nativeSessionId: "native-session",
    });

    expect(modelControl.clientForHost).toHaveBeenCalledWith("local");
    expect(local.listSessionImportSources).toHaveBeenCalledOnce();
    expect(local.listHarnessSessions).toHaveBeenCalledWith({ harnessId: "pi" });
    expect(local.importHarnessSession).toHaveBeenCalledWith({
      harnessId: "pi",
      nativeSessionId: "native-session",
    });
    expect(remote.listHarnessSessions).not.toHaveBeenCalled();
    expect(remote.importHarnessSession).not.toHaveBeenCalled();
  });

  it("invalidates and refreshes a stale managed Web capability after open fails", async () => {
    installFakeBrowser();
    let dshAvailable = true;
    let dshInspections = 0;
    const local = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async ({ harnessId }: { harnessId: string }) => {
        if (harnessId !== "deepseek-harness") return readyInspection();
        dshInspections += 1;
        return dshAvailable
          ? { ...readyInspection("deepseek-model-v1.bW9kZWw"), webUi: { open: true as const } }
          : {
              status: "unavailable" as const,
              error: { code: "processExited", message: "managed DSH exited", retryable: true },
            };
      }),
      openHarnessWebUi: vi.fn(async () => {
        throw new Error("managed DSH exited");
      }),
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const modelControl = {
      ...local,
      currentHostId: () => "local",
      clientForHost: vi.fn(() => local),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "deepseek-harness"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => {
      const diagnostics = testState.getConnectionDiagnostics?.();
      const dsh = diagnostics
        ?.snapshot()
        .hosts.find(({ hostId }) => hostId === "local")
        ?.agents.find(({ agent }) => agent === "deepseek-harness");
      expect(dsh?.webUiAvailable).toBe(true);
    });
    const inspectionsBeforeFailure = dshInspections;
    dshAvailable = false;
    const diagnostics = testState.getConnectionDiagnostics?.();
    await expect(diagnostics?.openWebUi?.("local", "deepseek-harness")).rejects.toThrow(
      "managed DSH exited",
    );
    expect(
      diagnostics
        ?.snapshot()
        .hosts.find(({ hostId }) => hostId === "local")
        ?.agents.find(({ agent }) => agent === "deepseek-harness")?.webUiAvailable,
    ).toBeUndefined();
    await vi.waitFor(() => expect(dshInspections).toBeGreaterThan(inspectionsBeforeFailure));

    probe.dispose();
  });

  it.each(["local", "remote"])(
    "keeps %s Harness operations isolated with an ambiguous global route",
    async (ownerHostId) => {
      installFakeBrowser();
      let globalHostId: string | null = null;
      const local = {
        listHarnessPlugins,
        inspectHarness: vi.fn(async () => readyInspection()),
        inspectThread: vi.fn(async () => ({
          owner: "external" as const,
          harnessId: "claude-code",
          transportModelId:
            "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
          effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
          history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
          locked: true,
        })),
        inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
        inspectThreadUsage: vi.fn(async () => ({ threadId: "thread-a", usage: null })),
        selectThreadModel: vi.fn(async ({ model }: { model: unknown }) => ({
          effectiveModel: model,
        })),
      };
      const remote = {
        listHarnessPlugins,
        inspectHarness: vi.fn(async () => {
          throw new Error("Harness unsupported on stock Codex");
        }),
        inspectThread: vi.fn(async () => {
          throw new Error("Thread is not on this Host");
        }),
      };
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({
        enabledAgents: ["codex", "claude-code"],
        defaultAgent: "codex",
      });
      probe.setAdapter(
        {
          state: "installing",
          reason: "draft-routing-policy-unavailable",
          modelUpdates: 0,
          hook: null,
        },
        undefined,
        undefined,
        {
          currentHostId: (composer?: Element) =>
            composer === testState.composer ? ownerHostId : globalHostId,
          clientForHost: (hostId: string) => (hostId === ownerHostId ? local : remote),
          inspectThreadUsage: () => {
            throw new Error("Global client must not be used");
          },
          selectThreadModel: () => {
            throw new Error("Global client must not be used");
          },
        } as never,
      );
      await vi.waitFor(() => expect(testState.renderedModelViews.at(-1)?.status).toBe("ready"));
      for (const hostId of [null, "local", "remote", "local"]) {
        globalHostId = hostId;
        window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
        await Promise.resolve();
      }
      await testState
        .getConnectionDiagnostics?.()
        ?.refresh(ownerHostId === "local" ? "remote" : "local");
      testState.selectModel?.("claude-model-v1.b3B1cw");
      await vi.waitFor(() => expect(local.selectThreadModel).toHaveBeenCalled());
      await vi.waitFor(() => expect(testState.renderedModelViews.at(-1)?.status).toBe("ready"));
      expect(local.inspectThread).toHaveBeenCalledWith({ threadId: "thread-a" });
      expect(remote.inspectThread).not.toHaveBeenCalled();
      expect(testState.renderedModelViews.at(-1)?.status).toBe("ready");
      expect(
        testState.sidebarOptions?.getLocalAgent?.({
          hostId: ownerHostId,
          threadId: "thread-a",
          draftId: null,
        }),
      ).toBe("claude-code");
    },
  );

  it("does not let a stale remote Host response mark a locked Claude Model unavailable", async () => {
    installFakeBrowser();
    let currentHostId = "host-a";
    let resolveCatalog!: (value: ReturnType<typeof readyInspection>) => void;
    const pendingCatalog = new Promise<ReturnType<typeof readyInspection>>((resolve) => {
      resolveCatalog = resolve;
    });
    let claudeInspections = 0;
    const hostA = {
      listHarnessPlugins,
      inspectHarness: vi.fn(({ harnessId }: { harnessId: string }) => {
        if (harnessId !== "claude-code") return Promise.resolve(readyInspection());
        claudeInspections += 1;
        return claudeInspections === 1 ? Promise.resolve(readyInspection()) : pendingCatalog;
      }),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
    };
    const genericHostB = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => readyInspection("opencodex-model-v1.generic")),
    };
    const modelControl = {
      currentHostId: () => currentHostId,
      clientForHost: vi.fn((hostId: string) => (hostId === "host-a" ? hostA : genericHostB)),
      inspectHarness: genericHostB.inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => expect(claudeInspections).toBe(2));
    currentHostId = "host-b";
    resolveCatalog(readyInspection("claude-model-v1.c29ubmV0"));
    await Promise.resolve();
    await Promise.resolve();

    expect(hostA.inspectThread).toHaveBeenCalledWith({ threadId: "thread-a" });
    expect(modelControl.clientForHost).toHaveBeenCalledWith("host-a");
    expect(genericHostB.inspectHarness).not.toHaveBeenCalledWith({ harnessId: "claude-code" });
    expect(testState.renderedModelViews.at(-1)).not.toMatchObject({ status: "error" });
    expect(testState.renderedModelViews).not.toContainEqual(
      expect.objectContaining({
        error: "Existing Thread Model is absent from the current Catalog",
      }),
    );
  });

  it("discards a stale catalog when the selected client changes for the same Host", async () => {
    installFakeBrowser();
    let resolveCatalog!: (value: ReturnType<typeof readyInspection>) => void;
    const pendingCatalog = new Promise<ReturnType<typeof readyInspection>>((resolve) => {
      resolveCatalog = resolve;
    });
    let claudeInspections = 0;
    const originalHost = {
      listHarnessPlugins,
      inspectHarness: vi.fn(
        ({ harnessId }: { harnessId: string }, options?: RendererRequestOptions) => {
          if (harnessId !== "claude-code" || options) return Promise.resolve(readyInspection());
          claudeInspections += 1;
          return pendingCatalog;
        },
      ),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
    };
    const replacementHost = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => readyInspection()),
    };
    let selectedHost: typeof originalHost | typeof replacementHost = originalHost;
    const modelControl = {
      currentHostId: () => "host-a",
      clientForHost: vi.fn(() => selectedHost),
      inspectHarness: originalHost.inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => expect(claudeInspections).toBe(1));
    selectedHost = replacementHost;
    resolveCatalog(readyInspection("claude-model-v1.c3RhbGU"));
    await Promise.resolve();
    await Promise.resolve();

    expect(testState.renderedModelViews.at(-1)).not.toMatchObject({ status: "error" });
    expect(testState.renderedModelViews).not.toContainEqual(
      expect.objectContaining({
        error: "Existing Thread Model is absent from the current Catalog",
      }),
    );
  });

  it("loads an external catalog for a draft mounted before the Adapter", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    const hostA = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => readyInspection()),
    };
    const modelControl = {
      currentHostId: () => "host-a",
      clientForHost: vi.fn(() => hostA),
      inspectHarness: hostA.inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const applyAgent = vi.fn(() => true);
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "claude-code",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      applyAgent,
      modelControl as never,
    );

    expect(applyAgent).toHaveBeenCalledWith(
      "claude-code",
      undefined,
      undefined,
      undefined,
      testState.composer,
    );
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "ready" }),
    );
    expect(hostA.inspectHarness).toHaveBeenCalledWith({ harnessId: "claude-code" });
  });

  it("reloads a ready draft catalog when the Composer changes Hosts", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    let hostId = "local";
    const local = { listHarnessPlugins, inspectHarness: vi.fn(async () => readyInspection()) };
    const remoteModelId = "claude-model-v1.c29ubmV0";
    const remote = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async () => readyInspection(remoteModelId)),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "claude-code",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      () => true,
      {
        currentHostId: () => hostId,
        clientForHost: (id: string) => (id === "local" ? local : remote),
        subscribeThreadUsage: () => () => undefined,
      } as never,
    );
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        selected: readyInspection().catalog.defaultModel,
      }),
    );

    hostId = "remote";
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        selected: { id: remoteModelId },
      }),
    );

    hostId = "local";
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        selected: readyInspection().catalog.defaultModel,
      }),
    );
  });

  it("reapplies the selected carrier and clears destination prewarm when a draft changes Hosts", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    let hostId = "local";
    const local = { listHarnessPlugins, inspectHarness: vi.fn(async () => readyInspection()) };
    const remote = { listHarnessPlugins, inspectHarness: vi.fn(async () => readyInspection()) };
    const applyAgent = vi.fn<(agent: string) => boolean>(() => true);
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "claude-code",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      applyAgent,
      {
        currentHostId: () => hostId,
        clientForHost: (id: string) => (id === "local" ? local : remote),
        subscribeThreadUsage: () => () => undefined,
      } as never,
    );
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "ready" }),
    );
    const applicationsBeforeSwitch = applyAgent.mock.calls.length;
    const clearsBeforeSwitch = testState.prewarmClears;

    hostId = "remote";
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));

    await vi.waitFor(() => expect(remote.inspectHarness).toHaveBeenCalled());
    expect(applyAgent.mock.calls.length).toBeGreaterThan(applicationsBeforeSwitch);
    expect(applyAgent.mock.calls.at(-1)?.[0]).toBe("claude-code");
    expect(testState.prewarmClears).toBeGreaterThan(clearsBeforeSwitch);
  });

  it("reloads a same-Host empty Claude catalog on explicit refresh", async () => {
    installFakeBrowser();
    let claudeInspections = 0;
    const hostA = {
      listHarnessPlugins,
      inspectHarness: vi.fn(({ harnessId }: { harnessId: string }) => {
        if (harnessId !== "claude-code") return Promise.resolve(readyInspection());
        claudeInspections += 1;
        return Promise.resolve(claudeInspections === 2 ? emptyInspection() : readyInspection());
      }),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
    };
    const local = { listHarnessPlugins, inspectHarness: vi.fn(async () => readyInspection()) };
    const modelControl = {
      currentHostId: () => "host-a",
      clientForHost: vi.fn((hostId: string) => (hostId === "host-a" ? hostA : local)),
      inspectHarness: local.inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => {
      expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "empty" });
    });
    expect(claudeInspections).toBe(2);
    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();
    testState.documentListeners.get("submit")?.({
      target: testState.composer,
      preventDefault,
      stopImmediatePropagation,
    } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopImmediatePropagation).toHaveBeenCalledOnce();

    await testState.getConnectionDiagnostics?.()?.refresh();
    await vi.waitFor(() => expect(claudeInspections).toBeGreaterThan(2));
    const inspectionsAfterRefresh = claudeInspections;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(claudeInspections).toBe(inspectionsAfterRefresh);
    expect(testState.renderedModelViews.at(-1)).toMatchObject({
      status: "ready",
      catalog: readyInspection().catalog,
    });
    expect(testState.renderedModelViews).not.toContainEqual(
      expect.objectContaining({ status: "error" }),
    );
  });
});
