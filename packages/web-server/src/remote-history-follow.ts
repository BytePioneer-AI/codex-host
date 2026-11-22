import timers from "node:timers/promises";
import type { ChThreadView } from "./ch-thread-view.ts";
import { RpcError, type StreamSink } from "./transport.ts";
import { toolOutputSink } from "./tool-output.ts";

function permanent(error: { code: string } | undefined): boolean {
  return (
    error !== undefined &&
    [
      "remote/history-too-large",
      "remote/controller-rejected",
      "remote/not-found",
      "remote/identity-invalid",
    ].includes(error.code)
  );
}

/** A read-only follower: retry initial transient failures, preserve live history on later failures. */
export async function followRemoteHistory(
  read: () => Promise<ChThreadView>,
  sink: StreamSink,
  request: Parameters<ChThreadView["log"]["follow"]>[1],
  shutdown: AbortSignal,
  failure: () => { code: string; message: string } | undefined,
  isCurrent: (view: ChThreadView) => boolean,
  refreshQueue: (view: ChThreadView) => void,
): Promise<void> {
  const lifetime = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    lifetime.abort();
    clearInterval(timer);
    shutdown.removeEventListener("abort", close);
  };
  sink.onClose(close);
  shutdown.addEventListener("abort", close, { once: true });
  if (sink.closed || shutdown.aborted) close();
  try {
    let view: ChThreadView | undefined;
    for (let attempt = 0; !lifetime.signal.aborted; attempt++) {
      const shared = attempt > 0 ? failure() : undefined;
      if (shared && permanent(shared)) throw new RpcError(shared.code, shared.message);
      try {
        view = await read();
        break;
      } catch (error) {
        if ((error instanceof RpcError && permanent(error)) || attempt >= 2) throw error;
        await timers.setTimeout(1500 * 2 ** attempt, undefined, {
          signal: lifetime.signal,
          ref: false,
        });
      }
    }
    if (!view || lifetime.signal.aborted) return;
    if (!isCurrent(view))
      throw new RpcError("remote/connection-changed", "Remote history changed before subscribing");
    view.log.follow(toolOutputSink(view.log, sink), request);
    if (lifetime.signal.aborted) return;
    let busy = false,
      failures = 0,
      retryAt = 0;
    timer = setInterval(() => {
      if (lifetime.signal.aborted) return;
      refreshQueue(view);
      if (busy || permanent(failure()) || Date.now() < retryAt) return;
      busy = true;
      void read()
        .then(
          () => {
            failures = 0;
            retryAt = 0;
          },
          (error: unknown) => {
            if (
              error instanceof RpcError &&
              ["remote/not-found", "remote/identity-invalid"].includes(error.code)
            ) {
              sink.fail(error.code, error.message);
              close();
              return;
            }
            // The source owns recovery: another viewer or an explicit read can clear its error.
            if (error instanceof RpcError && permanent(error)) {
              failures = 0;
              retryAt = 0;
              return;
            }
            failures = Math.min(failures + 1, 5);
            retryAt = Date.now() + Math.min(30_000, 1500 * 2 ** failures);
          },
        )
        .finally(() => {
          busy = false;
        });
    }, 1500);
    timer.unref();
  } catch (error) {
    const cancelled = lifetime.signal.aborted;
    close();
    if (!cancelled) throw error;
  }
}
