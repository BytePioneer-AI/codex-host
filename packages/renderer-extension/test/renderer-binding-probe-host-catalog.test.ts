import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as RendererComposerDom from "../src/renderer-composer-dom.js";
import type * as VersionedRendererAdapter from "../src/versioned-renderer-adapter.js";

const testState = vi.hoisted(() => ({
  composer: null as unknown as Element,
  editor: null as unknown as Element,
  sendButton: null as unknown as HTMLButtonElement,
  renderedModelViews: [] as Array<{ status: string; error?: string }>,
  getConnectionDiagnostics: null as null | (() => { refresh(): Promise<void> } | null),
  documentListeners: new Map<string, EventListener>(),
  modelTarget: ["conversation", "thread-a"] as readonly unknown[],
}));

vi.mock("../src/renderer-composer-dom.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererComposerDom>();
  return {
    ...original,
    composerForEditor: () => testState.composer,
    composerForElement: () => testState.composer,
    editorForElement: () => testState.editor,
    eventElement: () => testState.composer,
    mountComposerAgentControl: () => ({
      composer: testState.composer,
      composerId: "composer-1",
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
    }),
    renderComposerAgentControl: (
      _control: unknown,
      _selection: unknown,
      _adapter: unknown,
      _switching: unknown,
      _availability: unknown,
      modelView: { status: string; error?: string },
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
    waitForRendererDraftPrewarmPolicy: async () => ({ clear: async () => undefined }),
  };
});

vi.mock("../src/renderer-sidebar-agent-icons.js", () => ({
  installRendererSidebarAgentIcons: () => ({ refresh: vi.fn(), dispose: vi.fn() }),
  installRendererSidebarExternalPinning: () => vi.fn(),
}));

vi.mock("../src/renderer-settings-lifecycle.js", () => ({
  installRendererSettingsLifecycle: (
    _window: unknown,
    options: { getConnectionDiagnostics(): { refresh(): Promise<void> } | null },
  ) => {
    testState.getConnectionDiagnostics = options.getConnectionDiagnostics;
    return {
      locale: "en",
      refresh: vi.fn(),
      dispose: vi.fn(),
    };
  },
}));

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
  const composer = {
    isConnected: true,
    matches: (selector: string) => selector === "[data-codex-composer-root]",
    querySelectorAll: (selector: string) => (selector === "button" ? [testState.sendButton] : []),
    querySelector: (selector: string) => (selector.includes("textarea") ? testState.editor : null),
  } as unknown as Element;
  const editor = { closest: () => composer } as unknown as Element;
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
  testState.getConnectionDiagnostics = null;
  testState.documentListeners.clear();
  testState.modelTarget = ["conversation", "thread-a"];
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
  vi.stubGlobal(
    "MutationObserver",
    class {
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
  it("does not let a stale remote Host response mark a locked Claude Model unavailable", async () => {
    installFakeBrowser();
    let currentHostId = "host-a";
    let resolveCatalog!: (value: ReturnType<typeof readyInspection>) => void;
    const pendingCatalog = new Promise<ReturnType<typeof readyInspection>>((resolve) => {
      resolveCatalog = resolve;
    });
    let claudeInspections = 0;
    const hostA = {
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
    const replacementHost = {
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

    await vi.waitFor(() => expect(claudeInspections).toBe(2));
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
    let claudeInspections = 0;
    const hostA = {
      inspectHarness: vi.fn(async () => {
        claudeInspections += 1;
        return readyInspection();
      }),
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
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "claude-code",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => expect(claudeInspections).toBeGreaterThanOrEqual(2));
    expect(testState.renderedModelViews.at(-1)).not.toMatchObject({ status: "error" });
  });

  it("keeps a same-Host empty Claude catalog terminal across availability refreshes", async () => {
    installFakeBrowser();
    let claudeInspections = 0;
    const hostA = {
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
    const local = { inspectHarness: vi.fn(async () => readyInspection()) };
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
    expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "empty" });
    expect(testState.renderedModelViews).not.toContainEqual(
      expect.objectContaining({ status: "error" }),
    );
  });
});
