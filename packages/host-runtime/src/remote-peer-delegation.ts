import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  PEER_DELEGATION_BRIDGE_DIR,
  PEER_DELEGATION_MAX_HOPS,
  harnessIdSchema,
  jsonValueSchema,
  peerDelegationBridgeDescriptorSchema,
  peerDelegationHostsResultSchema,
  peerDelegationRequestSchema,
  peerDelegationResponseSchema,
  peerIdFromRemoteHostId,
  type PeerDelegationBridgeDescriptor,
  type PeerDelegationBridgeRequest,
  type PeerDelegationHostsResult,
  type PeerDelegationOperation,
  type PeerDelegationResponse,
  type PeerDelegationHostSummary,
} from "@codexhost/shared-contracts";
import { validateReadOptions } from "./delegation-snapshot.js";
import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlErrorCode,
  type DelegationStartInput,
  type DelegationThreadSnapshot,
  type HarnessInspectInput,
  type PersistedDelegationLookup,
  type ThreadAnswerInput,
  type ThreadCancelInput,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadSendInput,
  type ThreadWaitInput,
} from "./delegation-types.js";
import { startWithDelegationWorktree } from "./delegation-worktree.js";
import { peerOrigin } from "./external-client-origin.js";
import { codexhostDataDirectory } from "./external-clients.js";
import {
  canonicalizeWorktreePath,
  type PersistedPeerStartRecord,
  type WorktreeOwnerClaimResult,
} from "./peer-start-idempotency-store.js";

const execFileAsync = promisify(execFile);

const BRIDGE_ROUTE = "/v1/peer/delegation";
const DEFAULT_BRIDGE_TIMEOUT_MS = 65_000;
const MAX_BRIDGE_DESCRIPTOR_BYTES = 4096;
const DEFAULT_REMOTE_WAIT_POLL_INTERVALS_MS = [250, 500, 1_000, 1_500, 2_000] as const;

const VALID_ERROR_CODES: ReadonlySet<string> = new Set<DelegationControlErrorCode>([
  "INVALID_ARGUMENT",
  "HARNESS_NOT_FOUND",
  "THREAD_NOT_FOUND",
  "THREAD_BUSY",
  "PARENT_THREAD_AMBIGUOUS",
  "RESPONSE_TOO_LARGE",
  "RUNTIME_UNREACHABLE",
  "DELEGATION_FAILED",
  "FORBIDDEN",
  "UNSUPPORTED",
  "UNAUTHORIZED",
  "CURSOR_EXPIRED",
  "QUESTION_NOT_PENDING",
  "INTERNAL_ERROR",
]);

const CLIENT_SAFE_ERROR_MESSAGES: Readonly<Record<DelegationControlErrorCode, string>> = {
  INVALID_ARGUMENT: "Invalid peer delegation request",
  HARNESS_NOT_FOUND: "Requested Harness is unavailable on remote Peer",
  THREAD_NOT_FOUND: "Thread was not found on remote Peer",
  THREAD_BUSY: "Thread is busy on remote Peer",
  PARENT_THREAD_AMBIGUOUS: "Remote Peer runtime session is ambiguous",
  RESPONSE_TOO_LARGE: "Response from remote Peer is too large",
  RUNTIME_UNREACHABLE: "Remote Peer runtime is unavailable",
  DELEGATION_FAILED: "Peer delegation operation failed",
  FORBIDDEN: "Peer delegation request is forbidden",
  UNSUPPORTED: "Operation is not supported on remote Peer",
  UNAUTHORIZED: "Peer delegation request is unauthorized",
  CURSOR_EXPIRED: "Cursor expired on remote Peer",
  QUESTION_NOT_PENDING: "Question is no longer pending on remote Peer",
  INTERNAL_ERROR: "Peer delegation operation failed",
};

export function isRemoteHostId(hostId: string | undefined): hostId is string {
  return typeof hostId === "string" && hostId.length > 0 && hostId !== "local";
}

export function isRemotePeerHostId(hostId: string | undefined): hostId is string {
  return typeof hostId === "string" && peerIdFromRemoteHostId(hostId) !== undefined;
}

export function remoteThreadLink(threadId: string, hostId: string): string {
  return `thread://${threadId}?hostId=${encodeURIComponent(hostId)}`;
}

export function remoteNextHints(threadId: string, hostId: string): { read: string; wait: string } {
  const link = remoteThreadLink(threadId, hostId);
  return {
    read: `codexhost thread read ${link}`,
    wait: `codexhost thread wait ${link} --timeout-ms 30000`,
  };
}

/**
 * Uniform Thread reference parser shared by HTTP routes and MCP tools.
 * Preserves `hostId` from `thread://<id>?hostId=<encoded>` and rejects conflicting or invalid host selections.
 */
export function parseThreadReferenceInput(
  rawThreadId: unknown,
  rawHostId?: unknown,
): { threadId: string; hostId?: string } {
  if (typeof rawThreadId !== "string" || !rawThreadId.trim()) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is invalid");
  }
  let explicitHostId: string | undefined;
  if (rawHostId !== undefined) {
    if (typeof rawHostId !== "string" || !rawHostId.trim()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "hostId must be a non-empty string");
    }
    explicitHostId = rawHostId;
  }
  if (rawThreadId.startsWith("thread://")) {
    const match = /^thread:\/\/([^/?#]+)(?:\?hostId=([^&#]+))?$/u.exec(rawThreadId);
    if (!match?.[1]) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Thread reference is invalid");
    }
    let decodedHost: string | undefined;
    if (match[2] !== undefined) {
      try {
        decodedHost = decodeURIComponent(match[2]);
      } catch {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread reference is invalid");
      }
      if (!decodedHost.trim()) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread reference is invalid");
      }
    }
    if (explicitHostId && decodedHost && explicitHostId !== decodedHost) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "hostId conflicts with the Thread reference",
      );
    }
    const hostId = explicitHostId ?? decodedHost;
    return { threadId: match[1], ...(hostId ? { hostId } : {}) };
  }
  const prefix = "codex://threads/";
  const normalized = rawThreadId.startsWith(prefix)
    ? rawThreadId.slice(prefix.length)
    : rawThreadId;
  if (
    !normalized ||
    normalized.includes("/") ||
    normalized.includes("?") ||
    normalized.includes("#")
  ) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is invalid");
  }
  return { threadId: normalized, ...(explicitHostId ? { hostId: explicitHostId } : {}) };
}

export function peerDelegationBridgeDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), PEER_DELEGATION_BRIDGE_DIR);
}

function isLoopbackBridgeEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
    return false;
  const host = parsed.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "localhost";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readBridgeDescriptorFile(
  filePath: string,
): Promise<PeerDelegationBridgeDescriptor | undefined> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BRIDGE_DESCRIPTOR_BYTES) {
      return undefined;
    }
    if (process.platform !== "win32" && typeof process.getuid === "function") {
      if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
        return undefined;
      }
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const parsed = peerDelegationBridgeDescriptorSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      !isLoopbackBridgeEndpoint(parsed.data.endpoint) ||
      !isProcessAlive(parsed.data.pid)
    ) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readPeerDelegationBridges(
  environment: NodeJS.ProcessEnv,
): Promise<PeerDelegationBridgeDescriptor[]> {
  const dir = peerDelegationBridgeDirectory(environment);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const candidates = names.filter((name) => name.startsWith("bridge-") && name.endsWith(".json"));
  const descriptors = (
    await Promise.all(candidates.map((name) => readBridgeDescriptorFile(path.join(dir, name))))
  ).filter((entry): entry is PeerDelegationBridgeDescriptor => entry !== undefined);
  descriptors.sort((left, right) => right.startedAt - left.startedAt);
  return descriptors;
}

export interface RemotePeerCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RemotePeerDelegationClient {
  listHosts(): Promise<PeerDelegationHostsResult>;
  call(
    input: {
      hostId: string;
      operation: PeerDelegationOperation;
      hopCount: number;
      input: JsonObject;
    },
    options?: RemotePeerCallOptions,
  ): Promise<unknown>;
}

function toControlErrorCode(code: string): DelegationControlErrorCode {
  return VALID_ERROR_CODES.has(code) ? (code as DelegationControlErrorCode) : "DELEGATION_FAILED";
}

function abortTimeoutError(): DelegationControlError {
  return new DelegationControlError(
    "RUNTIME_UNREACHABLE",
    "Remote peer delegation request timed out",
    { timedOut: true },
  );
}

async function requestSingleBridge(
  descriptor: PeerDelegationBridgeDescriptor,
  request: PeerDelegationBridgeRequest,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
    diagnose?: (error: unknown) => void;
  } = {},
): Promise<unknown> {
  if (options.signal?.aborted) throw abortTimeoutError();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS, 120_000));
  const payload: PeerDelegationBridgeRequest =
    request.operation === "hosts" ? request : { ...request, timeoutMs };
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL(BRIDGE_ROUTE, descriptor.endpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal,
    });
  } catch (error) {
    options.diagnose?.(error);
    if (options.signal?.aborted || timeoutSignal.aborted) {
      throw abortTimeoutError();
    }
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      "Remote peer delegation bridge is unreachable; do not retry write operations automatically.",
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      `Remote peer delegation bridge returned an invalid response (HTTP ${response.status})`,
    );
  }
  const parsed = peerDelegationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DelegationControlError(
      "INTERNAL_ERROR",
      "Remote peer delegation bridge returned an invalid envelope",
    );
  }
  if (!parsed.data.ok) {
    throw new DelegationControlError(
      toControlErrorCode(parsed.data.error.code),
      parsed.data.error.message,
      parsed.data.error.details,
    );
  }
  return parsed.data.value;
}

function hostPriority(host: PeerDelegationHostSummary): number {
  return (host.online ? 2 : 0) + (host.delegation ? 1 : 0);
}

export function createRemotePeerDelegationClient(
  environment: NodeJS.ProcessEnv,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    diagnose?: (error: unknown) => void;
  } = {},
): RemotePeerDelegationClient {
  return {
    async listHosts(): Promise<PeerDelegationHostsResult> {
      const bridges = await readPeerDelegationBridges(environment);
      if (bridges.length === 0) return { hosts: [] };
      const settled = await Promise.allSettled(
        bridges.map(async (descriptor) => {
          const value = await requestSingleBridge(descriptor, { operation: "hosts" }, options);
          const parsed = peerDelegationHostsResultSchema.safeParse(value);
          if (!parsed.success) return [];
          return parsed.data.hosts;
        }),
      );
      const merged = new Map<string, PeerDelegationHostSummary>();
      for (const outcome of settled) {
        if (outcome.status !== "fulfilled") continue;
        for (const host of outcome.value) {
          const existing = merged.get(host.hostId);
          if (!existing || hostPriority(host) > hostPriority(existing)) {
            merged.set(host.hostId, host);
          }
        }
      }
      return { hosts: [...merged.values()] };
    },
    async call(input, callOptions = {}) {
      if (callOptions.signal?.aborted) throw abortTimeoutError();
      const startedAt = performance.now();
      const bridges = await readPeerDelegationBridges(environment);
      if (callOptions.signal?.aborted) throw abortTimeoutError();
      if (bridges.length === 0) {
        throw new DelegationControlError(
          "RUNTIME_UNREACHABLE",
          "Remote peer delegation bridge is unavailable. Start codexhost Web with paired remote peers.",
        );
      }
      const remainingTimeout = (): number | undefined => {
        if (callOptions.timeoutMs === undefined) return undefined;
        const left = Math.floor(callOptions.timeoutMs - (performance.now() - startedAt));
        if (left <= 0) throw abortTimeoutError();
        return left;
      };
      const buildOptions = () => {
        const left = remainingTimeout();
        return {
          ...options,
          ...(left !== undefined ? { timeoutMs: left } : {}),
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        };
      };
      if (bridges.length === 1) {
        return requestSingleBridge(
          bridges[0] as PeerDelegationBridgeDescriptor,
          input,
          buildOptions(),
        );
      }
      const probeLeft = remainingTimeout();
      const probeTimeout = Math.min(probeLeft ?? 5_000, 5_000);
      const owners: PeerDelegationBridgeDescriptor[] = [];
      const probes = await Promise.allSettled(
        bridges.map(async (descriptor) => {
          const value = await requestSingleBridge(
            descriptor,
            { operation: "hosts" },
            {
              ...options,
              timeoutMs: probeTimeout,
              ...(callOptions.signal ? { signal: callOptions.signal } : {}),
            },
          );
          const parsed = peerDelegationHostsResultSchema.safeParse(value);
          return parsed.success && parsed.data.hosts.some((host) => host.hostId === input.hostId)
            ? descriptor
            : undefined;
        }),
      );
      if (callOptions.signal?.aborted) throw abortTimeoutError();
      for (const probe of probes) {
        if (probe.status === "fulfilled" && probe.value) owners.push(probe.value);
      }
      if (owners.length === 0) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Remote peer is not configured or not enabled",
        );
      }
      if (owners.length > 1) {
        throw new DelegationControlError(
          "PARENT_THREAD_AMBIGUOUS",
          "Multiple local Web instances expose the same remote Peer",
        );
      }
      return requestSingleBridge(
        owners[0] as PeerDelegationBridgeDescriptor,
        input,
        buildOptions(),
      );
    },
  };
}

/** Race an async operation against an AbortSignal so slow callers cannot outrun the wait deadline. */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortTimeoutError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortTimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Bounded A-side polling over remote `read` with unified monotonic deadline and per-read AbortSignal. */
export async function waitRemotePeerThread(
  readOnce: (
    input: Omit<ThreadReadInput, "hostId" | "callerThreadId">,
    options: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<DelegationThreadSnapshot>,
  input: ThreadWaitInput,
  options: {
    pollIntervalsMs?: readonly number[];
    deadline?: number;
    signal?: AbortSignal;
  } = {},
): Promise<DelegationThreadSnapshot & { timedOut: boolean }> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new DelegationControlError("INVALID_ARGUMENT", "timeoutMs must be a positive integer");
  }
  const intervals = options.pollIntervalsMs?.length
    ? options.pollIntervalsMs
    : DEFAULT_REMOTE_WAIT_POLL_INTERVALS_MS;
  const read: Omit<ThreadReadInput, "hostId" | "callerThreadId"> = {
    threadId: input.threadId,
    view: input.view,
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  };
  const deadline = options.deadline ?? performance.now() + input.timeoutMs;
  let lastSnapshot: DelegationThreadSnapshot | undefined;
  let attempt = 0;
  for (;;) {
    const remainingBefore = Math.floor(deadline - performance.now());
    if (remainingBefore <= 0 || options.signal?.aborted) {
      if (lastSnapshot) return { ...lastSnapshot, timedOut: true };
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Timed out waiting for remote Peer Thread snapshot",
        { timedOut: true },
      );
    }
    const perRead = new AbortController();
    const timer = setTimeout(() => perRead.abort(new Error("timeout")), remainingBefore);
    const readSignal = options.signal
      ? AbortSignal.any([options.signal, perRead.signal])
      : perRead.signal;
    let snapshot: DelegationThreadSnapshot;
    try {
      snapshot = await raceWithAbort(
        readOnce(read, { timeoutMs: remainingBefore, signal: readSignal }),
        readSignal,
      );
    } catch (error) {
      const timedOut =
        readSignal.aborted ||
        (error instanceof DelegationControlError && error.details?.timedOut === true);
      if (timedOut) {
        if (lastSnapshot) return { ...lastSnapshot, timedOut: true };
        throw new DelegationControlError(
          "RUNTIME_UNREACHABLE",
          "Timed out waiting for remote Peer Thread snapshot",
          { timedOut: true },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    // Check deadline BEFORE accepting any terminal snapshot so late replies never report timedOut: false.
    const expired = options.signal?.aborted || performance.now() >= deadline;
    if (expired) {
      return { ...(lastSnapshot ?? snapshot), timedOut: true };
    }
    lastSnapshot = snapshot;
    if (
      snapshot.status === "completed" ||
      snapshot.status === "failed" ||
      snapshot.status === "interrupted" ||
      Boolean(snapshot.pendingQuestions?.length)
    ) {
      return { ...snapshot, timedOut: false };
    }
    const remainingAfter = Math.floor(deadline - performance.now());
    if (remainingAfter <= 0 || options.signal?.aborted) return { ...snapshot, timedOut: true };
    const interval = intervals[Math.min(attempt, intervals.length - 1)] ?? 1_000;
    attempt += 1;
    try {
      await sleep(Math.min(interval, remainingAfter), undefined, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      return { ...snapshot, timedOut: true };
    }
  }
}

const SAFE_HARNESS_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_GIT_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SAFE_GIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MAX_SAFE_HARNESS_IDS = 32;

function isSafeBranchName(value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_GIT_BRANCH_RE.test(value)) return false;
  if (
    value.includes("..") ||
    value.includes("//") ||
    value.includes("://") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    return false;
  }
  return true;
}

function isSafeCommitSha(value: unknown): value is string {
  return typeof value === "string" && SAFE_GIT_SHA_RE.test(value);
}

function isSafeHarnessId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_HARNESS_ID_RE.test(value) &&
    (value === "codex" || harnessIdSchema.safeParse(value).success)
  );
}

function sanitizeErrorDetails(
  details: Record<string, unknown> | undefined,
): JsonObject | undefined {
  if (!details) return undefined;
  const safe: JsonObject = {};
  if (Array.isArray(details.validHarnessIds)) {
    const valid = [...new Set(details.validHarnessIds.filter(isSafeHarnessId))].slice(
      0,
      MAX_SAFE_HARNESS_IDS,
    );
    if (valid.length > 0) safe.validHarnessIds = valid;
  }
  if (typeof details.readOnly === "boolean") {
    safe.readOnly = details.readOnly;
  }
  if (typeof details.worktreeRetained === "boolean") {
    safe.worktreeRetained = details.worktreeRetained;
  }
  if (
    details.worktree &&
    typeof details.worktree === "object" &&
    !Array.isArray(details.worktree)
  ) {
    const wt = details.worktree as Record<string, unknown>;
    if (isSafeBranchName(wt.branch) && isSafeCommitSha(wt.base)) {
      // Omit host filesystem `path` from remote error payloads while preserving validated retention facts.
      safe.worktree = { branch: wt.branch, base: wt.base };
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function clientSafeError(
  error: unknown,
  diagnose?: (error: unknown) => void,
): PeerDelegationResponse {
  diagnose?.(error);
  const code: DelegationControlErrorCode =
    error instanceof DelegationControlError ? error.code : "INTERNAL_ERROR";
  const details =
    error instanceof DelegationControlError ? sanitizeErrorDetails(error.details) : undefined;
  return {
    ok: false,
    error: {
      code,
      message: CLIENT_SAFE_ERROR_MESSAGES[code],
      ...(details ? { details } : {}),
    },
  };
}

export interface PeerStartIdempotency {
  findDelegationByRequest?: (requestId: string) => Promise<PersistedDelegationLookup | null>;
  runSerialized?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  getCachedStart?: (key: string) => { configHash: string; result: unknown } | undefined;
  setCachedStart?: (key: string, entry: { configHash: string; result: unknown }) => void;
  getPersistedStart?: (requestId: string) => Promise<PersistedPeerStartRecord | undefined>;
  savePersistedStart?: (record: PersistedPeerStartRecord) => Promise<void>;
  deletePersistedStart?: (requestId: string) => Promise<void>;
  claimWorktreeOwner?: (
    target: { path: string; branch: string },
    requestId: string,
  ) => Promise<WorktreeOwnerClaimResult>;
  getWorktreeOwner?: (target: { path: string; branch: string }) => Promise<string | undefined>;
  releaseWorktreeOwner?: (
    target: { path: string; branch: string },
    requestId: string,
  ) => Promise<void>;
}

function peerStartConfigHash(input: {
  parentThreadId: string;
  harnessId: unknown;
  task: unknown;
  cwd: string;
  worktree: unknown;
  base: unknown;
  model: unknown;
  thinkingOptionId: unknown;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        parentThreadId: input.parentThreadId,
        harnessId: input.harnessId ?? null,
        task: input.task ?? null,
        cwd: path.resolve(input.cwd),
        worktree: input.worktree ?? null,
        base: input.base ?? null,
        model: input.model ?? null,
        thinkingOptionId: input.thinkingOptionId ?? null,
      }),
    )
    .digest("hex");
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      { timeout: 10_000, maxBuffer: 262_144, windowsHide: true },
    );
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const WORKTREE_GITDIR_OWNER_FILE = "codexhost-peer-worktree-owner.json";

const gitdirWorktreeOwnerSchema = z
  .object({
    formatVersion: z.literal(1),
    requestId: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1),
    base: z.string().min(1),
  })
  .strict();

async function resolveWorktreeGitDir(worktreePath: string): Promise<string | undefined> {
  const rawGitDir = await gitOutput(worktreePath, ["rev-parse", "--git-dir"]);
  if (!rawGitDir) return undefined;
  return path.resolve(worktreePath, rawGitDir);
}

/**
 * Atomically write a request-bound ownership marker inside the linked worktree's private gitdir
 * (`.git/worktrees/<name>/codexhost-peer-worktree-owner.json`), leaving `git status` clean.
 */
async function writeWorktreeGitdirOwnerMarker(
  worktree: { path: string; branch: string; base: string },
  requestId: string,
): Promise<void> {
  const gitDir = await resolveWorktreeGitDir(worktree.path);
  if (!gitDir) {
    throw new DelegationControlError(
      "INTERNAL_ERROR",
      "Cannot locate private git directory for created worktree",
    );
  }
  const target = path.join(gitDir, WORKTREE_GITDIR_OWNER_FILE);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  const canonicalPath = await canonicalizeWorktreePath(worktree.path);
  const payload = gitdirWorktreeOwnerSchema.parse({
    formatVersion: 1,
    requestId,
    path: canonicalPath,
    branch: worktree.branch,
    base: worktree.base,
  });
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(payload), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function hasMatchingWorktreeGitdirOwnerMarker(
  worktree: { path: string; branch: string; base: string },
  requestId: string,
): Promise<boolean> {
  const gitDir = await resolveWorktreeGitDir(worktree.path);
  if (!gitDir) return false;
  let raw: string;
  try {
    raw = await readFile(path.join(gitDir, WORKTREE_GITDIR_OWNER_FILE), "utf8");
  } catch {
    return false;
  }
  try {
    const parsed = gitdirWorktreeOwnerSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return false;
    const [markerCanonical, expectedCanonical] = await Promise.all([
      canonicalizeWorktreePath(parsed.data.path),
      canonicalizeWorktreePath(worktree.path),
    ]);
    return (
      parsed.data.requestId === requestId &&
      markerCanonical === expectedCanonical &&
      parsed.data.branch === worktree.branch &&
      parsed.data.base === worktree.base
    );
  } catch {
    return false;
  }
}

/**
 * Inspect whether a previously planned worktree `{ path, branch, base }` was untouched ("absent"),
 * completely prepared by THIS `requestId` with a verified gitdir ownership marker ("ready"), or
 * partially/ambiguously/externally materialized ("ambiguous").
 */
async function inspectPlannedWorktree(
  repoCwd: string,
  planned: { path: string; branch: string; base: string },
  requestId: string,
): Promise<"absent" | "ready" | "ambiguous"> {
  let dirExists: boolean;
  try {
    dirExists = await pathExists(planned.path);
  } catch {
    return "ambiguous";
  }
  const branchSha = await gitOutput(repoCwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `refs/heads/${planned.branch}^{commit}`,
  ]);
  if (!dirExists && branchSha === undefined) return "absent";
  if (!dirExists || branchSha !== planned.base) return "ambiguous";
  const wtBranch = await gitOutput(planned.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const wtHead = await gitOutput(planned.path, ["rev-parse", "HEAD"]);
  if (wtBranch !== planned.branch || wtHead !== planned.base) return "ambiguous";
  const listed = await gitOutput(repoCwd, ["worktree", "list", "--porcelain", "-z"]);
  if (!listed) return "ambiguous";
  const [canonicalPlannedPath, registeredPaths] = await Promise.all([
    canonicalizeWorktreePath(planned.path),
    Promise.all(
      listed
        .split("\0")
        .filter((entry) => entry.startsWith("worktree "))
        .map((entry) => canonicalizeWorktreePath(entry.slice("worktree ".length))),
    ),
  ]);
  if (!registeredPaths.includes(canonicalPlannedPath)) return "ambiguous";
  if (!(await hasMatchingWorktreeGitdirOwnerMarker(planned, requestId))) {
    return "ambiguous";
  }
  return "ready";
}

function isFirstTurnConfirmed(result: { status?: string; turnId?: string }): boolean {
  return (
    typeof result.status === "string" &&
    result.status !== "creating" &&
    typeof result.turnId === "string" &&
    result.turnId.length > 0 &&
    result.turnId !== "pending"
  );
}

/** B-side dispatcher invoked via the authenticated local Client Channel. */
export async function dispatchPeerDelegationRequest(
  api: DelegationControlApi,
  rawParams: unknown,
  options: {
    onRemoteThreadStarted?: (threadId: string, hopCount: number) => void;
    diagnose?: (error: unknown) => void;
    idempotency?: PeerStartIdempotency;
  } = {},
): Promise<PeerDelegationResponse> {
  const parsed = peerDelegationRequestSchema.safeParse(rawParams);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: CLIENT_SAFE_ERROR_MESSAGES.INVALID_ARGUMENT },
    };
  }
  const { operation, hopCount, sourceId, input } = parsed.data;
  if (hopCount < 1) {
    return {
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: CLIENT_SAFE_ERROR_MESSAGES.INVALID_ARGUMENT },
    };
  }
  if (hopCount > PEER_DELEGATION_MAX_HOPS) {
    return {
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Peer delegation hop limit exceeded (maximum 1 hop)",
      },
    };
  }
  if (isRemoteHostId(typeof input.hostId === "string" ? input.hostId : undefined)) {
    return {
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Nested remote delegation is not allowed (hop limit 1)",
      },
    };
  }

  const sanitized: Record<string, unknown> = { ...input };
  delete sanitized.hostId;
  delete sanitized.callerThreadId;

  try {
    let value: unknown;
    switch (operation) {
      case "listHarnesses":
        value = await api.listHarnesses({});
        break;
      case "inspect": {
        delete sanitized.parentThreadId;
        value = await api.inspect(sanitized as unknown as HarnessInspectInput);
        break;
      }
      case "start": {
        const { worktree, base, ...startRest } = sanitized;
        if (typeof startRest.cwd !== "string" || !startRest.cwd.trim()) {
          throw new DelegationControlError(
            "INVALID_ARGUMENT",
            "--cwd is required for remote peer delegation",
          );
        }
        const parentThreadId = peerOrigin(sourceId);
        const requestId =
          typeof startRest.requestId === "string" && startRest.requestId.trim()
            ? startRest.requestId
            : undefined;
        const configHash = peerStartConfigHash({
          parentThreadId,
          harnessId: startRest.harnessId,
          task: startRest.task,
          cwd: startRest.cwd,
          worktree,
          base,
          model: startRest.model,
          thinkingOptionId: startRest.thinkingOptionId,
        });
        const runStart = async () => {
          const startedAt = new Date().toISOString();
          let adoptableWorktree: { path: string; branch: string; base: string } | undefined;
          let rerunBaseSha: string | undefined;
          let existingCreatedAt = startedAt;
          let hadPriorPersistedRecord = false;
          if (requestId) {
            const cached = options.idempotency?.getCachedStart?.(requestId);
            if (cached) {
              if (cached.configHash !== configHash) {
                throw new DelegationControlError(
                  "INVALID_ARGUMENT",
                  "Request ID is already associated with another Delegation configuration",
                );
              }
              return cached.result;
            }
            const persistedRecord = await options.idempotency?.getPersistedStart?.(requestId);
            if (persistedRecord) {
              hadPriorPersistedRecord = true;
              if (
                persistedRecord.parentThreadId !== parentThreadId ||
                persistedRecord.configHash !== configHash
              ) {
                throw new DelegationControlError(
                  "INVALID_ARGUMENT",
                  "Request ID is already associated with another Delegation configuration",
                );
              }
              existingCreatedAt = persistedRecord.createdAt;
              if (persistedRecord.state === "completed" && persistedRecord.result !== undefined) {
                const threadId =
                  persistedRecord.result &&
                  typeof persistedRecord.result === "object" &&
                  !Array.isArray(persistedRecord.result) &&
                  typeof (persistedRecord.result as Record<string, unknown>).threadId === "string"
                    ? ((persistedRecord.result as Record<string, unknown>).threadId as string)
                    : undefined;
                if (threadId) options.onRemoteThreadStarted?.(threadId, hopCount);
                options.idempotency?.setCachedStart?.(requestId, {
                  configHash,
                  result: persistedRecord.result,
                });
                return persistedRecord.result;
              }
              // Pending write-ahead record: recover ONLY when first Turn acceptance is confirmed.
              const persistedDelegation =
                await options.idempotency?.findDelegationByRequest?.(requestId);
              if (persistedDelegation) {
                if (
                  persistedDelegation.parentHostThreadId !== parentThreadId ||
                  persistedDelegation.targetHarnessId !== startRest.harnessId
                ) {
                  throw new DelegationControlError(
                    "INVALID_ARGUMENT",
                    "Request ID is already associated with another Delegation configuration",
                  );
                }
                if (persistedDelegation.status === "creating") {
                  throw new DelegationControlError(
                    "DELEGATION_FAILED",
                    "Previous delegation did not confirm first Turn submission; inspect before retrying",
                    persistedRecord.worktree
                      ? { worktreeRetained: true, worktree: persistedRecord.worktree }
                      : undefined,
                  );
                }
                const replayed = await api.start({
                  ...(startRest as unknown as DelegationStartInput),
                  ...(persistedRecord.worktree ? { cwd: persistedRecord.worktree.path } : {}),
                  parentThreadId,
                });
                if (!isFirstTurnConfirmed(replayed)) {
                  throw new DelegationControlError(
                    "DELEGATION_FAILED",
                    "Previous delegation did not confirm first Turn submission; inspect before retrying",
                    persistedRecord.worktree
                      ? { worktreeRetained: true, worktree: persistedRecord.worktree }
                      : undefined,
                  );
                }
                options.onRemoteThreadStarted?.(replayed.threadId, hopCount);
                const recovered = persistedRecord.worktree
                  ? { ...replayed, worktree: persistedRecord.worktree }
                  : replayed;
                await options.idempotency?.savePersistedStart?.({
                  formatVersion: 1,
                  requestId,
                  parentThreadId,
                  configHash,
                  state: "completed",
                  ...(persistedRecord.worktree ? { worktree: persistedRecord.worktree } : {}),
                  result: jsonValueSchema.parse(recovered),
                  createdAt: persistedRecord.createdAt,
                  updatedAt: new Date().toISOString(),
                });
                if (persistedRecord.worktree) {
                  await options.idempotency
                    ?.releaseWorktreeOwner?.(
                      {
                        path: persistedRecord.worktree.path,
                        branch: persistedRecord.worktree.branch,
                      },
                      requestId,
                    )
                    .catch(() => undefined);
                }
                options.idempotency?.setCachedStart?.(requestId, { configHash, result: recovered });
                return recovered;
              }
              if (persistedRecord.worktree) {
                // Only adopt or rerun a planned worktree when durable exclusive ownership belongs to this requestId.
                if (options.idempotency?.getWorktreeOwner) {
                  const ownerRequestId = await options.idempotency.getWorktreeOwner({
                    path: persistedRecord.worktree.path,
                    branch: persistedRecord.worktree.branch,
                  });
                  if (ownerRequestId !== requestId) {
                    throw new DelegationControlError(
                      "INVALID_ARGUMENT",
                      "Worktree branch or path is owned by another delegation request",
                    );
                  }
                }
                const wtState = await inspectPlannedWorktree(
                  startRest.cwd as string,
                  persistedRecord.worktree,
                  requestId,
                );
                if (wtState === "ready") {
                  adoptableWorktree = persistedRecord.worktree;
                } else if (wtState === "ambiguous") {
                  throw new DelegationControlError(
                    "DELEGATION_FAILED",
                    "Previous worktree preparation did not complete cleanly",
                    { worktreeRetained: true, worktree: persistedRecord.worktree },
                  );
                } else {
                  // Plan was persisted before Git ran; lock rerun to the originally resolved base commit SHA.
                  rerunBaseSha = persistedRecord.worktree.base;
                }
              }
            }
            if (!persistedRecord) {
              const persisted = await options.idempotency?.findDelegationByRequest?.(requestId);
              if (persisted) {
                // Without a persisted worktree start record, reject any worktree conflict before touching git.
                if (
                  worktree !== undefined ||
                  persisted.parentHostThreadId !== parentThreadId ||
                  persisted.targetHarnessId !== startRest.harnessId
                ) {
                  throw new DelegationControlError(
                    "INVALID_ARGUMENT",
                    "Request ID is already associated with another Delegation configuration",
                  );
                }
                if (persisted.status === "creating") {
                  throw new DelegationControlError(
                    "DELEGATION_FAILED",
                    "Previous delegation did not confirm first Turn submission; inspect before retrying",
                  );
                }
                const replayed = await api.start({
                  ...(startRest as unknown as DelegationStartInput),
                  parentThreadId,
                });
                if (!isFirstTurnConfirmed(replayed)) {
                  throw new DelegationControlError(
                    "DELEGATION_FAILED",
                    "Previous delegation did not confirm first Turn submission; inspect before retrying",
                  );
                }
                options.onRemoteThreadStarted?.(replayed.threadId, hopCount);
                options.idempotency?.setCachedStart?.(requestId, { configHash, result: replayed });
                return replayed;
              }
              // Write-ahead pending record BEFORE creating any worktree or starting any Thread.
              await options.idempotency?.savePersistedStart?.({
                formatVersion: 1,
                requestId,
                parentThreadId,
                configHash,
                state: "pending",
                createdAt: existingCreatedAt,
                updatedAt: startedAt,
              });
            }
          }
          let plannedWorktree: { path: string; branch: string; base: string } | undefined =
            adoptableWorktree;
          let newlyClaimedWorktree: { path: string; branch: string } | undefined;
          let startedThread = false;
          let created: unknown;
          try {
            if (adoptableWorktree) {
              try {
                const started = await api.start({
                  ...(startRest as unknown as DelegationStartInput),
                  cwd: adoptableWorktree.path,
                  parentThreadId,
                });
                startedThread = true;
                options.onRemoteThreadStarted?.(started.threadId, hopCount);
                created = { ...started, worktree: adoptableWorktree };
              } catch (error) {
                const original = error instanceof DelegationControlError ? error : undefined;
                throw new DelegationControlError(
                  original?.code ?? "DELEGATION_FAILED",
                  original?.message ?? "Delegation start failed after worktree adoption",
                  { ...original?.details, worktree: adoptableWorktree, worktreeRetained: true },
                );
              }
            } else {
              created = await startWithDelegationWorktree(
                {
                  cwd: startRest.cwd as string,
                  branch: worktree as string | undefined,
                  base: rerunBaseSha ?? (base as string | undefined),
                },
                async (resolvedCwd) => {
                  const started = await api.start({
                    ...(startRest as unknown as DelegationStartInput),
                    ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
                    parentThreadId,
                  });
                  startedThread = true;
                  options.onRemoteThreadStarted?.(started.threadId, hopCount);
                  return started;
                },
                {
                  // Atomically claim exclusive `(path, branch)` ownership and persist plan BEFORE Git mutates anything.
                  onWorktreePlanned: async (wt) => {
                    if (requestId) {
                      if (options.idempotency?.claimWorktreeOwner) {
                        const claimResult = await options.idempotency.claimWorktreeOwner(
                          { path: wt.path, branch: wt.branch },
                          requestId,
                        );
                        if (claimResult === "conflict") {
                          throw new DelegationControlError(
                            "INVALID_ARGUMENT",
                            "Worktree branch or path is already claimed by another delegation request",
                          );
                        }
                        if (claimResult === "claimed") {
                          newlyClaimedWorktree = { path: wt.path, branch: wt.branch };
                        }
                      }
                      try {
                        await options.idempotency?.savePersistedStart?.({
                          formatVersion: 1,
                          requestId,
                          parentThreadId,
                          configHash,
                          state: "pending",
                          worktree: wt,
                          createdAt: existingCreatedAt,
                          updatedAt: new Date().toISOString(),
                        });
                      } catch (error) {
                        // Git has not run yet; immediately release a newly claimed owner lock so it never orphans.
                        if (newlyClaimedWorktree) {
                          const toRelease = newlyClaimedWorktree;
                          newlyClaimedWorktree = undefined;
                          await options.idempotency
                            ?.releaseWorktreeOwner?.(toRelease, requestId)
                            .catch(() => undefined);
                        }
                        throw error;
                      }
                    }
                    plannedWorktree = wt;
                  },
                  // Stamp private gitdir ownership marker right after `git worktree add` succeeds, before starting Thread.
                  onWorktreeCreated: async (wt) => {
                    if (requestId) {
                      await writeWorktreeGitdirOwnerMarker(wt, requestId);
                    }
                  },
                },
              );
            }
          } catch (error) {
            const retained =
              error instanceof DelegationControlError && error.details?.worktreeRetained === true;
            if (requestId && !startedThread && !retained) {
              // `startWithDelegationWorktree` throws `!worktreeRetained` only when no owned directory
              // or branch was left behind; release any lock newly claimed during this attempt immediately.
              if (newlyClaimedWorktree) {
                await options.idempotency
                  ?.releaseWorktreeOwner?.(newlyClaimedWorktree, requestId)
                  .catch(() => undefined);
              }
              if (!hadPriorPersistedRecord) {
                await options.idempotency?.deletePersistedStart?.(requestId).catch(() => undefined);
              }
            }
            throw error;
          }
          if (requestId) {
            const createdObj =
              created && typeof created === "object" && !Array.isArray(created)
                ? (created as { status?: string; turnId?: string })
                : {};
            if (!isFirstTurnConfirmed(createdObj)) {
              throw new DelegationControlError(
                "DELEGATION_FAILED",
                "Delegation did not confirm first Turn submission",
                plannedWorktree ? { worktreeRetained: true, worktree: plannedWorktree } : undefined,
              );
            }
            await options.idempotency?.savePersistedStart?.({
              formatVersion: 1,
              requestId,
              parentThreadId,
              configHash,
              state: "completed",
              ...(plannedWorktree ? { worktree: plannedWorktree } : {}),
              result: jsonValueSchema.parse(created),
              createdAt: existingCreatedAt,
              updatedAt: new Date().toISOString(),
            });
            if (plannedWorktree) {
              await options.idempotency
                ?.releaseWorktreeOwner?.(
                  { path: plannedWorktree.path, branch: plannedWorktree.branch },
                  requestId,
                )
                .catch(() => undefined);
            }
            options.idempotency?.setCachedStart?.(requestId, { configHash, result: created });
          }
          return created;
        };
        value =
          requestId && options.idempotency?.runSerialized
            ? await options.idempotency.runSerialized(requestId, runStart)
            : await runStart();
        break;
      }
      case "send":
        value = await api.send(sanitized as unknown as ThreadSendInput);
        break;
      case "cancel":
        value = await api.cancel(sanitized as unknown as ThreadCancelInput);
        break;
      case "read":
        validateReadOptions(sanitized as unknown as ThreadReadInput);
        value = await api.read(sanitized as unknown as ThreadReadInput);
        break;
      case "answer":
        value = await api.answer(sanitized as unknown as ThreadAnswerInput);
        break;
      case "list":
        value = await api.list(sanitized as unknown as ThreadListInput);
        break;
    }
    return { ok: true, value: jsonValueSchema.parse(value) };
  } catch (error) {
    return clientSafeError(error, options.diagnose);
  }
}

export function newBridgeRequestLockKey(): string {
  return randomUUID();
}
