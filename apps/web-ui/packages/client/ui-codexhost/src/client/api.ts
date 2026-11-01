/** Thin client for the CodexHost server's `codexhost/*` RPC methods. */
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import {
  harnessSessionImportResultSchema,
  voiceStatusResultSchema,
  voiceTranscribeResultSchema,
  harnessSessionImportSourcesResultSchema,
  harnessSessionListResultSchema,
  type HarnessSessionImportCandidate,
  type HarnessSessionImportSourcesResult,
  type HarnessSessionListParams,
} from "@codexhost/shared-contracts";

import {
  DESKTOP_SCREENSHOT_PATH,
  DESKTOP_SCREENSHOT_TIME_HEADER,
  isDesktopScreenshotError,
} from "@codexhost/shared-contracts/desktop-screenshot";

export type ImportSource = HarnessSessionImportSourcesResult["harnesses"][number];
export type ImportCandidate = HarnessSessionImportCandidate;

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
    result: { ok: true; value: T } | { ok: false; error: { message: string } };
  };
  if (!envelope.result.ok) throw new Error(envelope.result.error.message);
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

export const desktopScreenshotApi = {
  capture: async (signal: AbortSignal) => {
    const response = await fetch(DESKTOP_SCREENSHOT_PATH.slice(1), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
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
    return { image: await response.blob(), capturedAt };
  },
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
