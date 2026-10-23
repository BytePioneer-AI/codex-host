import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectNativeChatVoiceBinding,
  installNativeChatVoiceHook,
  startNativeChatVoiceForRequest,
} from "../src/renderer-native-chat-voice.js";
import {
  CHAT_LIVE_VOICE_STORAGE_KEY,
  applySharedVoiceRoutes,
} from "../src/renderer-cpa-live-voice-preference.js";

function fixture() {
  const scopeDefinition = { id: Symbol(), __scopeBrand: "AppScope" };
  const backendConversationId = {};
  const ownerScopeDefinition = { id: Symbol(), __scopeBrand: "RouteScope" };
  const context = { displayName: "AppScope" };
  const composerScopeDefinition = { id: Symbol(), __scopeBrand: "ComposerScope" };
  const composerContext = { displayName: "ComposerScope" };
  const composerNode = {
    token: composerScopeDefinition,
    value: {
      kind: "chatgpt",
      chatGptSelectionContext: {
        conversationId: "desktop-local-conversation",
      },
    },
  };
  const composerChain = new Map<unknown, unknown>([
    [scopeDefinition.id, {}],
    [composerScopeDefinition.id, composerNode],
  ]);
  const appNode = {};
  const node = {};
  const chain = new Map<unknown, unknown>([
    [scopeDefinition.id, appNode],
    [ownerScopeDefinition.id, node],
  ]);
  composerChain.set(scopeDefinition.id, appNode);
  composerChain.set(ownerScopeDefinition.id, node);
  const outerComposerChain = new Map(composerChain);
  outerComposerChain.set(composerScopeDefinition.id, {
    value: { kind: "new", entrypoint: "home" },
  });
  const get = vi.fn<(selector: unknown, argument?: unknown) => unknown>(
    () => "6ad6391c-9a48-83e8-8a22-21548902d6d4",
  );
  const scope = { scope: ownerScopeDefinition, node, chain, get, set: vi.fn() };
  const props = {
    conversationId: "desktop-local-conversation",
    isWorkConversation: false,
    isTemporaryChat: false,
    shouldBlockExternalEgress: false,
    composerSelectionContext: { conversationId: "desktop-local-conversation" },
  };
  const owner = {
    memoizedProps: props,
    memoizedState: { memoizedState: { current: scope }, next: null as unknown },
    dependencies: {
      firstContext: {
        context,
        memoizedValue: chain,
        next: { context: composerContext, memoizedValue: outerComposerChain, next: null },
      },
    },
    return: null as unknown,
  };
  const provider = {
    tag: 10,
    type: composerContext,
    memoizedProps: { value: composerChain },
    return: owner,
  };
  const fiber = { return: provider };
  const composer = { __reactFiber$fixture: fiber } as unknown as Element;
  return {
    scopeDefinition,
    composerScopeDefinition,
    composerContext,
    composerNode,
    composerChain,
    backendConversationId,
    ownerScopeDefinition,
    context,
    scope,
    props,
    owner,
    provider,
    fiber,
    composer,
    get,
  };
}

describe("native Chat composer binding", () => {
  it("reads the backend Chat ID from the owner's RouteScope, never its desktop locator", () => {
    const f = fixture();
    const binding = detectNativeChatVoiceBinding(f.composer, f);
    expect(binding).toMatchObject({ scope: f.scope, props: f.props, context: f.context });
    expect(f.get).toHaveBeenCalledWith(f.backendConversationId, "desktop-local-conversation");
    expect(f.scope.set).not.toHaveBeenCalled();
  });

  it.each([
    { isWorkConversation: true },
    { isTemporaryChat: true },
    { shouldBlockExternalEgress: true },
    { shouldBlockExternalEgress: undefined },
    { readOnly: true },
    { composerSelectionContext: { conversationId: "another-composer" } },
  ])("rejects ineligible or mismatched Chat owners: %j", (overrides) => {
    const f = fixture();
    Object.assign(f.props, overrides);
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it.each([null, "local-chatgpt:draft", "codex-thread-id", undefined])(
    "does not invent a backend conversation ID when the native store returns %s",
    (id) => {
      const f = fixture();
      f.get.mockReturnValue(id as string);
      expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
    },
  );

  it.each([null, undefined])("accepts an unsaved native Chat draft with backend ID %s", (id) => {
    const f = fixture();
    const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
    f.props.conversationId = draft;
    f.props.composerSelectionContext.conversationId = draft;
    f.composerNode.value.chatGptSelectionContext.conversationId = draft;
    f.get.mockReturnValue(id);
    expect(detectNativeChatVoiceBinding(f.composer, f)).toMatchObject({
      props: f.props,
      scope: f.scope,
      backendConversationId: undefined,
    });
    expect(f.scope.set).not.toHaveBeenCalled();
  });

  it("rejects an outer new-Chat scope without the inner conversation selection", () => {
    const f = fixture();
    const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
    f.props.conversationId = draft;
    f.props.composerSelectionContext.conversationId = draft;
    f.get.mockReturnValue(null);
    Object.assign(f.composerNode.value, { kind: "new", entrypoint: "home" });
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it("reads the inner provider below an owner that consumes the outer new-Chat scope", () => {
    const f = fixture();
    expect(detectNativeChatVoiceBinding(f.composer, f)?.composerContext).toEqual({
      context: f.composerContext,
      chain: f.composerChain,
    });
  });

  it("rejects a consumed ComposerScope without a provider between the form and owner", () => {
    const f = fixture();
    f.owner.dependencies.firstContext.next.memoizedValue = f.composerChain;
    Object.assign(f.fiber, { return: f.owner });
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it("rejects a provider with a different native scope token or RouteScope node", () => {
    const f = fixture();
    Object.assign(f.composerNode, { token: { ...f.composerScopeDefinition } });
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
    f.composerNode.token = f.composerScopeDefinition;
    f.composerChain.set(f.ownerScopeDefinition.id, {});
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it("does not skip a nearer empty provider to accept a more distant valid scope", () => {
    const f = fixture();
    Object.assign(f.fiber, {
      return: { ...f.provider, memoizedProps: { value: new Map() }, return: f.provider },
    });
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it("rejects an unrecognized draft locator even when its backend ID is absent", () => {
    const f = fixture();
    const draft = "local-chatgpt:draft";
    f.props.conversationId = draft;
    f.props.composerSelectionContext.conversationId = draft;
    f.composerNode.value.chatGptSelectionContext.conversationId = draft;
    f.get.mockReturnValue(null);
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it("rejects absent or mismatched native ComposerScope ownership", () => {
    const f = fixture();
    f.composerNode.value.chatGptSelectionContext.conversationId = "different-chat";
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
    f.composerChain.delete(f.composerScopeDefinition.id);
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it("rejects contexts from another AppScope", () => {
    const f = fixture();
    f.composerChain.set(f.scopeDefinition.id, {});
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it("deduplicates native scope refs by their owning RouteScope node", () => {
    const f = fixture();
    f.owner.memoizedState.next = { memoizedState: { current: { ...f.scope } }, next: null };
    expect(detectNativeChatVoiceBinding(f.composer, f)?.scope.node).toBe(f.scope.node);
  });

  it("rejects competing RouteScope nodes and cycles in native hook state", () => {
    const f = fixture();
    const node = {};
    f.owner.memoizedState.next = {
      memoizedState: {
        current: {
          ...f.scope,
          node,
          chain: new Map([
            [f.scopeDefinition.id, node],
            [f.ownerScopeDefinition.id, node],
          ]),
        },
      },
      next: null,
    };
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
    f.owner.memoizedState.next = f.owner.memoizedState;
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
  });

  it("uses the published owner after React swaps an alternate", () => {
    const f = fixture();
    const staleOwner = { ...f.owner, memoizedProps: { ...f.props, isWorkConversation: true } };
    const stale = { return: staleOwner, alternate: f.fiber };
    const root = { child: f.owner, stateNode: { current: null as unknown } };
    Object.assign(f.owner, { return: root, child: f.provider });
    Object.assign(f.provider, { child: f.fiber });
    root.stateNode.current = root;
    staleOwner.return = root;
    Object.assign(f.composer, { __reactFiber$fixture: stale });
    expect(detectNativeChatVoiceBinding(f.composer, f)?.props).toBe(f.props);
  });
});

describe("Chat voice service launch boundary", () => {
  it("leaves Codex Desktop default on the native Codex service without invoking Chat START", () => {
    const start = vi.fn();
    const target = { __codexhostNativeChatVoiceV1: { status: "active", start } };
    applySharedVoiceRoutes(target, {
      chatExperience: "codex",
      chatConnection: "desktop",
      workConnection: "gateway",
    });
    expect(startNativeChatVoiceForRequest({ productExperience: "chat" }, target)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts native Chat and propagates failure without invoking a new-thread overlay", async () => {
    const start = vi.fn().mockRejectedValue(new Error("native unavailable"));
    const target = { __codexhostNativeChatVoiceV1: { status: "active", start } };
    const request = { source: "composer_button_new_thread", productExperience: "chat" };
    await expect(startNativeChatVoiceForRequest(request, target)).rejects.toThrow(
      "native unavailable",
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it("leaves Work, Grok and explicit Chat gateway launches on their existing path", () => {
    const start = vi.fn();
    const target = {
      __codexhostNativeChatVoiceV1: { status: "active", start },
      localStorage: {
        getItem: (key: string) => (key === CHAT_LIVE_VOICE_STORAGE_KEY ? "1" : null),
      },
    };
    expect(startNativeChatVoiceForRequest({ productExperience: "work" }, target)).toBeUndefined();
    expect(startNativeChatVoiceForRequest({ productExperience: "chat" }, target)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("fails through the pending native Chat binding instead of accepting a stale conversation", async () => {
    const start = vi.fn().mockRejectedValue(new Error("Select a ChatGPT conversation"));
    await expect(
      startNativeChatVoiceForRequest(
        { productExperience: "chat" },
        {
          __codexhostNativeChatVoiceV1: { status: "pending", start },
        },
      ),
    ).rejects.toThrow("Select a ChatGPT conversation");
  });
});

function installFixture() {
  const f = fixture();
  const enabled = {};
  let browserEnabled: unknown = false;
  let active = false;
  let connected = true;
  let sessionStarted = true;
  let serverId: unknown = "a7e3282d-f457-4586-9b28-921411364f6b";
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const start = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
  f.scope.get.mockImplementation((selector: unknown) =>
    selector === enabled ? browserEnabled : "6ad6391c-9a48-83e8-8a22-21548902d6d4",
  );
  f.scope.set.mockImplementation((_selector, value) => {
    browserEnabled = value;
  });
  const render = vi.fn();
  const unmount = vi.fn();
  const createRoot = vi.fn(() => ({ render, unmount }));
  const createElement = vi.fn((type, props, ...children) => ({ type, props, children }));
  const elements: Record<string, unknown>[] = [];
  const createElementDom = () => {
    const el = {
      type: "",
      className: "",
      title: "",
      disabled: false,
      style: {},
      setAttribute: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(),
    };
    elements.push(el);
    return el;
  };
  let visible = true;
  const parent = {
    insertBefore: vi.fn((element: Record<string, unknown>, anchor: unknown) => {
      Object.assign(element, { nextElementSibling: anchor });
    }),
  };
  const send = {
    type: "submit",
    className: "native-send-button",
    parentElement: parent,
    getBoundingClientRect: () => ({ width: 28 }),
    closest: () => null,
  };
  const styleValues = new Map<string, [string, string]>([["display", ["inline-flex", ""]]]);
  const overlayButton = {
    style: {
      getPropertyValue: (key: string) => styleValues.get(key)?.[0] ?? "",
      getPropertyPriority: (key: string) => styleValues.get(key)?.[1] ?? "",
      setProperty: (key: string, value: string, priority: string) =>
        styleValues.set(key, [value, priority]),
    },
  };
  const overlayButtons = [overlayButton];
  Object.assign(f.composer, {
    getBoundingClientRect: () => ({ width: visible ? 500 : 0 }),
    closest: () => null,
    contains: () => true,
    querySelector: () => null,
    querySelectorAll: vi.fn((selector: string) =>
      selector === 'button[type="submit"]' ? [send] : overlayButtons,
    ),
  });
  const initial = {
    B1n: f.backendConversationId,
    CDr: f.composerScopeDefinition,
    MOr: f.ownerScopeDefinition,
    aT: enabled,
    oT: vi.fn(),
    Ycr: {},
    n0n: {},
    Y1n: {},
    Nir: vi.fn(),
    SPn: () => ({
      getState: () => ({
        isVoiceModeActive: active,
        hasConnectedOnce: connected,
        hasVoiceSessionStarted: sessionStarted,
        earlyServerThreadId: serverId,
        server: { connectionState: connected ? "connected" : null },
        isWorkMode: false,
        conversationId: f.props.conversationId,
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
    }),
  };
  const shared = {
    Qst: f.scopeDefinition,
    FBt: () => ({ createElement }),
    PNt: () => ({ createRoot }),
    Vot: vi.fn((id: string) => `/c/${encodeURIComponent(id)}`),
  };
  const assets = ["app-initial-dddef47d6ef6.js", "app-shared-fc3316d48427.js"];
  const doc = {
    body: { append: vi.fn() },
    createElement: createElementDom,
    querySelectorAll: (selector: string) =>
      selector === "[data-chatgpt-composer]"
        ? [f.composer]
        : selector === '[style*="--vt-splash-screen-headline"]'
          ? []
          : assets.map((name) => ({ getAttribute: () => `app://-/assets/${name}` })),
  } as unknown as Document;
  const target = {
    __codexhostCpaLiveVoiceHookV1: {
      enabled: true,
      desktopVersion: "26.1016.62342",
      auditedDesktopVersion: "26.1007.30912",
      auditedAppInitialAsset: "app-initial-6350d04672d0.js",
    },
    document: doc,
    performance: { getEntriesByType: () => [] },
    setTimeout,
    clearTimeout,
  };
  const importModule = vi.fn(async (url: string): Promise<Record<string, unknown>> => {
    if (url.includes("app-shared")) return shared;
    if (url.includes("app-initial")) return initial;
    if (url.includes("start-voice")) return { t: vi.fn(), n: start };
    return { VoiceInstantConnectCacheController: vi.fn() };
  });
  return {
    ...f,
    target,
    importModule,
    start,
    render,
    unmount,
    createRoot,
    createElement,
    elements,
    initial,
    shared,
    assets,
    parent,
    send,
    overlayButton,
    overlayButtons,
    browserEnabled: () => browserEnabled,
    listeners,
    unsubscribe,
    setSessionStarted: (value: boolean) => {
      sessionStarted = value;
      for (const listener of listeners) listener();
    },
    setServerId: (value: unknown) => {
      serverId = value;
      for (const listener of listeners) listener();
    },
    setConnected: (value: boolean) => {
      connected = value;
      for (const listener of listeners) listener();
    },
    setActive: (value: boolean) => {
      active = value;
      for (const listener of listeners) listener();
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
  };
}

afterEach(() => vi.useRealTimers());
describe("native Chat voice lifecycle installation", () => {
  it("keeps one AppScope runtime when navigation replaces the RouteScope", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    const node = {};
    const chain = new Map(f.scope.chain);
    chain.set(f.ownerScopeDefinition.id, node);
    const next = { ...f.scope, node, chain };
    f.owner.memoizedState.memoizedState.current = next;
    f.composerChain.set(f.ownerScopeDefinition.id, node);
    await vi.advanceTimersByTimeAsync(500);
    expect(hook.status).toBe("active");
    expect(f.createRoot).toHaveBeenCalledOnce();
    expect(f.unmount).not.toHaveBeenCalled();
    await hook.start();
    expect(f.start).toHaveBeenCalledWith(
      next,
      f.props,
      { event_source: "composer" },
      expect.any(AbortSignal),
    );
    hook.dispose();
  });
  it("selects the adopted voice draft while its composer is hidden without releasing the native runtime", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
    const backend = "a7e3282d-f457-4586-9b28-921411364f6b";
    f.props.conversationId = draft;
    f.props.composerSelectionContext.conversationId = draft;
    f.composerNode.value.chatGptSelectionContext.conversationId = draft;
    let adopted = false;
    const nativeGet = f.scope.get.getMockImplementation();
    if (!nativeGet) throw new Error("Fixture native getter is missing");
    f.scope.get.mockImplementation((selector, argument) => {
      if (selector === f.initial.B1n) return adopted ? backend : null;
      if (selector === f.initial.Y1n) return adopted ? "message" : null;
      if (selector === f.initial.n0n)
        return adopted ? { message: { message: { author: { role: "user" } } } } : null;
      return nativeGet(selector, argument);
    });
    f.start.mockImplementation(async () => {
      f.setActive(true);
    });
    const hook = installNativeChatVoiceHook(f);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await hook.start();
      const signal = f.start.mock.calls[0]?.[3] as AbortSignal;
      f.setVisible(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.initial.Nir).not.toHaveBeenCalled();
      adopted = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(f.initial.Nir).toHaveBeenCalledExactlyOnceWith(
        f.scope,
        `/c/${encodeURIComponent(draft)}`,
      );
      expect(f.shared.Vot).toHaveBeenCalledExactlyOnceWith(draft);
      // Native canonicalization publishes the selected Chat composer in the same AppScope.
      f.props.conversationId = backend;
      f.props.composerSelectionContext.conversationId = backend;
      f.composerNode.value.kind = "chatgpt";
      f.composerNode.value.chatGptSelectionContext.conversationId = backend;
      f.setVisible(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.createRoot).toHaveBeenCalledOnce();
      expect(f.unmount).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(false);
      expect(hook.activeCall).toBe(true);
      expect(f.initial.Nir).toHaveBeenCalledOnce();
    } finally {
      hook.dispose();
    }
  });

  it("starts native voice without private page-navigation exports", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    for (const key of ["Nir", "Ycr"]) Reflect.deleteProperty(f.initial, key);
    Reflect.deleteProperty(f.shared, "Vot");
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.status).toBe("active");
    await hook.start();
    expect(f.start).toHaveBeenCalledOnce();
    hook.dispose();
  });

  it.each(["saved", "draft"])(
    "keeps native voice on its page through connection, session startup and retry: %s",
    async (kind) => {
      vi.useFakeTimers();
      const f = installFixture();
      if (kind === "draft") {
        const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
        f.props.conversationId = draft;
        f.props.composerSelectionContext.conversationId = draft;
        f.composerNode.value.chatGptSelectionContext.conversationId = draft;
        const nativeGet = f.scope.get.getMockImplementation();
        if (!nativeGet) throw new Error("Fixture native getter is missing");
        f.scope.get.mockImplementation((selector, argument) =>
          selector === f.backendConversationId ? null : nativeGet(selector, argument),
        );
      }
      f.setConnected(false);
      f.setSessionStarted(false);
      f.setServerId(null);
      f.start.mockImplementation(async () => {
        f.setActive(true);
      });
      // The real Desktop failure ends voice during a conversation-page transition.
      f.initial.Nir.mockImplementation(() => {
        f.setActive(false);
      });
      const hook = installNativeChatVoiceHook(f);
      try {
        await vi.advanceTimersByTimeAsync(0);
        let acknowledged = false;
        const starting = hook.start().then(() => {
          acknowledged = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(acknowledged).toBe(true);
        await starting;
        f.setConnected(true);
        f.setSessionStarted(true);
        f.setServerId("a7e3282d-f457-4586-9b28-921411364f6b");
        f.setVisible(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(hook.activeCall).toBe(true);
        expect(f.unmount).not.toHaveBeenCalled();
        expect(f.initial.Nir).not.toHaveBeenCalled();
        expect(f.shared.Vot).not.toHaveBeenCalled();
        f.setActive(false);
        f.setVisible(true);
        await vi.advanceTimersByTimeAsync(500);
        await hook.start();
        expect(f.start).toHaveBeenCalledTimes(2);
        expect(hook.activeCall).toBe(true);
        expect(f.initial.Nir).not.toHaveBeenCalled();
      } finally {
        hook.dispose();
      }
      expect(f.listeners.size).toBe(0);
    },
  );

  it("retains startup through a hidden composer before native START returns", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const gate = Promise.withResolvers<undefined>();
    f.start.mockImplementation(() => gate.promise);
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    const starting = hook.start();
    const signal = f.start.mock.calls[0]?.[3] as AbortSignal;
    f.setVisible(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(false);
    expect(f.unmount).not.toHaveBeenCalled();
    expect(f.browserEnabled()).toBe(true);
    gate.resolve(undefined);
    await starting;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.unmount).toHaveBeenCalledOnce();
    hook.dispose();
  });

  it("places native Voice immediately before Send when Dictate is absent", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    Object.assign(f.composer, { querySelector: () => null });
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    const voice = f.elements.find((element) => element.title === "Start Voice");
    expect(voice).toBeDefined();
    expect(f.parent.insertBefore).toHaveBeenCalledWith(voice, f.send);
    expect(voice?.type).toBe("button");
    await hook.start();
    expect(f.start).toHaveBeenCalledOnce();
    hook.dispose();
  });

  it("does not place Voice when Send ownership is ambiguous", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    Object.assign(f.composer, {
      querySelectorAll: (selector: string) =>
        selector === 'button[type="submit"]' ? [f.send, { ...f.send }] : f.overlayButtons,
    });
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.parent.insertBefore).not.toHaveBeenCalled();
    expect(f.overlayButton.style.getPropertyValue("display")).toBe("inline-flex");
    hook.dispose();
  });

  it("shows only native Chat START and restores the overlay control on Work or gateway override", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.parent.insertBefore).toHaveBeenCalledOnce();
    expect(f.overlayButton.style.getPropertyValue("display")).toBe("none");
    expect(f.overlayButton.style.getPropertyPriority("display")).toBe("important");
    expect(f.composer.querySelectorAll).toHaveBeenCalledWith(
      'button[aria-label="Start new voice chat"], button[aria-label="Start voice chat"]',
    );
    f.props.isWorkConversation = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.overlayButton.style.getPropertyValue("display")).toBe("inline-flex");
    expect(f.overlayButton.style.getPropertyPriority("display")).toBe("");
    f.props.isWorkConversation = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.overlayButton.style.getPropertyValue("display")).toBe("none");
    Object.assign(f.target, {
      localStorage: {
        getItem: (key: string) => (key === CHAT_LIVE_VOICE_STORAGE_KEY ? "1" : null),
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.overlayButton.style.getPropertyValue("display")).toBe("inline-flex");
    expect(hook.status).toBe("pending");
    hook.dispose();
  });

  it("keeps the native control visible when the replacement cannot be inserted", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    Object.assign(f.composer, { querySelectorAll: () => [] });
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.parent.insertBefore).not.toHaveBeenCalled();
    expect(f.overlayButton.style.getPropertyValue("display")).toBe("inline-flex");
    hook.dispose();
  });
  it("starts a new Chat through native START without synthesizing a backend UUID", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
    f.props.conversationId = draft;
    f.props.composerSelectionContext.conversationId = draft;
    f.composerNode.value.chatGptSelectionContext.conversationId = draft;
    const nativeGet = f.scope.get.getMockImplementation();
    if (!nativeGet) throw new Error("Fixture native getter is missing");
    f.scope.get.mockImplementation((selector, argument) =>
      selector === f.backendConversationId ? null : nativeGet(selector, argument),
    );
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.status).toBe("active");
    expect(f.parent.insertBefore).toHaveBeenCalledOnce();
    await hook.start();
    expect(f.start).toHaveBeenCalledWith(
      f.scope,
      f.props,
      { event_source: "composer" },
      expect.any(AbortSignal),
    );
    expect(f.props.conversationId).toBe(draft);
    expect(f.initial.Nir).not.toHaveBeenCalled();
    expect(f.scope.set).toHaveBeenCalledWith(f.initial.aT, true);
    expect(f.scope.set).toHaveBeenCalledTimes(1);
    hook.dispose();
  });

  it("restores Start Voice after leaving Chat, returning, and native composer replacement", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    const firstButton = f.parent.insertBefore.mock.calls[0]?.[0];
    if (!firstButton) throw new Error("Native voice button was not inserted");
    f.props.isWorkConversation = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(hook.status).toBe("pending");
    expect(firstButton.remove).toHaveBeenCalledOnce();
    expect(f.browserEnabled()).toBe(false);
    f.props.isWorkConversation = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(hook.status).toBe("active");
    expect(f.browserEnabled()).toBe(true);
    expect(f.parent.insertBefore).toHaveBeenCalledTimes(2);
    Object.assign(f.composer, { contains: () => false });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.parent.insertBefore).toHaveBeenCalledTimes(3);
    expect(f.createRoot).toHaveBeenCalledTimes(2);
    expect(f.start).not.toHaveBeenCalled();
    f.start.mockImplementation(async () => {
      f.setActive(true);
      return undefined;
    });
    await hook.start();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.initial.Nir).not.toHaveBeenCalled();
    hook.dispose();
  });

  it("installs again on a fresh document without a session-only activation flag", async () => {
    vi.useFakeTimers();
    const first = installFixture();
    const previous = installNativeChatVoiceHook(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(previous.status).toBe("active");
    previous.dispose();
    const next = installFixture();
    const hook = installNativeChatVoiceHook(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.status).toBe("active");
    expect(next.browserEnabled()).toBe(true);
    expect(next.parent.insertBefore).toHaveBeenCalledOnce();
    hook.dispose();
  });

  it.each(["26.1013.40934", "26.1016.51333", "26.1016.62343"])(
    "rejects unqualified Desktop %s before importing or enabling native Chat",
    async (desktopVersion) => {
      const f = installFixture();
      f.target.__codexhostCpaLiveVoiceHookV1.desktopVersion = desktopVersion;
      // Even cached audited assets must not bypass the installed-version guard.
      const hook = installNativeChatVoiceHook(f);
      expect(hook.status).toBe("unsupported");
      await expect(hook.start()).rejects.toThrow("Native Chat voice is unavailable");
      expect(f.importModule).not.toHaveBeenCalled();
      expect(f.initial.oT).not.toHaveBeenCalled();
      expect(f.scope.set).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.createRoot).not.toHaveBeenCalled();
      expect(f.parent.insertBefore).not.toHaveBeenCalled();
      hook.dispose();
    },
  );

  it.each([
    [
      "26.1016.62342",
      "app-initial-dddef47d6ef6.js",
      "app-shared-fc3316d48427.js",
      "start-voice-7cbf0a39d53b.js",
      "voice-prewarm-5d107129ac1c.js",
    ],
    [
      "26.1016.61520",
      "app-initial-c95ddb62696e.js",
      "app-shared-2eda13eb7044.js",
      "start-voice-18b08f0acdd7.js",
      "voice-prewarm-94271e581c1b.js",
    ],
  ])(
    "starts native Chat on %s using only its qualified modules",
    async (version, initial, shared, start, prewarm) => {
      vi.useFakeTimers();
      const f = installFixture();
      f.target.__codexhostCpaLiveVoiceHookV1.desktopVersion = version;
      f.assets.splice(0, f.assets.length, initial, shared);
      const hook = installNativeChatVoiceHook(f);
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      expect(f.importModule.mock.calls.map(([url]) => url)).toEqual(
        [shared, initial, start, prewarm].map((asset) => `app://-/assets/${asset}`),
      );
      await hook.start();
      expect(f.start).toHaveBeenCalledWith(
        f.scope,
        f.props,
        { event_source: "composer" },
        expect.any(AbortSignal),
      );
      hook.dispose();
    },
  );

  it.each([
    ["26.1016.62342", ["app-initial-c95ddb62696e.js", "app-shared-2eda13eb7044.js"]],
    ["26.1016.62342", ["app-initial-dddef47d6ef6.js", "app-shared-2eda13eb7044.js"]],
    [
      undefined,
      ["app-initial-dddef47d6ef6.js", "app-shared-fc3316d48427.js", "app-initial-c95ddb62696e.js"],
    ],
  ])("rejects mismatched or ambiguous Chat assets (%s, %j)", async (version, names) => {
    vi.useFakeTimers();
    const f = installFixture();
    if (version === undefined)
      Reflect.deleteProperty(f.target.__codexhostCpaLiveVoiceHookV1, "desktopVersion");
    else f.target.__codexhostCpaLiveVoiceHookV1.desktopVersion = version;
    f.assets.splice(0, f.assets.length, ...names);
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hook.status).toBe("unsupported");
    expect(f.importModule).not.toHaveBeenCalled();
    expect(f.initial.oT).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    hook.dispose();
  });

  it("rejects stale Chat assets when the installed Desktop version is unavailable", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    Reflect.deleteProperty(f.target.__codexhostCpaLiveVoiceHookV1, "desktopVersion");
    f.assets.splice(
      0,
      f.assets.length,
      "app-initial-90eb42395b7d.js",
      "app-shared-52443cbe9ac4.js",
      "app-primary-58a09006cc0c.js",
      "start-voice-18b08f0acdd7.js",
      "voice-prewarm-94271e581c1b.js",
    );
    const hook = installNativeChatVoiceHook(f);
    expect(hook.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hook.status).toBe("unsupported");
    await expect(hook.start()).rejects.toThrow("Select a ChatGPT conversation");
    expect(f.importModule).not.toHaveBeenCalled();
    expect(f.scope.set).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.createRoot).not.toHaveBeenCalled();
    expect(f.parent.insertBefore).not.toHaveBeenCalled();
    hook.dispose();
  });

  it("supplies the native prewarm controller with both AppScope and ComposerScope", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(1000);
    const element = f.render.mock.calls[0]?.[0];
    const providers = new Map<unknown, unknown>();
    for (let e = element; e?.props?.value; e = e.children[0]) providers.set(e.type, e.props.value);
    expect(providers.get(f.context)).toBe(f.scope.chain);
    expect(providers.get(f.composerContext)).toBe(f.composerChain);
    expect(hook.status).toBe("active");
    hook.dispose();
  });

  it("updates native ComposerScope on selection changes without replacing the prewarm root", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    const nextChain = new Map(f.composerChain);
    f.provider.memoizedProps.value = nextChain;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.createRoot).toHaveBeenCalledOnce();
    expect(f.render).toHaveBeenCalledTimes(2);
    const element = f.render.mock.calls[1]?.[0];
    const providers = new Map<unknown, unknown>();
    for (let e = element; e?.props?.value; e = e.children[0]) providers.set(e.type, e.props.value);
    expect(providers.get(f.composerContext)).toBe(nextChain);
    hook.dispose();
  });

  it("mounts native prewarm once across Chat selections and dispatches the native START with current props", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.status).toBe("active");
    expect(f.browserEnabled()).toBe(true);
    expect(f.render).toHaveBeenCalledOnce();
    f.props.conversationId = "second-desktop-chat";
    f.props.composerSelectionContext.conversationId = "second-desktop-chat";
    f.composerNode.value.chatGptSelectionContext.conversationId = "second-desktop-chat";
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.createRoot).toHaveBeenCalledOnce();
    expect(f.render).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    await hook.start();
    expect(f.start).toHaveBeenCalledWith(
      f.scope,
      f.props,
      { event_source: "composer" },
      expect.any(AbortSignal),
    );
    expect(f.initial.Nir).not.toHaveBeenCalled();
    hook.dispose();
    expect(f.unmount).toHaveBeenCalledOnce();
    expect(f.browserEnabled()).toBe(false);
  });

  it("retains native runtime while voice hides the composer, then restores it when returning to Work", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    f.setActive(true);
    f.setVisible(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.unmount).not.toHaveBeenCalled();
    expect(f.browserEnabled()).toBe(true);
    f.setActive(false);
    f.setVisible(true);
    f.props.isWorkConversation = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(hook.status).toBe("pending");
    expect(f.unmount).toHaveBeenCalledOnce();
    expect(f.browserEnabled()).toBe(false);
    await expect(hook.start()).rejects.toThrow("Select a ChatGPT conversation");
    expect(f.start).not.toHaveBeenCalled();
    hook.dispose();
  });

  it("fails closed before importing native code on an unaudited Desktop", async () => {
    const f = installFixture();
    f.target.__codexhostCpaLiveVoiceHookV1.desktopVersion = "26.1020.1";
    const hook = installNativeChatVoiceHook(f);
    expect(hook.status).toBe("unsupported");
    expect(f.importModule).not.toHaveBeenCalled();
    expect(f.scope.set).not.toHaveBeenCalled();
  });

  it("does not mount after disposal during native module loading", async () => {
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    hook.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.createRoot).not.toHaveBeenCalled();
    expect(f.scope.set).not.toHaveBeenCalled();
  });
});
