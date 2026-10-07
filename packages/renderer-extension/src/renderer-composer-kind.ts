import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

/** Dot's cloud-room composer shares the Codex DOM marker and conversationId,
 * but has no app-server Thread or Harness configuration. Use its nearest
 * explicit Orbit owner in the published React tree, never another composer
 * or a stale alternate. ProseMirror itself may have no React DOM pointer.
 */
export function isOrbitComposer(composer: Element): boolean {
  let element: Element | null =
    composer.querySelector('[contenteditable="true"], textarea, [role="textbox"]') ?? composer;
  for (let depth = 0; element && depth < 12; depth += 1) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (key) {
      for (const fiber of committedReactAncestors(
        Object.getOwnPropertyDescriptor(element, key)?.value,
      )) {
        const props = fiber.memoizedProps;
        if (typeof props === "object" && props !== null && "isOrbit" in props) {
          const value = props.isOrbit;
          if (typeof value === "boolean") return value;
        }
      }
      return false;
    }
    element = element.parentElement;
  }
  return false;
}
