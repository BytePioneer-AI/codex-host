import type { RendererModelClient } from "./renderer-model-client.js";
import type { HostThreadId } from "@codexhost/shared-contracts";

const REFRESH_MS = 5000;
const CHECK_TIMEOUT_MS = 5000;

export interface RendererNativeDraftScope {
  draftId: string;
  cwd: string;
}

export interface RendererNativeDraftComposer {
  composer: object;
  hostId: string | null;
  draftId: string | null;
}

interface BoundDraftWorkspace {
  hostId: string;
  draftId: string;
  cwd: string;
}

export interface RendererNativeDraftWorkspaceStore {
  publish(
    input: { hostId: string; cwd: string; draftId?: string | null },
    activeDrafts: readonly RendererNativeDraftComposer[],
  ): void;
  resolve(draft: RendererNativeDraftComposer): RendererNativeDraftScope | null;
  delete(composer: object): void;
  clear(hostId?: string): void;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Tracks confirmed draft workspaces bound to a mounted Composer, Host, and
 * draft identity. Host-level prewarm updates only bind when a single mounted
 * draft exists on that Host; ambiguous or unowned updates fail closed.
 */
export function createRendererNativeDraftWorkspaceStore(): RendererNativeDraftWorkspaceStore {
  const bindings = new Map<object, BoundDraftWorkspace>();
  const clearHost = (hostId: string): void => {
    for (const [composer, entry] of bindings) {
      if (entry.hostId === hostId) bindings.delete(composer);
    }
  };
  return {
    publish(input, activeDrafts) {
      const hostId = nonEmpty(input.hostId);
      const cwd = nonEmpty(input.cwd);
      if (!hostId || !cwd) return;
      const explicitDraftId = nonEmpty(input.draftId);
      const hostDrafts = activeDrafts.filter(
        (candidate): candidate is { composer: object; hostId: string; draftId: string } =>
          candidate.hostId === hostId && nonEmpty(candidate.draftId) !== null,
      );
      if (explicitDraftId) {
        const matches = hostDrafts.filter((candidate) => candidate.draftId === explicitDraftId);
        if (matches.length !== 1 || !matches[0]) {
          for (const candidate of matches) bindings.delete(candidate.composer);
          return;
        }
        bindings.set(matches[0].composer, { hostId, draftId: explicitDraftId, cwd });
        return;
      }
      if (hostDrafts.length !== 1 || !hostDrafts[0]) {
        if (hostDrafts.length > 1) clearHost(hostId);
        return;
      }
      bindings.set(hostDrafts[0].composer, { hostId, draftId: hostDrafts[0].draftId, cwd });
    },
    resolve(draft) {
      const hostId = nonEmpty(draft.hostId);
      const draftId = nonEmpty(draft.draftId);
      if (!hostId || !draftId) {
        bindings.delete(draft.composer);
        return null;
      }
      const entry = bindings.get(draft.composer);
      if (!entry) return null;
      if (entry.hostId !== hostId || entry.draftId !== draftId) {
        bindings.delete(draft.composer);
        return null;
      }
      return { draftId: entry.draftId, cwd: entry.cwd };
    },
    delete(composer) {
      bindings.delete(composer);
    },
    clear(hostId) {
      if (hostId === undefined) bindings.clear();
      else clearHost(hostId);
    },
  };
}

interface Route {
  client: RendererModelClient;
  threadId: HostThreadId | null;
  draftId: string | null;
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
    /** Confirmed identity and workspace of a new draft; ignored when `threadId` names an existing Thread. */
    draft?: RendererNativeDraftScope | null,
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
        const target = current.threadId
          ? { threadId: current.threadId }
          : current.draftCwd
            ? { cwd: current.draftCwd }
            : null;
        if (!target) {
          finish(false);
          return;
        }
        const independent =
          (await current.client.usesIndependentNativeInference?.(target)) === true;
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
    update(client, threadId, eligible, draft = null) {
      if (disposed || !eligible || !client) {
        invalidate();
        return false;
      }
      const draftId = threadId ? null : nonEmpty(draft?.draftId);
      const draftCwd = threadId ? null : nonEmpty(draft?.cwd);
      if (!threadId && (!draftId || !draftCwd)) {
        invalidate();
        return false;
      }
      if (
        route?.client !== client ||
        route.threadId !== threadId ||
        route.draftId !== draftId ||
        route.draftCwd !== draftCwd
      ) {
        invalidate();
        route = {
          client,
          threadId,
          draftId,
          draftCwd,
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
