import type {
  HarnessResult,
  HarnessSessionImportCapability,
  HarnessSessionImportSource,
} from "@codexhost/harness-adapter";
import type { HarnessSessionImportCandidate } from "@codexhost/shared-contracts";

export class AntigravitySessionImport implements HarnessSessionImportCapability {
  constructor(_environment: NodeJS.ProcessEnv) {}

  async listCandidates(_options?: {
    signal?: AbortSignal;
  }): Promise<HarnessResult<HarnessSessionImportCandidate[]>> {
    throw new Error("AntigravitySessionImport stub");
  }

  async resolveCandidate(
    _nativeSessionId: string,
    _options?: { signal?: AbortSignal },
  ): Promise<HarnessResult<HarnessSessionImportSource>> {
    throw new Error("AntigravitySessionImport stub");
  }
}
