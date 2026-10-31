/** Public session-import wire fixture; native discovery and mapping remain on the Host side. */
import {
  harnessSessionImportParamsSchema,
  harnessSessionListParamsSchema,
  type HarnessSessionImportCandidate,
} from "@codexhost/shared-contracts";
import { FakeChHost } from "./ch-host.ts";
import { defined } from "./defined.ts";

export class SessionImportHost extends FakeChHost {
  readonly sources = [
    { harnessId: "fake", name: "CH Harness" },
    { harnessId: "pi", name: "Pi" },
  ];
  readonly candidates = new Map<string, HarnessSessionImportCandidate[]>();
  readonly mappings = new Map<string, string>();
  beforeList?: (params: Record<string, unknown>) => Promise<void>;
  beforeImport?: () => Promise<void>;
  importError?: string;
  failCatalogAfterImport = false;

  constructor() {
    super();
    const candidates: HarnessSessionImportCandidate[] = Array.from({ length: 25 }, (_, index) => ({
      nativeSessionId: `native-${index}`,
      title: `Native history ${index}`,
      cwd: "/computer/import-project",
      updatedAt: 1_000_000 - index,
      running: index === 0 ? true : index === 1 ? false : null,
    }));
    this.candidates.set("fake", candidates);
    this.candidates.set("pi", [{ ...defined(candidates[2]), title: "Pi same native identity" }]);
  }

  override async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "thread/list" && this.failCatalogAfterImport && this.mappings.size)
      throw new Error("Catalog temporarily unavailable");
    if (!method.startsWith("codexhost/harness/session-import/"))
      return super.request<T>(method, params);
    this.requests.push({ method, params: structuredClone(params) });
    if (method.endsWith("/sources")) return { harnesses: this.sources } as T;
    if (method.endsWith("/list")) {
      const {
        harnessId,
        query = "",
        offset = 0,
        limit = 20,
      } = harnessSessionListParamsSchema.parse(params);
      await this.beforeList?.(params);
      const needle = query.toLowerCase();
      const candidates = (this.candidates.get(harnessId) ?? []).filter(
        (candidate) =>
          !this.mappings.has(JSON.stringify([harnessId, candidate.nativeSessionId])) &&
          [candidate.title, candidate.nativeSessionId, candidate.cwd].some((value) =>
            value?.toLowerCase().includes(needle),
          ),
      );
      return {
        candidates: candidates.slice(offset, offset + limit),
        total: candidates.length,
      } as T;
    }
    const { harnessId, nativeSessionId } = harnessSessionImportParamsSchema.parse(params);
    await this.beforeImport?.();
    if (this.importError) throw new Error(this.importError);
    const key = JSON.stringify([harnessId, nativeSessionId]);
    const existing = this.mappings.get(key);
    if (existing) return { threadId: existing } as T;
    const candidate = this.candidates
      .get(harnessId)
      ?.find((row) => row.nativeSessionId === nativeSessionId);
    if (!candidate) throw new Error("Native Session is no longer available");
    if (candidate.running === true) throw new Error("Native Session is busy");
    const threadId = `import-${harnessId}-${nativeSessionId}`;
    this.add(threadId, candidate.cwd, candidate.title ?? "Imported history");
    this.mappings.set(key, threadId);
    return { threadId } as T;
  }
}
