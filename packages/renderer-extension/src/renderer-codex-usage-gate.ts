/**
 * Lets an external Harness Composer submit while the signed-in ChatGPT Codex
 * subscription is out of usage.
 *
 * Desktop blocks Composer submission through two boolean selectors: the
 * ChatGPT Account rate-limit gate and the reserve `hardBlocked` gate. Both are
 * Account-wide, only apply to ChatGPT sign-in, and are not a protocol limit.
 * This module projects `false` for those two subscriptions of one Composer
 * only. It never writes Accounts, atoms or query data, so the Codex path and
 * other Composers keep the native result. Other native submit blockers are
 * unaffected. Anything that cannot be verified keeps the native restriction.
 */
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
type Fiber = { memoizedProps?: unknown; memoizedState?: unknown; alternate?: unknown };
type Instance = { value: unknown; getSnapshot(): unknown };
type GateKind = "account" | "reserve";

/** One Desktop `useSyncExternalStore` subscription: memo, instance and effect hooks. */
interface Subscription {
  subscriber: Subscriber;
  store: Store;
  atom: Atom;
  instance: Instance;
  subscribeEffect: () => unknown;
}

interface Projection {
  subscriber: Subscriber;
  instance: Instance;
  restore(): void;
}

const EDITOR_SELECTOR = '[contenteditable="true"][role="textbox"]';
const MAX_HOOKS = 4096;
const MAX_DOM_DEPTH = 12;
const RETRY_DELAY_MS = 1000;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hooksOf(fiber: unknown): Hook[] {
  const result: Hook[] = [];
  let hook = isRecord(fiber) ? fiber.memoizedState : null;
  while (isRecord(hook) && result.length < MAX_HOOKS) {
    result.push(hook);
    hook = hook.next;
  }
  return hook == null ? result : [];
}

/** Composer components that combine native submit blockers into `submitDisabled`. */
function submitOwners(composer: Element): Fiber[] {
  // The ProseMirror editor is not rendered by React; start at its nearest React host.
  let element: Element | null = composer.querySelector(EDITOR_SELECTOR) ?? composer;
  for (let depth = 0; element && depth < MAX_DOM_DEPTH; depth += 1) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (key) {
      const owners = committedReactAncestors(
        Object.getOwnPropertyDescriptor(element, key)?.value,
      ).filter(
        ({ memoizedProps: props }) =>
          isRecord(props) &&
          "onLocalSubmitStart" in props &&
          typeof props.submitDisabled === "boolean",
      );
      return owners as Fiber[];
    }
    element = element.parentElement;
  }
  return [];
}

function findSubmitOwner(composer: Element): Fiber | null {
  const owners = submitOwners(composer);
  return owners.length === 1 ? (owners[0] ?? null) : null;
}

function subscriptionAt(hook: Hook): Subscription | null {
  const memo = hook.memoizedState;
  if (!Array.isArray(memo) || !Array.isArray(memo[1])) return null;
  const [subscriber, [store, atom]] = memo as [unknown, unknown[]];
  const instance = hook.next?.queue;
  const effect = hook.next?.next?.memoizedState;
  if (
    !isRecord(subscriber) ||
    typeof subscriber.getSnapshot !== "function" ||
    typeof subscriber.subscribe !== "function" ||
    (typeof subscriber.createRender === "function" && subscriber.createRender() != null) ||
    !isRecord(store) ||
    typeof store.get !== "function" ||
    typeof store.sub !== "function" ||
    !isRecord(atom) ||
    typeof atom.read !== "function" ||
    "write" in atom ||
    !isRecord(instance) ||
    typeof instance.value !== "boolean" ||
    instance.getSnapshot !== subscriber.getSnapshot ||
    !isRecord(effect) ||
    typeof effect.create !== "function" ||
    !Array.isArray(effect.deps) ||
    effect.deps[0] !== subscriber.subscribe
  ) {
    return null;
  }
  return {
    subscriber: subscriber as Subscriber,
    store: store as Store,
    atom: atom as Atom,
    instance: instance as Instance,
    subscribeEffect: effect.create as () => unknown,
  };
}

/**
 * Identify a gate by the fields its selector reads, not by minified names or
 * hook positions. Dependencies are replayed read-only through tracing copies.
 */
function gateKind({ store, atom }: Subscription): GateKind | null {
  const read = new Set<string>();
  const trace = (value: RecordValue, prefix: string): RecordValue =>
    new Proxy(
      { ...value },
      {
        get(target, property, receiver) {
          if (typeof property === "string") read.add(`${prefix}.${property}`);
          return Reflect.get(target, property, receiver);
        },
      },
    );
  try {
    const native = store.get(atom);
    const replayed = atom.read((dependency) => {
      const value = store.get(dependency);
      if (!isRecord(value)) return value;
      if (typeof value.hardBlocked === "boolean") return trace(value, "reserve");
      if ("authMethod" in value) return trace(value, "auth");
      if (isRecord(value.data) && isRecord(value.data.rate_limit)) {
        return {
          ...value,
          data: { ...value.data, rate_limit: trace(value.data.rate_limit, "limit") },
        };
      }
      return value;
    });
    if (typeof native !== "boolean" || replayed !== native) return null;
  } catch {
    return null;
  }
  if (read.has("reserve.hardBlocked") && !read.has("reserve.active")) return "reserve";
  if (read.has("auth.authMethod") && read.has("limit.allowed")) return "account";
  return null;
}

function gateSubscriptions(owner: Fiber): Record<GateKind, Subscription[]> {
  const found: Record<GateKind, Subscription[]> = { account: [], reserve: [] };
  for (const hook of hooksOf(owner)) {
    const subscription = subscriptionAt(hook);
    const kind = subscription && gateKind(subscription);
    if (subscription && kind) found[kind].push(subscription);
  }
  return found;
}

/**
 * Gate subscriptions by kind; `null` when a kind is ambiguous. The account gate
 * returns early without reading usage when it cannot block (for example API-key
 * sign-in), so it may legitimately be absent until it reads `rate_limit`.
 */
function discoverGates(owner: Fiber): Map<GateKind, Subscription> | null {
  const found = new Map<GateKind, Subscription>();
  for (const [kind, subscriptions] of Object.entries(gateSubscriptions(owner)) as Array<
    [GateKind, Subscription[]]
  >) {
    if (subscriptions.length > 1) return null;
    if (subscriptions[0]) found.set(kind, subscriptions[0]);
  }
  return found;
}

export interface RendererCodexUsageGateInspection {
  ownerCount: number;
  reserveGateCount: number;
  accountGateCount: number;
}

/** Read-only contract audit: counts only, never patches or subscribes. */
export function inspectComposerCodexUsageGate(composer: Element): RendererCodexUsageGateInspection {
  const owners = submitOwners(composer);
  const gates = owners.length === 1 && owners[0] ? gateSubscriptions(owners[0]) : null;
  return {
    ownerCount: owners.length,
    reserveGateCount: gates?.reserve.length ?? 0,
    accountGateCount: gates?.account.length ?? 0,
  };
}

/**
 * Replace this component instance's snapshot with `false` and ask React to
 * re-check it. React's own store-change listener is obtained by running the
 * subscription effect once with `store.sub` captured synchronously; the shared
 * store keeps no extra subscription.
 */
function project({ subscriber, store, atom, instance, subscribeEffect }: Subscription): Projection {
  for (const [target, key] of [
    [store, "sub"],
    [subscriber, "getSnapshot"],
    [instance, "getSnapshot"],
  ] as const) {
    if (Object.getOwnPropertyDescriptor(target, key)?.writable !== true) {
      throw new Error("Codex usage gate is not writable");
    }
  }
  let notify: (() => void) | undefined;
  const originalSub = store.sub;
  try {
    store.sub = (candidate, listener) => {
      if (candidate !== atom || notify) throw new Error("Unexpected Codex usage subscription");
      notify = listener;
      return () => undefined;
    };
    subscribeEffect();
  } finally {
    store.sub = originalSub;
  }
  if (!notify) throw new Error("Codex usage gate listener is unavailable");
  const onChange = notify;
  const original = subscriber.getSnapshot;
  const allowed = (): boolean => false;
  subscriber.getSnapshot = allowed;
  instance.getSnapshot = allowed;
  if (instance.value !== false) onChange();
  return {
    subscriber,
    instance,
    restore() {
      if (subscriber.getSnapshot === allowed) subscriber.getSnapshot = original;
      if (instance.getSnapshot === allowed) instance.getSnapshot = original;
      onChange();
    },
  };
}

function isBound(owner: Fiber, projections: Iterable<Projection>): boolean {
  const alternate = isRecord(owner.alternate) ? owner.alternate : null;
  const bound = [...projections];
  return [owner, alternate].some((fiber) => {
    const hooks = hooksOf(fiber);
    return bound.every(({ subscriber, instance }) =>
      hooks.some(
        (hook) =>
          Array.isArray(hook.memoizedState) &&
          hook.memoizedState[0] === subscriber &&
          hook.next?.queue === instance,
      ),
    );
  });
}

export type RendererCodexUsageGateStatus = "native" | "bypassed" | "unsupported";

export interface RendererCodexUsageGate {
  /** `allowed`: this Composer submits to a ready external Harness. */
  update(allowed: boolean): RendererCodexUsageGateStatus;
  /** Re-apply the last decision, rebinding if Desktop replaced the Composer hooks. */
  refresh(): RendererCodexUsageGateStatus;
  dispose(): void;
}

export function createRendererCodexUsageGate(composer: Element): RendererCodexUsageGate {
  let owner: Fiber | null = null;
  const projections = new Map<GateKind, Projection>();
  let retryAt = 0;
  let allowed = false;
  const release = (): void => {
    const previous = [...projections.values()];
    owner = null;
    projections.clear();
    for (const projection of previous) {
      try {
        projection.restore();
      } catch {
        // Keep restoring the other gate.
      }
    }
  };
  const bind = (): RendererCodexUsageGateStatus => {
    const current = owner ?? findSubmitOwner(composer);
    const gates = current && discoverGates(current);
    // The reserve gate always reads its field, so its absence means an unknown contract.
    if (!current || !gates?.has("reserve")) throw new Error("Codex usage gate is unavailable");
    owner = current;
    for (const [kind, gate] of gates) {
      if (!projections.has(kind)) projections.set(kind, project(gate));
    }
    return "bypassed";
  };
  const apply = (): RendererCodexUsageGateStatus => {
    if (!allowed || !composer.isConnected) {
      release();
      retryAt = 0;
      return "native";
    }
    if (owner && !isBound(owner, projections.values())) {
      release();
      retryAt = 0;
    }
    if (owner && projections.size === 2) return "bypassed";
    if (Date.now() < retryAt) return owner ? "bypassed" : "unsupported";
    retryAt = Date.now() + RETRY_DELAY_MS;
    try {
      return bind();
    } catch {
      release();
      return "unsupported";
    }
  };
  return {
    update(next) {
      allowed = next;
      return apply();
    },
    refresh: apply,
    dispose() {
      allowed = false;
      release();
    },
  };
}
