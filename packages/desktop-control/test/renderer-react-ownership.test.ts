import { describe, expect, it } from "vitest";
import { committedReactAncestors } from "../src/renderer-react-ownership.js";

type Fiber = Record<string, unknown>;

describe("committed React ownership", () => {
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
    for (let depth = 1; depth < 20_010; depth += 1) {
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
    for (let i = 0; i < 20_010; i++) siblings = { sibling: siblings };
    first.return.stateNode.current.child = siblings;
    expect(committedReactAncestors(first)).toEqual([]);
  });
});
