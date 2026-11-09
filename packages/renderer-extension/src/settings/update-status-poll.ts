import type { UpdateStatus, UpdateStatusResult } from "@codexhost/shared-contracts";
import type { RendererSettingsPageMountContext } from "./core.js";
import {
  RENDERER_UPDATE_REQUEST_TIMEOUT_MS,
  runBoundedRendererUpdateRequest,
} from "./update-request.js";

export const RENDERER_UPDATE_STATUS_WAIT_MS = 10 * 60_000;
const STATUS_POLL_INTERVAL_MS = 750;

/** Reads update status through service restarts without submitting another update. */
export function createRendererUpdateStatusPoll(
  context: RendererSettingsPageMountContext,
  handlers: {
    status(status: UpdateStatus | null): void;
    reconnecting(): void;
    unavailable(): void;
  },
): {
  start(readStatus: () => Promise<UpdateStatusResult>, previousStatus?: UpdateStatus | null): void;
  dispose(): void;
} {
  const window = context.content.ownerDocument.defaultView;
  let timer: number | undefined;
  let deadline = 0;
  let disposed = false;
  const active = (): boolean => !disposed && !context.signal.aborted;
  const clearTimer = (): void => {
    if (timer !== undefined) window?.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (
    readStatus: () => Promise<UpdateStatusResult>,
    previousStatus: UpdateStatus | null,
  ): void => {
    clearTimer();
    if (!active()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      handlers.unavailable();
      return;
    }
    timer = window?.setTimeout(
      () => {
        timer = undefined;
        if (!active()) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          handlers.unavailable();
          return;
        }
        void context.runLatest(
          (signal) =>
            runBoundedRendererUpdateRequest(
              readStatus,
              signal,
              Math.min(RENDERER_UPDATE_REQUEST_TIMEOUT_MS, remaining),
            ),
          {
            success(result) {
              if (!active()) return;
              const terminal =
                result.status && ["succeeded", "failed"].includes(result.status.phase);
              // An interrupted start can leave the previous operation's terminal status intact.
              const previousResult =
                terminal &&
                previousStatus?.version === result.status?.version &&
                previousStatus?.phase === result.status?.phase &&
                previousStatus?.updatedAt === result.status?.updatedAt;
              if (!previousResult) handlers.status(result.status);
              if (!terminal || previousResult) schedule(readStatus, previousStatus);
            },
            failure() {
              if (!active()) return;
              if (Date.now() < deadline) handlers.reconnecting();
              schedule(readStatus, previousStatus);
            },
          },
        );
      },
      Math.min(STATUS_POLL_INTERVAL_MS, remaining),
    );
  };
  return {
    start(readStatus, previousStatus = null) {
      deadline = Date.now() + RENDERER_UPDATE_STATUS_WAIT_MS;
      schedule(readStatus, previousStatus);
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
