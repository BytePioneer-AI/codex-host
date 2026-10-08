import { describe, expect, it } from "vitest";
import { isOrbitComposer, orbitComposerKind } from "../src/renderer-composer-kind.js";
import { findComposerModelTarget } from "../src/versioned-renderer-adapter.js";

function composerWithEditor(fiber: object): Element {
  const editor = { parentElement: null };
  Object.defineProperty(editor, "__reactFiber$test", { value: fiber });
  return { querySelector: () => editor } as unknown as Element;
}

describe("Dot composer ownership", () => {
  it("uses the published tree when a DOM pointer still refers to a normal composer", () => {
    const old = {
      memoizedProps: { isOrbit: false },
      return: null as unknown,
      alternate: null as unknown,
    };
    const current = { memoizedProps: { isOrbit: true }, return: null as unknown, alternate: old };
    old.alternate = current;
    const root = { stateNode: { current: null as unknown }, child: current as unknown };
    root.stateNode.current = root;
    old.return = root;
    current.return = root;
    const composer = composerWithEditor(old);
    expect(isOrbitComposer(composer)).toBe(true);
    // No model/Harness route may be derived from the cloud conversationId.
    expect(findComposerModelTarget(composer)).toBeNull();
    root.child = old;
    expect(isOrbitComposer(composer)).toBe(false);
  });

  it("honors the nearest explicit owner and never inspects a sibling Orbit room", () => {
    const outer = { memoizedProps: { isOrbit: true }, return: null };
    const local = { memoizedProps: { isOrbit: false }, return: outer };
    expect(isOrbitComposer(composerWithEditor(local))).toBe(false);
    expect(isOrbitComposer(composerWithEditor({ sibling: outer, return: null }))).toBe(false);
  });

  it("does not classify missing or malformed metadata as a cloud composer", () => {
    // Bounded ancestry without a published root stays the documented
    // partial-binding inspection path: without an explicit Orbit owner these
    // keep the native classification so ordinary composers stay mounted.
    expect(orbitComposerKind(composerWithEditor({ return: null }))).toBe("codex");
    expect(
      orbitComposerKind(composerWithEditor({ memoizedProps: { isOrbit: "true" }, return: null })),
    ).toBe("codex");
    expect(isOrbitComposer(composerWithEditor({ return: null }))).toBe(false);
    expect(
      isOrbitComposer(composerWithEditor({ memoizedProps: { isOrbit: "true" }, return: null })),
    ).toBe(false);
  });

  it("classifies a published tree without an explicit owner as a native composer", () => {
    const root = {
      stateNode: { current: null as unknown },
      child: null as unknown,
    };
    root.stateNode.current = root;
    const fiber = { memoizedProps: {}, return: root, alternate: null as unknown };
    root.child = fiber;
    expect(orbitComposerKind(composerWithEditor(fiber))).toBe("codex");
  });

  it("keeps a root unmounted when the published walk gives up on its pointer", () => {
    const cyclic: { memoizedProps: Record<string, unknown>; return: unknown } = {
      memoizedProps: { isOrbit: true, conversationId: "dot-room" },
      return: null,
    };
    cyclic.return = cyclic;
    const composer = composerWithEditor(cyclic);
    expect(orbitComposerKind(composer)).toBe("unknown");
    expect(isOrbitComposer(composer)).toBe(false);
    // No model/Harness route may be derived from an unclassifiable root.
    expect(findComposerModelTarget(composer)).toBeNull();
  });
});
