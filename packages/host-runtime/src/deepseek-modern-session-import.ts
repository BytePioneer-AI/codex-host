import type { HarnessAdapter, HarnessSessionImportCapability } from "@codexhost/harness-adapter";
import { MappingStoreError, type StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  mapExternalThreadHarnessError,
  transportModelIdForHarness,
  type ExternalThreadRpcError,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  nativeSessionRefSchema,
  type DeepSeekModernSessionCandidate,
  type HostThreadId,
} from "@codexhost/shared-contracts";

import {
  createExternalThreadRecordInput,
  externalThreadValue,
  type ExternalThreadRepository,
} from "./external-thread-repository.js";

const DEEPSEEK_HARNESS_ID = harnessIdSchema.parse("deepseek-harness");

export type DeepSeekModernSessionListOutcome =
  | { ok: true; candidates: DeepSeekModernSessionCandidate[] }
  | { ok: false; error: ExternalThreadRpcError };

export type DeepSeekModernSessionImportOutcome =
  | { ok: true; threadId: HostThreadId; thread: JsonObject }
  | { ok: false; error: ExternalThreadRpcError };

function sessionImportCapability(
  adapter: HarnessAdapter | undefined,
): HarnessSessionImportCapability | null {
  return adapter?.harnessId === DEEPSEEK_HARNESS_ID ? (adapter.sessionImport ?? null) : null;
}

function fixedError(code: number, message: string): ExternalThreadRpcError {
  return { code, message };
}

function mappedRecord(
  records: readonly StoredThreadRecordV1[],
  nativeSessionId: string,
): StoredThreadRecordV1 | undefined {
  return records.find(
    (record) =>
      !record.subagent &&
      record.state === "ready" &&
      record.nativeSessionRef?.harnessId === DEEPSEEK_HARNESS_ID &&
      record.nativeSessionRef.nativeSessionId === nativeSessionId,
  );
}

function importedThread(
  record: StoredThreadRecordV1,
): Extract<DeepSeekModernSessionImportOutcome, { ok: true }> {
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

export class DeepSeekModernSessionImporter {
  readonly #sessionImport: HarnessSessionImportCapability | null;
  readonly #adapterRegistered: boolean;
  readonly #diagnose: (error: unknown) => void;
  readonly #imports = new Map<string, Promise<DeepSeekModernSessionImportOutcome>>();
  readonly #repository: ExternalThreadRepository;

  constructor(input: {
    adapter?: HarnessAdapter | undefined;
    diagnose?: (error: unknown) => void;
    repository: ExternalThreadRepository;
  }) {
    this.#sessionImport = sessionImportCapability(input.adapter);
    this.#adapterRegistered = input.adapter?.harnessId === DEEPSEEK_HARNESS_ID;
    this.#diagnose = input.diagnose ?? (() => undefined);
    this.#repository = input.repository;
  }

  async list(): Promise<DeepSeekModernSessionListOutcome> {
    const listed = await this.#readCandidates();
    if (!listed.ok) return listed;
    try {
      const records = await this.#repository.list();
      return {
        ok: true,
        candidates: listed.candidates.filter(
          ({ nativeSessionId }) => !mappedRecord(records, nativeSessionId),
        ),
      };
    } catch {
      return {
        ok: false,
        error: fixedError(-32081, "DeepSeek Session mappings could not be read"),
      };
    }
  }

  import(nativeSessionId: string): Promise<DeepSeekModernSessionImportOutcome> {
    const pending = this.#imports.get(nativeSessionId);
    if (pending) return pending;
    const operation = this.#import(nativeSessionId).finally(() => {
      if (this.#imports.get(nativeSessionId) === operation) this.#imports.delete(nativeSessionId);
    });
    this.#imports.set(nativeSessionId, operation);
    return operation;
  }

  async #readCandidates(): Promise<DeepSeekModernSessionListOutcome> {
    const sessionImport = this.#sessionImport;
    if (!sessionImport) {
      return {
        ok: false,
        error: this.#adapterRegistered
          ? fixedError(-32076, "DeepSeek Modern Session import is unsupported")
          : fixedError(-32077, "DeepSeek Harness is unavailable"),
      };
    }
    try {
      const listed = await sessionImport.listCandidates();
      return listed.ok
        ? { ok: true, candidates: [...listed.value] }
        : { ok: false, error: mapExternalThreadHarnessError(listed.error, "read") };
    } catch {
      return {
        ok: false,
        error: fixedError(-32077, "DeepSeek Harness is unavailable"),
      };
    }
  }

  async #import(nativeSessionId: string): Promise<DeepSeekModernSessionImportOutcome> {
    let records: StoredThreadRecordV1[];
    try {
      records = await this.#repository.list();
    } catch {
      return {
        ok: false,
        error: fixedError(-32081, "DeepSeek Session mappings could not be read"),
      };
    }
    const existing = mappedRecord(records, nativeSessionId);
    if (existing) return importedThread(existing);

    const listed = await this.#readCandidates();
    if (!listed.ok) return listed;
    try {
      records = await this.#repository.list();
    } catch {
      return {
        ok: false,
        error: fixedError(-32081, "DeepSeek Session mappings could not be read"),
      };
    }
    const winner = mappedRecord(records, nativeSessionId);
    if (winner) return importedThread(winner);
    const candidate = listed.candidates.find(
      (session) => session.nativeSessionId === nativeSessionId,
    );
    if (!candidate) {
      return {
        ok: false,
        error: fixedError(-32079, "DeepSeek Modern Session is no longer available"),
      };
    }
    if (candidate.running) {
      return {
        ok: false,
        error: fixedError(-32072, "DeepSeek Modern Session is busy"),
      };
    }

    let provisional: StoredThreadRecordV1;
    try {
      provisional = await this.#repository.createProvisional(
        createExternalThreadRecordInput({
          harnessId: DEEPSEEK_HARNESS_ID,
          cwd: candidate.cwd,
          ...(candidate.title ? { title: candidate.title } : {}),
          transportModelId: transportModelIdForHarness("deepseek-harness"),
          ephemeral: false,
          historyMode: "paginated",
        }),
      );
    } catch {
      return {
        ok: false,
        error: fixedError(-32081, "DeepSeek Modern Session import could not be persisted"),
      };
    }

    try {
      const record = await this.#repository.commitNative(
        provisional.hostThreadId,
        nativeSessionRefSchema.parse({
          harnessId: DEEPSEEK_HARNESS_ID,
          nativeSessionId,
          formatVersion: 1,
        }),
        [],
      );
      return importedThread(record);
    } catch (error) {
      await this.#repository
        .removeProvisional(provisional.hostThreadId)
        .catch((cleanupError) => this.#diagnose(cleanupError));
      if (error instanceof MappingStoreError && error.code === "DUPLICATE_NATIVE_SESSION") {
        try {
          const winner = mappedRecord(await this.#repository.list(), nativeSessionId);
          if (winner) return importedThread(winner);
        } catch (readError) {
          this.#diagnose(readError);
        }
      }
      return {
        ok: false,
        error: fixedError(-32081, "DeepSeek Modern Session import could not be persisted"),
      };
    }
  }
}
