import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { committedReactAncestors } from "./renderer-react-ownership.js";

export const NATIVE_SCHEDULE_SIDEBAR_ROW_SELECTOR =
  'aside [data-sidebar-cycle-item][role="button"][aria-labelledby]';

/** Desktop 26.1023 local schedule rows own an automation above the shared sidebar item.
 * Cloud rows instead own item.automation; they must not be queried on the local Host.
 */
export function readNativeScheduleSidebarThread(element: {
  matches(selector: string): boolean;
}): string | null {
  if (!element.matches(NATIVE_SCHEDULE_SIDEBAR_ROW_SELECTOR)) return null;
  const keys = Object.keys(element).filter((key) => key.startsWith("__reactFiber$"));
  const key = keys[0];
  if (keys.length !== 1 || !key) return null;
  let scheduledContainer = false;
  const candidates = new Set<string>();
  let depth = 0;
  for (const fiber of committedReactAncestors(Reflect.get(element, key))) {
    if (++depth > 12) break;
    const props = fiber.memoizedProps as Record<string, unknown> | null;
    if (!props || typeof props !== "object") continue;
    if (Object.hasOwn(props, "data-selected-scheduled-task")) scheduledContainer = true;
    if (!scheduledContainer || !Object.hasOwn(props, "automation")) continue;
    const automation = props.automation as Record<string, unknown> | null;
    if (
      !automation ||
      typeof automation !== "object" ||
      automation.kind !== "heartbeat" ||
      typeof automation.id !== "string" ||
      !automation.id ||
      (props.hostId != null && props.hostId !== "local") ||
      (automation.hostId != null && automation.hostId !== "local")
    )
      return null;
    const parsed = hostThreadIdSchema.safeParse(automation.targetThreadId);
    if (!parsed.success) return null;
    candidates.add(parsed.data);
  }
  return candidates.size === 1 ? (candidates.values().next().value ?? null) : null;
}
