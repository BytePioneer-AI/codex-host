import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

type RecordValue = Record<string, unknown>;
type Atom = { read(get: (atom: Atom) => unknown): unknown };
type Store = {
  get(atom: Atom): unknown;
  sub(atom: Atom, listener: () => void): () => void;
};
type Subscriber = {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
  createRender?: () => unknown;
};
type Hook = { memoizedState?: unknown; queue?: unknown; next?: Hook | null };
interface Subscription {
  subscriber: Subscriber;
  store: Store;
  atom: Atom;
  instance: { value: unknown; getSnapshot(): unknown };
  effect: { create(): unknown; deps: unknown[] };
}
type GateKind = "account" | "reserve";

const MAX_HOOKS = 4096;
const EDITOR = '[contenteditable="true"][role="textbox"]';

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hooks(owner: RecordValue): Hook[] {
  const result: Hook[] = [];
  const seen = new Set<Hook>();
  let hook = owner.memoizedState;
  while (record(hook) && result.length < MAX_HOOKS) {
    if (seen.has(hook)) return [];
    seen.add(hook);
    result.push(hook);
    hook = hook.next;
  }
  return hook == null ? result : [];
}

function ownerFor(composer: Element): RecordValue | null {
  let element: Element | null = composer.matches(EDITOR)
    ? composer
    : composer.querySelector(EDITOR);
  for (let depth = 0; element && depth < 12; depth += 1, element = element.parentElement) {
    const key = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
    if (!key) continue;
    const owners = committedReactAncestors(
      Object.getOwnPropertyDescriptor(element, key)?.value,
    ).filter(
      ({ memoizedProps: props }) =>
        record(props) &&
        record(props.composerController) &&
        "onLocalSubmitStart" in props &&
        typeof props.submitDisabled === "boolean",
    );
    return owners.length === 1 ? (owners[0] ?? null) : null;
  }
  return null;
}

function subscription(hook: Hook): Subscription | null {
  const memo = hook.memoizedState;
  if (!Array.isArray(memo) || !Array.isArray(memo[1])) return null;
  const subscriber = memo[0];
  const [store, atom] = memo[1];
  const instance = hook.next?.queue;
  const effect = hook.next?.next?.memoizedState;
  if (
    !record(subscriber) ||
    typeof subscriber.getSnapshot !== "function" ||
    typeof subscriber.subscribe !== "function" ||
    !record(store) ||
    typeof store.get !== "function" ||
    typeof store.sub !== "function" ||
    !record(atom) ||
    typeof atom.read !== "function" ||
    "write" in atom ||
    !record(instance) ||
    typeof instance.value !== "boolean" ||
    instance.getSnapshot !== subscriber.getSnapshot ||
    !record(effect) ||
    typeof effect.create !== "function" ||
    !Array.isArray(effect.deps) ||
    effect.deps.length !== 1 ||
    effect.deps[0] !== subscriber.subscribe
  )
    return null;
  return { subscriber, store, atom, instance, effect } as unknown as Subscription;
}

/** Read-only selector probe. Never writes Accounts, query results or atoms. The
 * selected fields, not minified names or hook positions, identify the two gates.
 * Copies are used as Proxy targets because native snapshots may be frozen. */
function gateKind(binding: Subscription): GateKind | null {
  const { subscriber, store, atom } = binding;
  const observed = new Set<string>();
  const trace = (value: RecordValue, prefix: string): RecordValue =>
    new Proxy(
      { ...value },
      {
        get(target, property, receiver) {
          if (typeof property === "string") observed.add(`${prefix}.${property}`);
          return Reflect.get(target, property, receiver);
        },
      },
    );
  try {
    const native = store.get(atom);
    if (
      typeof native !== "boolean" ||
      typeof subscriber.getSnapshot() !== "boolean" ||
      subscriber.createRender?.() != null
    )
      return null;
    const computed = atom.read((dependency) => {
      const value = store.get(dependency);
      if (!record(value)) return value;
      if (["active", "eligible", "hardBlocked"].every((key) => typeof value[key] === "boolean")) {
        return trace(value, "reserve");
      }
      if ("authMethod" in value && "authenticatedAccountId" in value && "userId" in value) {
        return trace(value, "auth");
      }
      if (record(value.data) && record(value.data.rate_limit)) {
        return {
          ...value,
          data: trace(
            { ...value.data, rate_limit: trace(value.data.rate_limit, "limit") },
            "usage",
          ),
        };
      }
      return value;
    });
    if (computed !== native) return null;
    if (observed.has("reserve.hardBlocked") && !observed.has("reserve.active")) return "reserve";
    if (
      observed.has("auth.authMethod") &&
      observed.has("auth.authenticatedAccountId") &&
      observed.has("usage.plan_type") &&
      observed.has("limit.allowed")
    )
      return "account";
  } catch {
    // Unknown native contracts must not turn into an unconditional unblock.
  }
  return null;
}

function discover(owner: RecordValue): Subscription[] | null {
  const found = new Map<GateKind, Subscription>();
  for (const hook of hooks(owner)) {
    const candidate = subscription(hook);
    if (!candidate) continue;
    const kind = gateKind(candidate);
    if (!kind) continue;
    if (found.has(kind)) return null;
    found.set(kind, candidate);
  }
  return found.size === 2 ? [...found.values()] : null;
}

export function inspectComposerCodexUsageGate(composer: Element): {
  candidateCount: number;
  verifiedCount: number;
} {
  const owner = ownerFor(composer);
  return { candidateCount: owner ? 1 : 0, verifiedCount: owner && discover(owner) ? 1 : 0 };
}

interface Projection {
  binding: Subscription;
  refresh(): void;
  dispose(): void;
}

/** A boolean useSyncExternalStore subscriber belongs to this component instance,
 * unlike its backing store/atom. Only its snapshot is projected. A synchronous
 * subscription capture obtains React's own notifier without scheduling through
 * arbitrary state hooks or changing the global Account store. store.sub is
 * restored in finally, before any notification, and no extra subscription is
 * retained in the backing store. */
function project(binding: Subscription, enabled: () => boolean): Projection {
  const { subscriber, store, atom, instance, effect } = binding;
  const originalSnapshot = subscriber.getSnapshot;
  const originalSub = store.sub;
  let notify: (() => void) | undefined;
  let cleanup: unknown;
  let disposed = false;
  const getSnapshot = () => {
    const native = originalSnapshot.call(subscriber);
    return !disposed && typeof native === "boolean" && enabled() ? false : native;
  };
  // These are instance-owned mutable surfaces in the verified Desktop contract.
  for (const [target, key] of [
    [store, "sub"],
    [subscriber, "getSnapshot"],
    [instance, "getSnapshot"],
  ] as const) {
    if (Object.getOwnPropertyDescriptor(target, key)?.writable !== true) {
      throw new Error("Codex usage subscriber is not writable");
    }
  }
  try {
    store.sub = (candidate, listener) => {
      if (candidate !== atom || notify) throw new Error("Unexpected Codex usage subscription");
      notify = listener;
      return () => undefined;
    };
    cleanup = effect.create();
  } finally {
    store.sub = originalSub;
  }
  if (!notify || typeof cleanup !== "function") {
    if (typeof cleanup === "function") cleanup();
    throw new Error("Codex usage subscription is unavailable");
  }
  const onChange = notify;
  const unsubscribe = cleanup;
  subscriber.getSnapshot = getSnapshot;
  instance.getSnapshot = getSnapshot;
  return {
    binding,
    refresh() {
      const next = getSnapshot();
      if (!Object.is(instance.value, next)) onChange();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (subscriber.getSnapshot === getSnapshot) subscriber.getSnapshot = originalSnapshot;
      if (instance.getSnapshot === getSnapshot) instance.getSnapshot = originalSnapshot;
      try {
        onChange();
      } finally {
        unsubscribe();
      }
    },
  };
}

export interface RendererCodexUsageGate {
  refresh(): "inactive" | "ready" | "unsupported";
  dispose(): void;
}

export function createRendererCodexUsageGate(
  composer: Element,
  canIgnoreCodexUsage: () => boolean,
): RendererCodexUsageGate {
  let projections: Projection[] = [];
  let disposed = false;
  let applying = false;
  const enabled = () => {
    try {
      return !disposed && !applying && composer.isConnected && canIgnoreCodexUsage();
    } catch {
      return false;
    }
  };
  const clear = () => {
    const previous = projections;
    projections = [];
    for (const projection of previous) {
      try {
        projection.dispose();
      } catch {
        // Snapshots are restored before notifying React. Still restore the other gate.
      }
    }
  };
  return {
    refresh() {
      if (!enabled()) {
        clear();
        return "inactive";
      }
      const owner = ownerFor(composer);
      const current = owner ? hooks(owner) : [];
      if (
        projections.length &&
        projections.every(({ binding }) =>
          current.some(
            (hook) =>
              Array.isArray(hook.memoizedState) &&
              hook.memoizedState[0] === binding.subscriber &&
              hook.next?.queue === binding.instance,
          ),
        )
      ) {
        for (const projection of projections) projection.refresh();
        return "ready";
      }
      clear();
      const bindings = owner && discover(owner);
      if (!bindings) return "unsupported";
      applying = true;
      try {
        for (const binding of bindings) projections.push(project(binding, enabled));
      } catch {
        clear();
        return "unsupported";
      } finally {
        applying = false;
      }
      for (const projection of projections) projection.refresh();
      return "ready";
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
