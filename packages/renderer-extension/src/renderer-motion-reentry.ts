import { loadCodexNativeServices } from "./codex-native-services.js";

interface VisualElement {
  features: { exit?: { isExitComplete?: boolean } };
  presenceContext?: { isPresent: boolean } | null;
  prevPresenceContext?: { isPresent: boolean } | null;
  blockInitialAnimation: boolean;
  updateFeatures(): void;
}

interface VisualElementClass {
  prototype: VisualElement;
}

const ownMethod = (prototype: object, name: string): boolean =>
  typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === "function";

/** Motion's VisualElement base class. Every bundled Motion copy imports the same class, and
 * its updateFeatures() is the only caller of the feature instances' update(). */
function isMotionVisualElement(value: unknown): value is VisualElementClass {
  if (typeof value !== "function") return false;
  const prototype: unknown = value.prototype;
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    ownMethod(prototype, "updateFeatures") &&
    ownMethod(prototype, "getProps")
  );
}

/** Motion's completed-exit path calls reset() then animateChanges(). reset makes
 * the next animateChanges() mount again, so an AnimatePresence initial=false
 * skips reentry while remembering its target as already resolved. The exit
 * values then remain indefinitely. Reentry is not a first appearance: let the
 * native update animate it, retaining the initial policy for every other
 * lifecycle.
 *
 * Each Motion copy registers its own exit feature class in a shared registry, and an element
 * keeps the class it was created with. The patch therefore sits on the shared VisualElement
 * method that updates whichever exit feature an element holds.
 */
function installCompletedExitReentry(prototype: VisualElement): () => void {
  const original = prototype.updateFeatures;
  const updateFeatures = function (this: VisualElement): void {
    if (
      this.features.exit?.isExitComplete !== true ||
      this.presenceContext?.isPresent !== true ||
      this.prevPresenceContext?.isPresent !== false
    ) {
      return original.call(this);
    }
    const blocked = this.blockInitialAnimation;
    this.blockInitialAnimation = false;
    try {
      original.call(this);
    } finally {
      this.blockInitialAnimation = blocked;
    }
  };
  prototype.updateFeatures = updateFeatures;
  return () => {
    if (prototype.updateFeatures === updateFeatures) prototype.updateFeatures = original;
  };
}

export function installRendererMotionReentry(ownerWindow: Window): {
  ready: Promise<void>;
  dispose(): void;
} {
  let disposed = false;
  let release: (() => void) | undefined;
  const ready = loadCodexNativeServices(ownerWindow, isMotionVisualElement).then((found) => {
    if (disposed) return;
    if (!found) throw new Error("Native Motion VisualElement is unavailable");
    release = installCompletedExitReentry(found.prototype);
  });
  return {
    ready,
    dispose() {
      disposed = true;
      release?.();
      release = undefined;
    },
  };
}
