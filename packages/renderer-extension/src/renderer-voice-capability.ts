import { selectVoiceAssets, supportsVoiceVersion } from "./renderer-voice-assets.js";
import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import { CLIENT_OWNED_VOICE_ASSETS, isWorkComposerSurface } from "./renderer-client-owned-voice.js";
import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-hook.js";
import {
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
  voiceGatewayIsReady,
} from "./renderer-cpa-live-voice-preference.js";

const GLOBAL = "__codexhostVoiceCapabilityV1";
export const INFERENCE_GATE = "3683713372";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object";
type Atom = { read(get: (atom: Atom) => unknown): unknown; write?: unknown };
type Store = { get(atom: Atom): unknown; sub(atom: Atom, listener: () => void): () => void };
interface Subscriber {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
  createRender?(): unknown;
}
interface Signal {
  atom: Atom;
  store: Store;
}
interface Instance {
  getSnapshot(): unknown;
}
interface Hook {
  memoizedState?: unknown;
  queue?: unknown;
  next?: Hook | null;
}
interface ScopeNode {
  store: Store;
  familyBindings: Map<Family, Map<string, { cacheKey: unknown }>>;
}
interface Family {
  scope: { id: unknown };
  resolve(node: ScopeNode, chain: Map<unknown, unknown>, parameter: string): { atom: Atom };
}
type Capability = { isLoading: boolean; isError: boolean; isCapable: boolean };
const capable = (value: unknown): value is Capability =>
  record(value) &&
  typeof value.isLoading === "boolean" &&
  typeof value.isError === "boolean" &&
  typeof value.isCapable === "boolean";
const equal = (a: Capability, b: Capability) =>
  a.isLoading === b.isLoading && a.isError === b.isError && a.isCapable === b.isCapable;

/** Replay readonly dependencies for one owned subscription. The inference rollout
 * is omitted only in this evaluation; native atoms, provider config and Statsig
 * retain their values. Writable state and self-reading leaves remain native.
 * This path never writes `model_provider` and never flips Statsig gate 3683713372.
 */
export function replayVoiceCapability(store: Store, atom: Atom, gate: Atom): Capability | null {
  const evaluate = (override: boolean) => {
    const visiting = new Set<Atom>();
    let remaining = 512;
    let hits = 0;
    const read = (dependency: Atom): unknown => {
      if (--remaining < 0) throw new Error("Voice capability dependency limit");
      const value = store.get(dependency);
      if (dependency === gate) {
        hits += 1;
        if (typeof value !== "boolean") throw new Error("Voice inference gate unavailable");
        return override ? false : value;
      }
      if (dependency.write || visiting.has(dependency)) return value;
      if (typeof dependency.read !== "function") throw new Error("Voice dependency unavailable");
      visiting.add(dependency);
      try {
        return dependency.read(read);
      } finally {
        visiting.delete(dependency);
      }
    };
    return { value: read(atom), hits };
  };
  try {
    const native = store.get(atom);
    if (!capable(native) || native.isLoading || native.isError) return null;
    const before = evaluate(false);
    if (!capable(before.value) || !equal(native, before.value)) return null;
    const after = evaluate(true);
    return after.hits > 0 && capable(after.value) && !after.value.isLoading && !after.value.isError
      ? after.value
      : null;
  } catch {
    return null;
  }
}

function isFamily(value: unknown): value is Family {
  return record(value) && record(value.scope) && typeof value.resolve === "function";
}

/** Family.resolve accepts arbitrary keys, so probing unrelated families cannot
 * identify the inference gate. Only the selected asset profile owns these exports.
 */
export function initializeVoiceCapabilityFamilies(
  module: RecordValue,
  assets: { capabilityInit: string; capabilityFamily: string; inferenceGateFamily: string },
): { family: Family; gates: Family } {
  const initialize = module[assets.capabilityInit];
  if (typeof initialize !== "function") throw new Error("Voice capability initializer unavailable");
  initialize();
  const family = module[assets.capabilityFamily];
  const gates = module[assets.inferenceGateFamily];
  if (!isFamily(family) || !isFamily(gates))
    throw new Error("Voice capability families unavailable");
  return { family, gates };
}

export function hooks(fiber: RecordValue): Hook[] {
  const result: Hook[] = [];
  const seen = new Set<unknown>();
  let hook = fiber.memoizedState;
  while (record(hook) && result.length < 4096 && !seen.has(hook)) {
    seen.add(hook);
    result.push(hook as Hook);
    hook = hook.next;
  }
  return hook == null ? result : [];
}

function composerFibers(composer: Element, chat = false): Set<RecordValue> {
  const fibers = new Set<RecordValue>();
  const rootKey = Object.getOwnPropertyNames(composer).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  const ancestors = rootKey
    ? committedReactAncestors(Object.getOwnPropertyDescriptor(composer, rootKey)?.value)
    : [];
  let root = ancestors[0];
  if (chat) {
    // Chat's native realtime hook lives on the form's owning component.
    const owners = ancestors.filter(
      ({ memoizedProps: props }) =>
        record(props) &&
        props.isWorkConversation === false &&
        props.isTemporaryChat === false &&
        props.shouldBlockExternalEgress === false &&
        props.readOnly !== true &&
        typeof props.conversationId === "string" &&
        record(props.composerSelectionContext) &&
        props.composerSelectionContext.conversationId === props.conversationId,
    );
    if (owners.length !== 1) return fibers;
    root = owners[0];
  }
  if (!root) return fibers;
  for (const element of [composer, ...composer.querySelectorAll("*")].slice(0, 2048)) {
    const key = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
    if (!key) continue;
    const ancestors = committedReactAncestors(Object.getOwnPropertyDescriptor(element, key)?.value);
    const boundary = ancestors.indexOf(root);
    if (boundary < 0) continue;
    for (const fiber of ancestors.slice(0, boundary + 1)) if (record(fiber)) fibers.add(fiber);
  }
  return fibers;
}

/** The native family memo binds the capability cache key, AppScope chain and
 * signal to the same component's useSyncExternalStore subscription. Only local
 * voice.realtime / voice.thread members within the Composer qualify.
 */
export function bindComposerVoiceCapability(
  composer: Element,
  family: Family,
  gates: Family,
  allowed: () => boolean,
  chat = false,
): { dispose(): void; current(): boolean } {
  return bindVoiceCapabilitySubscriptions(
    () => composerFibers(composer, chat),
    family,
    gates,
    allowed,
  );
}

/** Subscription ownership is supplied by the version-qualified surface owner. */
export function bindVoiceCapabilitySubscriptions(
  currentFibers: () => Set<RecordValue>,
  family: Family,
  gates: Family,
  allowed: () => boolean,
  realtimeOnly = false,
  names: readonly (
    "voice.realtime" | "voice.thread" | "dictation.composer" | "dictation.global"
  )[] = ["voice.realtime", "voice.thread"],
): { dispose(): void; current(): boolean } {
  const fibers = currentFibers();
  const restores: (() => void)[] = [];
  const bindings: { subscriber: Subscriber; signal: Signal; instance: Instance }[] = [];
  try {
    for (const fiber of fibers) {
      const list = hooks(fiber);
      for (const memo of list) {
        const [signal, deps] = Array.isArray(memo.memoizedState) ? memo.memoizedState : [];
        if (
          !record(signal) ||
          !Array.isArray(deps) ||
          deps.length !== 5 ||
          deps[3] !== family ||
          !(deps[1] instanceof Map) ||
          deps[2] !== undefined
        )
          continue;
        const chain = deps[1] as Map<unknown, unknown>;
        const node = chain.get(family.scope.id) as ScopeNode | undefined;
        const members = node?.familyBindings?.get(family);
        if (!node || !(members instanceof Map) || node.store !== signal.store) continue;
        const matches = [...members].filter(([, member]) => member.cacheKey === deps[0]);
        if (matches.length !== 1 || typeof matches[0]?.[0] !== "string") continue;
        const parameter = JSON.parse(matches[0][0]);
        if (
          !record(parameter) ||
          Object.keys(parameter).some((key) => key !== "name" && key !== "hostId") ||
          !names.some((name) => parameter.name === name) ||
          (realtimeOnly && parameter.name !== "voice.realtime") ||
          (parameter.hostId !== undefined && parameter.hostId !== "local") ||
          (parameter.name === "voice.thread" && parameter.hostId !== "local")
        )
          continue;
        const subscriptions = list.filter((hook) => {
          const state = hook.memoizedState;
          return (
            Array.isArray(state) &&
            Array.isArray(state[1]) &&
            state[1].length === 2 &&
            state[1][0] === signal &&
            state[1][1] === undefined &&
            typeof state[0]?.getSnapshot === "function"
          );
        });
        if (subscriptions.length !== 1) throw new Error("Ambiguous voice subscription");
        const hook = subscriptions[0] as Hook;
        const subscriber = (hook.memoizedState as unknown[])[0] as Subscriber;
        const instance = hook.next?.queue as Instance | undefined;
        const effect = hook.next?.next?.memoizedState;
        const store = signal.store as Store;
        const gate = gates.resolve(node, chain, INFERENCE_GATE)?.atom;
        if (
          !gate ||
          !instance ||
          !record(effect) ||
          !Array.isArray(effect.deps) ||
          effect.deps[0] !== subscriber.subscribe ||
          typeof effect.create !== "function" ||
          typeof instance.getSnapshot !== "function" ||
          !capable(store.get(signal.atom as Atom)) ||
          !capable(subscriber.getSnapshot()) ||
          !capable(instance.getSnapshot()) ||
          !equal(
            store.get(signal.atom as Atom) as Capability,
            subscriber.getSnapshot() as Capability,
          ) ||
          !equal(subscriber.getSnapshot() as Capability, instance.getSnapshot() as Capability) ||
          subscriber.createRender?.() != null
        )
          throw new Error("Unsupported voice subscription");
        for (const [object, key] of [
          [store, "sub"],
          [subscriber, "getSnapshot"],
          [instance, "getSnapshot"],
        ] as const)
          if (Object.getOwnPropertyDescriptor(object, key)?.writable !== true)
            throw new Error("Voice subscription is not writable");
        let notify: (() => void) | undefined;
        const sub = store.sub;
        try {
          store.sub = (atom, listener) => {
            if (atom !== signal.atom || notify) throw new Error("Unexpected voice subscription");
            notify = listener;
            return () => {};
          };
          effect.create();
        } finally {
          store.sub = sub;
        }
        if (!notify) throw new Error("Voice listener unavailable");
        const original = subscriber.getSnapshot;
        const originalInstance = instance.getSnapshot;
        let previous: Capability | undefined;
        const snapshot = () => {
          const native = original.call(subscriber);
          if (!allowed()) return native;
          const projected = replayVoiceCapability(store, signal.atom as Atom, gate);
          if (!projected || !projected.isCapable) return native;
          if (!previous || !equal(previous, projected)) previous = projected;
          return previous;
        };
        subscriber.getSnapshot = snapshot;
        instance.getSnapshot = snapshot;
        const onChange = notify;
        restores.push(() => {
          if (subscriber.getSnapshot === snapshot) subscriber.getSnapshot = original;
          if (instance.getSnapshot === snapshot) instance.getSnapshot = originalInstance;
          onChange();
        });
        bindings.push({ subscriber, signal: signal as unknown as Signal, instance });
        onChange();
      }
    }
    if (!restores.length) throw new Error("Owned voice capability unavailable");
    if (realtimeOnly && restores.length !== 1) throw new Error("Ambiguous voice starter");
  } catch (error) {
    for (const restore of restores.reverse()) restore();
    throw error;
  }
  return {
    dispose() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
    current() {
      const current = [...currentFibers()].flatMap(hooks);
      return bindings.every(({ subscriber, signal, instance }) => {
        try {
          const snapshot = subscriber.getSnapshot();
          const instanceSnapshot = instance.getSnapshot();
          if (
            !capable(snapshot) ||
            !capable(instanceSnapshot) ||
            !equal(snapshot, instanceSnapshot)
          )
            return false;
          return current.some((hook) => {
            const committed = hook.next?.memoizedState;
            return (
              Array.isArray(hook.memoizedState) &&
              hook.memoizedState[0] === subscriber &&
              hook.memoizedState[1]?.[0] === signal &&
              hook.next?.queue === instance &&
              capable(committed) &&
              equal(committed, snapshot) &&
              (!realtimeOnly || snapshot.isCapable)
            );
          });
        } catch {
          return false;
        }
      });
    },
  };
}

interface Target {
  [key: string]: unknown;
  document?: Document;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export function installVoiceCapabilityProjection(
  options: {
    target?: Target;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): { status: string; dispose(): void } {
  const target = options.target ?? (globalThis as unknown as Target);
  if (target[GLOBAL]) return target[GLOBAL] as { status: string; dispose(): void };
  const config = readCpaLiveVoiceHookConfig(target);
  if (!config) return { status: "disabled", dispose() {} };
  if (!supportsVoiceVersion(CLIENT_OWNED_VOICE_ASSETS, config.desktopVersion))
    return { status: "unsupported", dispose() {} };
  let timer: ReturnType<typeof setTimeout>;
  let binding: ReturnType<typeof bindComposerVoiceCapability> | undefined;
  let composer: Element | undefined;
  let disposed = false;
  const handle = {
    status: "pending",
    dispose() {
      disposed = true;
      target.clearTimeout(timer);
      binding?.dispose();
      if (target[GLOBAL] === handle) Reflect.deleteProperty(target, GLOBAL);
    },
  };
  target[GLOBAL] = handle;
  const hookActive = (key: string) => {
    const hook = target[key];
    return record(hook) && hook.status === "active";
  };
  const currentRoute = () => {
    try {
      const routing = target.__codexhostHostRoutingV1 as RendererHostRouting | undefined;
      const route = routing?.forComposer();
      return route?.hostId === "local" && routing?.forHost("local") === route ? route : undefined;
    } catch {
      return undefined;
    }
  };
  const external = () => {
    try {
      return currentRoute()?.policy.selectedModel()?.startsWith("codexhost/") === true;
    } catch {
      return false;
    }
  };
  const chatGateway = () =>
    !isWorkComposerSurface(target) && chatLiveVoicePreferenceAllowsOverride(target);
  const allowed = () =>
    !!readCpaLiveVoiceHookConfig(target) &&
    voiceGatewayIsReady(target) &&
    hookActive("__codexhostClientOwnedVoiceV1") &&
    hookActive("__codexhostExternalVoiceLaunchV1") &&
    (chatGateway() ||
      (!!currentRoute() &&
        (isWorkComposerSurface(target) ||
          (external() &&
            target.document?.querySelectorAll("[data-chatgpt-composer]").length === 0)) &&
        (cpaLiveVoicePreferenceAllowsInstall(target) || external())));
  const refresh = async () => {
    if (disposed) return;
    try {
      const names = loadedAssetNames(target.document, target.performance);
      const assets = selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, names, config.desktopVersion);
      if (!assets) {
        handle.status = "unsupported";
      } else if (!allowed()) handle.status = "pending";
      else {
        const module = await (options.importModule ?? ((url) => import(url)))(
          `app://-/assets/${assets.initial}`,
        );
        if (disposed) return;
        const composers = [
          ...(target.document?.querySelectorAll(
            chatGateway() ? "[data-chatgpt-composer]" : "[data-codex-composer-root]",
          ) ?? []),
        ].filter(
          (element) =>
            element.getBoundingClientRect().width > 0 && !element.closest("[hidden], [inert]"),
        );
        if (composers.length !== 1) throw new Error("Voice composer unavailable");
        if (composers[0] !== composer || !binding?.current()) {
          binding?.dispose();
          binding = undefined;
          composer = composers[0];
          const { family, gates } = initializeVoiceCapabilityFamilies(module, assets);
          binding = bindComposerVoiceCapability(
            composer as Element,
            family,
            gates,
            allowed,
            chatGateway(),
          );
        }
        handle.status = "active";
      }
    } catch {
      handle.status = "unsupported";
    }
    if (handle.status !== "active") {
      binding?.dispose();
      binding = undefined;
      composer = undefined;
    }
    if (!disposed) timer = target.setTimeout(() => void refresh(), 1000);
  };
  void refresh();
  return handle;
}
