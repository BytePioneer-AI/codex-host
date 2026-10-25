import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

import { installRendererExternalQueue } from "./renderer-external-queue.js";
import { installRendererExternalSteering } from "./renderer-external-steering.js";
import { isAvatarOverlayHref } from "./renderer-overlay-thread-isolation.js";

const DISCOVERY_MS = 60_000;
const INTERVAL_MS = 50;
const HOOK_WALK_LIMIT = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFollowUpManager(value: unknown): value is object {
  return (
    isRecord(value) &&
    ["sendRequest", "steerTurn", "startTurn", "getTurnCoordinator", "getConversation"].every(
      (key) => typeof value[key] === "function",
    )
  );
}

function managerFromHookState(value: unknown): object | null {
  if (isFollowUpManager(value)) return value;
  return isRecord(value) && isFollowUpManager(value.manager) ? value.manager : null;
}

function overlayFollowUpManagers(document: Document): object[] {
  const managers = new Set<object>();
  const surfaces = [...document.querySelectorAll("[data-avatar-overlay-native-surface-id]")];
  const roots = surfaces.length > 0 ? surfaces : [document.documentElement];
  for (const element of roots) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    const fiber = key ? Object.getOwnPropertyDescriptor(element, key)?.value : undefined;
    for (const current of committedReactAncestors(fiber)) {
      let hook = current.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
      for (let index = 0; hook && index < HOOK_WALK_LIMIT; index += 1) {
        const manager = managerFromHookState(hook.memoizedState);
        if (manager) managers.add(manager);
        hook = hook.next && typeof hook.next === "object" ? (hook.next as typeof hook) : null;
      }
    }
  }
  return [...managers];
}

export type OverlayExternalFollowUpsStatus = "disabled" | "pending" | "active";

export interface OverlayExternalFollowUpsHandle {
  status: OverlayExternalFollowUpsStatus;
  dispose(): void;
}

export interface OverlayExternalFollowUpsTarget {
  location?: { href: string };
  document?: Document;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/**
 * Avatar overlay is a persistent Desktop webcontents and can own an External
 * Thread's stream. This hook installs the same steer wrappers used on the
 * primary Renderer, including stream-owner admission for Host queue drain.
 */
export function installOverlayExternalFollowUps(
  target: OverlayExternalFollowUpsTarget | null = typeof globalThis === "undefined"
    ? null
    : (globalThis as unknown as OverlayExternalFollowUpsTarget),
): OverlayExternalFollowUpsHandle {
  const href = target?.location?.href;
  if (!target || typeof href !== "string" || !isAvatarOverlayHref(href)) {
    return { status: "disabled", dispose() {} };
  }
  const wrapped = new WeakSet<object>();
  const cleanups = new Set<() => void>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  const handle: OverlayExternalFollowUpsHandle = {
    status: "pending",
    dispose() {
      disposed = true;
      if (timer !== undefined) target.clearTimeout(timer);
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          /* Release the remaining hooks too. */
        }
      }
      cleanups.clear();
    },
  };
  const attempt = (): void => {
    if (disposed) return;
    const document = target.document;
    if (document) {
      for (const manager of overlayFollowUpManagers(document)) {
        if (wrapped.has(manager)) continue;
        const queue = installRendererExternalQueue(manager);
        const steering = installRendererExternalSteering(manager);
        if (!queue && !steering) continue;
        wrapped.add(manager);
        if (queue) cleanups.add(queue);
        if (steering) cleanups.add(steering);
        handle.status = "active";
      }
    }
    if (disposed || handle.status === "active") return;
    if (Date.now() - started >= DISCOVERY_MS) return;
    timer = target.setTimeout(attempt, INTERVAL_MS);
  };
  attempt();
  return handle;
}
