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
type GateKind = "account" | "accountReserveActive" | "reserve";

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

/**
 * Composer components that combine native submit blockers into `submitDisabled`
 * and hold the reserve gate. Desktop wraps the owner in a pass-through component
 * with the same props but no gate hooks, so props alone are ambiguous.
 */
function submitOwnerCandidates(composer: Element): Fiber[] {
  // The ProseMirror editor is not rendered by React; start at its nearest React host.
  let element: Element | null = composer.querySelector(EDITOR_SELECTOR) ?? composer;
  for (let depth = 0; element && depth < MAX_DOM_DEPTH; depth += 1) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (key) {
      return committedReactAncestors(Object.getOwnPropertyDescriptor(element, key)?.value).filter(
        ({ memoizedProps: props }) =>
          isRecord(props) &&
          "onLocalSubmitStart" in props &&
          typeof props.submitDisabled === "boolean",
      ) as Fiber[];
    }
    element = element.parentElement;
  }
  return [];
}

function submitOwners(composer: Element): Fiber[] {
  return submitOwnerCandidates(composer).filter((owner) => {
    const gates = gateSubscriptions(owner);
    return !gates.invalid && gates.reserve.length > 0;
  });
}

function findSubmitOwner(composer: Element): Fiber | null {
  const owners = submitOwners(composer);
  return owners.length === 1 ? (owners[0] ?? null) : null;
}

function findOuterAccountGateOwner(
  composer: Element,
  primary: Fiber,
): Fiber | null | undefined {
  const matches = submitOwnerCandidates(composer).filter((candidate) => {
    if (candidate === primary) return false;

    const gates = gateSubscriptions(candidate);

    return !gates.invalid && gates.reserve.length === 0 && gates.account.length === 1;
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  return undefined;
}

function subscriptionAt(hook: Hook): Subscription | null {
  const memo = hook.memoizedState;
  if (!Array.isArray(memo) || !Array.isArray(memo[1])) return null;
  const [subscriber, dependencies] = memo as [unknown, unknown[]];
  if (dependencies.length !== 2) return null;
  // 26.928 parameterized selectors memoize a readonly signal adapter instead
  // of [store, atom]. The subscription still targets that adapter's atom.
  const signal = dependencies[0];
  const adapted =
    dependencies[1] === undefined &&
    isRecord(signal) &&
    typeof signal.get === "function" &&
    typeof signal.subscribe === "function";
  const [store, atom] = adapted ? [signal.store, signal.atom] : dependencies;
  const instance = hook.next?.queue;
  const effect = hook.next?.next?.memoizedState;
  if (
    !isRecord(subscriber) ||
    typeof subscriber.getSnapshot !== "function" ||
    typeof subscriber.subscribe !== "function" ||
    !isRecord(store) ||
    typeof store.get !== "function" ||
    typeof store.sub !== "function" ||
    !isRecord(atom) ||
    typeof atom.read !== "function" ||
    "write" in atom ||
    !isRecord(instance) ||
    typeof instance.value !== "boolean" ||
    typeof instance.getSnapshot !== "function" ||
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
function gateKind({ store, atom }: Subscription): GateKind | "mixed" | null {
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
    const visiting = new Set<Atom>();
    let remaining = 128;
    const replay = (dependency: Atom): unknown => {
      if (remaining-- <= 0 || visiting.has(dependency)) {
        throw new Error("Codex usage selector dependencies are unavailable");
      }
      const value = store.get(dependency);
      // New signal atoms delegate to another readonly boolean selector. Replay
      // those indirections too, but never evaluate writable state atom readers.
      if (
        typeof value === "boolean" &&
        typeof dependency.read === "function" &&
        !("write" in dependency)
      ) {
        visiting.add(dependency);
        try {
          const result = dependency.read(replay);
          if (result !== value) throw new Error("Codex usage selector replay differs");
          return result;
        } finally {
          visiting.delete(dependency);
        }
      }
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
    };
    visiting.add(atom);
    const replayed = atom.read(replay);
    if (typeof native !== "boolean" || replayed !== native) return null;
  } catch {
    return null;
  }
  const reserve = read.has("reserve.hardBlocked") && !read.has("reserve.active");
  const account = read.has("auth.authMethod") && read.has("limit.allowed");
  const accountReserveActive =
    account &&
    read.has("limit.primary_window") &&
    read.has("limit.secondary_window") &&
    read.has("reserve.active") &&
    !read.has("reserve.hardBlocked");
  // Desktop 26.928 folds the Account exhaustion selector with reserve.active.
  // This remains a usage-only gate, but reserve.hardBlocked combinations stay ambiguous.
  if (account && read.has("reserve.hardBlocked")) return "mixed";
  if (accountReserveActive) return "accountReserveActive";
  if (account && read.has("reserve.active")) return "mixed";
  if (reserve) return "reserve";
  if (account) return "account";
  return null;
}

function snapshotsMatch(
  { subscriber, instance, store, atom }: Subscription,
  projected?: Projection,
): boolean {
  // Direct snapshots also cover already-bound gates. A lazy wrapper must agree
  // with this readonly atom; never silently treat a mismatched Account gate as
  // the legitimate API-key case where its selector does not read usage.
  try {
    if (typeof subscriber.createRender === "function" && subscriber.createRender() != null) {
      return false;
    }
    if (instance.getSnapshot === subscriber.getSnapshot) return true;
    if (typeof subscriber.createRender !== "function") return false;
    const expected =
      projected?.subscriber === subscriber && projected.instance === instance
        ? false
        : store.get(atom);
    return (
      typeof expected === "boolean" &&
      subscriber.getSnapshot() === expected &&
      instance.getSnapshot() === expected
    );
  } catch {
    return false;
  }
}

function gateSubscriptions(
  owner: Fiber,
  projections?: ReadonlyMap<GateKind, Projection>,
): Record<GateKind, Subscription[]> & { invalid: boolean } {
  const found: Record<GateKind, Subscription[]> & { invalid: boolean } = {
    account: [],
    accountReserveActive: [],
    reserve: [],
    invalid: false,
  };
  for (const hook of hooksOf(owner)) {
    const subscription = subscriptionAt(hook);
    const kind = subscription && gateKind(subscription);
    if (subscription && kind) {
      if (kind !== "mixed" && snapshotsMatch(subscription, projections?.get(kind))) {
        found[kind].push(subscription);
      } else found.invalid = true;
    }
  }
  return found;
}

/**
 * Gate subscriptions by kind; `null` when a kind is ambiguous. The account gate
 * returns early without reading usage when it cannot block (for example API-key
 * sign-in), so it may legitimately be absent until it reads `rate_limit`.
 */
function discoverGates(
  owner: Fiber,
  projections: ReadonlyMap<GateKind, Projection>,
): Map<GateKind, Subscription> | null {
  const gates = gateSubscriptions(owner, projections);
  if (gates.invalid) return null;
  const found = new Map<GateKind, Subscription>();
  for (const kind of ["account", "accountReserveActive", "reserve"] as const) {
    const subscriptions = gates[kind];
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
  const originalInstance = instance.getSnapshot;
  const allowed = (): boolean => false;
  subscriber.getSnapshot = allowed;
  instance.getSnapshot = allowed;
  if (instance.value !== false) onChange();
  return {
    subscriber,
    instance,
    restore() {
      if (subscriber.getSnapshot === allowed) subscriber.getSnapshot = original;
      if (instance.getSnapshot === allowed) instance.getSnapshot = originalInstance;
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
  let outerAccountOwner: Fiber | null = null;
  let outerAccountProjection: Projection | null = null;
  const projections = new Map<GateKind, Projection>();
  let retryAt = 0;
  let allowed = false;
  const release = (): void => {
    const previous = [...projections.values()];
    owner = null;
    outerAccountOwner = null;

    if (outerAccountProjection) {
      previous.push(outerAccountProjection);
    }

    outerAccountProjection = null;
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
    const gates = current && discoverGates(current, projections);
    // The reserve gate always reads its field, so its absence means an unknown contract.
    if (!current || !gates?.has("reserve")) throw new Error("Codex usage gate is unavailable");
    owner = current;

    for (const [kind, gate] of gates) {
      if (!projections.has(kind)) projections.set(kind, project(gate));
    }

    const outer = findOuterAccountGateOwner(composer, current);
    if (outer === undefined) throw new Error("Outer Codex usage gate is ambiguous");

    if (outer) {
      const outerGates = gateSubscriptions(outer);
      const account = outerGates.account[0];

      if (!account) {
        throw new Error("Outer Codex usage gate is unavailable");
      }

      outerAccountOwner = outer;

      if (!outerAccountProjection) {
        outerAccountProjection = project(account);
      }
    }

    return "bypassed";
  };
  const apply = (): RendererCodexUsageGateStatus => {
    if (!allowed || !composer.isConnected) {
      release();
      retryAt = 0;
      return "native";
    }
    if (
      (owner && !isBound(owner, projections.values())) ||
      (outerAccountOwner &&
        outerAccountProjection &&
        !isBound(outerAccountOwner, [outerAccountProjection]))
    ) {
      release();
      retryAt = 0;
    }

    if (
      owner &&
      projections.has("reserve") &&
      (projections.has("account") || projections.has("accountReserveActive")) &&
      (!outerAccountOwner || outerAccountProjection)
    ) {
      return "bypassed";
    }
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
