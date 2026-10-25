import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import { hooks, replayVoiceCapability } from "./renderer-voice-capability.js";

type Value = Record<string, unknown>;
type Store = Parameters<typeof replayVoiceCapability>[0];
type Atom = Parameters<typeof replayVoiceCapability>[1];
interface Hook {
  memoizedState?: unknown;
  next?: Hook | null;
  queue?: unknown;
}
interface Subscriber {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
  createRender?(): unknown;
}
interface Instance {
  getSnapshot(): unknown;
}
interface Scope {
  scope: unknown;
  node: { store: Store };
  chain: Map<unknown, unknown>;
  get(selector: unknown, argument?: unknown): unknown;
}
const record = (value: unknown): value is Value => value !== null && typeof value === "object";

/** Settings groups and their exported page, never AppScope siblings or composers. */
export function voiceSettingsSurface(
  doc: Document,
  page: unknown,
  appScope: { id: unknown },
): { scope: Scope; fibers: Set<Value> } | undefined {
  const pages = new Set<Value>();
  const fibers = new Set<Value>();
  const elements = new Set<Element>();
  for (const section of doc.querySelectorAll("section")) {
    elements.add(section);
    // Shortcut controls mount their own mode reader beneath the group section.
    for (const control of section.querySelectorAll?.("button,input") ?? []) elements.add(control);
  }
  for (const element of [...elements].slice(0, 512)) {
    const key = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
    const ancestors = committedReactAncestors(
      key && Object.getOwnPropertyDescriptor(element, key)?.value,
    );
    const boundary = ancestors.findIndex((fiber) => fiber.type === page);
    if (boundary < 0) continue;
    pages.add(ancestors[boundary] as Value);
    for (const fiber of ancestors.slice(0, boundary + 1)) fibers.add(fiber);
  }
  if (pages.size !== 1) return;
  const scopes = new Map<unknown, Scope>();
  for (const fiber of fibers)
    for (const hook of hooks(fiber)) {
      const scope = record(hook.memoizedState) ? hook.memoizedState.current : undefined;
      if (
        record(scope) &&
        scope.scope === appScope &&
        record(scope.node) &&
        scope.chain instanceof Map &&
        scope.chain.get(appScope.id) === scope.node &&
        typeof scope.get === "function"
      )
        scopes.set(scope.node, scope as unknown as Scope);
    }
  const scope = [...scopes.values()][0];
  return scopes.size === 1 && scope ? { scope, fibers } : undefined;
}

/** Prove that a readonly boolean derives from this exact realtime capability.
 * Replaying with the native value must agree before substituting its projection.
 */
function availability(store: Store, atom: Atom, voice: Atom, gate: Atom): boolean | undefined {
  const native = store.get(atom);
  const projected = replayVoiceCapability(store, voice, gate);
  if (typeof native !== "boolean" || atom.write || projected?.isCapable !== true) return;
  const evaluate = (override: boolean) => {
    let remaining = 512;
    let hits = 0;
    const visiting = new Set<Atom>();
    const read = (dependency: Atom): unknown => {
      if (--remaining < 0) throw new Error("Settings availability dependency limit");
      const value = store.get(dependency);
      if (dependency === voice) {
        hits += 1;
        return override ? projected : value;
      }
      if (dependency.write || visiting.has(dependency)) return value;
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
    const before = evaluate(false);
    const after = evaluate(true);
    return before.hits > 0 &&
      before.value === native &&
      after.hits > 0 &&
      typeof after.value === "boolean"
      ? after.value
      : undefined;
  } catch {
    return;
  }
}

/** The native group uses a store/atom boolean reader rather than the capability
 * family's signal. Project only its proven dependency on voice.realtime.
 */
export function bindVoiceSettingsAvailability(
  currentFibers: () => Set<Value>,
  store: Store,
  voice: Atom,
  gate: Atom,
  allowed: () => boolean,
): { current(): boolean; dispose(): void } {
  const candidates: { hook: Hook; subscriber: Subscriber; atom: Atom }[] = [];
  for (const fiber of currentFibers())
    for (const hook of hooks(fiber)) {
      const [subscriber, deps] = Array.isArray(hook.memoizedState) ? hook.memoizedState : [];
      if (
        !record(subscriber) ||
        typeof subscriber.getSnapshot !== "function" ||
        !Array.isArray(deps) ||
        deps.length !== 2 ||
        deps[0] !== store ||
        !record(deps[1]) ||
        typeof deps[1].read !== "function"
      )
        continue;
      const atom = deps[1] as Atom;
      if (availability(store, atom, voice, gate) === true)
        candidates.push({ hook, subscriber: subscriber as unknown as Subscriber, atom });
    }
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate)
    throw new Error("Unavailable or ambiguous Settings availability reader");
  const { hook, subscriber, atom } = candidate;
  const instance = hook.next?.queue as Instance | undefined;
  const effect = hook.next?.next?.memoizedState;
  const native = store.get(atom);
  if (
    !instance ||
    typeof instance.getSnapshot !== "function" ||
    !record(effect) ||
    !Array.isArray(effect.deps) ||
    effect.deps.length !== 1 ||
    effect.deps[0] !== subscriber.subscribe ||
    typeof effect.create !== "function" ||
    subscriber.getSnapshot() !== native ||
    instance.getSnapshot() !== native ||
    subscriber.createRender?.() != null
  )
    throw new Error("Unsupported Settings availability subscription");
  for (const [object, key] of [
    [store, "sub"],
    [subscriber, "getSnapshot"],
    [instance, "getSnapshot"],
  ] as const)
    if (Object.getOwnPropertyDescriptor(object, key)?.writable !== true)
      throw new Error("Settings availability reader is not writable");
  let notify: (() => void) | undefined;
  const sub = store.sub;
  try {
    store.sub = (selected, listener) => {
      if (selected !== atom || notify) throw new Error("Unexpected Settings subscription");
      notify = listener;
      return () => {};
    };
    effect.create();
  } finally {
    store.sub = sub;
  }
  if (!notify) throw new Error("Settings availability listener unavailable");
  const original = subscriber.getSnapshot;
  const originalInstance = instance.getSnapshot;
  const snapshot = () =>
    allowed() && availability(store, atom, voice, gate) === true ? true : original.call(subscriber);
  subscriber.getSnapshot = snapshot;
  instance.getSnapshot = snapshot;
  const onChange = notify;
  let disposed = false;
  const binding = {
    current() {
      try {
        const expected = subscriber.getSnapshot();
        return (
          !disposed &&
          expected === true &&
          instance.getSnapshot() === expected &&
          [...currentFibers()]
            .flatMap(hooks)
            .some(
              (current) =>
                current.memoizedState &&
                Array.isArray(current.memoizedState) &&
                current.memoizedState[0] === subscriber &&
                current.memoizedState[1]?.[0] === store &&
                current.memoizedState[1]?.[1] === atom &&
                current.next?.queue === instance &&
                current.next.memoizedState === expected,
            )
        );
      } catch {
        return false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (subscriber.getSnapshot === snapshot) subscriber.getSnapshot = original;
      if (instance.getSnapshot === snapshot) instance.getSnapshot = originalInstance;
      onChange();
    },
  };
  try {
    onChange();
  } catch (error) {
    binding.dispose();
    throw error;
  }
  return binding;
}
