import { afterEach, expect, it, vi } from "vitest";
import { installRendererMotionReentry } from "../src/renderer-motion-reentry.js";

const native = vi.hoisted(() => ({ exports: [] as unknown[] }));
vi.mock("../src/codex-native-services.js", () => ({
  loadCodexNativeServices: async (_window: Window, matches: (value: unknown) => boolean) =>
    native.exports.find(matches) ?? null,
}));
afterEach(() => {
  native.exports = [];
});

interface Node {
  blockInitialAnimation: boolean;
}

function exitFeature(observed: boolean[]) {
  return class {
    isExitComplete = false;
    isMounted = false;
    constructor(readonly node: Node) {}
    update() {
      observed.push(this.node.blockInitialAnimation);
    }
    mount() {}
  };
}
type ExitFeature = ReturnType<typeof exitFeature>;

/** Mirrors the native Motion module: a feature registry (and its getter export) that each
 * bundled Motion copy overwrites with its own classes, and the shared VisualElement that
 * creates an element's exit feature from the registry once, then keeps updating it. */
function nativeMotion(initial: ExitFeature) {
  const registry = {
    animation: {
      Feature: class {
        updateAnimationControlsSubscription() {}
      },
    },
    exit: { Feature: initial },
  };
  class VisualElement implements Node {
    blockInitialAnimation = true;
    presenceContext = { isPresent: true };
    prevPresenceContext: { isPresent: boolean } | undefined;
    features: { exit?: InstanceType<ExitFeature> } = {};
    getProps() {
      return {};
    }
    updateFeatures() {
      const feature = (this.features.exit ??= new registry.exit.Feature(this));
      if (feature.isMounted) feature.update();
      else feature.isMounted = true;
      return feature;
    }
    /** present -> exit (completed or not) -> present, as AnimatePresence drives it. */
    reenter(exitCompleted = true) {
      this.prevPresenceContext = this.presenceContext;
      this.presenceContext = { isPresent: false };
      this.updateFeatures().isExitComplete = exitCompleted;
      this.prevPresenceContext = this.presenceContext;
      this.presenceContext = { isPresent: true };
      this.updateFeatures();
    }
  }
  const getter = new Function("registry", "return function(){return registry}")(registry);
  native.exports = [getter, VisualElement];
  return {
    VisualElement,
    register(Feature: ExitFeature) {
      registry.exit.Feature = Feature;
    },
  };
}

it("uses native animation for completed-exit reentry and restores the original method on dispose", async () => {
  const observed: boolean[] = [];
  const { VisualElement } = nativeMotion(exitFeature(observed));
  const original = VisualElement.prototype.updateFeatures;
  const installation = installRendererMotionReentry({} as Window);
  await installation.ready;
  try {
    const element = new VisualElement();
    element.updateFeatures();
    element.reenter();
    expect(observed).toEqual([true, false]);
    expect(element.blockInitialAnimation).toBe(true);

    // Reentry before the exit completed keeps the native policy.
    element.reenter(false);
    expect(observed).toEqual([true, false, true, true]);
  } finally {
    installation.dispose();
  }
  expect(VisualElement.prototype.updateFeatures).toBe(original);
});

it("covers live elements created with an exit feature that the registry has since replaced", async () => {
  const observedA: boolean[] = [];
  const observedB: boolean[] = [];
  const ExitA = exitFeature(observedA);
  const ExitB = exitFeature(observedB);
  const motion = nativeMotion(ExitA);
  const installation = installRendererMotionReentry({} as Window);
  await installation.ready;
  try {
    // A -> B (an element is created with B) -> A
    motion.register(ExitB);
    const queued = new motion.VisualElement();
    queued.updateFeatures();
    motion.register(ExitA);
    const other = new motion.VisualElement();
    other.updateFeatures();

    queued.reenter();
    other.reenter();
    expect(queued.features.exit).toBeInstanceOf(ExitB);
    expect(observedB).toEqual([true, false]);
    expect(observedA).toEqual([true, false]);
  } finally {
    installation.dispose();
  }
});
