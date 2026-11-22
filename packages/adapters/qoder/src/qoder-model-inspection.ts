import type { QoderModelInfo, QoderQuery } from "./qoder-sdk-types.js";

const MODEL_INSPECTION_TIMEOUT_MS = 10_000;

/** One initialization + live read, bounded together and cancelled when the Adapter closes. */
export async function loadQoderModels(
  query: Pick<QoderQuery, "initializationResult" | "getAvailableModels">,
  controller: AbortController,
  closing: AbortSignal,
): Promise<QoderModelInfo[]> {
  const cancel = () => controller.abort(closing.reason);
  closing.addEventListener("abort", cancel, { once: true });
  if (closing.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new Error("Qoder Model inspection timed out after 10000ms")),
    MODEL_INSPECTION_TIMEOUT_MS,
  );
  let rejectAborted: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAborted, { once: true });
    if (controller.signal.aborted) rejectAborted();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        await query.initializationResult?.();
        controller.signal.throwIfAborted();
        return (await query.getAvailableModels?.({ fetchStrategy: "live" })) ?? [];
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    closing.removeEventListener("abort", cancel);
    if (rejectAborted) controller.signal.removeEventListener("abort", rejectAborted);
  }
}
