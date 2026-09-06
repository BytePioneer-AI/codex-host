import {
  harnessSessionImportSourcesResultSchema,
  harnessSessionListParamsSchema,
  harnessSessionListResultSchema,
  harnessSessionImportParamsSchema,
  harnessSessionImportResultSchema,
  type HarnessSessionImportSourcesResult,
  type HarnessSessionListParams,
  type HarnessSessionListResult,
  type HarnessSessionImportParams,
  type HarnessSessionImportResult,
} from "@codexhost/shared-contracts";

export interface RendererSessionImportClient {
  listSessionImportSources(): Promise<HarnessSessionImportSourcesResult>;
  listHarnessSessions(input: HarnessSessionListParams): Promise<HarnessSessionListResult>;
  importHarnessSession(input: HarnessSessionImportParams): Promise<HarnessSessionImportResult>;
}

export class RendererSessionImportUnavailableError extends Error {
  constructor() {
    super("Harness Session import is unavailable");
    this.name = "RendererSessionImportUnavailableError";
  }
}

/** Fixed, typed methods only; callers never receive an arbitrary request bridge. */
export function createRendererSessionImportClient(
  send: (method: string, params: unknown) => Promise<unknown>,
): RendererSessionImportClient {
  const pending = new Map<string, Promise<HarnessSessionImportResult>>();
  const request = async (method: string, params: unknown): Promise<unknown> => {
    try {
      return await send(method, params);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === -32601 || code === -32076) throw new RendererSessionImportUnavailableError();
      throw error;
    }
  };
  return {
    async listSessionImportSources() {
      return harnessSessionImportSourcesResultSchema.parse(
        await request("codexhost/harness/session-import/sources", {}),
      );
    },
    async listHarnessSessions(input) {
      const params = harnessSessionListParamsSchema.parse(input);
      return harnessSessionListResultSchema.parse(
        await request("codexhost/harness/session-import/list", params),
      );
    },
    async importHarnessSession(input) {
      const params = harnessSessionImportParamsSchema.parse(input);
      const key = JSON.stringify([params.harnessId, params.nativeSessionId]);
      const existing = pending.get(key);
      if (existing) return existing;
      const operation = request("codexhost/harness/session-import/import", params)
        .then((value) => harnessSessionImportResultSchema.parse(value))
        .finally(() => {
          if (pending.get(key) === operation) pending.delete(key);
        });
      pending.set(key, operation);
      return operation;
    },
  };
}
