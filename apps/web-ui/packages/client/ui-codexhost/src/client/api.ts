/** Thin client for the CodexHost server's `codexhost/*` RPC methods. */
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import {
  harnessSessionImportResultSchema,
  voiceStatusResultSchema,
  voiceTranscribeResultSchema,
  harnessSessionImportSourcesResultSchema,
  harnessSessionListResultSchema,
  webAccessTokenCreateResultSchema,
  webAccessTokenDeleteResultSchema,
  webAccessTokenListResultSchema,
  type HarnessSessionImportCandidate,
  type HarnessSessionImportSourcesResult,
  type HarnessSessionListParams,
} from "@codexhost/shared-contracts";

import type { DesktopScreenshotProgress } from "./desktop-screenshot.ts";
import {
  DESKTOP_SCREENSHOT_PATH,
  DESKTOP_SCREENSHOT_TIME_HEADER,
  isDesktopScreenshotError,
} from "@codexhost/shared-contracts/desktop-screenshot";

export type ImportSource = HarnessSessionImportSourcesResult["harnesses"][number];
export type ImportCandidate = HarnessSessionImportCandidate;

/** A failed RPC, keeping the server's error code for callers that treat some codes specially. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`api/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: { args },
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const envelope = (await response.json()) as {
    result:
      | { ok: true; value: T }
      | { ok: false; error: { message: string; code: string; details?: unknown } };
  };
  if (!envelope.result.ok) {
    const { message, code, details } = envelope.result.error;
    throw new ApiError(message, code, details);
  }
  return envelope.result.value;
}

export const voiceApi = {
  status: async () =>
    voiceStatusResultSchema.parse(await call<unknown>("codexhost/voice/status", {})),
  transcribe: async (audio: Blob, signal: AbortSignal) => {
    const response = await fetch("api/voice/transcribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": audio.type },
      body: audio,
      signal,
    });
    // Validation failures also return a typed result (e.g. HTTP 413).
    return voiceTranscribeResultSchema.parse(await response.json());
  },
};

/** Longest wait for response headers: the Host's 15s native capture plus network margin. */
const SCREENSHOT_HEADERS_TIMEOUT_MS = 25_000;
/** Longest silence while the image streams in. */
const SCREENSHOT_STALL_TIMEOUT_MS = 20_000;
/** Capture slots are released a moment after an aborted request closes; retry `busy` briefly. */
const SCREENSHOT_BUSY_RETRIES = 3;
const SCREENSHOT_BUSY_DELAY_MS = 500;

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

export const desktopScreenshotApi = {
  capture: async (
    signal: AbortSignal,
    onProgress?: (progress: DesktopScreenshotProgress) => void,
  ) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await captureOnce(signal, onProgress);
      } catch (error) {
        if (!(
          error instanceof Error &&
          error.message === "busy" &&
          attempt < SCREENSHOT_BUSY_RETRIES
        ))
          throw error;
        await delay(SCREENSHOT_BUSY_DELAY_MS, signal);
      }
    }
  },
};

/**
 * One capture request with a progress watchdog: a phone link that stalls
 * surfaces as `timeout` instead of an endless spinner.
 */
async function captureOnce(
  signal: AbortSignal,
  onProgress?: (progress: DesktopScreenshotProgress) => void,
) {
  const link = new AbortController();
  const forward = (): void => link.abort();
  signal.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const watch = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      link.abort();
    }, ms);
  };
  try {
    watch(SCREENSHOT_HEADERS_TIMEOUT_MS);
    const response = await fetch(DESKTOP_SCREENSHOT_PATH.slice(1), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: link.signal,
    });
    watch(SCREENSHOT_STALL_TIMEOUT_MS);
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as
        { error?: unknown } | undefined;
      throw new Error(isDesktopScreenshotError(failure?.error) ? failure.error : "unavailable");
    }
    const capturedAt = response.headers.get(DESKTOP_SCREENSHOT_TIME_HEADER);
    if (
      response.headers.get("content-type") !== "image/png" ||
      capturedAt === null ||
      !Number.isFinite(Date.parse(capturedAt))
    )
      throw new Error("capture-failed");
    // Headers arrive only after the Host finished capturing, so everything from
    // here on is transfer time; report it so a slow link reads as progress.
    const length = Number(response.headers.get("content-length"));
    const total = Number.isFinite(length) && length > 0 ? length : undefined;
    onProgress?.({ loaded: 0, total });
    if (response.body === null) return { image: await response.blob(), capturedAt };
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watch(SCREENSHOT_STALL_TIMEOUT_MS);
      chunks.push(value);
      loaded += value.length;
      onProgress?.({ loaded, total });
    }
    return { image: new Blob(chunks, { type: "image/png" }), capturedAt };
  } catch (error) {
    if (timedOut && !signal.aborted) throw new Error("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forward);
  }
}

export const accessTokenApi = {
  list: async () =>
    webAccessTokenListResultSchema.parse(await call<unknown>("codexhost/accessTokenList", {})),
  create: async (name: string) =>
    webAccessTokenCreateResultSchema.parse(
      await call<unknown>("codexhost/accessTokenCreate", { name }),
    ),
  delete: async (id: string) =>
    webAccessTokenDeleteResultSchema.parse(
      await call<unknown>("codexhost/accessTokenDelete", { id }),
    ),
};

export const pushApi = {
  config: () => call<{ publicKey: string; subscriptions: number }>("codexhost/pushConfig", {}),
  subscribe: (subscription: PushSubscriptionJSON) =>
    call<{ subscribed: boolean }>("codexhost/pushSubscribe", {
      subscription,
      userAgent: navigator.userAgent,
    }),
  unsubscribe: (endpoint: string) =>
    call<{ subscribed: boolean }>("codexhost/pushUnsubscribe", { endpoint }),
  test: () => call<{ sent: number }>("codexhost/pushTest", {}),
};

export const importApi = {
  sources: async () =>
    harnessSessionImportSourcesResultSchema.parse(
      await call<unknown>("codexhost/importSources", {}),
    ),
  candidates: async (request: HarnessSessionListParams) =>
    harnessSessionListResultSchema.parse(
      await call<unknown>("codexhost/importCandidates", { request }),
    ),
  importSession: async (harnessId: string, nativeSessionId: string) =>
    harnessSessionImportResultSchema.parse(
      await call<unknown>("codexhost/import", {
        request: { harnessId, nativeSessionId },
      }),
    ),
};

/** Edits address a displayed occurrence; the gateway resolves its native identity. */
export const sentMessageEditApi = {
  send: (sessionId: string, atSeq: number, text: string) =>
    call<{ status: "accepted" | "rejected" | "unconfirmed" | "reverted"; message?: string }>(
      "codexhost/editMessage",
      { request: { sessionId, atSeq, text } },
    ),
};

/** Thread-only discovery; never falls back to a draft Harness query. */
export const harnessCommandApi = {
  inspect: (sessionId: string) =>
    call<import("@codexhost/shared-contracts").HarnessCommandCatalog>("codexhost/threadCommands", {
      request: { sessionId },
    }),
  execute: (sessionId: string, commandId: string) =>
    call<import("@codexhost/shared-contracts").ThreadCommandExecuteResult>(
      "codexhost/executeThreadCommand",
      {
        request: { sessionId, commandId },
      },
    ),
};
