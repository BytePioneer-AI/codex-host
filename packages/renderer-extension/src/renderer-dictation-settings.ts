import { hooks, replayVoiceCapability } from "./renderer-voice-capability.js";

type Atom = Parameters<typeof replayVoiceCapability>[1];
type Store = Parameters<typeof replayVoiceCapability>[0];
type Value = Record<string, unknown>;
type Mode = "os-global" | "app" | null;
interface Subscriber {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
  createRender?(): unknown;
}
interface Instance {
  getSnapshot(): unknown;
}
const record = (value: unknown): value is Value => value !== null && typeof value === "object";
const mode = (value: unknown): value is Mode =>
  value === null || value === "os-global" || value === "app";

/** Preserve the native platform selector, replaying only proven dictation capabilities. */
export function replayDictationSettingsMode(
  store: Store,
  atom: Atom,
  capabilities: readonly Atom[],
  gate: Atom,
): Mode | undefined {
  try {
    const native = store.get(atom);
    if (atom.write || !mode(native)) return;
    const replacements = new Map(
      capabilities.map((capability) => [
        capability,
        replayVoiceCapability(store, capability, gate),
      ]),
    );
    const evaluate = (override: boolean) => {
      let remaining = 512;
      let hits = 0;
      const visiting = new Set<Atom>();
      const read = (dependency: Atom): unknown => {
        if (--remaining < 0) throw new Error("Dictation Settings dependency limit");
        const value = store.get(dependency);
        if (replacements.has(dependency)) {
          hits += 1;
          const projected = replacements.get(dependency);
          return override && projected?.isCapable ? projected : value;
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
    const before = evaluate(false),
      after = evaluate(true);
    return before.hits > 0 && before.value === native && after.hits > 0 && mode(after.value)
      ? after.value
      : undefined;
  } catch {
    return;
  }
}

/** Bind all exact mode readers within Settings, including newly mounted shortcut
 * controls. The native mode chooses the OS service used by their save handlers.
 */
export function bindDictationSettingsMode(
  currentFibers: () => Set<Value>,
  store: Store,
  atom: Atom,
  capabilities: readonly Atom[],
  gate: Atom,
  allowed: () => boolean,
): { current(): boolean; dispose(): void } {
  const readers = () =>
    [...currentFibers()].flatMap(hooks).filter((hook) => {
      const [subscriber, deps] = Array.isArray(hook.memoizedState) ? hook.memoizedState : [];
      return (
        record(subscriber) &&
        typeof subscriber.getSnapshot === "function" &&
        Array.isArray(deps) &&
        deps.length === 2 &&
        deps[0] === store &&
        deps[1] === atom
      );
    });
  const subscriptions = readers();
  if (
    !subscriptions.length ||
    replayDictationSettingsMode(store, atom, capabilities, gate) === undefined
  )
    throw new Error("Native Settings dictation mode unavailable");
  const restores: (() => void)[] = [];
  const bindings: { subscriber: Subscriber; instance: Instance }[] = [];
  try {
    for (const hook of subscriptions) {
      const subscriber = (hook.memoizedState as unknown[])[0] as Subscriber;
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
        throw new Error("Unsupported Settings dictation mode subscription");
      for (const [object, key] of [
        [store, "sub"],
        [subscriber, "getSnapshot"],
        [instance, "getSnapshot"],
      ] as const)
        if (Object.getOwnPropertyDescriptor(object, key)?.writable !== true)
          throw new Error("Dictation Settings reader is not writable");
      const sub = store.sub;
      let notify: (() => void) | undefined;
      try {
        store.sub = (selected, listener) => {
          if (selected !== atom || notify)
            throw new Error("Unexpected dictation Settings subscription");
          notify = listener;
          return () => {};
        };
        effect.create();
      } finally {
        store.sub = sub;
      }
      if (!notify) throw new Error("Dictation Settings listener unavailable");
      const original = subscriber.getSnapshot,
        originalInstance = instance.getSnapshot;
      const snapshot = () => {
        if (allowed()) {
          const projected = replayDictationSettingsMode(store, atom, capabilities, gate);
          if (projected !== undefined) return projected;
        }
        return original.call(subscriber);
      };
      subscriber.getSnapshot = snapshot;
      instance.getSnapshot = snapshot;
      const onChange = notify;
      restores.push(() => {
        if (subscriber.getSnapshot === snapshot) subscriber.getSnapshot = original;
        if (instance.getSnapshot === snapshot) instance.getSnapshot = originalInstance;
        onChange();
      });
      bindings.push({ subscriber, instance });
      onChange();
    }
  } catch (error) {
    for (const restore of restores.reverse()) restore();
    throw error;
  }
  return {
    current() {
      try {
        const current = readers();
        return (
          restores.length > 0 &&
          current.length === bindings.length &&
          bindings.every(({ subscriber, instance }) => {
            const expected = subscriber.getSnapshot();
            return (
              mode(expected) &&
              instance.getSnapshot() === expected &&
              current.some(
                (hook) =>
                  (hook.memoizedState as unknown[])[0] === subscriber &&
                  hook.next?.queue === instance &&
                  hook.next.memoizedState === expected,
              )
            );
          })
        );
      } catch {
        return false;
      }
    },
    dispose() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
}
