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

  it("validates a published parent path without walking unrelated subtrees", () => {
    const root: Fiber = {};
    const parent: Fiber = { return: root };
    const first: Fiber = { return: parent };
    const readSidebarChildren = vi.fn(() => ({}));
    root.stateNode = { current: root };
    root.child = {
      get child() {
        return readSidebarChildren();
      },
      sibling: parent,
    };
    parent.child = first;

    expect(committedReactAncestors(first)).toEqual([first, parent, root]);
    expect(readSidebarChildren).not.toHaveBeenCalled();

    // Even an in-place change under the same published root must be observed.
    parent.child = {};
    expect(committedReactAncestors(first)).toEqual([]);
    expect(readSidebarChildren).toHaveBeenCalledTimes(1);
  });

  it("validates alternate parent identities without traversing earlier subtrees", () => {
    const state: { current?: Fiber } = {};
    const oldRoot: Fiber = { stateNode: state };
    const currentRoot: Fiber = { stateNode: state };
    const currentParent: Fiber = { return: currentRoot };
    const oldParent: Fiber = { return: oldRoot, alternate: currentParent };
    const alternate: Fiber = { return: currentParent };
    const first: Fiber = { return: oldParent, alternate };
    const readSidebarChildren = vi.fn(() => ({}));
    currentParent.child = alternate;
    currentRoot.child = {
      get child() {
        return readSidebarChildren();
      },
      sibling: currentParent,
    };
    state.current = currentRoot;

    expect(committedReactAncestors(first)).toEqual([alternate, currentParent, currentRoot]);
    expect(readSidebarChildren).not.toHaveBeenCalled();
  });

  it("falls back to the actual published parent when a plausible path is disconnected", () => {
    const root: Fiber = {};
    const staleParent: Fiber = { return: root };
    const first: Fiber = { return: staleParent };
    const actualParent: Fiber = { child: first };
    root.stateNode = { current: root };
    staleParent.child = {};
    staleParent.sibling = actualParent;
    root.child = staleParent;
    expect(committedReactAncestors(first)).toEqual([first, actualParent, root]);
  });

  it("does not substitute an unrelated published root for the requested root", () => {
    const root: Fiber = { stateNode: { current: {} } };
    expect(committedReactAncestors(root)).toEqual([]);
    const alternate: Fiber = {};
    root.alternate = alternate;
    root.stateNode = { current: alternate };
    expect(committedReactAncestors(root)).toEqual([alternate]);
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
