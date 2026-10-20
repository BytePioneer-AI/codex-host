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
  const draftConversationId = {};
  const context = { displayName: "AppScope" };
  const composerScopeDefinition = { id: Symbol(), __scopeBrand: "ComposerScope" };
  const composerContext = { displayName: "ComposerScope" };
  const composerNode = {
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
  const node = {};
  const chain = new Map([[scopeDefinition.id, node]]);
  composerChain.set(scopeDefinition.id, node);
  const get = vi.fn<(selector: unknown, argument?: unknown) => unknown>(
    () => "6ad6391c-9a48-83e8-8a22-21548902d6d4",
  );
  const scope = { scope: scopeDefinition, node, chain, get, set: vi.fn() };
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
        next: { context: composerContext, memoizedValue: composerChain, next: null },
      },
    },
    return: null as unknown,
  };
  const fiber = { return: owner };
  const composer = { __reactFiber$fixture: fiber } as unknown as Element;
  return {
    scopeDefinition,
    composerScopeDefinition,
    composerContext,
    composerNode,
    composerChain,
    backendConversationId,
    draftConversationId,
    context,
    scope,
    props,
    owner,
    fiber,
    composer,
    get,
  };
}

function useNewChatComposer(f: ReturnType<typeof fixture>) {
  Object.assign(f.composerNode.value, { kind: "new", entrypoint: "home" });
  const composerScope = {
    ...f.scope,
    scope: f.composerScopeDefinition,
    node: f.composerNode,
    chain: f.composerChain,
    get: vi.fn((selector) =>
      selector === f.draftConversationId ? f.props.conversationId : undefined,
    ),
  };
  f.owner.memoizedState.next = { memoizedState: { current: composerScope }, next: null };
  return composerScope;
}

describe("native Chat composer binding", () => {
  it("reads the backend Chat ID from the owner's AppScope, never its desktop locator", () => {
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
    useNewChatComposer(f);
    f.get.mockReturnValue(id);
    expect(detectNativeChatVoiceBinding(f.composer, f)).toMatchObject({
      props: f.props,
      scope: f.scope,
      backendConversationId: undefined,
    });
    expect(f.scope.set).not.toHaveBeenCalled();
  });

  it("rejects new-Chat scopes that cannot prove the current native draft ownership", () => {
    const f = fixture();
    const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
    f.props.conversationId = draft;
    f.props.composerSelectionContext.conversationId = draft;
    f.get.mockReturnValue(null);
    const composerScope = useNewChatComposer(f);
    composerScope.get.mockReturnValue("another-draft");
    expect(detectNativeChatVoiceBinding(f.composer, f)).toBeUndefined();
    f.owner.memoizedState.next = null;
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

  it("deduplicates native scope refs by their owning AppScope node", () => {
    const f = fixture();
    f.owner.memoizedState.next = { memoizedState: { current: { ...f.scope } }, next: null };
    expect(detectNativeChatVoiceBinding(f.composer, f)?.scope.node).toBe(f.scope.node);
  });

  it("rejects competing AppScope nodes and cycles in native hook state", () => {
    const f = fixture();
    const node = {};
    f.owner.memoizedState.next = {
      memoizedState: {
        current: { ...f.scope, node, chain: new Map([[f.scopeDefinition.id, node]]) },
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
    Object.assign(f.owner, { return: root, child: f.fiber });
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
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const locationSelector = {};
  let location: unknown = { pathname: "/", key: "original" };
  const start = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
  f.scope.get.mockImplementation((selector: unknown) =>
    selector === enabled
      ? browserEnabled
      : selector === locationSelector
        ? location
        : "6ad6391c-9a48-83e8-8a22-21548902d6d4",
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
      setAttribute: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(),
    };
    elements.push(el);
    return el;
  };
  let visible = true;
  const parent = { append: vi.fn() };
  const dictate = { className: "native-button", parentElement: parent };
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
    querySelector: () => dictate,
    querySelectorAll: vi.fn(() => overlayButtons),
  });
  const initial = {
    pZn: f.backendConversationId,
    xAt: { scope: f.composerScopeDefinition },
    lXt: f.draftConversationId,
    Aw: enabled,
    jw: vi.fn(),
    FFr: locationSelector,
    uIr: vi.fn(),
    ejn: () => ({
      getState: () => ({
        isVoiceModeActive: active,
        hasConnectedOnce: connected,
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
    Cot: f.scopeDefinition,
    yzt: () => ({ createElement }),
    vMt: () => ({ createRoot }),
    xat: vi.fn((id: string) => `/c/${encodeURIComponent(id)}`),
  };
  const assets = ["app-initial-90eb42395b7d.js", "app-shared-52443cbe9ac4.js"];
  const doc = {
    body: { append: vi.fn() },
    createElement: createElementDom,
    querySelectorAll: (selector: string) =>
      selector === "[data-chatgpt-composer]"
        ? [f.composer]
        : assets.map((name) => ({ getAttribute: () => `app://-/assets/${name}` })),
  } as unknown as Document;
  const target = {
    __codexhostCpaLiveVoiceHookV1: {
      enabled: true,
      desktopVersion: "26.1013.40934",
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
    setLocation: (value: unknown) => {
      location = value;
    },
    assets,
    parent,
    overlayButton,
    overlayButtons,
    browserEnabled: () => browserEnabled,
    listeners,
    unsubscribe,
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

  it.each(["connected", "ended", "disposed", "navigated-away"])(
    "waits for native transport before selecting a new Chat: %s",
    async (outcome) => {
      vi.useFakeTimers();
      const f = installFixture();
      const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
      f.props.conversationId = draft;
      f.props.composerSelectionContext.conversationId = draft;
      useNewChatComposer(f);
      const nativeGet = f.scope.get.getMockImplementation();
      if (!nativeGet) throw new Error("Fixture native getter is missing");
      f.scope.get.mockImplementation((selector, argument) =>
        selector === f.backendConversationId ? null : nativeGet(selector, argument),
      );
      f.setConnected(false);
      f.start.mockImplementation(async () => {
        f.setActive(true);
      });
      const hook = installNativeChatVoiceHook(f);
      await vi.advanceTimersByTimeAsync(0);
      const starting = hook.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.initial.uIr).not.toHaveBeenCalled();
      expect(hook.activeCall).toBe(true);
      if (outcome === "disposed") hook.dispose();
      else if (outcome === "ended") f.setActive(false);
      else {
        if (outcome === "navigated-away") f.setLocation({ pathname: "/another-chat" });
        f.setConnected(true);
      }
      await starting;
      expect(f.initial.uIr).toHaveBeenCalledTimes(outcome === "connected" ? 1 : 0);
      if (outcome === "ended") {
        const retry = hook.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.start).toHaveBeenCalledTimes(2);
        expect(f.initial.uIr).not.toHaveBeenCalled();
        f.setConnected(true);
        await retry;
        expect(f.initial.uIr).toHaveBeenCalledOnce();
      }
      hook.dispose();
      expect(f.listeners.size).toBe(0);
    },
  );

  it("shows only native Chat START and restores the overlay control on Work or gateway override", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.parent.append).toHaveBeenCalledOnce();
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
    Object.assign(f.composer, { querySelector: () => null });
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.parent.append).not.toHaveBeenCalled();
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
    useNewChatComposer(f);
    const nativeGet = f.scope.get.getMockImplementation();
    if (!nativeGet) throw new Error("Fixture native getter is missing");
    f.scope.get.mockImplementation((selector, argument) =>
      selector === f.backendConversationId ? null : nativeGet(selector, argument),
    );
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.status).toBe("active");
    expect(f.parent.append).toHaveBeenCalledOnce();
    await hook.start();
    expect(f.start).toHaveBeenCalledWith(
      f.scope,
      f.props,
      { event_source: "composer" },
      expect.any(AbortSignal),
    );
    expect(f.props.conversationId).toBe(draft);
    expect(f.initial.uIr).not.toHaveBeenCalled();
    expect(f.scope.set).toHaveBeenCalledWith(f.initial.Aw, true);
    expect(f.scope.set).toHaveBeenCalledTimes(1);
    hook.dispose();
  });

  it.each([
    "active",
    "navigated-away",
    "disposed",
    "inactive",
    "different-session",
    "work-session",
    "navigation-failed",
  ])("selects the same new Chat after START only when still current: %s", async (outcome) => {
    vi.useFakeTimers();
    const f = installFixture();
    const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
    f.props.conversationId = draft;
    f.props.composerSelectionContext.conversationId = draft;
    useNewChatComposer(f);
    const nativeGet = f.scope.get.getMockImplementation();
    if (!nativeGet) throw new Error("Missing native getter");
    f.scope.get.mockImplementation((selector, argument) =>
      selector === f.backendConversationId ? null : nativeGet(selector, argument),
    );
    const gate = Promise.withResolvers<undefined>();
    f.start.mockImplementation(() => gate.promise);
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    const starting = hook.start();
    f.setActive(outcome !== "inactive");
    const originalStore = f.initial.ejn();
    if (outcome === "different-session" || outcome === "work-session")
      f.initial.ejn = () => ({
        ...originalStore,
        getState: () => ({
          isVoiceModeActive: true,
          hasConnectedOnce: true,
          isWorkMode: outcome === "work-session",
          conversationId: outcome === "different-session" ? "another-chat" : draft,
        }),
      });
    if (outcome === "navigation-failed")
      f.initial.uIr.mockImplementation(() => {
        throw new Error("Navigation bridge unavailable");
      });
    if (outcome === "navigated-away") f.setLocation({ pathname: "/another-chat" });
    if (outcome === "disposed") hook.dispose();
    gate.resolve(undefined);
    await starting;
    if (outcome === "active" || outcome === "navigation-failed") {
      expect(f.shared.xat).toHaveBeenCalledWith(draft);
      expect(f.initial.uIr).toHaveBeenCalledExactlyOnceWith(
        f.scope,
        `/c/${encodeURIComponent(draft)}`,
      );
    } else expect(f.initial.uIr).not.toHaveBeenCalled();
    hook.dispose();
  });

  it("restores Start Voice after leaving Chat, returning, and native composer replacement", async () => {
    vi.useFakeTimers();
    const f = installFixture();
    const hook = installNativeChatVoiceHook(f);
    await vi.advanceTimersByTimeAsync(0);
    const firstButton = f.parent.append.mock.calls[0]?.[0];
    f.props.isWorkConversation = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(hook.status).toBe("pending");
    expect(firstButton.remove).toHaveBeenCalledOnce();
    expect(f.browserEnabled()).toBe(false);
    f.props.isWorkConversation = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(hook.status).toBe("active");
    expect(f.browserEnabled()).toBe(true);
    expect(f.parent.append).toHaveBeenCalledTimes(2);
    Object.assign(f.composer, { contains: () => false });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.parent.append).toHaveBeenCalledTimes(3);
    expect(f.createRoot).toHaveBeenCalledTimes(2);
    expect(f.start).not.toHaveBeenCalled();
    f.start.mockImplementation(async () => {
      f.setActive(true);
      return undefined;
    });
    await hook.start();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.initial.uIr).not.toHaveBeenCalled();
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
    expect(next.parent.append).toHaveBeenCalledOnce();
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
    f.owner.dependencies.firstContext.next.memoizedValue = nextChain;
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
    expect(f.initial.uIr).not.toHaveBeenCalled();
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
