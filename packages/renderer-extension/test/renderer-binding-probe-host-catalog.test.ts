import {
  harnessIdSchema,
  hostThreadIdSchema,
  type HarnessModelRef,
  type ThreadUsageInspection,
} from "@codexhost/shared-contracts";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import type * as RendererComposerDom from "../src/renderer-composer-dom.js";
import {
  isRendererModelPickerDisabled,
  type RendererModelControlView,
} from "../src/renderer-model-picker.js";
import type { RendererRequestOptions } from "../src/renderer-request-sender.js";
import type { installRendererSidebarAgentIcons } from "../src/renderer-sidebar-agent-icons.js";
import type { RendererConnectionDiagnostics } from "../src/settings/connections-page.js";
import type { RendererSessionImportClient } from "../src/settings/session-import-page.js";
import type * as VersionedRendererAdapter from "../src/versioned-renderer-adapter.js";

const testState = vi.hoisted(() => ({
  composer: null as unknown as Element,
  composers: [] as Element[],
  composerForElement: new Map<Element, Element>(),
  editorForComposer: new Map<Element, Element>(),
  sendButtonForComposer: new Map<Element, HTMLButtonElement>(),
  modelTargetForComposer: new Map<Element, readonly unknown[]>(),
  selectModels: new Map<Element, (modelId: string) => void>(),
  selectAgents: new Map<Element, (agent: string) => void>(),
  renderedControls: new Map<
    Element,
    Array<{
      selection: { agent: string; phase: string };
      adapter: string;
      availability: Record<string, string>;
      modelView: RendererModelControlView;
      usage: unknown;
    }>
  >(),
  editor: null as unknown as Element,
  sendButton: null as unknown as HTMLButtonElement,
  renderedModelViews: [] as RendererModelControlView[],
  selectModel: null as null | ((modelId: string) => void),
  getConnectionDiagnostics: null as null | (() => RendererConnectionDiagnostics | null),
  getSessionImportClient: null as null | (() => RendererSessionImportClient | null),
  sidebarOptions: null as null | Parameters<typeof installRendererSidebarAgentIcons>[0],
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
    composerForEditor: (editor: Element) =>
      testState.composerForElement.get(editor) ?? testState.composer,
    composerForElement: (element: Element) =>
      testState.composerForElement.get(element) ?? testState.composer,
    editorForElement: (element: Element) =>
      testState.editorForComposer.get(testState.composerForElement.get(element) ?? element) ?? null,
    eventElement: (event: Event) =>
      event.target instanceof Element ? event.target : testState.composer,
    mountComposerAgentControl: (
      ...args: Parameters<typeof RendererComposerDom.mountComposerAgentControl>
    ) => {
      const [composer, composerId, sendButton] = args;
      testState.selectModel = args[7];
      testState.selectModels.set(composer, args[7]);
      testState.selectAgents.set(composer, args[4] as (agent: string) => void);
      return {
        composer,
        composerId,
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
        sendButton,
        sendDisabledBeforeSwitch: null,
      };
    },
    renderComposerAgentControl: (
      ...args: Parameters<typeof RendererComposerDom.renderComposerAgentControl>
    ) => {
      const [control, selection, adapter, , availability, modelView, , usage] = args;
      const view: RendererModelControlView = { ...(modelView ?? { status: "idle" }) };
      testState.renderedModelViews.push(view);
      const rendered = testState.renderedControls.get(control.composer) ?? [];
      rendered.push({
        selection: { ...selection },
        adapter,
        availability: { ...availability } as Record<string, string>,
        modelView: view,
        usage,
      });
      testState.renderedControls.set(control.composer, rendered);
    },
    reconcileComposerNativeControls: vi.fn(),
    disposeComposerAgentControl: vi.fn(),
    sendButtonWithin: (composer: Element) =>
      testState.sendButtonForComposer.get(composer) ?? testState.sendButton,
  };
});

vi.mock("../src/versioned-renderer-adapter.js", async (importOriginal) => {
  const original = await importOriginal<typeof VersionedRendererAdapter>();
  return {
    ...original,
    findComposerModelTarget: (composer: Element) =>
      testState.modelTargetForComposer.get(composer) ?? testState.modelTarget,
    waitForRendererDraftPrewarmPolicy: async () => ({
      clear: async () => {
        testState.prewarmClears += 1;
      },
    }),
  };
});

vi.mock("../src/renderer-sidebar-agent-icons.js", () => ({
  installRendererSidebarAgentIcons: (
    options: Parameters<typeof installRendererSidebarAgentIcons>[0],
  ) => {
    testState.sidebarOptions = options;
    return { refresh: vi.fn(), dispose: vi.fn() };
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

function installFakeBrowser(
  composers: Array<{ hidden?: boolean; target?: readonly unknown[] }> = [{}],
): void {
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
  testState.composers = [];
  testState.composerForElement.clear();
  testState.editorForComposer.clear();
  testState.sendButtonForComposer.clear();
  testState.modelTargetForComposer.clear();
  testState.selectModels.clear();
  testState.selectAgents.clear();
  testState.renderedControls.clear();
  for (const fixture of composers) {
    const sendButton = {
      type: "submit",
      disabled: false,
      parentElement: null,
      getAttribute: () => null,
    } as unknown as HTMLButtonElement;
    const composer = Object.assign(new FakeElement(), {
      isConnected: true,
      hidden: fixture.hidden ?? false,
      matches: (selector: string) => selector === "[data-codex-composer-root]",
      querySelectorAll: (selector: string) => (selector === "button" ? [sendButton] : []),
      querySelector: (selector: string) => (selector.includes("textarea") ? editor : null),
    }) as unknown as Element;
    const editor = Object.assign(new FakeElement(), {
      closest: () => composer,
    }) as unknown as Element;
    testState.composers.push(composer);
    for (const element of [composer, editor, sendButton]) {
      testState.composerForElement.set(element, composer);
    }
    testState.editorForComposer.set(composer, editor);
    testState.sendButtonForComposer.set(composer, sendButton);
    if (fixture.target) testState.modelTargetForComposer.set(composer, fixture.target);
  }
  const composer = testState.composers[0];
  assert(composer);
  const editor = testState.editorForComposer.get(composer);
  const sendButton = testState.sendButtonForComposer.get(composer);
  assert(editor);
  assert(sendButton);
  testState.composer = composer;
  testState.editor = editor;
  testState.sendButton = sendButton;
  testState.renderedModelViews = [];
  testState.selectModel = null;
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
    querySelectorAll: (selector: string) =>
      selector.includes("textarea") ? [...testState.editorForComposer.values()] : [],
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
        inspectHarness: vi.fn(async () => readyInspection()),
      };
      const remote = {
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
    expect(
      diagnostics
        ?.snapshot()
        .hosts.find(({ hostId }) => hostId === "local")
        ?.agents.find(({ agent }) => agent === "pi"),
    ).toMatchObject({ availability: "checking", error: null });
    expect(inspectHarness).not.toHaveBeenCalled();
  });
  it("reports a disconnected Host and ignores its late availability reply without affecting local", async () => {
    installFakeBrowser();
    const pending = Promise.withResolvers<ReturnType<typeof readyInspection>>();
    const local = {
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

  it("does not rediscover the request route for unrelated sidebar rows", async () => {
    installFakeBrowser();
    const host = {
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
    const expectRecoverableView = (error: string) => {
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
      expect(probe.lockedSelection()?.model).toEqual(oldModel);
      expectSubmissionBlocked(true);
    };

    await vi.waitFor(() => {
      expectRecoverableView("Existing Thread Model is absent from the current Catalog");
    });
    expect(host.selectThreadModel).not.toHaveBeenCalled();
    expect(applyAgent).not.toHaveBeenCalled();

    const selectModel = testState.selectModel;
    assert(selectModel);
    selectModel(newModel.id);
    await vi.waitFor(() => expectRecoverableView("Model selection failed"));
    expect(host.selectThreadModel).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-a",
      model: newModel,
    });

    selectModel(newModel.id);
    expect(testState.renderedModelViews.at(-1)).toMatchObject({
      status: "selecting",
      selected: oldModel,
    });
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
    expect(host.selectThreadModel).toHaveBeenCalledTimes(2);
    expect(probe.lockedSelection()?.model).toEqual(newModel);
    expectSubmissionBlocked(false);
    expect(applyAgent).not.toHaveBeenCalled();
  });

  it("routes Session import to local while the current Composer Host is remote", async () => {
    installFakeBrowser();
    const local = {
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
    const hostA = {
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
    const local = { inspectHarness: vi.fn(async () => readyInspection()) };
    const remoteModelId = "claude-model-v1.c29ubmV0";
    const remote = { inspectHarness: vi.fn(async () => readyInspection(remoteModelId)) };
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
    const local = { inspectHarness: vi.fn(async () => readyInspection()) };
    const remote = { inspectHarness: vi.fn(async () => readyInspection()) };
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
    expect(testState.renderedModelViews.at(-1)).toMatchObject({
      status: "ready",
      catalog: readyInspection().catalog,
    });
    expect(testState.renderedModelViews).not.toContainEqual(
      expect.objectContaining({ status: "error" }),
    );
  });
});

describe("Renderer binding mixed-Host composers", () => {
  it.each(["disconnect", "replace"])(
    "ignores pending ownership from a retired remote client after %s",
    async (mode) => {
      installFakeBrowser([
        { target: ["conversation", "same-thread"] },
        { hidden: true, target: ["conversation", "same-thread"] },
      ]);
      const [localComposer, remoteComposer] = testState.composers;
      assert(localComposer);
      assert(remoteComposer);
      const ownership = Promise.withResolvers<{
        owner: "external";
        harnessId: "claude-code";
        transportModelId: string;
        locked: true;
        history: { fork: true; forkAcrossCwd: false; rollbackLastTurn: true };
      }>();
      const local = {
        inspectThread: vi.fn(async () => ({ owner: "codex" as const, locked: true })),
        inspectHarness: vi.fn(async () => readyInspection()),
        inspectThreadUsage: vi.fn(async () => ({
          threadId: "same-thread",
          usage: { inputTokens: 11 },
        })),
        subscribeThreadUsage: vi.fn(() => () => undefined),
      };
      const retired = { ...local, inspectThread: vi.fn(() => ownership.promise) };
      const replacement = {
        ...local,
        inspectThread: vi.fn(async () => ({ owner: "codex" as const, locked: true })),
      };
      let remoteClient: typeof retired | typeof replacement | null = retired;
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({ enabledAgents: ["codex", "claude-code"] });
      const ready = {
        state: "ready",
        reason: "ready",
        modelUpdates: 0,
        hook: "request-bridge",
      } as const;
      probe.setAdapter(
        ready,
        undefined,
        undefined,
        {
          currentHostId: (composer?: Element) =>
            composer === localComposer ? "local" : composer === remoteComposer ? "remote" : null,
          clientForHost: (hostId: string) => (hostId === "local" ? local : remoteClient),
        } as never,
        () => ready,
      );
      await vi.waitFor(() => {
        expect(retired.inspectThread).toHaveBeenCalledOnce();
        expect(testState.renderedControls.get(localComposer)?.at(-1)).toMatchObject({
          selection: { agent: "codex", phase: "locked" },
        });
      });
      const localOwnershipCalls = local.inspectThread.mock.calls.length;
      remoteClient = mode === "disconnect" ? null : replacement;
      window.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
      ownership.resolve({
        owner: "external",
        harnessId: "claude-code",
        transportModelId: "codexhost/claude-code-native",
        locked: true,
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
      });
      await ownership.promise;
      await Promise.resolve();
      expect(testState.renderedControls.get(remoteComposer)).not.toContainEqual(
        expect.objectContaining({
          selection: expect.objectContaining({ agent: "claude-code" }),
        }),
      );
      expect(local.inspectThread).toHaveBeenCalledTimes(localOwnershipCalls);
      if (mode === "replace") {
        await vi.waitFor(() =>
          expect(testState.renderedControls.get(remoteComposer)?.at(-1)).toMatchObject({
            selection: { agent: "codex", phase: "locked" },
          }),
        );
      }
    },
  );

  it.each([true, false])(
    "routes co-mounted ownership and Harness menus independently (remote hidden: %s)",
    async (hidden) => {
      installFakeBrowser([
        { target: ["conversation", "same-thread"] },
        { hidden, target: ["conversation", "same-thread"] },
      ]);
      const [localComposer, remoteComposer] = testState.composers;
      assert(localComposer);
      assert(remoteComposer);
      const threadId = hostThreadIdSchema.parse("same-thread");
      const usageListeners = new Map<string, (update: ThreadUsageInspection) => void>();
      const usageDisposers = new Map<string, ReturnType<typeof vi.fn>>();
      const subscribeForHost = (hostId: string) =>
        vi.fn((listener: (update: ThreadUsageInspection) => void) => {
          usageListeners.set(hostId, listener);
          const dispose = vi.fn();
          usageDisposers.set(hostId, dispose);
          return dispose;
        });
      const local = {
        hostId: "local",
        currentHostId: () => "local",
        inspectHarness: vi.fn(async () => readyInspection()),
        inspectThread: vi.fn(async () => ({
          owner: "external" as const,
          harnessId: "claude-code",
          transportModelId:
            "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
          effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
          history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
          locked: true,
          usage: { inputTokens: 11 },
        })),
        inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
        inspectThreadUsage: vi.fn(async () => ({
          threadId: "same-thread",
          usage: { inputTokens: 11 },
        })),
        subscribeThreadUsage: subscribeForHost("local"),
        selectThreadModel: vi.fn(async (input: { model: HarnessModelRef }) => ({
          effectiveModel: input.model,
          resolvedModelLabel: "local-selection",
        })),
      };
      const remote = {
        hostId: "remote-host",
        currentHostId: () => "remote-host",
        inspectHarness: vi.fn(async () => ({
          status: "notInstalled" as const,
          error: {
            code: "notInstalled",
            message: "Harness is not installed on remote",
            retryable: false,
          },
        })),
        inspectThread: vi.fn(async () => ({ owner: "codex" as const, locked: true })),
        inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
        inspectThreadUsage: vi.fn(async () => ({
          threadId: "same-thread",
          usage: { inputTokens: 22 },
        })),
        subscribeThreadUsage: subscribeForHost("remote-host"),
      };
      let remoteClient: typeof remote | null = remote;
      const currentHostId = vi.fn((composer?: Element) =>
        composer === localComposer ? "local" : composer === remoteComposer ? "remote-host" : null,
      );
      const modelControl = {
        currentHostId,
        clientForHost: vi.fn((hostId: string) =>
          hostId === "local" ? local : hostId === "remote-host" ? remoteClient : null,
        ),
        inspectHarness: vi.fn(),
        inspectThread: vi.fn(),
        inspectThreadUsage: vi.fn(),
        selectThreadModel: vi.fn(),
        subscribeThreadUsage: vi.fn(() => () => undefined),
      };
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({
        enabledAgents: ["codex", "pi", "claude-code"],
        defaultAgent: "codex",
      });
      const ready = {
        state: "ready",
        reason: "ready",
        modelUpdates: 0,
        hook: "request-bridge",
      } as const;
      probe.setAdapter(
        ready,
        undefined,
        vi.fn(() => true),
        modelControl as never,
        (composer) =>
          composer === remoteComposer && !remoteClient
            ? {
                ...ready,
                state: "installing",
                reason: "draft-routing-policy-unavailable",
                hook: null,
              }
            : ready,
      );
      await vi.waitFor(() => {
        expect(local.inspectThread).toHaveBeenCalledWith({ threadId: "same-thread" });
        expect(remote.inspectThread).toHaveBeenCalledWith({ threadId: "same-thread" });
        expect(testState.renderedControls.get(localComposer)?.at(-1)).toMatchObject({
          selection: { agent: "claude-code", phase: "locked" },
          adapter: "ready",
          availability: { pi: "ready", "claude-code": "ready" },
          modelView: { status: "ready" },
        });
        expect(testState.renderedControls.get(remoteComposer)?.at(-1)).toMatchObject({
          selection: { agent: "codex", phase: "locked" },
          adapter: "ready",
          availability: { pi: "notInstalled", "claude-code": "notInstalled" },
        });
      });
      expect(probe.status().mountedComposers).toBe(2);
      expect(currentHostId()).toBeNull();
      expect(currentHostId(localComposer)).toBe("local");
      expect(currentHostId(remoteComposer)).toBe("remote-host");
      expect(modelControl.inspectHarness).not.toHaveBeenCalled();
      expect(modelControl.inspectThread).not.toHaveBeenCalled();
      expect(modelControl.inspectThreadUsage).not.toHaveBeenCalled();
      expect(local.subscribeThreadUsage).toHaveBeenCalledOnce();
      expect(remote.subscribeThreadUsage).toHaveBeenCalledOnce();
      expect(modelControl.subscribeThreadUsage).not.toHaveBeenCalled();
      usageListeners.get("local")?.({
        threadId,
        usage: { inputTokens: 111 },
      });
      usageListeners.get("remote-host")?.({
        threadId,
        usage: { inputTokens: 222 },
      });
      expect(testState.renderedControls.get(localComposer)?.at(-1)?.usage).toEqual({
        inputTokens: 111,
      });
      expect(testState.renderedControls.get(remoteComposer)?.at(-1)?.usage).toEqual({
        inputTokens: 222,
      });
      testState.selectModels.get(localComposer)?.("claude-model-v1.b3B1cw");
      await vi.waitFor(() =>
        expect(testState.renderedControls.get(localComposer)?.at(-1)?.modelView).toMatchObject({
          status: "ready",
          resolvedModelLabel: "local-selection",
        }),
      );
      expect(local.selectThreadModel).toHaveBeenCalledWith({
        threadId: "same-thread",
        model: { id: "claude-model-v1.b3B1cw" },
      });
      expect(modelControl.selectThreadModel).not.toHaveBeenCalled();

      const localOwnershipCalls = local.inspectThread.mock.calls.length;
      const retiredUsage = usageListeners.get("remote-host");
      remoteClient = null;
      window.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
      expect(usageDisposers.get("remote-host")).toHaveBeenCalledOnce();
      expect(usageDisposers.get("local")).not.toHaveBeenCalled();
      expect(local.inspectThread).toHaveBeenCalledTimes(localOwnershipCalls);
      expect(testState.renderedControls.get(localComposer)?.at(-1)).toMatchObject({
        adapter: "ready",
        modelView: { status: "ready", resolvedModelLabel: "local-selection" },
        usage: { inputTokens: 111 },
      });
      expect(testState.renderedControls.get(remoteComposer)?.at(-1)).toMatchObject({
        adapter: "installing",
        usage: null,
      });
      retiredUsage?.({ threadId, usage: { inputTokens: 999 } });
      expect(testState.renderedControls.get(remoteComposer)?.at(-1)?.usage).toBeNull();
      expect(testState.renderedControls.get(localComposer)?.at(-1)?.usage).toEqual({
        inputTokens: 111,
      });
    },
  );
});
