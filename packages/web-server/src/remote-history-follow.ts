import timers from "node:timers/promises";
import type { ChThreadView } from "./ch-thread-view.ts";
import { RpcError, type StreamSink } from "./transport.ts";
import { toolOutputSink } from "./tool-output.ts";

function permanent(error: unknown): boolean {
  return (
    error instanceof RpcError &&
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
      try {
        view = await read();
        break;
      } catch (error) {
        if (permanent(error) || attempt >= 2) throw error;
        await timers.setTimeout(1500 * 2 ** attempt, undefined, {
          signal: lifetime.signal,
          ref: false,
        });
      }
    }
    if (!view || lifetime.signal.aborted) return;
    view.log.follow(toolOutputSink(view.log, sink), request);
    let busy = false,
      failures = 0,
      retryAt = 0;
    timer = setInterval(() => {
      if (busy || lifetime.signal.aborted || Date.now() < retryAt) return;
      busy = true;
      void read()
        .then(
          () => {
            failures = 0;
            retryAt = 0;
          },
          (error: unknown) => {
            // read() publishes the error. A permanent failure waits for explicit history retry.
            if (permanent(error)) {
              clearInterval(timer);
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
