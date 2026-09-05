import type { HarnessAdapter, HarnessSessionImportCapability } from "@codexhost/harness-adapter";
import { MappingStoreError, type StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  mapExternalThreadHarnessError,
  transportModelIdForHarness,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  HARNESS_SESSION_IMPORT_DEFAULT_PAGE_SIZE,
  harnessSessionImportCandidateSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessSessionImportCandidate,
  type HarnessSessionListParams,
  type HostThreadId,
} from "@codexhost/shared-contracts";

import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";

export type HarnessSessionListOutcome =
  | { ok: true; candidates: HarnessSessionImportCandidate[]; total: number }
  | { ok: false; error: ExternalThreadRpcError };
export type HarnessSessionImportOutcome =
  | { ok: true; threadId: HostThreadId; thread: JsonObject }
  | { ok: false; error: ExternalThreadRpcError };

function fixedError(code: number, message: string): ExternalThreadRpcError {
  return { code, message };
}

function importedThread(
  record: StoredThreadRecordV1,
): Extract<HarnessSessionImportOutcome, { ok: true }> {
  return {
    ok: true,
    threadId: record.hostThreadId,
    thread: externalThreadValue({
      record,
      turns: [],
      sessionId: record.hostThreadId,
      loaded: false,
    }),
  };
}

/** Host-owned mapping transaction. Native discovery, eligibility and locators belong to the Adapter. */
export class HarnessSessionImporter {
  readonly #capability: HarnessSessionImportCapability | undefined;
  readonly #adapterRegistered: boolean;
  readonly #harnessId: HarnessId;
  readonly #diagnose: (error: unknown) => void;
  readonly #imports = new Map<string, Promise<HarnessSessionImportOutcome>>();
  readonly #repository: ExternalThreadRepository;

  constructor(input: {
    harnessId: HarnessId;
    adapter?: HarnessAdapter | undefined;
    diagnose?: (error: unknown) => void;
    repository: ExternalThreadRepository;
  }) {
    this.#harnessId = input.harnessId;
    this.#adapterRegistered = input.adapter?.harnessId === input.harnessId;
    this.#capability = this.#adapterRegistered ? input.adapter?.sessionImport : undefined;
    this.#diagnose = input.diagnose ?? (() => undefined);
    this.#repository = input.repository;
  }

  #mappedRecord(
    records: readonly StoredThreadRecordV1[],
    nativeSessionId: string,
  ): StoredThreadRecordV1 | undefined {
    return records.find(
      (record) =>
        !record.subagent &&
        record.state === "ready" &&
        record.nativeSessionRef?.harnessId === this.#harnessId &&
        record.nativeSessionRef.nativeSessionId === nativeSessionId,
    );
  }

  #unavailable(): ExternalThreadRpcError {
    return this.#adapterRegistered
      ? fixedError(-32076, "Harness Session import is unsupported")
      : fixedError(-32077, "Harness is unavailable");
  }

  async list(
    input: Pick<HarnessSessionListParams, "query" | "offset" | "limit"> = {},
  ): Promise<HarnessSessionListOutcome> {
    const capability = this.#capability;
    if (!capability?.resolveCandidate) return { ok: false, error: this.#unavailable() };
    try {
      const listed = await capability.listCandidates();
      if (!listed.ok)
        return { ok: false, error: mapExternalThreadHarnessError(listed.error, "read") };
      // Adapter metadata is not a wire page: total storage must not be bounded by response size.
      const parsed = harnessSessionImportCandidateSchema.array().safeParse(listed.value);
      if (
        !parsed.success ||
        new Set(parsed.data.map(({ nativeSessionId }) => nativeSessionId)).size !==
          parsed.data.length
      ) {
        return { ok: false, error: fixedError(-32082, "Harness Session list is invalid") };
      }
      const mapped = new Set(
        (await this.#repository.list()).flatMap((record) =>
          !record.subagent &&
          record.state === "ready" &&
          record.nativeSessionRef?.harnessId === this.#harnessId
            ? [record.nativeSessionRef.nativeSessionId]
            : [],
        ),
      );
      const query = input.query?.trim().toLowerCase() ?? "";
      const candidates = parsed.data
        .filter(
          (candidate) =>
            !mapped.has(candidate.nativeSessionId) &&
            (!query ||
              [candidate.title, candidate.nativeSessionId, candidate.cwd].some((value) =>
                value?.toLowerCase().includes(query),
              )),
        )
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            left.nativeSessionId.localeCompare(right.nativeSessionId, "en"),
        );
      const offset = input.offset ?? 0;
      return {
        ok: true,
        total: candidates.length,
        candidates: candidates.slice(
          offset,
          offset + (input.limit ?? HARNESS_SESSION_IMPORT_DEFAULT_PAGE_SIZE),
        ),
      };
    } catch {
      return {
        ok: false,
        error: fixedError(-32082, "Harness Session candidates could not be read"),
      };
    }
  }

  import(nativeSessionId: string): Promise<HarnessSessionImportOutcome> {
    const pending = this.#imports.get(nativeSessionId);
    if (pending) return pending;
    const operation = this.#import(nativeSessionId).finally(() => {
      if (this.#imports.get(nativeSessionId) === operation) this.#imports.delete(nativeSessionId);
    });
    this.#imports.set(nativeSessionId, operation);
    return operation;
  }

  async #import(nativeSessionId: string): Promise<HarnessSessionImportOutcome> {
    let records: StoredThreadRecordV1[];
    try {
      records = await this.#repository.list();
    } catch {
      return { ok: false, error: fixedError(-32081, "Session mappings could not be read") };
    }
    const existing = this.#mappedRecord(records, nativeSessionId);
    if (existing) return importedThread(existing);
    const capability = this.#capability;
    if (!capability?.resolveCandidate) return { ok: false, error: this.#unavailable() };

    let source;
    try {
      source = await capability.resolveCandidate(nativeSessionId);
    } catch {
      return { ok: false, error: fixedError(-32077, "Harness Session could not be resolved") };
    }
    // Another request may have committed while native discovery was in flight.
    try {
      records = await this.#repository.list();
    } catch {
      return { ok: false, error: fixedError(-32081, "Session mappings could not be read") };
    }
    const winner = this.#mappedRecord(records, nativeSessionId);
    if (winner) return importedThread(winner);
    if (!source.ok)
      return {
        ok: false,
        error:
          source.error.code === "sessionNotFound"
            ? fixedError(-32079, "Native Session is no longer available")
            : mapExternalThreadHarnessError(source.error, "read"),
      };
    const metadata = harnessSessionImportCandidateSchema.safeParse(source.value.candidate);
    const ref = nativeSessionRefSchema.safeParse(source.value.nativeRef);
    if (
      !metadata.success ||
      !ref.success ||
      ref.data.harnessId !== this.#harnessId ||
      ref.data.nativeSessionId !== nativeSessionId ||
      metadata.data.nativeSessionId !== nativeSessionId
    ) {
      return { ok: false, error: fixedError(-32076, "Harness Session import identity is invalid") };
    }
    const candidate = metadata.data;
    if (candidate.running === true)
      return { ok: false, error: fixedError(-32072, "Native Session is busy") };

    let provisional: StoredThreadRecordV1;
    try {
      provisional = await this.#repository.createProvisional(
        createExternalThreadRecordInput({
          harnessId: this.#harnessId,
          cwd: candidate.cwd,
          ...(candidate.title ? { title: candidate.title } : {}),
          transportModelId: transportModelIdForHarness(this.#harnessId),
          ephemeral: false,
          historyMode: "paginated",
        }),
      );
    } catch {
      return { ok: false, error: fixedError(-32081, "Session import could not be persisted") };
    }
    try {
      const record = await this.#repository.commitNative(provisional.hostThreadId, ref.data, []);
      return importedThread(record);
    } catch (error) {
      await this.#repository
        .removeProvisional(provisional.hostThreadId)
        .catch((cleanupError) => this.#diagnose(cleanupError));
      if (error instanceof MappingStoreError && error.code === "DUPLICATE_NATIVE_SESSION") {
        try {
          const winner = this.#mappedRecord(await this.#repository.list(), nativeSessionId);
          if (winner) return importedThread(winner);
        } catch (readError) {
          this.#diagnose(readError);
        }
      }
      return { ok: false, error: fixedError(-32081, "Session import could not be persisted") };
    }
  }
}
