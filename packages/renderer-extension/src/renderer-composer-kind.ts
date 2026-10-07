import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

/**
 * Dot's cloud-room composer shares the Codex DOM marker and conversationId,
 * but has no app-server Thread or Harness configuration. Use its nearest
 * explicit Orbit owner in the published React tree, never another composer
 * or a stale alternate. ProseMirror itself may have no React DOM pointer.
 */
export type OrbitComposerKind = "orbit" | "codex" | "unknown";

export function orbitComposerKind(composer: Element): OrbitComposerKind {
  let element: Element | null =
    composer.querySelector('[contenteditable="true"], textarea, [role="textbox"]') ?? composer;
  for (let depth = 0; element && depth < 12; depth += 1) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (key) {
      let walked = false;
      for (const fiber of committedReactAncestors(
        Object.getOwnPropertyDescriptor(element, key)?.value,
      )) {
        walked = true;
        const props = fiber.memoizedProps;
        if (typeof props === "object" && props !== null && "isOrbit" in props) {
          const value = props.isOrbit;
          if (typeof value === "boolean") return value ? "orbit" : "codex";
        }
      }
      // The DOM pointer exists but the bounded walk gave up (a return cycle
      // or the visited-fiber cap). Classifying such a root as a native Codex
      // composer mounted cloud rooms and blocked their submissions, so it
      // stays unmounted instead. Chains without a published root keep the
      // documented partial-binding inspection path: without an explicit
      // Orbit owner they classify as native.
      return walked ? "codex" : "unknown";
    }
    element = element.parentElement;
  }
  // No React pointer near the root gives no evidence either way; keep the
  // native classification so ordinary composers still receive controls.
  // Cloud rooms observed so far always publish a pointer nearby.
  return "codex";
}

export function isOrbitComposer(composer: Element): boolean {
  return orbitComposerKind(composer) === "orbit";
}
