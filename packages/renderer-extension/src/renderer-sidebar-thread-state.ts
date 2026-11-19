import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

type RecordValue = Record<string, unknown>;
type Atom = { read(get: (atom: Atom) => unknown): unknown };
type Store = {
  get(atom: Atom): unknown;
  sub(atom: Atom, listener: () => void): () => void;
};
type Subscriber = { getSnapshot(): unknown; subscribe(listener: () => void): () => void };
type Instance = { value: unknown; getSnapshot(): unknown };
interface Subscription {
  atom: Atom;
  store: Store;
  subscriber: Subscriber;
  instance: Instance;
  effect(): unknown;
}

const SIDEBAR = "[data-app-action-sidebar-scroll]";
const ROW = "data-app-action-sidebar-thread-row";
const ID = "data-app-action-sidebar-thread-id";
const HOST = "data-app-action-sidebar-thread-host-id";

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hooks(owner: RecordValue): RecordValue[] {
  const result: RecordValue[] = [];
  let hook = owner.memoizedState;
  while (record(hook) && result.length < 4096) {
    result.push(hook);
    hook = hook.next;
  }
  return hook == null ? result : [];
}

function identity(owner: RecordValue): { threadId: string; hostId: string } | null {
  const props = owner.memoizedProps;
  if (!record(props) || !record(props.dataAttributes)) return null;
  const { conversationId: threadId, hostId, dataAttributes: attributes } = props;
  if (
    typeof threadId !== "string" ||
    !threadId ||
    typeof hostId !== "string" ||
    !hostId ||
    !(ROW in attributes) ||
    attributes[HOST] !== hostId ||
    (attributes[ID] !== threadId && attributes[ID] !== `${hostId}:${threadId}`)
  )
    return null;
  return { threadId, hostId };
}

function subscription(hook: RecordValue): Subscription | null {
  const memo = hook.memoizedState;
  if (!Array.isArray(memo) || !Array.isArray(memo[1])) return null;
  const [subscriber, deps] = memo;
  const signal = deps[0];
  const next = hook.next;
  const instance = record(next) ? next.queue : null;
  const effectHook = record(next) ? next.next : null;
  const effect = record(effectHook) ? effectHook.memoizedState : null;
  if (
    deps.length !== 2 ||
    deps[1] !== undefined ||
    !record(signal) ||
    typeof signal.get !== "function" ||
    typeof signal.subscribe !== "function" ||
    !record(signal.atom) ||
    typeof signal.atom.read !== "function" ||
    "write" in signal.atom ||
    !record(signal.store) ||
    typeof signal.store.get !== "function" ||
    typeof signal.store.sub !== "function" ||
    !record(subscriber) ||
    typeof subscriber.getSnapshot !== "function" ||
    typeof subscriber.subscribe !== "function" ||
    !record(instance) ||
    typeof instance.getSnapshot !== "function" ||
    !record(effect) ||
    typeof effect.create !== "function" ||
    !Array.isArray(effect.deps) ||
    effect.deps[0] !== subscriber.subscribe
  )
    return null;
  return {
    atom: signal.atom as Atom,
    store: signal.store as Store,
    subscriber: subscriber as Subscriber,
    instance: instance as Instance,
    effect: effect.create as () => unknown,
  };
}

export interface SidebarThreadStateRepair {
  isBound(owner: RecordValue): boolean;
  dispose(): void;
}

/** Repair only a proven stale null selector for an external sidebar row. The
 * fresh readonly atom evaluates Desktop's own query and subscribes to its current
 * dependencies. No Thread state, titles, ordering or archive filters are written.
 */
export function repairSidebarThreadState(owner: unknown): SidebarThreadStateRepair | null {
  if (!record(owner)) return null;
  const key = identity(owner);
  if (!key) return null;
  const candidates: Subscription[] = [];
  try {
    for (const hook of hooks(owner)) {
      const candidate = subscription(hook);
      if (!candidate) continue;
      const { atom, store, subscriber, instance } = candidate;
      if (
        instance.value !== null ||
        store.get(atom) !== null ||
        subscriber.getSnapshot() !== null ||
        instance.getSnapshot() !== null
      )
        continue;
      const value = atom.read((dependency) => store.get(dependency));
      if (
        record(value) &&
        record(value.summary) &&
        value.summary.modelProvider === "codexhost" &&
        value.summary.conversationId === key.threadId &&
        value.summary.hostId === key.hostId &&
        Array.isArray(value.requests) &&
        typeof value.resumeState === "string"
      )
        candidates.push(candidate);
    }
  } catch {
    return null;
  }
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate) return null;
  const { atom, store, subscriber, instance, effect } = candidate;
  for (const [target, name] of [
    [store, "sub"],
    [subscriber, "getSnapshot"],
    [instance, "getSnapshot"],
  ] as const) {
    if (Object.getOwnPropertyDescriptor(target, name)?.writable !== true) return null;
  }
  const originalSub = store.sub;
  let notify: (() => void) | undefined;
  // Capture React's existing store-change callback without adding another
  // subscription to the stale atom (the same binding contract as the usage gate).
  try {
    store.sub = (candidate, listener) => {
      if (candidate !== atom || notify) throw new Error("Unexpected sidebar state subscription");
      notify = listener;
      return () => {};
    };
    effect();
  } catch {
    return null;
  } finally {
    store.sub = originalSub;
  }
  if (!notify) return null;
  const onChange = notify;
  const fresh: Atom = { read: (get) => atom.read(get) };
  const getSnapshot = () => store.get(fresh);
  const original = subscriber.getSnapshot;
  const originalInstance = instance.getSnapshot;
  let unsubscribe = () => {};
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (subscriber.getSnapshot === getSnapshot) subscriber.getSnapshot = original;
    if (instance.getSnapshot === getSnapshot) instance.getSnapshot = originalInstance;
  };
  try {
    subscriber.getSnapshot = getSnapshot;
    instance.getSnapshot = getSnapshot;
    unsubscribe = originalSub.call(store, fresh, onChange);
    onChange();
  } catch {
    dispose();
    return null;
  }
  return {
    isBound(current) {
      return (
        instance.getSnapshot === getSnapshot &&
        hooks(current).some((hook) => {
          const candidate = subscription(hook);
          return candidate?.instance === instance && candidate.subscriber === subscriber;
        })
      );
    },
    dispose,
  };
}

/** Includes rows that render null and therefore have no row DOM element. */
function sidebarOwners(root: ParentNode): Set<RecordValue> {
  const owners = new Set<RecordValue>();
  for (const element of root.querySelectorAll(SIDEBAR)) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    const first =
      key && committedReactAncestors(Object.getOwnPropertyDescriptor(element, key)?.value)[0];
    if (!first) continue;
    const stack = [first];
    const seen = new Set<RecordValue>();
    while (stack.length && seen.size < 200_000) {
      const fiber = stack.pop();
      if (!fiber) break;
      if (seen.has(fiber)) return new Set();
      seen.add(fiber);
      if (identity(fiber)) owners.add(fiber);
      if (fiber !== first && record(fiber.sibling)) stack.push(fiber.sibling);
      if (record(fiber.child)) stack.push(fiber.child);
    }
    if (stack.length) return new Set();
  }
  return owners;
}

export function createRendererSidebarThreadState(root: ParentNode) {
  const repairs = new Map<RecordValue, SidebarThreadStateRepair>();
  return {
    refresh() {
      const owners = sidebarOwners(root);
      for (const [owner, repair] of repairs) {
        const current = owners.has(owner)
          ? owner
          : record(owner.alternate) && owners.has(owner.alternate)
            ? owner.alternate
            : null;
        if (current && repair.isBound(current)) owners.delete(current);
        else {
          repair.dispose();
          repairs.delete(owner);
        }
      }
      for (const owner of owners) {
        const repair = repairSidebarThreadState(owner);
        if (repair) repairs.set(owner, repair);
      }
    },
    dispose() {
      for (const repair of repairs.values()) repair.dispose();
      repairs.clear();
    },
  };
}

export function installRendererSidebarThreadState(root: Document = document) {
  const control = createRendererSidebarThreadState(root);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      control.refresh();
    }, 0);
  };
  const observer = new MutationObserver((mutations) => {
    if (
      mutations.some((mutation) => {
        const element = mutation.target as Element;
        if (element.closest?.(SIDEBAR)) return true;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) =>
            node instanceof Element && (node.matches(SIDEBAR) || node.querySelector(SIDEBAR)),
        );
      })
    )
      schedule();
  });
  observer.observe(root.documentElement, { childList: true, subtree: true });
  control.refresh();
  return {
    dispose() {
      observer.disconnect();
      clearTimeout(timer);
      control.dispose();
    },
  };
}
