/** Session-authorized, version-checked Office bytes shared by concurrent preview reads. */
import type {
  OfficeToPdfPriority,
  OfficeToPdfGeneration,
} from "@deepseek-ai/dsh-office-to-pdf/types";
import type { RemoteResult } from "@deepseek-ai/dsh-api-remotes/client";
import type { WorkspaceFileStat } from "@deepseek-ai/dsh-api-workspace-files/types";
import type { DocumentFileBytes, SessionFile } from "../rpc.ts";

/** PDF bytes and conversion metadata owned by Office preview. */
export type OfficeFileBytes = DocumentFileBytes & {
  readonly missingFonts: readonly string[];
  readonly generation: OfficeToPdfGeneration;
};

/** Host-level cache partition for Office preview results. */
export interface OfficePreviewScope {
  /** Stable partition key isolating local and per-Peer in-flight/cached conversions. */
  readonly scopeKey: string;
  /** Whether to query Hub `officeToPdf/generation` and retain completed PDFs across reopens. */
  readonly useHostGeneration: boolean;
}

const REMOTE_SESSION_PREFIX = "web-remote:";

/**
 * Extract the remote host identity from a `web-remote:<base64url([hostId, threadId])>` session ID.
 * Falls back to the opaque session ID when the payload is a draft or cannot be decoded.
 */
export function decodeRemoteHostScope(sessionId: string): string | undefined {
  if (!sessionId.startsWith(REMOTE_SESSION_PREFIX)) return undefined;
  const encoded = sessionId.slice(REMOTE_SESSION_PREFIX.length);
  if (!encoded || encoded.startsWith("draft-")) return sessionId;
  try {
    const base64 = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].length > 0) {
      return parsed[0];
    }
  } catch {
    // Isolate malformed remote IDs under their own key rather than falling back to local.
  }
  return sessionId;
}

/**
 * Partition Office preview caching by owning Host.
 * Remote Peer sessions bypass Hub generation and cross-reopen PDF retention so Peer restarts
 * or font updates never serve stale cached PDFs while keeping in-flight deduplication and full
 * isolation from Hub's local cache.
 */
export function officeScopeForSession(sessionId: string): OfficePreviewScope {
  const remoteHost = decodeRemoteHostScope(sessionId);
  if (remoteHost === undefined) return { scopeKey: "local", useHostGeneration: true };
  return { scopeKey: `remote:${remoteHost}`, useHostGeneration: false };
}

/**
 * Load authorized PDF contents for one Office source.
 * @param file - Session and source path.
 * @param signal - this reader's lifetime.
 * @returns converted PDF bytes or a declared source-access failure.
 */
export type ReadOfficeDocument = (
  file: SessionFile,
  signal: AbortSignal,
) => Promise<RemoteResult<OfficeFileBytes>>;

/** Authorized cached reads carry explicit scheduling intent to the Host. */
export type ReadOfficeBytes = (
  file: SessionFile,
  signal: AbortSignal,
  priority: OfficeToPdfPriority,
) => ReturnType<ReadOfficeDocument>;

type Result = Awaited<ReturnType<ReadOfficeDocument>>;
type Success = Extract<Result, { ok: true }>;
type Stat = (file: SessionFile, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileStat>>;
interface Pending {
  readonly scopeKey: string;
  readonly controller: AbortController;
  readonly promise: Promise<Result>;
  users: number;
}

const DEFAULT_SCOPE: OfficePreviewScope = { scopeKey: "local", useHostGeneration: true };

/** Bounded successful results; each caller reauthorizes and checks source freshness before reuse. */
export class OfficePreviewCache {
  private readonly ready = new Map<string, Success>();
  private readonly readyScope = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  private bytes = 0;
  private readers = 0;
  private generation: OfficeToPdfGeneration | undefined;
  private generationQuery = 0;
  private acceptedQuery = 0;
  private readonly superseded = new Error();
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<Result>>();
  private readonly reads = new Set<Promise<Result>>();

  /**
   * @param stat - authorized source metadata lookup.
   * @param convert - Host render Remote returning binary PDF bytes borrowed read-only by callers.
   * @param maxEntries - maximum completed results retained for local sessions.
   * @param maxBytes - maximum retained PDF byteLength for local sessions.
   * @param maxPending - maximum unsettled Host conversion requests, including cancellation teardown.
   * @param maxReaders - maximum readers, including metadata lookups.
   * @param generation - current Host renderer generation, checked before cached reuse for local sessions.
   * @param busy - localized capacity failure.
   * @param resolveScope - host scope classifier isolating local and remote Peer sessions.
   */
  constructor(
    private readonly stat: Stat,
    private readonly convert: ReadOfficeBytes,
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly maxPending: number,
    private readonly maxReaders: number,
    private readonly currentGeneration: (
      signal: AbortSignal,
    ) => Promise<RemoteResult<OfficeToPdfGeneration>>,
    private readonly busy: () => Error,
    private readonly resolveScope: (file: SessionFile) => OfficePreviewScope = () => DEFAULT_SCOPE,
  ) {}

  /**
   * Share a conversion without letting one caller cancel another caller's work.
   * Renderer replacement retries authorization once; repeated replacement reports localized capacity failure.
   * @param file - Session authorization scope and source path.
   * @param signal - this caller's lifetime.
   * @param priority - foreground preview or speculative read.
   * @returns current PDF bytes borrowed read-only, or a declared source-read failure; cancellation rejects.
   */
  async read(
    file: SessionFile,
    signal: AbortSignal,
    priority: OfficeToPdfPriority = "foreground",
  ): Promise<Result> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const readerLimit = priority === "background" ? this.maxReaders - 1 : this.maxReaders;
    if (this.readers >= readerLimit || (priority === "background" && this.maxPending === 1))
      throw this.busy();
    this.readers++;
    const operation = this.lookup(file, signal, priority);
    this.reads.add(operation);
    try {
      return await operation;
    } finally {
      this.readers--;
      this.reads.delete(operation);
    }
  }

  private async lookup(
    file: SessionFile,
    signal: AbortSignal,
    priority: OfficeToPdfPriority,
  ): Promise<Result> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.lookupGeneration(file, signal, priority);
      } catch (error) {
        if (error !== this.superseded) throw error;
      }
    }
    throw this.busy();
  }

  private evictScope(scopeKey: string, abortPending: boolean): void {
    for (const [key, entryScope] of [...this.readyScope.entries()]) {
      if (entryScope !== scopeKey) continue;
      const entry = this.ready.get(key);
      if (entry !== undefined) {
        this.ready.delete(key);
        this.bytes -= entry.value.data.byteLength;
      }
      this.readyScope.delete(key);
    }
    if (abortPending) {
      for (const [pendingKey, pending] of [...this.pending.entries()]) {
        if (pending.scopeKey !== scopeKey) continue;
        pending.controller.abort(this.superseded);
        this.pending.delete(pendingKey);
      }
    }
  }

  private async lookupGeneration(
    file: SessionFile,
    signal: AbortSignal,
    priority: OfficeToPdfPriority,
  ): Promise<Result> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    const scope = this.resolveScope(file);
    let localGeneration: OfficeToPdfGeneration | undefined;
    if (scope.useHostGeneration) {
      const query = ++this.generationQuery;
      const generation = await this.currentGeneration(signal);
      signal.throwIfAborted();
      if (!generation.ok) return generation;
      if (query < this.acceptedQuery && generation.value !== this.generation) throw this.superseded;
      this.acceptedQuery = Math.max(query, this.acceptedQuery);
      if (generation.value !== this.generation) {
        this.generation = generation.value;
        this.evictScope(scope.scopeKey, true);
      }
      localGeneration = generation.value;
    }
    const metadata = await this.stat(file, signal);
    signal.throwIfAborted();
    if (!metadata.ok) return metadata;
    if (scope.useHostGeneration && localGeneration !== this.generation) throw this.superseded;
    const key = JSON.stringify([
      scope.scopeKey,
      scope.useHostGeneration ? localGeneration : "remote",
      file.sessionId,
      metadata.value.absolutePath,
      metadata.value.version,
    ]);
    if (scope.useHostGeneration) {
      const cached = this.ready.get(key);
      if (cached !== undefined) {
        this.ready.delete(key);
        this.ready.set(key, cached);
        return cached;
      }
    }
    // A foreground RPC joins and promotes background work at the shared Host queue.
    const pendingKey = JSON.stringify([key, priority]);
    let entry = this.pending.get(pendingKey);
    if (entry === undefined) {
      const pendingLimit = priority === "background" ? this.maxPending - 1 : this.maxPending;
      if (this.tasks.size >= pendingLimit) throw this.busy();
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return this.convert(file, controller.signal, priority);
        })
        .then((result) => {
          controller.signal.throwIfAborted();
          // Only local Host conversions (verified against Hub's live generation) are retained
          // across reopens; remote Peer conversions never populate or mutate shared cache state.
          if (
            scope.useHostGeneration &&
            localGeneration === this.generation &&
            result.ok &&
            result.value.generation === localGeneration &&
            result.value.version === metadata.value.version &&
            result.value.absolutePath === metadata.value.absolutePath
          ) {
            this.retain(key, scope.scopeKey, result);
          }
          return result;
        })
        .finally(() => {
          this.tasks.delete(promise);
          if (this.pending.get(pendingKey)?.controller === controller)
            this.pending.delete(pendingKey);
        });
      this.tasks.add(promise);
      entry = { scopeKey: scope.scopeKey, controller, promise, users: 0 };
      this.pending.set(pendingKey, entry);
    }
    const shared = entry;
    shared.users += 1;
    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", abort);
        shared.users -= 1;
        if (shared.users === 0 && this.pending.get(pendingKey) === shared) {
          this.pending.delete(pendingKey);
          shared.controller.abort();
        }
        return true;
      };
      const abort = (): void => {
        const reason: unknown = signal.reason;
        finish();
        reject(
          reason instanceof Error
            ? reason
            : new Error("Office preview cancelled", { cause: reason }),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      shared.promise.then(
        (result) => {
          if (finish()) resolve(result);
        },
        (error: unknown) => {
          if (finish())
            reject(
              error instanceof Error ? error : new Error("Office preview failed", { cause: error }),
            );
        },
      );
    });
  }

  /** Clear retained bytes, cancel outstanding conversions, and await their completion. */
  async dispose(): Promise<void> {
    this.lifetime.abort();
    this.pending.clear();
    this.ready.clear();
    this.readyScope.clear();
    this.bytes = 0;
    await Promise.allSettled([...this.reads, ...this.tasks]);
  }

  private retain(key: string, scopeKey: string, result: Success): void {
    const previous = this.ready.get(key);
    if (previous !== undefined) {
      this.ready.delete(key);
      this.readyScope.delete(key);
      this.bytes -= previous.value.data.byteLength;
    }
    const size = result.value.data.byteLength;
    if (size > this.maxBytes) return;
    while (this.ready.size >= this.maxEntries || this.bytes + size > this.maxBytes) {
      const oldest = this.ready.entries().next().value as [string, Success];
      this.ready.delete(oldest[0]);
      this.readyScope.delete(oldest[0]);
      this.bytes -= oldest[1].value.data.byteLength;
    }
    this.ready.set(key, result);
    this.readyScope.set(key, scopeKey);
    this.bytes += size;
  }
}
