import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import {
  auditedAppInitialAssetPresent,
  loadedAssetNames,
  readCpaLiveVoiceHookConfig,
} from "./renderer-cpa-live-voice-hook.js";
import { nativeChatVoicePreferenceAllowsStart } from "./renderer-cpa-live-voice-preference.js";
import { observeNativeChatVoiceState } from "./renderer-native-chat-voice-state.js";
import { nativeChatVoiceDraftSelection } from "./renderer-native-chat-voice-selection.js";
import {
  alignNativeChatVoiceButton,
  hideNativeChatVoiceHomeHeadline,
} from "./renderer-native-chat-voice-presentation.js";

const HOOK_GLOBAL = "__codexhostNativeChatVoiceV1";
const NATIVE_CHAT_VOICE_VERSION = "26.1016.61520";
const NATIVE_CHAT_INITIAL_ASSET = "app-initial-c95ddb62696e.js";
const NATIVE_CHAT_SHARED_ASSET = "app-shared-2eda13eb7044.js";
const START_ASSET = "start-voice-18b08f0acdd7.js";
const PREWARM_ASSET = "voice-prewarm-94271e581c1b.js";
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
  appNode: object;
  props: RecordValue & { conversationId: string };
  scope: ChatVoiceScope;
  context: unknown;
  composerContext: { context: unknown; chain: Map<unknown, unknown> };
  backendConversationId: string | undefined;
}
interface NativeChatVoiceModules {
  scopeDefinition: { id: unknown; __scopeBrand: string };
  ownerScopeDefinition: { id: unknown; __scopeBrand: string };
  backendConversationId: unknown;
  composerScopeDefinition: { id: unknown; __scopeBrand: string };
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

/** Resolve the native RouteScope ref and its AppScope/inner ComposerScope chain.
 * A Codex locator or Thread-Id is never a Chat ID.
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
    const scopes = scopeRefs(owner, native.ownerScopeDefinition);
    if (scopes.size !== 1) return;
    const scope = [...scopes.values()][0];
    if (!scope) return;
    const appNode = scope.chain.get(native.scopeDefinition.id);
    if (!record(appNode)) return;
    const backendId = scope.get(native.backendConversationId, props.conversationId);
    const hasBackendId = typeof backendId === "string" && CONVERSATION_UUID.test(backendId);
    // Native drafts have a local locator until voice or a message creates the Chat.
    // START accepts an absent backend ID and owns conversation creation.
    const isDraft =
      backendId == null &&
      props.conversationId.startsWith("local-chatgpt:") &&
      CONVERSATION_UUID.test(props.conversationId.slice("local-chatgpt:".length));
    if (!hasBackendId && !isDraft) return;
    // The owner creates this provider below itself. Its own subscriptions can
    // still consume the outer home/new ComposerScope, which does not own the form.
    const provider = ancestors
      .slice(0, ancestors.indexOf(owner))
      .find(
        (fiber) =>
          fiber.tag === 10 &&
          record(fiber.type) &&
          fiber.type.displayName === native.composerScopeDefinition.__scopeBrand,
      );
    if (!provider) return;
    const composerChain = record(provider.memoizedProps) ? provider.memoizedProps.value : undefined;
    const composerNode =
      composerChain instanceof Map
        ? composerChain.get(native.composerScopeDefinition.id)
        : undefined;
    if (
      !(composerChain instanceof Map) ||
      composerChain.get(native.scopeDefinition.id) !== appNode ||
      composerChain.get(native.ownerScopeDefinition.id) !== scope.node ||
      !record(composerNode) ||
      composerNode.token !== native.composerScopeDefinition ||
      !record(composerNode.value) ||
      composerNode.value.kind !== "chatgpt" ||
      !record(composerNode.value.chatGptSelectionContext) ||
      composerNode.value.chatGptSelectionContext.conversationId !== props.conversationId
    )
      return;
    const composerContext = { context: provider.type, chain: composerChain };
    const contexts = new Set<unknown>();
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
          chain.get(native.scopeDefinition.id) === appNode
        )
          contexts.add(context);
        dependency = dependency.next;
      }
    }
    if (contexts.size !== 1) return;
    return {
      composer,
      appNode,
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
  if (!hook || hook.status === "disabled" || hook.status === "unsupported")
    return Promise.reject(new Error("Native Chat voice is unavailable"));
  return hook.start();
}

/** Desktop browser voice owns serialization, authentication, WM, events and cleanup.
 * aT enables its dormant runtime and native VoiceRoom in the app root. The
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
  if (config.desktopVersion !== undefined && config.desktopVersion !== NATIVE_CHAT_VOICE_VERSION)
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
  let selectDraft: (() => void) | undefined;
  let restoreHeadline: (() => void) | undefined;
  let renderFailed = false;
  const started = Date.now();
  const showHeadline = () => {
    restoreHeadline?.();
    restoreHeadline = undefined;
  };
  const removeButton = () => {
    button?.remove();
    button = undefined;
    for (const [control, [display, priority]] of overlayButtons)
      if (
        control.style.getPropertyValue("display") === "none" &&
        control.style.getPropertyPriority("display") === "important"
      )
        control.style.setProperty("display", display, priority);
    overlayButtons.clear();
  };
  const release = () => {
    showHeadline();
    selectDraft = undefined;
    controller?.abort();
    controller = undefined;
    removeButton();
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
      scopeDefinition: modules.shared.Qst as NativeChatVoiceModules["scopeDefinition"],
      ownerScopeDefinition: modules.initial.MOr as NativeChatVoiceModules["ownerScopeDefinition"],
      backendConversationId: modules.initial.B1n,
      composerScopeDefinition: modules.initial
        .CDr as NativeChatVoiceModules["composerScopeDefinition"],
    });
  };
  const handle: ChatVoiceHook = {
    get activeCall() {
      if (starting) return true;
      if (!boundScope || !modules || typeof modules.initial.SPn !== "function") return false;
      try {
        return (
          modules.initial.SPn(boundScope) as { getState(): { isVoiceModeActive: boolean } }
        ).getState().isVoiceModeActive;
      } catch {
        return false;
      }
    },
    status: "pending",
    async start() {
      if (disposed || starting) return;
      const current = findBinding();
      if (!current || !modules || current.appNode !== mounted?.node)
        throw new Error("Select a ChatGPT conversation to start Chat voice");
      starting = true;
      controller = new AbortController();
      const signal = controller.signal;
      let origin: unknown;
      try {
        if (modules.initial.Ycr != null) origin = current.scope.get(modules.initial.Ycr);
      } catch {
        chatVoiceDebug("native-chat-selection-failed");
      }
      selectDraft = undefined;
      chatVoiceDebug("native-chat-start", {
        hasConversationId: current.backendConversationId !== undefined,
      });
      try {
        // Native start validates availability, navigation, active sessions and START/RESTART
        // commands, then reads conversation_id via B1n before dispatching START.
        await Reflect.apply(modules.start.n as (...args: unknown[]) => unknown, undefined, [
          current.scope,
          current.props,
          { event_source: "composer" },
          signal,
        ]);
        chatVoiceDebug("native-chat-start-returned");
        try {
          selectDraft = nativeChatVoiceDraftSelection(
            current,
            modules.initial,
            modules.shared,
            origin,
            signal,
          );
          selectDraft();
        } catch {
          chatVoiceDebug("native-chat-selection-failed");
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
          !auditedAppInitialAssetPresent(names, NATIVE_CHAT_INITIAL_ASSET) ||
          !auditedAppInitialAssetPresent(names, NATIVE_CHAT_SHARED_ASSET)
        ) {
          if (Date.now() - started >= 60_000) {
            handle.status = "unsupported";
            return;
          }
          return;
        }
        const [shared, initial, start, prewarm] = await Promise.all(
          [NATIVE_CHAT_SHARED_ASSET, NATIVE_CHAT_INITIAL_ASSET, START_ASSET, PREWARM_ASSET].map(
            (asset) => importModule(`app://-/assets/${asset}`),
          ),
        );
        if (disposed) return;
        if (
          !shared ||
          !initial ||
          !start ||
          !prewarm ||
          typeof start.t !== "function" ||
          typeof start.n !== "function" ||
          typeof initial.oT !== "function" ||
          typeof initial.SPn !== "function" ||
          typeof shared.FBt !== "function" ||
          typeof shared.PNt !== "function" ||
          typeof prewarm.VoiceInstantConnectCacheController !== "function"
        )
          throw new Error();
        initial.oT();
        start.t();
        if (
          !record(shared.Qst) ||
          !record(initial.MOr) ||
          !initial.B1n ||
          !initial.aT ||
          !record(initial.CDr)
        )
          throw new Error();
        modules = { shared, initial, start, prewarm };
      }
      const current = findBinding();
      selectDraft?.();
      if (!current) {
        showHeadline();
        if (handle.activeCall) return;
        release();
        handle.status = "pending";
        return;
      }
      if (mounted && current.appNode !== mounted.node) release();
      boundScope = current.scope;
      if (!mounted) {
        const { scope } = current;
        const initial = modules.initial;
        const previous = scope.get(initial.aT);
        const container = doc.createElement("div");
        container.setAttribute("data-codexhost-chat-voice-prewarm", "");
        doc.body.append(container);
        const react = Reflect.apply(modules.shared.FBt as () => unknown, undefined, []) as {
          createElement(type: unknown, props: unknown, ...children: unknown[]): unknown;
        };
        const reactDom = Reflect.apply(modules.shared.PNt as () => unknown, undefined, []) as {
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
        const stopObserving = observeNativeChatVoiceState(scope, initial);
        let appChain: Map<unknown, unknown> | undefined;
        let composerChain: Map<unknown, unknown> | undefined;
        mounted = {
          node: current.appNode,
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
            stopObserving();
            root.unmount();
            container.remove();
            if (scope.get(initial.aT) === true) scope.set(initial.aT, previous);
            chatVoiceDebug("native-chat-unbound");
          },
        };
        scope.set(initial.aT, true);
        chatVoiceDebug("native-chat-bound", {
          hasConversationId: current.backendConversationId !== undefined,
        });
      }
      mounted.render(current);
      const voiceState = (
        Reflect.apply(modules.initial.SPn as (...args: unknown[]) => unknown, undefined, [
          current.scope,
        ]) as {
          getState(): {
            isVoiceModeActive: boolean;
            isWorkMode: boolean;
            conversationId: unknown;
          };
        }
      ).getState();
      if (
        current.props.conversationId.startsWith("local-chatgpt:") &&
        voiceState.isVoiceModeActive &&
        voiceState.isWorkMode === false &&
        voiceState.conversationId === current.props.conversationId
      )
        restoreHeadline ??= hideNativeChatVoiceHomeHeadline(doc);
      else showHeadline();
      const sends = [
        ...current.composer.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
      ].filter(
        (control) =>
          control.getBoundingClientRect().width > 0 && !control.closest("[hidden], [inert]"),
      );
      const send = sends.length === 1 ? sends[0] : undefined;
      if (!send?.parentElement) removeButton();
      else {
        if (!button || !current.composer.contains(button)) {
          removeButton();
          button = doc.createElement("button");
          button.type = "button";
          button.setAttribute(BUTTON, "");
          button.setAttribute("aria-label", "Start Voice");
          button.title = "Start Voice";
          button.innerHTML =
            '<svg class="icon-primary-action text-composer-primary" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 8v4m4-7v10m6-12v14m4-9v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
          button.addEventListener("click", () => {
            void handle.start().catch(() => {
              if (button) button.title = "Chat voice could not start. Try again.";
            });
          });
        }
        if (button.nextElementSibling !== send) send.parentElement.insertBefore(button, send);
        alignNativeChatVoiceButton(button, send, doc);
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
      if (button && send) {
        button.disabled =
          starting || current.props.isStreaming === true || voiceState.isVoiceModeActive;
        // Empty Send is disabled independently of whether voice can start.
        const className = [
          ...send.className
            .split(/\s+/)
            .filter((name) => name !== "opacity-50" && name !== "cursor-default"),
          ...(button.disabled ? ["opacity-50", "cursor-default"] : []),
        ].join(" ");
        if (button.className !== className) button.className = className;
      }
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
