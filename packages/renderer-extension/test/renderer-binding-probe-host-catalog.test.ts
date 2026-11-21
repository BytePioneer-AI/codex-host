import {
  harnessIdSchema,
  harnessPluginDescriptorSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type AccountCreditsSnapshot,
} from "@codexhost/shared-contracts";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import type * as RendererComposerDom from "../src/renderer-composer-dom.js";
import {
  createRendererModelClient,
  HARNESS_PLUGIN_LIST_METHOD,
  THREAD_INSPECT_METHOD,
  THREAD_USAGE_INSPECT_METHOD,
  THREAD_USAGE_UPDATED_METHOD,
} from "../src/renderer-model-client.js";
import {
  isRendererModelPickerDisabled,
  rendererModelSelectionFailed,
  type RendererModelControlView,
} from "../src/renderer-model-picker.js";
import type { RendererRequestOptions } from "../src/renderer-request-sender.js";
import type * as RendererSidebarAgentIcons from "../src/renderer-sidebar-agent-icons.js";
import type { RendererConnectionDiagnostics } from "../src/settings/connections-page.js";
import type { RendererSessionImportClient } from "../src/settings/session-import-page.js";
import type * as VersionedRendererAdapter from "../src/versioned-renderer-adapter.js";

it("filters Desktop internal environments from connection hosts", async () => {
  installFakeBrowser();
  const { isListedConnectionHost } = await import("../src/renderer-binding-probe.js");
  expect(["local", "remote-mac", "ssh:mac"].filter(isListedConnectionHost)).toEqual([
    "local",
    "remote-mac",
    "ssh:mac",
  ]);
  expect(["durable", "env_e_internal"].filter(isListedConnectionHost)).toEqual([]);
});

const mutation = (type: MutationRecordType, target: Node) =>
  ({ type, target, addedNodes: [], removedNodes: [] }) as unknown as MutationRecord;

const testState = vi.hoisted(() => ({
  composer: null as unknown as Element,
  editor: null as unknown as Element,
  sendButton: null as unknown as HTMLButtonElement,
  renderedModelViews: [] as RendererModelControlView[],
  selectAgent: null as null | Parameters<typeof RendererComposerDom.mountComposerAgentControl>[4],
  refreshModels: null as null | (() => void),
  selectPermissionMode: null as null | ((permissionModeId: string) => void),
  renderedPermissionMode: null as
    null | Parameters<typeof RendererComposerDom.renderComposerAgentControl>[6],
  renderedCredits: null as AccountCreditsSnapshot | null,
  selectModel: null as null | ((modelId: string) => void),
  selectThinking: null as null | ((thinkingOptionId: string) => void),
  getConnectionDiagnostics: null as null | (() => RendererConnectionDiagnostics | null),
  getSessionImportClient: null as null | ((hostId?: string) => RendererSessionImportClient | null),
  sidebarOptions: null as
    null | Parameters<typeof RendererSidebarAgentIcons.installRendererSidebarAgentIcons>[0],
  sidebarRefresh: vi.fn(),
  documentListeners: new Map<string, EventListener>(),
  modelTarget: ["conversation", "thread-a"] as readonly unknown[] | null,
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
    mountComposerAgentControl: (
      ...args: Parameters<typeof RendererComposerDom.mountComposerAgentControl>
    ) => {
      testState.selectAgent = args[4];
      testState.refreshModels = args[11] ?? null;
      testState.selectModel = args[7];
      testState.selectThinking = args[8];
      testState.selectPermissionMode = args[9];
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
      permissionModeView: Parameters<typeof RendererComposerDom.renderComposerAgentControl>[6],
      _usage: unknown,
      credits: AccountCreditsSnapshot | null,
    ) => {
      testState.renderedModelViews.push({ ...modelView });
      testState.renderedPermissionMode = permissionModeView;
      testState.renderedCredits = credits;
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

vi.mock("../src/renderer-sidebar-agent-icons.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RendererSidebarAgentIcons>()),
  SIDEBAR_THREAD_ROW_SELECTOR: "[data-app-action-sidebar-thread-row]",
  installRendererSidebarAgentIcons: (
    options: Parameters<typeof RendererSidebarAgentIcons.installRendererSidebarAgentIcons>[0],
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
      getSessionImportClient(hostId?: string): RendererSessionImportClient | null;
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
      id: harnessIdSchema.parse(id),
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
    // This catalog-only fixture has no layout; visible question cards have browser coverage.
    getClientRects(): DOMRect[] {
      return [];
    }
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
    contains: (element: Element) => element === testState.sendButton,
    querySelectorAll: (selector: string) => (selector === "button" ? [testState.sendButton] : []),
    querySelector: (selector: string) => (selector.includes("textarea") ? testState.editor : null),
  }) as unknown as Element;
  const editor = Object.assign(new FakeElement(), {
    closest: () => composer,
  }) as unknown as Element;
  const sendButton = Object.assign(new FakeElement(), {
    isConnected: true,
    closest: (selector: string): Element | null => (selector === "button" ? sendButton : null),
    type: "submit",
    disabled: false,
    parentElement: null,
    getAttribute: () => null,
  }) as unknown as HTMLButtonElement;
  testState.composer = composer;
  testState.editor = editor;
  testState.sendButton = sendButton;
  testState.renderedModelViews = [];
  testState.selectAgent = null;
  testState.refreshModels = null;
  testState.selectPermissionMode = null;
  testState.renderedPermissionMode = null;
  testState.renderedCredits = null;
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
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      testState.animationFrames.push(callback),
    cancelAnimationFrame: vi.fn(),
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(() => 0),
    clearInterval: vi.fn(),
    open: vi.fn(),
  };
  const document_ = {
    documentElement: {},
    head: { append: vi.fn() },
    body: {},
    createElement: vi.fn(() => ({
      setAttribute: vi.fn(),
      textContent: "",
      remove: vi.fn(),
    })),
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
  vi.stubGlobal("requestAnimationFrame", window_.requestAnimationFrame);
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
      readonly detail: unknown;

      constructor(type: string, init?: CustomEventInit) {
        super(type, init);
        this.detail = init?.detail;
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

describe("Renderer binding native draft routing", () => {
  it("allows editing without a private Model binding but waits for routing before Send", async () => {
    installFakeBrowser();
    testState.modelTarget = null;
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({ enabledAgents: ["codex"], defaultAgent: "codex" });
    const [selection] = probe.status().selections;
    assert(selection);
    expect(selection).toMatchObject({ agent: "codex", phase: "draft" });

    const submissions: unknown[] = [];
    window.addEventListener("codexhost:renderer-submission", (event) => {
      submissions.push((event as CustomEvent<unknown>).detail);
    });
    const dispatch = (event: Event, target: Element): boolean => {
      const listener = testState.documentListeners.get(event.type);
      assert(listener);
      Object.defineProperty(event, "target", { value: target });
      listener(event);
      return event.defaultPrevented;
    };
    const send = () => dispatch(new Event("click", { cancelable: true }), testState.sendButton);
    const backspace = Object.assign(new Event("keydown", { cancelable: true }), {
      key: "Backspace",
    });
    const beforeInput = Object.assign(new Event("beforeinput", { cancelable: true }), {
      inputType: "deleteContentBackward",
    });
    expect(dispatch(backspace, testState.editor)).toBe(false);
    expect(dispatch(beforeInput, testState.editor)).toBe(false);
    expect(send()).toBe(true);
    expect(submissions).toEqual([]);

    const applyAgent = vi.fn(() => true);
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      applyAgent,
    );
    expect(send()).toBe(false);
    expect(applyAgent).toHaveBeenCalledWith(
      "codex",
      undefined,
      undefined,
      undefined,
      testState.composer,
    );
    expect(submissions).toEqual([
      { composerId: selection.composerId, agent: "codex", trigger: "click" },
    ]);
  });
});

describe("Renderer binding Harness directory diagnostics", () => {
  it("keeps stock Codex usable and probes a replacement local connection", async () => {
    installFakeBrowser();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: { id: "thread-a", modelProvider: "openai", cliVersion: "1" } };
      }
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    });
    let local = createRendererModelClient([{ sendRequest: request }]);
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({});
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      () => true,
      { currentHostId: () => "local", clientForHost: () => local } as never,
    );
    const diagnostics = testState.getConnectionDiagnostics?.();
    assert(diagnostics);
    await diagnostics.refresh("local");
    expect(diagnostics.snapshot()).toMatchObject({
      adapter: { state: "ready" },
      hosts: [{ hostId: "local", directoryUnsupported: true, agents: [] }],
    });
    expect(request).toHaveBeenCalledWith(THREAD_INSPECT_METHOD, { threadId: "thread-a" });
    expect(request).toHaveBeenCalledWith("thread/read", {
      threadId: "thread-a",
      includeTurns: false,
    });
    const prevented = vi.fn();
    testState.documentListeners.get("submit")?.({
      target: testState.composer,
      preventDefault: prevented,
      stopImmediatePropagation: vi.fn(),
    } as unknown as Event);
    expect(prevented).not.toHaveBeenCalled();

    await diagnostics.refresh("local");
    expect(
      request.mock.calls.filter(([method]) => method === HARNESS_PLUGIN_LIST_METHOD),
    ).toHaveLength(1);
    local = null;
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
    expect(diagnostics.snapshot().hosts[0]?.directoryUnsupported).toBeUndefined();

    local = createRendererModelClient([
      {
        sendRequest: async (method) => {
          if (method === HARNESS_PLUGIN_LIST_METHOD) return { plugins: [] };
          throw new Error(`Unexpected method: ${method}`);
        },
      },
    ]);
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
    await vi.waitFor(() => {
      expect(diagnostics.snapshot().hosts[0]).not.toHaveProperty("directoryError");
    });
  });

  it.each(["remote-ssh-discovered:linux", "remote-control:mac"])(
    "refreshes connection diagnostics when the local client changes while %s stays active",
    async (hostId) => {
      installFakeBrowser();
      let local = createRendererModelClient([
        {
          sendRequest: async () => {
            throw Object.assign(new Error("Method not found"), { code: -32601 });
          },
        },
      ]);
      const remote = {
        listHarnessPlugins: async () => ({ plugins: [] }),
        inspectThread: async () => ({ owner: "codex", locked: true }),
        inspectThreadCommands: async () => ({ commands: [] }),
        inspectThreadUsage: async () => ({ threadId: "thread-a", usage: null }),
      };
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({});
      probe.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        undefined,
        undefined,
        {
          currentHostId: () => hostId,
          clientForHost: (target: string) => (target === "local" ? local : remote),
        } as never,
      );
      const diagnostics = testState.getConnectionDiagnostics?.();
      assert(diagnostics);
      await vi.waitFor(() =>
        expect(diagnostics.snapshot().hosts).toMatchObject([
          { hostId: "local", active: false, directoryUnsupported: true },
          { hostId, active: true },
        ]),
      );
      let latestStatus: ReturnType<typeof diagnostics.snapshot> | undefined;
      diagnostics.subscribe(() => {
        latestStatus = diagnostics.snapshot();
      });
      const sendRequest = vi.fn(async () => ({ plugins: [] }));
      local = createRendererModelClient([{ sendRequest }]);
      const [localBeforeScan] = diagnostics.snapshot().hosts;
      expect.soft(localBeforeScan).not.toHaveProperty("directoryError");
      expect.soft(localBeforeScan).not.toHaveProperty("directoryUnsupported");

      const notify = testState.notifyMutations;
      assert(notify);
      notify([mutation("attributes", testState.editor)]);
      for (const callback of testState.animationFrames.splice(0)) callback(performance.now());
      expect(sendRequest).toHaveBeenCalledWith(HARNESS_PLUGIN_LIST_METHOD, {});
      await vi.waitFor(() => {
        expect(latestStatus?.hosts).toMatchObject([
          { hostId: "local", active: false },
          { hostId, active: true },
        ]);
        expect(latestStatus?.hosts[0]).not.toHaveProperty("directoryError");
        expect(latestStatus?.hosts[0]).not.toHaveProperty("directoryUnsupported");
      });
    },
  );

  it.each([
    { reject: Object.assign(new Error("Method not found"), { code: -32601 }), retry: false },
    { reject: new Error("Connection timed out"), retry: true },
  ])("only retries transient directory failures ($reject.message)", async ({ reject, retry }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      installFakeBrowser();
      // Give the probe a directory call that does not cache RPC errors itself,
      // so retry attempts at this seam are visible.
      const { RendererMethodUnavailableError } = await import("../src/renderer-request-sender.js");
      const list = vi.fn(async () => ({ plugins: [] }));
      list.mockRejectedValueOnce(
        retry ? reject : new RendererMethodUnavailableError(HARNESS_PLUGIN_LIST_METHOD, reject),
      );
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({});
      probe.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        undefined,
        undefined,
        { currentHostId: () => "local", listHarnessPlugins: list } as never,
      );
      const diagnostics = testState.getConnectionDiagnostics?.();
      assert(diagnostics);
      await vi.advanceTimersByTimeAsync(1000);
      if (retry) expect(diagnostics.snapshot().hosts[0]).not.toHaveProperty("directoryError");
      else {
        expect(diagnostics.snapshot().hosts[0]?.directoryUnsupported).toBe(true);
        await diagnostics.refresh("local");
      }
      expect(list).toHaveBeenCalledTimes(retry ? 2 : 1);
    } finally {
      vi.useRealTimers();
    }
  });
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
        { harnessId: "unseen-remote", refresh: true, purpose: "availability" },
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
          { harnessId: "pi", refresh: false, purpose: "availability" },
          { priority: "background" },
        );
        expect(remote.inspectHarness).toHaveBeenCalledWith(
          { harnessId: "claude-code", refresh: false, purpose: "availability" },
          { priority: "background" },
        );
        expect(local.inspectHarness).toHaveBeenCalledWith(
          { harnessId: "pi", refresh: false, purpose: "availability" },
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
      { harnessId: "pi", refresh: true, purpose: "availability" },
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

  it("excludes the reserved durable Host from connection diagnostics even when active or listed", async () => {
    installFakeBrowser();
    const local = { listHarnessPlugins, inspectHarness: vi.fn(async () => readyInspection()) };
    const durable = { listHarnessPlugins: vi.fn(), inspectHarness: vi.fn() };
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
        currentHostId: () => "durable",
        knownHostIds: () => ["local", "durable"],
        clientForHost: (hostId: string) => (hostId === "durable" ? durable : local),
      } as never,
    );
    const diagnostics = testState.getConnectionDiagnostics?.();
    await diagnostics?.refresh();
    expect(diagnostics?.snapshot().hosts.map(({ hostId }) => hostId)).toEqual(["local"]);
    expect(durable.listHarnessPlugins).not.toHaveBeenCalled();
    expect(durable.inspectHarness).not.toHaveBeenCalled();
    probe.dispose();
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

  it("renders a restarted Claude Thread's quota push after Composer polling has stopped", async () => {
    vi.useFakeTimers();
    try {
      installFakeBrowser();
      const usage = { totalTokens: 120 };
      const quota: AccountCreditsSnapshot = { usedPercent: 10, periodType: "five_hour" };
      let accountCredits: AccountCreditsSnapshot | undefined;
      let notifyUsage: ((notification: unknown) => void) | undefined;
      const sendRequest = vi.fn(async (method: string) => {
        if (method !== THREAD_USAGE_INSPECT_METHOD) throw new Error(`Unexpected method ${method}`);
        return { threadId: "thread-a", usage, accountCreditsSupported: true, accountCredits };
      });
      const client = createRendererModelClient([
        {
          sendRequest,
          addNotificationCallback: (methods, callback) => {
            if (methods.includes(THREAD_USAGE_UPDATED_METHOD)) notifyUsage = callback;
            return () => undefined;
          },
        },
      ]);
      assert(client);
      const inspection = readyInspection();
      const host = {
        ...client,
        listHarnessPlugins,
        inspectHarness: async () => inspection,
        inspectThread: async () => ({
          owner: "external" as const,
          harnessId: harnessIdSchema.parse("claude-code"),
          transportModelId:
            "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
          effectiveModel: inspection.catalog.defaultModel,
          history: inspection.capabilities.history,
          locked: true as const,
          usage,
        }),
        inspectThreadCommands: async () => ({ commands: [] }),
      };
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({ enabledAgents: ["codex", "claude-code"] });
      try {
        probe.setAdapter(
          { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
          undefined,
          undefined,
          { ...host, currentHostId: () => "local", clientForHost: () => host },
        );
        const usageReads = () =>
          sendRequest.mock.calls.filter(([method]) => method === THREAD_USAGE_INSPECT_METHOD)
            .length;
        await vi.advanceTimersByTimeAsync(24_000);
        expect(usageReads()).toBe(7); // Initial read and one pass of the six backoff delays.
        await vi.advanceTimersByTimeAsync(16_000);
        expect(usageReads()).toBe(7);
        expect(testState.renderedCredits).toBeNull();

        // The slow account inspection completed without a Turn or native token update.
        accountCredits = quota;
        assert(notifyUsage);
        notifyUsage({ method: THREAD_USAGE_UPDATED_METHOD, params: { threadId: "thread-a" } });
        await vi.advanceTimersByTimeAsync(16_000);
        expect(testState.renderedCredits).toEqual(quota);
        expect(usageReads()).toBe(8); // Notification-triggered read, not renewed polling.
      } finally {
        probe.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
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

  it("routes Session import to the current remote Composer Host", async () => {
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
    let currentHostId: string | null = "remote-1";
    const modelControl = {
      ...remote,
      currentHostId: () => currentHostId,
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
    if (!client) throw new Error("Remote Session import client was not installed");
    expect(client.hostId).toBe("remote-1");
    await client.listSessionImportSources();
    await client.listHarnessSessions({ harnessId: harnessIdSchema.parse("pi") });
    await client.importHarnessSession({
      harnessId: harnessIdSchema.parse("pi"),
      nativeSessionId: "native-session",
    });

    expect(modelControl.clientForHost).toHaveBeenCalledWith("remote-1");
    expect(remote.listSessionImportSources).toHaveBeenCalledOnce();
    expect(remote.listHarnessSessions).toHaveBeenCalledWith({ harnessId: "pi" });
    expect(remote.importHarnessSession).toHaveBeenCalledWith({
      harnessId: "pi",
      nativeSessionId: "native-session",
    });
    expect(local.listSessionImportSources).not.toHaveBeenCalled();
    expect(local.listHarnessSessions).not.toHaveBeenCalled();
    expect(local.importHarnessSession).not.toHaveBeenCalled();
    currentHostId = null;
    expect(testState.getSessionImportClient?.()).toBeNull();
    const selected = testState.getSessionImportClient?.("remote-1");
    expect(selected?.hostId).toBe("remote-1");
    await selected?.listSessionImportSources();
    expect(remote.listSessionImportSources).toHaveBeenCalledTimes(2);
    expect(local.listSessionImportSources).not.toHaveBeenCalled();
    modelControl.clientForHost.mockReturnValueOnce(null as never);
    expect(testState.getSessionImportClient?.("remote-1")).toBeNull();
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

  it("refreshes only the selected Harness without replacing its ready view in flight", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    const pending = Promise.withResolvers<ReturnType<typeof readyInspection>>();
    const client = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async ({ refresh }: { refresh?: boolean }) =>
        refresh ? pending.promise : readyInspection(),
      ),
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
      { currentHostId: () => "local", clientForHost: () => client } as never,
    );
    const latest = () => testState.renderedModelViews.at(-1);
    await vi.waitFor(() => expect(latest()?.status).toBe("ready"));
    const original = readyInspection();
    const refresh = testState.refreshModels;
    assert(refresh);
    refresh();
    refresh();
    expect(latest()).toMatchObject({
      status: "ready",
      refreshing: true,
      catalog: original.catalog,
    });
    expect(client.inspectHarness.mock.calls.flat().filter(({ refresh }) => refresh)).toEqual([
      { harnessId: "claude-code", refresh: true },
    ]);
    pending.resolve({
      ...original,
      catalog: {
        ...original.catalog,
        models: [...original.catalog.models, ...readyInspection("new-model").catalog.models],
      },
    });
    await vi.waitFor(() => expect(latest()?.catalog?.models.at(-1)?.ref.id).toBe("new-model"));
    expect(latest()).toMatchObject({ status: "ready", selected: original.catalog.defaultModel });
    expect(latest()?.refreshing).not.toBe(true);

    client.inspectHarness.mockRejectedValueOnce(new Error("Refresh failed"));
    refresh();
    expect(latest()?.refreshing).toBe(true);
    await vi.waitFor(() => expect(latest()?.refreshing).not.toBe(true));
    expect(latest()?.status).toBe("ready");
    expect(latest()?.catalog?.models.at(-1)?.ref.id).toBe("new-model");
  });

  it("confirms a pending Permission Mode selection while models refresh", async () => {
    installFakeBrowser();
    const inspection = {
      ...readyInspection(),
      permissionModes: {
        modes: [
          { id: "default", label: "Default" },
          { id: "acceptEdits", label: "Accept edits" },
        ],
        defaultModeId: "default",
      },
    };
    inspection.capabilities.configuration.selectPermissionMode = true;
    const model = inspection.catalog.defaultModel;
    const permission = Promise.withResolvers<{ effectivePermissionModeId: string }>();
    const pendingRefresh = Promise.withResolvers<typeof inspection>();
    const client = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async ({ refresh }: { refresh?: boolean }) =>
        refresh ? pendingRefresh.promise : inspection,
      ),
      inspectThread: async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId: "codexhost/claude-code-native@claude-model-v1.b3B1cw@default@auto",
        effectiveModel: model,
        effectivePermissionModeId: "default",
        locked: true,
      }),
      inspectThreadCommands: async () => ({ commands: [] }),
      inspectThreadUsage: async () => ({ usage: null, accountCredits: null }),
      selectThreadPermissionMode: vi.fn(() => permission.promise),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      () => true,
      { currentHostId: () => "local", clientForHost: () => client } as never,
    );
    await vi.waitFor(() => {
      expect(testState.renderedPermissionMode).toMatchObject({
        status: "ready",
        selected: "default",
      });
    });
    const { selectPermissionMode, refreshModels } = testState;
    assert(selectPermissionMode && refreshModels);
    selectPermissionMode("acceptEdits");
    expect(client.selectThreadPermissionMode).toHaveBeenCalledWith({
      threadId: "thread-a",
      permissionModeId: "acceptEdits",
    });
    expect(testState.renderedPermissionMode?.status).toBe("selecting");
    refreshModels();
    expect(testState.renderedModelViews.at(-1)?.refreshing).toBe(true);

    permission.resolve({ effectivePermissionModeId: "acceptEdits" });
    await vi.waitFor(() => {
      expect(testState.renderedPermissionMode).toMatchObject({
        status: "ready",
        selected: "acceptEdits",
      });
    });
    expect(testState.renderedModelViews.at(-1)?.refreshing).toBe(true);
    pendingRefresh.resolve(inspection);
    await vi.waitFor(() => expect(testState.renderedModelViews.at(-1)?.refreshing).not.toBe(true));
    expect(testState.renderedPermissionMode).toMatchObject({
      status: "ready",
      selected: "acceptEdits",
    });
  });

  it("discards a model refresh after replacing its Composer", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    const pending = Promise.withResolvers<ReturnType<typeof readyInspection>>();
    const client = {
      listHarnessPlugins,
      inspectHarness: vi.fn(async ({ refresh }: { refresh?: boolean }) =>
        refresh ? pending.promise : readyInspection(),
      ),
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
      { currentHostId: () => "local", clientForHost: () => client } as never,
    );
    const latest = () => testState.renderedModelViews.at(-1);
    await vi.waitFor(() => expect(latest()?.status).toBe("ready"));
    const { composer, refreshModels, notifyMutations } = testState;
    assert(refreshModels && notifyMutations);
    refreshModels();
    const refreshResponse = client.inspectHarness.mock.results.at(-1)?.value;
    assert(refreshResponse);
    expect(latest()?.refreshing).toBe(true);

    const replacement = Object.assign(Object.create(Element.prototype) as Element, composer);
    Object.assign(composer, { isConnected: false });
    testState.composer = replacement;
    notifyMutations([
      {
        type: "childList",
        target: document.body,
        addedNodes: [replacement],
        removedNodes: [composer],
      } as unknown as MutationRecord,
    ]);
    for (const callback of testState.animationFrames.splice(0)) callback(performance.now());
    await vi.waitFor(() => {
      expect(testState.refreshModels).not.toBe(refreshModels);
      expect(latest()?.status).toBe("ready");
      expect(latest()?.refreshing).not.toBe(true);
    });
    pending.resolve(readyInspection("stale-model"));
    await refreshResponse;
    expect(latest()?.catalog).toEqual(readyInspection().catalog);
    expect(
      testState.renderedModelViews.some(
        ({ catalog }) => catalog?.defaultModel?.id === "stale-model",
      ),
    ).toBe(false);
  });

  it("discards a model refresh that finishes after switching Harnesses", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    const pending = Promise.withResolvers<ReturnType<typeof readyInspection>>();
    const client = {
      listHarnessPlugins,
      inspectHarness: vi.fn(
        async ({ harnessId, refresh }: { harnessId: string; refresh?: boolean }) =>
          refresh ? pending.promise : readyInspection(harnessId === "pi" ? "pi-model" : undefined),
      ),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code", "pi"],
      defaultAgent: "claude-code",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      () => true,
      { currentHostId: () => "local", clientForHost: () => client } as never,
    );
    const latest = () => testState.renderedModelViews.at(-1);
    await vi.waitFor(() => expect(latest()?.status).toBe("ready"));
    testState.refreshModels?.();
    expect(latest()?.refreshing).toBe(true);
    testState.selectAgent?.("pi");
    await vi.waitFor(() => expect(latest()?.selected?.id).toBe("pi-model"));
    pending.resolve(readyInspection("stale-claude-model"));
    await pending.promise;
    await Promise.resolve();
    expect(latest()).toMatchObject({
      status: "ready",
      catalog: readyInspection("pi-model").catalog,
    });
    expect(latest()?.refreshing).not.toBe(true);
    expect(
      testState.renderedModelViews.some((view) =>
        view.catalog?.models.some(({ ref }) => ref.id === "stale-claude-model"),
      ),
    ).toBe(false);
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
