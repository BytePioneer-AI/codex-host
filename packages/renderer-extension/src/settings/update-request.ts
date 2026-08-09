export const RENDERER_UPDATE_REQUEST_TIMEOUT_MS = 15_000;

export class RendererUpdateRequestTimeoutError extends Error {
  constructor() {
    super("Update request timed out");
    this.name = "RendererUpdateRequestTimeoutError";
  }
}

export function runBoundedRendererUpdateRequest<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs = RENDERER_UPDATE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (handler: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      handler();
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new RendererUpdateRequestTimeoutError()));
    }, timeoutMs);
    const abort = (): void => {
      settle(() => reject(new Error("Update request was aborted")));
    };

    const rejectRequest = (error: unknown): void => {
      settle(() => reject(error));
    };

    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    try {
      void operation().then(
        (value) => settle(() => resolve(value)),
        (error) => rejectRequest(error),
      );
    } catch (error) {
      rejectRequest(error);
    }
  });
}
