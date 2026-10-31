import type { RendererModelClient } from "./renderer-model-client.js";
import type { HostThreadId } from "@codexhost/shared-contracts";

const REFRESH_MS = 5000;
const CHECK_TIMEOUT_MS = 5000;

interface Route {
  client: RendererModelClient;
  threadId: HostThreadId | null;
  draftCwd: string | null;
  independent: boolean;
  pending: boolean;
  checkedAt: number;
}

export interface RendererNativeInferenceRoute {
  update(
    client: RendererModelClient | null,
    threadId: HostThreadId | null,
    eligible: boolean,
    /** Workspace of a new draft; ignored when `threadId` names an existing Thread. */
    draftCwd?: string | null,
  ): boolean;
  dispose(): void;
}

export function createRendererNativeInferenceRoute(
  onChange: () => void,
): RendererNativeInferenceRoute {
  let route: Route | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let requestGeneration = 0;
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const invalidate = (): void => {
    requestGeneration++;
    clearTimer();
    route = null;
  };
  const check = (current: Route): void => {
    const generation = ++requestGeneration;
    clearTimer();
    current.pending = true;
    const finish = (independent: boolean): void => {
      if (disposed || route !== current || !current.pending || requestGeneration !== generation)
        return;
      clearTimer();
      current.pending = false;
      current.independent = independent;
      current.checkedAt = Date.now();
      timer = setTimeout(() => {
        timer = null;
        if (!disposed && route === current) onChange();
      }, REFRESH_MS);
      onChange();
    };
    // Retain only a same-target proof during bounded revalidation, never after failure.
    timer = setTimeout(() => {
      if (disposed || route !== current || !current.pending || requestGeneration !== generation)
        return;
      console.warn(
        "codexhost native inference route verification timed out; retaining Codex usage gate",
      );
      finish(false);
    }, CHECK_TIMEOUT_MS);
    void (async () => {
      try {
        const independent =
          (await current.client.usesIndependentNativeInference?.(
            current.threadId
              ? { threadId: current.threadId }
              : current.draftCwd
                ? { cwd: current.draftCwd }
                : undefined,
          )) === true;
        finish(independent);
      } catch (error) {
        if (disposed || route !== current || !current.pending || requestGeneration !== generation)
          return;
        console.warn(
          "codexhost native inference route could not be verified; retaining Codex usage gate",
          error instanceof Error ? error.name : "UnknownError",
        );
        finish(false);
      }
    })();
  };
  return {
    update(client, threadId, eligible, draftCwd = null) {
      if (disposed || !eligible || !client) {
        invalidate();
        return false;
      }
      const cwd = threadId ? null : draftCwd || null;
      if (route?.client !== client || route.threadId !== threadId || route.draftCwd !== cwd) {
        invalidate();
        route = {
          client,
          threadId,
          draftCwd: cwd,
          independent: false,
          pending: false,
          checkedAt: 0,
        };
        check(route);
      } else if (!route.pending && Date.now() - route.checkedAt >= REFRESH_MS) {
        check(route);
      }
      return route.independent;
    },
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}
