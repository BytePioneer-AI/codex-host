import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH,
  deepSeekModernSessionListResultSchema,
  deepSeekModernSessionImportParamsSchema,
  deepSeekModernSessionListParamsSchema,
  harnessIdSchema,
  harnessSessionImportParamsSchema,
  harnessSessionImportResultSchema,
  harnessSessionImportSourcesParamsSchema,
  harnessSessionImportSourcesResultSchema,
  harnessSessionListParamsSchema,
  harnessSessionListResultSchema,
  jsonValueSchema,
  type HarnessPluginDescriptor,
  type JsonObject,
  type JsonRpcRequest,
} from "@codexhost/shared-contracts";

import type { ExternalThreadRepository } from "./external-thread-repository.js";
import { HarnessSessionImporter } from "./harness-session-import.js";

const SOURCES = "codexhost/harness/session-import/sources";
const LIST = "codexhost/harness/session-import/list";
const IMPORT = "codexhost/harness/session-import/import";
const LEGACY_LIST = "codexhost/deepseek/modern-session/list";
const LEGACY_IMPORT = "codexhost/deepseek/modern-session/import";

export function isSessionImportRequest(method: string): boolean {
  return [SOURCES, LIST, IMPORT, LEGACY_LIST, LEGACY_IMPORT].includes(method);
}

interface SessionImportResponse {
  body: JsonObject;
  importedThread?: JsonObject;
}

/** Method-specific RPC validation and one shared per-Harness importer, including legacy aliases. */
export class SessionImportRequests {
  readonly #importers = new Map<string, HarnessSessionImporter>();
  readonly #notified = new Set<string>();
  constructor(
    private readonly input: {
      adapters: ReadonlyMap<string, HarnessAdapter>;
      descriptors: () => readonly HarnessPluginDescriptor[];
      repository: ExternalThreadRepository;
      diagnose: (error: unknown) => void;
    },
  ) {}

  async handle(request: JsonRpcRequest): Promise<SessionImportResponse> {
    const invalid = (): SessionImportResponse => ({
      body: { error: { code: -32602, message: "Invalid Session import params" } },
    });
    if (request.method === SOURCES) {
      if (!harnessSessionImportSourcesParamsSchema.safeParse(request.params).success)
        return invalid();
      const harnesses = [...this.input.adapters]
        .filter(([, adapter]) => Boolean(adapter.sessionImport?.resolveCandidate))
        .map(([harnessId]) => ({
          harnessId,
          name: this.input.descriptors().find(({ id }) => id === harnessId)?.name ?? harnessId,
        }));
      return {
        body: {
          result: jsonValueSchema.parse(
            harnessSessionImportSourcesResultSchema.parse({ harnesses }),
          ),
        },
      };
    }
    const listing = request.method === LIST || request.method === LEGACY_LIST;
    let params: unknown = request.params;
    if (request.method === LEGACY_LIST || request.method === LEGACY_IMPORT) {
      const legacy = listing
        ? deepSeekModernSessionListParamsSchema.safeParse(params)
        : deepSeekModernSessionImportParamsSchema.safeParse(params);
      if (!legacy.success) return invalid();
      params = { ...legacy.data, harnessId: "deepseek-harness" };
    }
    const parsed = listing
      ? harnessSessionListParamsSchema.safeParse(params)
      : harnessSessionImportParamsSchema.safeParse(params);
    if (!parsed.success) return invalid();
    const { harnessId } = parsed.data;
    let importer = this.#importers.get(harnessId);
    if (!importer) {
      importer = new HarnessSessionImporter({
        harnessId: harnessIdSchema.parse(harnessId),
        adapter: this.input.adapters.get(harnessId),
        repository: this.input.repository,
        diagnose: this.input.diagnose,
      });
      // Unrecognized client IDs must not grow a permanent cache.
      if (this.input.adapters.has(harnessId)) this.#importers.set(harnessId, importer);
    }
    if (listing) {
      const outcome = await importer.list(
        request.method === LEGACY_LIST
          ? { limit: HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH }
          : harnessSessionListParamsSchema.parse(parsed.data),
      );
      return {
        body: outcome.ok
          ? {
              result: jsonValueSchema.parse(
                request.method === LEGACY_LIST
                  ? deepSeekModernSessionListResultSchema.parse({ candidates: outcome.candidates })
                  : harnessSessionListResultSchema.parse({
                      candidates: outcome.candidates,
                      total: outcome.total,
                    }),
              ),
            }
          : { error: { ...outcome.error } },
      };
    }
    const imported = harnessSessionImportParamsSchema.parse(parsed.data);
    const outcome = await importer.import(imported.nativeSessionId);
    if (!outcome.ok) return { body: { error: { ...outcome.error } } };
    const notify = !this.#notified.has(outcome.threadId);
    if (notify) this.#notified.add(outcome.threadId);
    return {
      body: {
        result: jsonValueSchema.parse(
          harnessSessionImportResultSchema.parse({ threadId: outcome.threadId }),
        ),
      },
      ...(notify ? { importedThread: outcome.thread } : {}),
    };
  }
}
