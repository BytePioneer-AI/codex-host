import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REACT_FIBER_WALK_LIMIT_EVENT,
  committedReactAncestors,
} from "../src/renderer-react-ownership.js";

type Fiber = Record<string, unknown>;

const LIMIT = 200_000;

function captureLimitEvents(): Event[] {
  const events: Event[] = [];
  vi.stubGlobal("dispatchEvent", (event: Event) => {
    events.push(event);
    return true;
  });
  return events;
}

describe("committed React ownership", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the committed parent path for a bailout child with stale return pointers", () => {
    const state: { current?: Fiber } = {};
    const oldRoot: Fiber = { stateNode: state };
    const oldParent: Fiber = { return: oldRoot };
    const first: Fiber = { return: oldParent };
    const currentParent: Fiber = { child: first };
    const currentRoot: Fiber = { stateNode: state, child: { sibling: currentParent } };
    currentParent.return = currentRoot;
    first.alternate = { return: currentParent };
    state.current = currentRoot;
    expect(committedReactAncestors(first)).toEqual([first, currentParent, currentRoot]);
  });

  it("follows later commits without retaining a cached manager", () => {
    const state: { current?: Fiber } = {};
    const oldRoot: Fiber = { stateNode: state };
    const newRoot: Fiber = { stateNode: state };
    const first: Fiber = { return: oldRoot };
    const alternate: Fiber = { return: newRoot };
    first.alternate = alternate;
    oldRoot.child = first;
    newRoot.child = alternate;
    state.current = oldRoot;
    expect(committedReactAncestors(first)).toEqual([first, oldRoot]);
    state.current = newRoot;
    expect(committedReactAncestors(first)).toEqual([alternate, newRoot]);
    state.current = oldRoot;
    expect(committedReactAncestors(first)).toEqual([first, oldRoot]);
  });

  it("does not fall back to an unmounted or disconnected published tree", () => {
    const state: { current: Fiber | null } = { current: null };
    const first: Fiber = { return: { stateNode: state } };
    expect(committedReactAncestors(first)).toEqual([]);
    state.current = { child: {} };
    expect(committedReactAncestors(first)).toEqual([]);
  });

  it("retains bounded legacy ancestry when there is no published root", () => {
    const parent = {};
    const first = { return: parent };
    expect(committedReactAncestors(first)).toEqual([first, parent]);
    expect(committedReactAncestors(null)).toEqual([]);
  });

  it("resolves a valid deeply nested Thread without a root-depth limit", () => {
    const first: Fiber = {};
    let node = first;
    for (let depth = 1; depth < 209; depth += 1) {
      const parent: Fiber = { child: node };
      node.return = parent;
      node = parent;
    }
    node.stateNode = { current: node };
    const ancestors = committedReactAncestors(first);
    expect(ancestors).toHaveLength(209);
    expect(ancestors[0]).toBe(first);
    expect(ancestors.at(-1)).toBe(node);
  });

  it("bounds parent traversal even without a cycle", () => {
    const first: Fiber = {};
    let node = first;
    for (let depth = 1; depth < 200_010; depth += 1) {
      const parent: Fiber = {};
      node.return = parent;
      node = parent;
    }
    expect(committedReactAncestors(first)).toEqual([]);
  });

  it("rejects cyclic ancestry and bounds malformed committed trees", () => {
    const cyclic: Fiber = {};
    cyclic.return = cyclic;
    expect(committedReactAncestors(cyclic)).toEqual([]);
    const child: Fiber = {};
    child.sibling = child;
    const first = { return: { stateNode: { current: { child } } } };
    expect(committedReactAncestors(first)).toEqual([]);
    let siblings: Fiber = {};
    for (let i = 0; i < 200_010; i++) siblings = { sibling: siblings };
    first.return.stateNode.current.child = siblings;
    expect(committedReactAncestors(first)).toEqual([]);
  });

  it("finds a Composer committed after more than 20,000 fibers", () => {
    const events = captureLimitEvents();
    const first: Fiber = {};
    const root: Fiber = {};
    root.stateNode = { current: root };
    first.return = root;
    // The Composer is the last sibling, reached after every earlier sidebar item.
    let sibling: Fiber = first;
    for (let i = 0; i < 20_300; i++) sibling = { sibling };
    root.child = sibling;
    expect(committedReactAncestors(first)).toEqual([first, root]);
    expect(events).toEqual([]);
  });

  it.each([false, true])("skips unrelated committed subtrees (alternate: %s)", (useAlternate) => {
    const root: Fiber = {};
    const state = { current: root };
    root.stateNode = state;
    const composer: Fiber = { return: root };
    const unrelated: Fiber = { sibling: composer };
    const readChild = vi.fn(() => ({}));
    Object.defineProperty(unrelated, "child", { get: readChild });
    root.child = unrelated;
    const pointer: Fiber = useAlternate
      ? { return: { stateNode: state }, alternate: composer }
      : composer;
    expect(committedReactAncestors(pointer)).toEqual([composer, root]);
    expect(readChild).not.toHaveBeenCalled();
  });

  it("falls back when a return path reaches the current root through an uncommitted parent", () => {
    const root: Fiber = {};
    root.stateNode = { current: root };
    const actualParent: Fiber = { return: root };
    const staleParent: Fiber = { return: root };
    const composer: Fiber = { return: staleParent };
    actualParent.child = composer;
    root.child = actualParent;
    expect(committedReactAncestors(composer)).toEqual([composer, actualParent, root]);
  });

  it("announces an exhausted walk instead of failing silently", () => {
    const events = captureLimitEvents();
    const first: Fiber = {};
    const root: Fiber = {};
    root.stateNode = { current: root };
    first.return = root;
    let sibling: Fiber = first;
    for (let i = 0; i < LIMIT + 10; i++) sibling = { sibling };
    root.child = sibling;
    expect(committedReactAncestors(first)).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(REACT_FIBER_WALK_LIMIT_EVENT);
    expect((events[0] as CustomEvent).detail).toEqual({ limit: LIMIT });
  });

  it("announces an exhausted parent walk but not malformed or missing trees", () => {
    const events = captureLimitEvents();
    const cyclic: Fiber = {};
    cyclic.return = cyclic;
    expect(committedReactAncestors(cyclic)).toEqual([]);
    const detached: Fiber = { return: { stateNode: { current: { child: {} } } } };
    expect(committedReactAncestors(detached)).toEqual([]);
    expect(events).toEqual([]);

    const first: Fiber = {};
    let node = first;
    for (let depth = 1; depth < LIMIT + 10; depth += 1) {
      const parent: Fiber = {};
      node.return = parent;
      node = parent;
    }
    expect(committedReactAncestors(first)).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([REACT_FIBER_WALK_LIMIT_EVENT]);
  });
});
