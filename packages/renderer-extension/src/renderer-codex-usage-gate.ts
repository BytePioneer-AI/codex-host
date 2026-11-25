/**
 * Lets an external Harness Composer submit while the signed-in ChatGPT Codex
 * subscription is out of usage.
 *
 * Desktop blocks Composer submission through two usage gates: the ChatGPT
 * Account rate-limit gate and the reserve `hardBlocked` gate, subscribed either
 * as separate booleans or merged into the `usage-limit` / `reserve-limit`
 * submit reasons. Both are Account-wide, only apply to ChatGPT sign-in, and are
 * not a protocol limit. This module projects only those usage blockers for one
 * Composer. It never writes Accounts, atoms or query data, so the Codex path
 * and other Composers keep the native result. Other native submit blockers are
 * unaffected. Anything that cannot be verified keeps the native restriction.
 *
 * Desktop 26.1002 moved the Account gate into a child of the submit owner and
 * lets an active reserve exempt it, so gates are collected along the Composer's
 * committed ancestors up to the owner.
 */
import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

import { createRendererCodexUsageBanner } from "./renderer-codex-usage-banner.js";

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
type Fiber = {
  memoizedProps?: unknown;
  memoizedState?: unknown;
  alternate?: unknown;
  updateQueue?: unknown;
  elementType?: unknown;
  type?: unknown;
};
type Instance = { value: unknown; getSnapshot(): unknown };
type GateKind = "account" | "reserve";
const USAGE_REASON = { account: "usage-limit", reserve: "reserve-limit" } as const;

/** One Desktop `useSyncExternalStore` subscription: memo, instance and effect hooks. */
interface Subscription {
  fiber: Fiber;
  subscriber: Subscriber;
  store: Store;
  atom: Atom;
  instance: Instance;
  subscribeEffect: () => unknown;
}

interface Projection {
  fiber: Fiber;
  subscriber: Subscriber;
  instance: Instance;
  snapshot(): unknown;
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

/** A submit owner and the committed fibers from the editor up to it, inclusive. */
type GateScope = { owner: Fiber } & ({ fibers: Fiber[] } | { reasons: Subscription });

/** Resolve the committed Composer's reason subscription or legacy boolean gate scope. */
function submitOwners(
  composer: Element,
  projections?: ReadonlyMap<Instance, Projection>,
): GateScope[] {
  // The ProseMirror editor is not rendered by React; start at its nearest React host.
  let element: Element | null = composer.querySelector(EDITOR_SELECTOR) ?? composer;
  for (let depth = 0; element && depth < MAX_DOM_DEPTH; depth += 1) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (key) {
      const ancestors = committedReactAncestors(
        Object.getOwnPropertyDescriptor(element, key)?.value,
      ) as Fiber[];
      const consumers = ancestors.filter(
        ({ memoizedProps: props }) =>
          isRecord(props) &&
          typeof props.submitDisabledReasons === "string" &&
          typeof props.onSubmitLocal === "function",
      );
      if (consumers.length > 0) {
        const consumer = consumers.length === 1 ? consumers[0] : undefined;
        const reasons = consumer && submitReasonSubscription(ancestors, consumer, projections);
        return consumer && reasons ? [{ owner: consumer, reasons }] : [];
      }
      const scopes: Array<{ owner: Fiber; fibers: Fiber[] }> = [];
      ancestors.forEach(({ memoizedProps: props }, index) => {
        if (
          isRecord(props) &&
          "onLocalSubmitStart" in props &&
          typeof props.submitDisabled === "boolean"
        ) {
          scopes.push({ owner: ancestors[index] as Fiber, fibers: ancestors.slice(0, index + 1) });
        }
      });
      // An outer pass-through wrapper's scope contains the inner owner's, so
      // only the innermost owner whose scope holds the reserve gate counts.
      const valid = scopes.filter((scope) => {
        const gates = gateSubscriptions(scope, projections);
        return !gates.invalid && gates.reserve.length > 0;
      });
      return valid.filter(
        (scope) => !valid.some((other) => other !== scope && scope.fibers.includes(other.owner)),
      );
    }
    element = element.parentElement;
  }
  return [];
}

function findSubmitScope(
  composer: Element,
  projections: ReadonlyMap<Instance, Projection>,
): GateScope | null {
  const scopes = submitOwners(composer, projections);
  return scopes.length === 1 ? (scopes[0] ?? null) : null;
}

function subscriptionAt(hook: Hook, fiber: Fiber): Subscription | null {
  const memo = hook.memoizedState;
  if (!Array.isArray(memo) || !Array.isArray(memo[1])) return null;
  const [subscriber, dependencies] = memo as [unknown, unknown[]];
  // Signal adapters carry their own store and atom. The memo may also track
  // subscription lifetime; only the store/atom references identify the source.
  const signal = dependencies[0];
  const adapted =
    isRecord(signal) && typeof signal.get === "function" && typeof signal.subscribe === "function";
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
    (typeof instance.value !== "boolean" && typeof instance.value !== "string") ||
    typeof instance.getSnapshot !== "function" ||
    !isRecord(effect) ||
    typeof effect.create !== "function" ||
    !Array.isArray(effect.deps) ||
    effect.deps[0] !== subscriber.subscribe
  ) {
    return null;
  }
  return {
    fiber,
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
function gateKind({
  store,
  atom,
}: Pick<Subscription, "store" | "atom">): GateKind | "mixed" | null {
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
  // Desktop 26.1002 lets an active reserve exempt the Account gate; reading
  // `reserve.active` alone only relaxes it. A selector that also reads the
  // reserve hard block cannot be separated into the two verified gates.
  if (account && read.has("reserve.hardBlocked")) return "mixed";
  if (reserve) return "reserve";
  if (account) return "account";
  return null;
}

function isUsageReason(reason: string): boolean {
  return reason === USAGE_REASON.reserve || reason === USAGE_REASON.account;
}

function usageReasonSelector({ store, atom }: Subscription): boolean {
  const gates = new Map<Atom, GateKind | "mixed" | null>();
  const replay = (enabled?: ReadonlySet<GateKind>): unknown => {
    const visiting = new Set<Atom>([atom]);
    let remaining = 128;
    const get = (dependency: Atom): unknown => {
      if (remaining-- <= 0 || visiting.has(dependency)) throw new Error("Invalid reason selector");
      const value = store.get(dependency);
      if (typeof dependency.read !== "function" || "write" in dependency) return value;
      if (typeof value === "boolean") {
        if (!gates.has(dependency)) gates.set(dependency, gateKind({ store, atom: dependency }));
        const kind = gates.get(dependency);
        if (kind === "mixed") throw new Error("Mixed usage gate");
        return kind && enabled ? enabled.has(kind) : value;
      }
      if (typeof value !== "string") return value;
      visiting.add(dependency);
      try {
        return dependency.read(get);
      } finally {
        visiting.delete(dependency);
      }
    };
    return atom.read(get);
  };
  try {
    if (replay() !== store.get(atom)) return false;
    const cases: GateKind[][] = [[], ["reserve"], ["account"], ["reserve", "account"]];
    return (
      cases.every((enabled) => {
        const value = replay(new Set(enabled));
        return (
          typeof value === "string" &&
          value.split(",").sort().join(",") === enabled.map((kind) => USAGE_REASON[kind]).join(",")
        );
      }) && [...gates.values()].filter((kind) => kind !== null).length === 2
    );
  } catch {
    return false;
  }
}

function submitReasonSubscription(
  ancestors: Fiber[],
  consumer: Fiber,
  projections?: ReadonlyMap<Instance, Projection>,
): Subscription | null {
  const props = consumer.memoizedProps as { submitDisabledReasons: string };
  const type = consumer.elementType ?? consumer.type;
  if (type == null) return null;
  const producers = ancestors.slice(ancestors.indexOf(consumer) + 1).filter(({ updateQueue }) => {
    const cache = isRecord(updateQueue) ? updateQueue.memoCache : null;
    return (
      isRecord(cache) &&
      Array.isArray(cache.data) &&
      cache.data.some(
        (row: unknown) =>
          Array.isArray(row) &&
          row.some((node: unknown) => isRecord(node) && node.props === props && node.type === type),
      )
    );
  });
  const producer = producers[0];
  if (producers.length !== 1 || !producer) return null;
  const candidates = hooksOf(producer)
    .map((hook) => subscriptionAt(hook, producer))
    .filter(
      (sub): sub is Subscription =>
        sub !== null && typeof sub.instance.value === "string" && usageReasonSelector(sub),
    );
  const candidate = candidates[0];
  const committedReasons = props.submitDisabledReasons.split(",").filter(isUsageReason).join(",");
  return candidates.length === 1 &&
    candidate &&
    candidate.instance.value === committedReasons &&
    snapshotsMatch(candidate, projections)
    ? candidate
    : null;
}

function snapshotsMatch(
  { subscriber, instance, store, atom }: Subscription,
  projections?: ReadonlyMap<Instance, Projection>,
): boolean {
  const projected = projections?.get(instance);
  // Direct snapshots also cover already-bound gates. A lazy wrapper must agree
  // with this readonly atom; never silently treat a mismatched Account gate as
  // the legitimate API-key case where its selector does not read usage.
  try {
    if (typeof subscriber.createRender === "function" && subscriber.createRender() != null) {
      return false;
    }
    if (typeof instance.value === "boolean") {
      if (instance.getSnapshot === subscriber.getSnapshot) return true;
      if (typeof subscriber.createRender !== "function") return false;
    }
    const expected = projected?.subscriber === subscriber ? projected.snapshot() : store.get(atom);
    return (
      typeof expected === typeof instance.value &&
      subscriber.getSnapshot() === expected &&
      instance.getSnapshot() === expected
    );
  } catch {
    return false;
  }
}

function gateSubscriptions(
  scope: { fibers: Fiber[] },
  projections?: ReadonlyMap<Instance, Projection>,
): Record<GateKind, Subscription[]> & { invalid: boolean } {
  const found: Record<GateKind, Subscription[]> & { invalid: boolean } = {
    account: [],
    reserve: [],
    invalid: false,
  };
  for (const fiber of scope.fibers) {
    for (const hook of hooksOf(fiber)) {
      const subscription = subscriptionAt(hook, fiber);
      const kind =
        subscription && typeof subscription.instance.value === "boolean" && gateKind(subscription);
      if (subscription && kind) {
        if (kind !== "mixed" && snapshotsMatch(subscription, projections)) {
          found[kind].push(subscription);
        } else found.invalid = true;
      }
    }
  }
  return found;
}

/**
 * Gate subscriptions with their kind; `null` when a kind is ambiguous within one
 * component. Desktop 26.1002 subscribes the Account gate in more than one
 * component of the scope, and each subscription blocks its own component. The
 * account gate returns early without reading usage when it cannot block (for
 * example API-key sign-in), so it may legitimately be absent until it reads
 * `rate_limit`.
 */
function discoverGates(
  scope: { fibers: Fiber[] },
  projections: ReadonlyMap<Instance, Projection>,
): Subscription[] | null {
  const gates = gateSubscriptions(scope, projections);
  if (gates.invalid || gates.reserve.length === 0) return null;
  const found: Subscription[] = [];
  for (const kind of ["account", "reserve"] as const) {
    const fibers = new Set<Fiber>();
    for (const subscription of gates[kind]) {
      if (fibers.has(subscription.fiber)) return null;
      fibers.add(subscription.fiber);
      found.push(subscription);
    }
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
  const owner = owners.length === 1 ? owners[0] : undefined;
  const reasons = owner && "reasons" in owner;
  const gates = owner && "fibers" in owner ? gateSubscriptions(owner) : null;
  return {
    ownerCount: owners.length,
    reserveGateCount: reasons ? 1 : (gates?.reserve.length ?? 0),
    accountGateCount: reasons ? 1 : (gates?.account.length ?? 0),
  };
}

/**
 * Project this component instance's usage snapshot and ask React to
 * re-check it. React's own store-change listener is obtained by running the
 * subscription effect once with `store.sub` captured synchronously; the shared
 * store keeps no extra subscription.
 */
function project({
  fiber,
  subscriber,
  store,
  atom,
  instance,
  subscribeEffect,
}: Subscription): Projection {
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
  const snapshot =
    typeof instance.value === "string"
      ? () => {
          const value = original.call(subscriber);
          return typeof value === "string"
            ? value
                .split(",")
                .filter((reason) => !isUsageReason(reason))
                .join(",")
            : value;
        }
      : () => false;
  subscriber.getSnapshot = snapshot;
  instance.getSnapshot = snapshot;
  if (instance.value !== snapshot()) onChange();
  return {
    fiber,
    subscriber,
    instance,
    snapshot,
    restore() {
      if (subscriber.getSnapshot === snapshot) subscriber.getSnapshot = original;
      if (instance.getSnapshot === snapshot) instance.getSnapshot = originalInstance;
      onChange();
    },
  };
}

function isBound(projections: Iterable<Projection>): boolean {
  return [...projections].every(({ fiber, subscriber, instance }) => {
    const alternate = isRecord(fiber.alternate) ? fiber.alternate : null;
    return [fiber, alternate].some((candidate) =>
      hooksOf(candidate).some(
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
  let owner: GateScope | null = null;
  const projections = new Map<Instance, Projection>();
  let retryAt = 0;
  let allowed = false;
  const banner = createRendererCodexUsageBanner();
  const release = (): void => {
    banner.restore();
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
    // A commit can publish an alternate owner with additional gate subscriptions.
    const current = findSubmitScope(composer, projections);
    const gates =
      current && ("reasons" in current ? [current.reasons] : discoverGates(current, projections));
    if (!current || !gates) throw new Error("Codex usage gate is unavailable");
    owner = current;
    for (const [instance, projection] of projections) {
      if (
        gates.some(
          (gate) => gate.instance === instance && gate.subscriber === projection.subscriber,
        )
      ) {
        continue;
      }
      projection.restore();
      projections.delete(instance);
    }
    for (const gate of gates) {
      if (!projections.has(gate.instance)) projections.set(gate.instance, project(gate));
    }
    return "bypassed";
  };
  // The usage banner only describes the Codex path; hide it while bypassed.
  const apply = (): RendererCodexUsageGateStatus => {
    const status = applyGate();
    if (status === "bypassed" && owner) banner.hide(owner.owner);
    else banner.restore();
    return status;
  };
  const applyGate = (): RendererCodexUsageGateStatus => {
    if (!allowed || !composer.isConnected) {
      release();
      retryAt = 0;
      return "native";
    }
    if (owner && !isBound(projections.values())) {
      release();
      retryAt = 0;
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
