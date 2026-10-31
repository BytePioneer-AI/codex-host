import type {
  HarnessError,
  HarnessResult,
  HarnessSessionImportCandidate,
  HarnessSessionImportCapability,
} from "@codexhost/harness-adapter";
import type { HarnessId } from "@codexhost/shared-contracts";

import { HARNESS_BROKER_SESSION_IMPORT_PAGE_SIZE } from "./protocol.js";
import { brokerSessionImportPageSchema, brokerSessionImportSourceSchema } from "./validation.js";

/** One listing at a time preserves the connection's server-side page snapshot. */
export function createBrokerSessionImportCapability(input: {
  harnessId: HarnessId;
  request(
    method: "adapter.sessionImport.list" | "adapter.sessionImport.resolve",
    params: unknown,
  ): Promise<HarnessResult<unknown>>;
  isClosed(): boolean;
  error(error: unknown): HarnessError;
}): HarnessSessionImportCapability {
  let listing: Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> | null = null;
  const closed = (): HarnessResult<never> => ({
    ok: false,
    error: { code: "invalidState", message: "Harness broker adapter is closed", retryable: false },
  });
  const invalid = (): HarnessResult<never> => ({
    ok: false,
    error: {
      code: "protocolError",
      message: "Harness broker returned invalid Session import metadata",
      retryable: false,
    },
  });
  const list = async (): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> => {
    try {
      const candidates: HarnessSessionImportCandidate[] = [];
      const identities = new Set<string>();
      let total: number | undefined;
      for (;;) {
        if (input.isClosed()) return closed();
        const result = await input.request("adapter.sessionImport.list", {
          offset: candidates.length,
          limit: HARNESS_BROKER_SESSION_IMPORT_PAGE_SIZE,
        });
        if (input.isClosed()) return closed();
        if (!result.ok) return result;
        const page = brokerSessionImportPageSchema.safeParse(result.value);
        if (
          !page.success ||
          (total !== undefined && total !== page.data.total) ||
          page.data.total < candidates.length + page.data.candidates.length ||
          (page.data.candidates.length === 0 && candidates.length < page.data.total)
        )
          return invalid();
        total = page.data.total;
        for (const candidate of page.data.candidates) {
          if (identities.has(candidate.nativeSessionId)) return invalid();
          identities.add(candidate.nativeSessionId);
          candidates.push(candidate);
        }
        if (candidates.length === total) return { ok: true, value: candidates };
      }
    } catch (error) {
      return { ok: false, error: input.error(error) };
    }
  };
  return {
    listCandidates() {
      if (input.isClosed()) return Promise.resolve(closed());
      listing ??= list().finally(() => {
        listing = null;
      });
      return listing;
    },
    async resolveCandidate(nativeSessionId) {
      if (input.isClosed()) return closed();
      try {
        const result = await input.request("adapter.sessionImport.resolve", { nativeSessionId });
        if (input.isClosed()) return closed();
        if (!result.ok) return result;
        const source = brokerSessionImportSourceSchema.safeParse(result.value);
        if (
          !source.success ||
          source.data.nativeRef.harnessId !== input.harnessId ||
          source.data.candidate.nativeSessionId !== nativeSessionId
        )
          return invalid();
        return { ok: true, value: source.data };
      } catch (error) {
        return { ok: false, error: input.error(error) };
      }
    },
  };
}
