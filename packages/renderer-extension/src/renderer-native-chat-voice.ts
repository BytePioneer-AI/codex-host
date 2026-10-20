import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
  CLIENT_OWNED_VOICE_VERSION,
} from "./renderer-client-owned-voice.js";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import {
  auditedAppInitialAssetPresent,
  loadedAssetNames,
  readCpaLiveVoiceHookConfig,
} from "./renderer-cpa-live-voice-hook.js";
import { nativeChatVoicePreferenceAllowsStart } from "./renderer-cpa-live-voice-preference.js";
import { navigateNativeChatVoiceDraft } from "./renderer-native-chat-voice-navigation.js";

const HOOK_GLOBAL = "__codexhostNativeChatVoiceV1";
const START_ASSET = "start-voice-954090654801.js";
const PREWARM_ASSET = "voice-prewarm-fb2c91219553.js";
const BUTTON = "data-codexhost-chat-voice-start";
const CONVERSATION_UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object";

export interface ChatVoiceScope {
  scope: unknown;
  node: unknown;
  chain: Map<unknown, unknown>;
  get(selector: unknown, argument?: unknown): unknown;
  set(selector: unknown, value: unknown): void;
}
export interface NativeChatVoiceBinding {
  composer: Element;
  props: RecordValue & { conversationId: string };
  scope: ChatVoiceScope;
  context: unknown;
  composerContext: { context: unknown; chain: Map<unknown, unknown> };
  backendConversationId: string | undefined;
}
interface NativeChatVoiceModules {
  scopeDefinition: { id: unknown; __scopeBrand: string };
  backendConversationId: unknown;
  composerScopeDefinition: { id: unknown; __scopeBrand: string };
  draftConversationId: unknown;
}

function scopeRefs(owner: RecordValue, definition: { id: unknown }): Map<unknown, ChatVoiceScope> {
  const scopes = new Map<unknown, ChatVoiceScope>();
  let hook = owner.memoizedState;
  const seen = new Set<unknown>();
  while (record(hook) && seen.size < 4096 && !seen.has(hook)) {
    seen.add(hook);
    const state = hook.memoizedState;
    const scope = record(state) ? state.current : undefined;
    if (
      record(scope) &&
      scope.scope === definition &&
      typeof scope.get === "function" &&
      typeof scope.set === "function" &&
      scope.chain instanceof Map &&
      scope.chain.get(definition.id) === scope.node
    )
      scopes.set(scope.node, scope as unknown as ChatVoiceScope);
    hook = hook.next;
  }
  return hook == null ? scopes : new Map();
}

/** Resolve the current Chat owner from the committed tree, including the AppScope
 * useRef used by native start-voice. A Codex locator or Thread-Id is never a Chat ID.
 */
export function detectNativeChatVoiceBinding(
  composer: Element,
  native: NativeChatVoiceModules,
): NativeChatVoiceBinding | undefined {
  const key = Object.getOwnPropertyNames(composer).find((key) => key.startsWith("__reactFiber$"));
  if (!key) return;
  const ancestors = committedReactAncestors(Object.getOwnPropertyDescriptor(composer, key)?.value);
  for (const owner of ancestors) {
    const props = owner.memoizedProps;
    if (
      !record(props) ||
      typeof props.isWorkConversation !== "boolean" ||
      typeof props.isTemporaryChat !== "boolean" ||
      typeof props.conversationId !== "string"
    )
      continue;
    if (
      props.isWorkConversation ||
      props.isTemporaryChat ||
      props.shouldBlockExternalEgress !== false ||
      props.readOnly === true ||
      !record(props.composerSelectionContext) ||
      props.composerSelectionContext.conversationId !== props.conversationId
    )
      return;
    const scopes = scopeRefs(owner, native.scopeDefinition);
    if (scopes.size !== 1) return;
    const scope = [...scopes.values()][0];
    if (!scope) return;
    const backendId = scope.get(native.backendConversationId, props.conversationId);
    const hasBackendId = typeof backendId === "string" && CONVERSATION_UUID.test(backendId);
    // Native drafts have a local locator until voice or a message creates the Chat.
    // START accepts an absent backend ID and owns conversation creation.
    const isDraft =
      backendId == null &&
      props.conversationId.startsWith("local-chatgpt:") &&
      CONVERSATION_UUID.test(props.conversationId.slice("local-chatgpt:".length));
    if (!hasBackendId && !isDraft) return;
    const draftScopes = new Map<unknown, ChatVoiceScope>();
    if (isDraft)
      for (const fiber of ancestors)
        for (const [node, ref] of scopeRefs(fiber, native.composerScopeDefinition))
          if (ref.chain.get(native.scopeDefinition.id) === scope.node) draftScopes.set(node, ref);
    const contexts = new Set<unknown>();
    let composerContext: NativeChatVoiceBinding["composerContext"] | undefined;
    for (const fiber of ancestors) {
      let dependency = record(fiber.dependencies) ? fiber.dependencies.firstContext : undefined;
      const seenDependencies = new Set<unknown>();
      while (
        record(dependency) &&
        seenDependencies.size < 4096 &&
        !seenDependencies.has(dependency)
      ) {
        seenDependencies.add(dependency);
        const context = dependency.context;
        const chain = dependency.memoizedValue;
        if (
          record(context) &&
          context.displayName === native.scopeDefinition.__scopeBrand &&
          chain instanceof Map &&
          chain.get(native.scopeDefinition.id) === scope.node
        )
          contexts.add(context);
        if (
          !composerContext &&
          record(context) &&
          context.displayName === native.composerScopeDefinition.__scopeBrand &&
          chain instanceof Map &&
          chain.get(native.scopeDefinition.id) === scope.node
        ) {
          const node = chain.get(native.composerScopeDefinition.id);
          if (
            record(node) &&
            record(node.value) &&
            ((node.value.kind === "chatgpt" &&
              record(node.value.chatGptSelectionContext) &&
              node.value.chatGptSelectionContext.conversationId === props.conversationId) ||
              (isDraft &&
                node.value.kind === "new" &&
                native.draftConversationId != null &&
                draftScopes.get(node)?.get(native.draftConversationId) === props.conversationId))
          )
            composerContext = { context, chain };
          else return;
        }
        dependency = dependency.next;
      }
    }
    if (contexts.size !== 1 || !composerContext) return;
    return {
      composer,
      props: props as NativeChatVoiceBinding["props"],
      scope,
      context: [...contexts][0],
      composerContext,
      backendConversationId: hasBackendId ? backendId : undefined,
    };
  }
}

interface ChatVoiceHook {
  readonly activeCall?: boolean;
  status: "disabled" | "pending" | "active" | "unsupported";
  start(): Promise<void>;
  dispose(): void;
}
interface ChatVoiceTarget {
  [key: string]: unknown;
  document?: Document;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/** The Chat service request must not enter the Codex new-thread overlay. */
export function startNativeChatVoiceForRequest(
  request: unknown,
  target: object = globalThis,
): Promise<void> | undefined {
  if (
    !record(request) ||
    request.productExperience !== "chat" ||
    !nativeChatVoicePreferenceAllowsStart(target)
  )
    return;
  const hook = (target as RecordValue)[HOOK_GLOBAL] as ChatVoiceHook | undefined;
  if (!hook || hook.status === "disabled") return;
  return hook.start();
}

/** Desktop browser voice owns serialization, authentication, WM, events and cleanup.
 * Aw enables its dormant runtime; kw mounts VoiceRoom in the native app root. The
 * native cache controller is mounted once per AppScope, not once per selection.
 */
export function installNativeChatVoiceHook(
  options: {
    target?: ChatVoiceTarget;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): ChatVoiceHook {
  const target = options.target ?? (globalThis as unknown as ChatVoiceTarget);
  const existing = target[HOOK_GLOBAL] as ChatVoiceHook | undefined;
  if (existing) return existing;
  const config = readCpaLiveVoiceHookConfig(target);
  const unavailable = (status: "disabled" | "unsupported"): ChatVoiceHook => ({
    status,
    dispose() {},
    start: async () => {
      throw new Error("Native Chat voice is unavailable");
    },
  });
  if (!config) return unavailable("disabled");
  if (config.desktopVersion !== undefined && config.desktopVersion !== CLIENT_OWNED_VOICE_VERSION)
    return unavailable("unsupported");
  const doc = target.document;
  if (!doc) return unavailable("unsupported");
  const importModule = options.importModule ?? ((url: string) => import(url));
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let modules:
    | { initial: RecordValue; shared: RecordValue; start: RecordValue; prewarm: RecordValue }
    | undefined;
  let boundScope: ChatVoiceScope | undefined;
  let mounted:
    { node: unknown; render(binding: NativeChatVoiceBinding): void; dispose(): void } | undefined;
  let button: HTMLButtonElement | undefined;
  const overlayButtons = new Map<HTMLButtonElement, [string, string]>();
  let controller: AbortController | undefined;
  let starting = false;
  let renderFailed = false;
  const started = Date.now();
  const removeButton = () => {
    button?.remove();
    button = undefined;
  };
  const release = () => {
    controller?.abort();
    controller = undefined;
    removeButton();
    for (const [control, [display, priority]] of overlayButtons)
      if (
        control.style.getPropertyValue("display") === "none" &&
        control.style.getPropertyPriority("display") === "important"
      )
        control.style.setProperty("display", display, priority);
    overlayButtons.clear();
    mounted?.dispose();
    mounted = undefined;
    boundScope = undefined;
  };
  const findBinding = () => {
    if (!modules || !nativeChatVoicePreferenceAllowsStart(target)) return;
    const forms = [...doc.querySelectorAll("[data-chatgpt-composer]")].filter(
      (form) => form.getBoundingClientRect().width > 0 && !form.closest("[hidden], [inert]"),
    );
    if (forms.length !== 1) return;
    const form = forms[0];
    if (!form) return;
    return detectNativeChatVoiceBinding(form, {
      scopeDefinition: modules.shared.Cot as NativeChatVoiceModules["scopeDefinition"],
      backendConversationId: modules.initial.pZn,
      draftConversationId: modules.initial.lXt,
      composerScopeDefinition: (
        modules.initial.xAt as { scope: NativeChatVoiceModules["composerScopeDefinition"] }
      ).scope,
    });
  };
  const handle: ChatVoiceHook = {
    get activeCall() {
      if (starting) return true;
      if (!boundScope || !modules || typeof modules.initial.ejn !== "function") return false;
      try {
        return (
          modules.initial.ejn(boundScope) as { getState(): { isVoiceModeActive: boolean } }
        ).getState().isVoiceModeActive;
      } catch {
        return false;
      }
    },
    status: "pending",
    async start() {
      if (disposed || starting) return;
      const current = findBinding();
      if (!current || !modules || current.scope.node !== mounted?.node)
        throw new Error("Select a ChatGPT conversation to start Chat voice");
      starting = true;
      controller = new AbortController();
      const signal = controller.signal;
      const origin = current.scope.get(modules.initial.FFr);
      chatVoiceDebug("native-chat-start", {
        hasConversationId: current.backendConversationId !== undefined,
      });
      try {
        // Xe validates Chat availability, navigation, active sessions and START/RESTART
        // commands, then reads conversation_id via pZn before dispatching START.
        await Reflect.apply(modules.start.n as (...args: unknown[]) => unknown, undefined, [
          current.scope,
          current.props,
          { event_source: "composer" },
          signal,
        ]);
        chatVoiceDebug("native-chat-start-returned");
        try {
          if (
            !disposed &&
            nativeChatVoicePreferenceAllowsStart(target) &&
            (await navigateNativeChatVoiceDraft(
              current,
              modules.initial,
              modules.shared,
              origin,
              signal,
            ))
          )
            chatVoiceDebug("native-chat-draft-selected");
        } catch {
          chatVoiceDebug("native-chat-draft-selection-failed");
        }
      } catch {
        chatVoiceDebug("native-chat-start-failed");
        throw new Error("Native Chat voice could not start");
      } finally {
        starting = false;
      }
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) target.clearTimeout(timer);
      release();
      if (target[HOOK_GLOBAL] === handle) Reflect.deleteProperty(target, HOOK_GLOBAL);
    },
  };
  target[HOOK_GLOBAL] = handle;
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    try {
      if (renderFailed) throw new Error();
      if (!modules) {
        const names = loadedAssetNames(doc, target.performance);
        if (
          !auditedAppInitialAssetPresent(names, CLIENT_OWNED_VOICE_INITIAL_ASSET) ||
          !auditedAppInitialAssetPresent(names, CLIENT_OWNED_VOICE_SHARED_ASSET)
        ) {
          if (Date.now() - started >= 60_000) {
            handle.status = "unsupported";
            return;
          }
          return;
        }
        const [shared, initial, start, prewarm] = await Promise.all(
          [
            CLIENT_OWNED_VOICE_SHARED_ASSET,
            CLIENT_OWNED_VOICE_INITIAL_ASSET,
            START_ASSET,
            PREWARM_ASSET,
          ].map((asset) => importModule(`app://-/assets/${asset}`)),
        );
        if (disposed) return;
        if (
          !shared ||
          !initial ||
          !start ||
          !prewarm ||
          typeof start.t !== "function" ||
          typeof start.n !== "function" ||
          typeof initial.jw !== "function" ||
          typeof initial.ejn !== "function" ||
          typeof initial.uIr !== "function" ||
          typeof shared.xat !== "function" ||
          typeof shared.yzt !== "function" ||
          typeof shared.vMt !== "function" ||
          typeof prewarm.VoiceInstantConnectCacheController !== "function"
        )
          throw new Error();
        initial.jw();
        start.t();
        if (
          !record(shared.Cot) ||
          !initial.pZn ||
          !initial.lXt ||
          !initial.Aw ||
          !initial.FFr ||
          !record(initial.xAt) ||
          !record(initial.xAt.scope)
        )
          throw new Error();
        modules = { shared, initial, start, prewarm };
      }
      const current = findBinding();
      if (!current) {
        if (
          boundScope &&
          typeof modules.initial.ejn === "function" &&
          (
            modules.initial.ejn(boundScope) as { getState(): { isVoiceModeActive: boolean } }
          ).getState().isVoiceModeActive
        )
          return;
        release();
        handle.status = "pending";
        return;
      }
      if (mounted && current.scope.node !== mounted.node) release();
      boundScope = current.scope;
      if (!mounted) {
        const { scope } = current;
        const initial = modules.initial;
        const previous = scope.get(initial.Aw);
        const container = doc.createElement("div");
        container.setAttribute("data-codexhost-chat-voice-prewarm", "");
        doc.body.append(container);
        const react = Reflect.apply(modules.shared.yzt as () => unknown, undefined, []) as {
          createElement(type: unknown, props: unknown, ...children: unknown[]): unknown;
        };
        const reactDom = Reflect.apply(modules.shared.vMt as () => unknown, undefined, []) as {
          createRoot(
            container: Element,
            options: { onUncaughtError(): void },
          ): { render(element: unknown): void; unmount(): void };
        };
        const root = reactDom.createRoot(container, {
          onUncaughtError() {
            renderFailed = true;
          },
        });
        let appChain: Map<unknown, unknown> | undefined;
        let composerChain: Map<unknown, unknown> | undefined;
        mounted = {
          node: scope.node,
          render(next) {
            if (appChain === next.scope.chain && composerChain === next.composerContext.chain)
              return;
            appChain = next.scope.chain;
            composerChain = next.composerContext.chain;
            root.render(
              react.createElement(
                next.context,
                { value: appChain },
                react.createElement(
                  next.composerContext.context,
                  { value: composerChain },
                  react.createElement(modules?.prewarm.VoiceInstantConnectCacheController, null),
                ),
              ),
            );
          },
          dispose() {
            root.unmount();
            container.remove();
            if (scope.get(initial.Aw) === true) scope.set(initial.Aw, previous);
            chatVoiceDebug("native-chat-unbound");
          },
        };
        scope.set(initial.Aw, true);
        chatVoiceDebug("native-chat-bound", {
          hasConversationId: current.backendConversationId !== undefined,
        });
      }
      mounted.render(current);
      if (!button || !current.composer.contains(button)) {
        removeButton();
        const dictate = current.composer.querySelector<HTMLButtonElement>(
          'button[aria-label="Dictate"]',
        );
        if (dictate?.parentElement) {
          button = doc.createElement("button");
          button.type = "button";
          button.className = dictate.className;
          button.setAttribute(BUTTON, "");
          button.setAttribute("aria-label", "Start Voice");
          button.title = "Start Voice";
          button.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 8v4m4-7v10m6-12v14m4-9v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
          button.addEventListener("click", () => {
            void handle.start().catch(() => {
              if (button) button.title = "Chat voice could not start. Try again.";
            });
          });
          dictate.parentElement.append(button);
        }
      }
      if (button)
        // The Codex entry opens onboarding/optimistic launch state before its
        // service RPC. Only the native Chat START control belongs in this composer.
        for (const control of current.composer.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Start new voice chat"], button[aria-label="Start voice chat"]',
        )) {
          if (!overlayButtons.has(control))
            overlayButtons.set(control, [
              control.style.getPropertyValue("display"),
              control.style.getPropertyPriority("display"),
            ]);
          control.style.setProperty("display", "none", "important");
        }
      if (button)
        button.disabled =
          starting ||
          current.props.isStreaming === true ||
          (modules.initial.ejn instanceof Function &&
            (
              modules.initial.ejn(current.scope) as { getState(): { isVoiceModeActive: boolean } }
            ).getState().isVoiceModeActive);
      handle.status = "active";
    } catch {
      release();
      handle.status = "unsupported";
      chatVoiceDebug("native-chat-binding-failed");
      return;
    } finally {
      if (!disposed && handle.status !== "unsupported")
        timer = target.setTimeout(() => void refresh(), 500);
    }
  };
  void refresh();
  return handle;
}
