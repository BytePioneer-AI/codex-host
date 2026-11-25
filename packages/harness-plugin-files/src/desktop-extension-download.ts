import { setTimeout as delay } from "node:timers/promises";
import {
  desktopExtensionHttpUrlSchema,
  isGitHubDesktopExtensionZipballUrl,
} from "@codexhost/shared-contracts";

const githubHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "codexhost-desktop-extensions",
};
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 400;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class ExtensionDownloadError extends Error {}

export class ExtensionHttpError extends ExtensionDownloadError {
  constructor(readonly status: number) {
    super(`Download returned HTTP ${status}`);
  }
}

export interface ExtensionDownloadOptions {
  signal?: AbortSignal | undefined;
  allowUrl: (url: URL) => boolean;
  timeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  retries?: number | undefined;
  retryBaseDelayMs?: number | undefined;
}

function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof ExtensionHttpError) return RETRYABLE_HTTP_STATUSES.has(error.status);
  return !(error instanceof ExtensionDownloadError);
}

export async function downloadExtensionBytes(
  url: string,
  limit: number,
  headers: Record<string, string> | undefined,
  {
    signal: callerSignal,
    allowUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idleTimeoutMs,
    retries = 0,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  }: ExtensionDownloadOptions,
) {
  const parsed = desktopExtensionHttpUrlSchema.safeParse(url);
  if (!parsed.success) throw new ExtensionDownloadError("Expected a credential-free HTTP(S) URL");
  const initialTarget = new URL(parsed.data);
  const requestHeaders =
    headers ?? (isGitHubDesktopExtensionZipballUrl(initialTarget) ? githubHeaders : undefined);
  const effectiveIdleMs = Math.min(idleTimeoutMs ?? timeoutMs, timeoutMs);
  const totalTimeout = AbortSignal.timeout(timeoutMs);
  const overallSignal = callerSignal ? AbortSignal.any([totalTimeout, callerSignal]) : totalTimeout;

  for (let attempt = 0; ; attempt++) {
    if (callerSignal?.aborted)
      throw new ExtensionDownloadError("Download aborted", { cause: callerSignal.reason });
    if (totalTimeout.aborted)
      throw new ExtensionDownloadError("Download timed out", { cause: totalTimeout.reason });

    const attemptController = new AbortController();
    const signal = AbortSignal.any([overallSignal, attemptController.signal]);
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        attemptController.abort(new Error("Download timed out"));
      }, effectiveIdleMs);
    };
    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    try {
      let target = new URL(initialTarget.href);
      let response: Response;
      for (let redirects = 0; ; redirects++) {
        if (!allowUrl(target) || target.username || target.password)
          throw new ExtensionDownloadError("Unsafe download URL");
        resetIdle();
        response = await fetch(target.href, {
          signal,
          redirect: "manual",
          ...(requestHeaders ? { headers: requestHeaders } : {}),
        });
        const location = response.headers.get("location");
        if (!location || ![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel().catch(() => undefined);
        if (redirects >= 4) throw new ExtensionDownloadError("Too many download redirects");
        try {
          target = new URL(location, target);
        } catch {
          throw new ExtensionDownloadError("Invalid download redirect URL");
        }
      }
      const body = response.body;
      if (!response.ok || !body || Number(response.headers.get("content-length")) > limit) {
        await body?.cancel().catch(() => undefined);
        if (!response.ok) throw new ExtensionHttpError(response.status);
        throw new ExtensionDownloadError("Download is empty or exceeds the size limit");
      }
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          resetIdle();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new ExtensionDownloadError("Download exceeds the size limit");
          chunks.push(value);
        }
      } finally {
        clearIdle();
        await reader.cancel().catch(() => undefined);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      clearIdle();
      if (callerSignal?.aborted)
        throw new ExtensionDownloadError("Download aborted", { cause: callerSignal.reason });
      if (totalTimeout.aborted)
        throw new ExtensionDownloadError("Download timed out", { cause: totalTimeout.reason });
      if (attempt < retries && isRetryableDownloadError(error)) {
        const waitMs = retryBaseDelayMs * 2 ** attempt;
        try {
          if (waitMs > 0) await delay(waitMs, undefined, { signal: overallSignal });
        } catch (delayError) {
          if (callerSignal?.aborted)
            throw new ExtensionDownloadError("Download aborted", { cause: callerSignal.reason });
          throw new ExtensionDownloadError("Download timed out", { cause: delayError });
        }
        continue;
      }
      if (error instanceof ExtensionDownloadError) throw error;
      throw new ExtensionDownloadError(idleTimedOut ? "Download timed out" : "Download failed", {
        cause: error,
      });
    }
  }
}
