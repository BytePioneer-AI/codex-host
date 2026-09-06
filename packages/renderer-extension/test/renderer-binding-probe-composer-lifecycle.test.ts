import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as RendererComposerDom from "../src/renderer-composer-dom.js";
import type * as VersionedRendererAdapter from "../src/versioned-renderer-adapter.js";

const testState = vi.hoisted(() => ({
  composer: null as unknown as Element,
  editor: null as unknown as Element,
  sendButton: null as unknown as HTMLButtonElement | null,
  mountCalls: 0,
  renders: [] as Array<{ subagentThread: boolean | undefined; switching: boolean }>,
  observerCallback: null as null | ((records: unknown[]) => void),
  modelTarget: ["default"] as readonly unknown[],
}));

vi.mock("../src/renderer-composer-dom.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererComposerDom>();
  return {
    ...original,
    composerForEditor: () => testState.composer,
    composerForElement: () => testState.composer,
    editorForElement: () => testState.editor,
    eventElement: () => testState.composer,
    mountComposerAgentControl: () => {
      testState.mountCalls += 1;
      return {
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
      };
    },
    renderComposerAgentControl: (
      _control: unknown,
      state: { subagentThread?: boolean },
      _adapter: unknown,
      switching: boolean,
    ) => {
      testState.renders.push({ subagentThread: state.subagentThread, switching });
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
}));

vi.mock("../src/renderer-settings-lifecycle.js", () => ({
  installRendererSettingsLifecycle: () => ({
    locale: "en",
    refresh: vi.fn(),
    dispose: vi.fn(),
  }),
}));

function fakeSubmitButton(): HTMLButtonElement {
  return {
    type: "submit",
    disabled: false,
    isConnected: true,
    parentElement: null,
    getAttribute: () => null,
  } as unknown as HTMLButtonElement;
}

function installFakeBrowser(): void {
  const listeners = new EventTarget();
  const composer = {
    isConnected: true,
    matches: (selector: string) => selector === "[data-codex-composer-root]",
    querySelectorAll: (selector: string) =>
      selector === "button" && testState.sendButton ? [testState.sendButton] : [],
    querySelector: (selector: string) => (selector.includes("textarea") ? testState.editor : null),
  } as unknown as Element;
  const editor = { closest: () => composer } as unknown as Element;
  testState.composer = composer;
  testState.editor = editor;
  testState.mountCalls = 0;
  testState.renders = [];
  testState.observerCallback = null;
  testState.modelTarget = ["default"];
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
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("window", window_);
  vi.stubGlobal("document", document_);
  vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: (records: unknown[]) => void) {
        testState.observerCallback = callback;
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

function triggerScan(): void {
  testState.observerCallback?.([]);
}

afterEach(() => {
  const api = (
    globalThis.window as unknown as {
      __codexhostRendererBindingProbeV1?: { dispose(): void };
    }
  )?.__codexhostRendererBindingProbeV1;
  api?.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Renderer binding mount anchor", () => {
  it("does not inject chips for a composer without a submit button, then mounts once it appears", async () => {
    installFakeBrowser();
    testState.sendButton = null;
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });

    // The read-only composer has no submit-class anchor: nothing is mounted.
    expect(testState.mountCalls).toBe(0);
    expect(probe.status().mountedComposers).toBe(0);

    // A later mutation batch delivers the submit button; scan() retries mount.
    testState.sendButton = fakeSubmitButton();
    triggerScan();
    await Promise.resolve();
    await Promise.resolve();

    expect(testState.mountCalls).toBe(1);
    expect(probe.status().mountedComposers).toBe(1);
  });
});

describe("Renderer binding thread ownership retry", () => {
  it("retries a failed ownership inspection on a bounded ladder until it succeeds", async () => {
    vi.useFakeTimers();
    installFakeBrowser();
    testState.sendButton = fakeSubmitButton();
    testState.modelTarget = ["conversation", "thread-a"];

    let inspectCalls = 0;
    const host = {
      inspectThread: vi.fn(async () => {
        inspectCalls += 1;
        if (inspectCalls === 1) throw new Error("subagent transcript unsettled");
        return { owner: "codex" as const, locked: true as const };
      }),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
      inspectHarnessCommands: vi.fn(async () => ({ commands: [] })),
    };
    const modelControl = {
      currentHostId: () => "local",
      clientForHost: vi.fn(() => host),
      inspectThread: host.inspectThread,
      inspectThreadUsage: host.inspectThreadUsage,
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

    // Flush the first (failing) inspection; ownership is blocked meanwhile.
    await vi.advanceTimersByTimeAsync(0);
    expect(host.inspectThread).toHaveBeenCalledTimes(1);
    expect(testState.renders.at(-1)?.switching).toBe(true);

    // The scheduled retry re-arms the inspection and reaches ready.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.inspectThread).toHaveBeenCalledTimes(2);
    expect(testState.renders.at(-1)?.switching).toBe(false);

    // Success clears the ladder: no further retries fire.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.inspectThread).toHaveBeenCalledTimes(2);
  });
});

describe("Renderer binding subagent read-only awareness", () => {
  it("propagates subagent inspection into the render state", async () => {
    installFakeBrowser();
    testState.sendButton = fakeSubmitButton();
    testState.modelTarget = ["conversation", "thread-child"];

    const host = {
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        subagent: true,
        locked: true as const,
      })),
      inspectHarness: vi.fn(async () => ({
        status: "ready" as const,
        catalog: {
          models: [{ ref: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }) }],
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
      })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-child",
        usage: null,
        accountCredits: null,
      })),
      inspectHarnessCommands: vi.fn(async () => ({ commands: [] })),
    };
    const modelControl = {
      currentHostId: () => "local",
      clientForHost: vi.fn(() => host),
      inspectThread: host.inspectThread,
      inspectHarness: host.inspectHarness,
      inspectThreadUsage: host.inspectThreadUsage,
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

    await vi.waitFor(() =>
      expect(testState.renders.at(-1)).toMatchObject({ subagentThread: true, switching: false }),
    );
  });
});
