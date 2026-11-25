/** Thin client for the CodexHost server's `codexhost/*` RPC methods. */
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import {
  harnessSessionImportResultSchema,
  RELEASE_ANNOUNCEMENT_ACKNOWLEDGE_METHOD,
  RELEASE_ANNOUNCEMENT_GET_METHOD,
  REMOTE_PEERS_METHODS,
  releaseAnnouncementAcknowledgeParamsSchema,
  releaseAnnouncementGetParamsSchema,
  releaseAnnouncementGetResultSchema,
  remotePeerCreateDirResultSchema,
  remotePeerListDirsResultSchema,
  remotePeerListResultSchema,
  remotePeerRemoveResultSchema,
  remotePeerSummarySchema,
  remotePeerTestResultSchema,
  remotePeerWorkspaceMutationResultSchema,
  updateCheckResultSchema,
  voiceStatusResultSchema,
  voiceTranscribeResultSchema,
  harnessSessionImportSourcesResultSchema,
  harnessSessionListResultSchema,
  webAccessStateSchema,
  webServeResultSchema,
  webAutostartStateSchema,
  webRelayStateSchema,
  webTurnDiffsResultSchema,
  skillsListResultSchema,
  type HarnessCommandCatalog,
  type ReleaseAnnouncementGetParams,
  type RemotePeerAddParams,
  type RemotePeerCreateWorkspaceParams,
  type RemotePeerDeleteWorkspaceParams,
  type RemotePeerRenameWorkspaceParams,
  type RemotePeerSummary,
  type RemotePeerTestParams,
  type RemotePeerUpdateParams,
  type ThreadCommandExecuteResult,
  type ThreadHandoffMetadata,
  type HarnessSessionImportCandidate,
  type HarnessSessionImportSourcesResult,
  type HarnessSessionListParams,
} from "@codexhost/shared-contracts";

import type { RestoredQueuedMessage } from "@deepseek-ai/dsh-client-ui-conversation/client";
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

export async function checkHostUpdate(signal: AbortSignal) {
  const response = await fetch("api/ch/v1/rpc", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "codexhost/update/check", params: {} }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const reply = (await response.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (reply.error) throw new Error(reply.error.message ?? "Update check failed");
  return updateCheckResultSchema.parse(reply.result);
}

export async function getReleaseAnnouncement(
  signal: AbortSignal,
  params: ReleaseAnnouncementGetParams = {},
) {
  const response = await fetch("api/ch/v1/rpc", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: RELEASE_ANNOUNCEMENT_GET_METHOD,
      params: releaseAnnouncementGetParamsSchema.parse(params),
    }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const reply = (await response.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (reply.error) throw new Error(reply.error.message ?? "Release announcement check failed");
  return releaseAnnouncementGetResultSchema.parse(reply.result);
}

export async function acknowledgeReleaseAnnouncement(version: string) {
  const response = await fetch("api/ch/v1/rpc", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: RELEASE_ANNOUNCEMENT_ACKNOWLEDGE_METHOD,
      params: releaseAnnouncementAcknowledgeParamsSchema.parse({ version }),
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const reply = (await response.json()) as {
    error?: { message?: string };
  };
  if (reply.error)
    throw new Error(reply.error.message ?? "Release announcement acknowledge failed");
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

/** The server's request-trust decision for the current session. */
export async function readWebAccessAuth(
  signal: AbortSignal,
): Promise<{ authenticated: boolean; local: boolean }> {
  const response = await fetch("api/auth/status", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) return { authenticated: false, local: false };
  const status = (await response.json()) as { authenticated?: unknown; local?: unknown };
  return {
    authenticated: status.authenticated === true,
    local: status.local === true,
  };
}

/** Whether this session is authenticated from this computer (used for local-only shortcuts). */
export async function isLocalWebAccess(signal: AbortSignal): Promise<boolean> {
  const status = await readWebAccessAuth(signal);
  return status.authenticated && status.local;
}

/**
 * Copy text via the async Clipboard API, falling back to `execCommand` on plain HTTP origins
 * where `navigator.clipboard` is unavailable.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      if (typeof window !== "undefined" && window.isSecureContext) throw error;
    }
  }
  if (typeof document === "undefined" || document.body === null) {
    throw new Error("Clipboard unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error("Clipboard copy rejected");
  } finally {
    textarea.remove();
  }
}

export const accessTokenApi = {
  relay: async (
    enabled: boolean,
    settings?: { name?: string; invite?: string; kind?: "official" | "self-hosted"; host?: string },
  ) =>
    webRelayStateSchema.parse(await call<unknown>("codexhost/relaySet", { enabled, ...settings })),
  lan: (enabled: boolean) => call<{ changed: boolean }>("codexhost/lanSet", { enabled }),
  autostart: async (enabled: boolean) =>
    webAutostartStateSchema.parse(await call<unknown>("codexhost/autostartSet", { enabled })),
  serve: async (enabled: boolean) =>
    webServeResultSchema.parse(await call<unknown>("codexhost/tailscaleServeSet", { enabled })),
  get: async () => webAccessStateSchema.parse(await call<unknown>("codexhost/accessTokenGet", {})),
  regenerate: async () =>
    webAccessStateSchema.parse(await call<unknown>("codexhost/accessTokenRegenerate", {})),
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
  test: (endpoint: string) => call<{ sent: number }>("codexhost/pushTest", { endpoint }),
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

/** Cumulative file diffs are scoped to one displayed Session and Turn. */
export const turnDiffsApi = {
  read: async (sessionId: string, turn: number, path?: string) =>
    webTurnDiffsResultSchema.parse(
      await call("codexhost/turnDiffs", {
        request: { sessionId, turn, ...(path === undefined ? {} : { path }) },
      }),
    ).diffs,
};

/** Edits address a displayed occurrence; the gateway resolves its native identity. */
export const sentMessageEditApi = {
  send: (sessionId: string, atSeq: number, text: string) =>
    call<{ status: "accepted" | "rejected" | "unconfirmed" | "reverted"; message?: string }>(
      "codexhost/editMessage",
      { request: { sessionId, atSeq, text } },
    ),
};

/** Cross-Harness context handoff: creates a new target Thread with packaged context. */
export const handoffApi = {
  handoff: (request: {
    sessionId: string;
    atSeq?: number;
    targetHarnessId: string;
    targetModel?: string;
    targetThinkingOptionId?: string;
  }) =>
    call<{ sessionId: string; handoff: ThreadHandoffMetadata }>("session/handoff", {
      request,
    }),
};

/** Takes a pending queued entry off the Shared Host and restores its text and Web-owned attachments. */
export const queueMessageEditApi = {
  takeForEdit: (sessionId: string, itemId: string, revision: string) =>
    call<RestoredQueuedMessage>("codexhost/editQueueItem", {
      request: { sessionId, itemId, revision },
    }),
};

export const skillLibraryApi = {
  list: async (sessionId: string) =>
    skillsListResultSchema.parse(await call<unknown>("codexhost/skills/list", { sessionId })),
};

/** A Thread's native catalog; a draft only gets official Codex Skills from its workspace. */
export const harnessCommandApi = {
  inspect: (sessionId: string) =>
    call<HarnessCommandCatalog>("codexhost/threadCommands", {
      request: { sessionId },
    }),
  execute: (sessionId: string, commandId: string) =>
    call<ThreadCommandExecuteResult>("codexhost/executeThreadCommand", {
      request: { sessionId, commandId },
    }),
};

function parseRemotePeerResult(value: unknown): { peer: RemotePeerSummary } {
  const candidate =
    value !== null && typeof value === "object" && "peer" in value
      ? (value as { peer: unknown }).peer
      : value;
  return { peer: remotePeerSummarySchema.parse(candidate) };
}

export const remotePeersApi = {
  list: async () =>
    remotePeerListResultSchema.parse(await call<unknown>(REMOTE_PEERS_METHODS.list, {})),
  add: async (input: RemotePeerAddParams) =>
    parseRemotePeerResult(await call<unknown>(REMOTE_PEERS_METHODS.add, input)),
  update: async (input: RemotePeerUpdateParams) =>
    parseRemotePeerResult(await call<unknown>(REMOTE_PEERS_METHODS.update, input)),
  remove: async (peerId: string) =>
    remotePeerRemoveResultSchema.parse(
      await call<unknown>(REMOTE_PEERS_METHODS.remove, { peerId }),
    ),
  reconnect: async (peerId: string) =>
    parseRemotePeerResult(await call<unknown>(REMOTE_PEERS_METHODS.reconnect, { peerId })),
  test: async (input: RemotePeerTestParams) =>
    remotePeerTestResultSchema.parse(await call<unknown>(REMOTE_PEERS_METHODS.test, input)),
  listDirs: async (peerId: string, path?: string) =>
    remotePeerListDirsResultSchema.parse(
      await call<unknown>(
        REMOTE_PEERS_METHODS.listDirs,
        path === undefined ? { peerId } : { peerId, path },
      ),
    ),
  createDir: async (peerId: string, parentPath: string, name: string) =>
    remotePeerCreateDirResultSchema.parse(
      await call<unknown>(REMOTE_PEERS_METHODS.createDir, { peerId, parentPath, name }),
    ),
  createWorkspace: async (input: RemotePeerCreateWorkspaceParams) =>
    remotePeerWorkspaceMutationResultSchema.parse(
      await call<unknown>(REMOTE_PEERS_METHODS.createWorkspace, input),
    ),
  renameWorkspace: async (input: RemotePeerRenameWorkspaceParams) =>
    remotePeerWorkspaceMutationResultSchema.parse(
      await call<unknown>(REMOTE_PEERS_METHODS.renameWorkspace, input),
    ),
  deleteWorkspace: async (input: RemotePeerDeleteWorkspaceParams) =>
    remotePeerWorkspaceMutationResultSchema.parse(
      await call<unknown>(REMOTE_PEERS_METHODS.deleteWorkspace, input),
    ),
};
