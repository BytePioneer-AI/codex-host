import { performance } from "node:perf_hooks";
import type {
  DecodedThreadListRequest,
  JsonObject,
  OfficialThreadListPage,
} from "@codexhost/protocol-core";

type Stage =
  | "store"
  | "shared_catalog"
  | "aggregate"
  | "external"
  | "official_page"
  | "official_cursor_repair";

interface Metric {
  ms: number;
  calls: number;
  maxMs: number;
}

const rounded = (ms: number): number => Math.round(ms * 100) / 100;

/** Bounded per-page diagnostics; parameters, cursors and Thread contents are not retained. */
export class ThreadListTiming {
  private readonly started: number;
  private readonly stages: Partial<Record<Stage, Metric>> = {};
  private readonly officialCalls: Array<{
    kind: "page" | "cursor_repair";
    limit: number;
    hasCursor: boolean;
    ms: number;
    rows: number;
    ok: boolean;
  }> = [];
  readonly counts = {
    mappingRecords: 0,
    placements: 0,
    sharedRows: 0,
    externalRows: 0,
    returnedRows: 0,
    officialUnavailable: 0,
  };

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now();
  }

  private end(stage: Stage, started: number): void {
    const ms = this.now() - started;
    const metric = (this.stages[stage] ??= { ms: 0, calls: 0, maxMs: 0 });
    metric.ms += ms;
    metric.calls++;
    metric.maxMs = Math.max(metric.maxMs, ms);
  }

  async measure<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await work();
    } finally {
      this.end(stage, started);
    }
  }

  external<T extends { data: unknown[] }>(work: () => T): T {
    const started = this.now();
    try {
      const result = work();
      this.counts.externalRows = result.data.length;
      return result;
    } finally {
      this.end("external", started);
    }
  }

  async official(
    kind: "page" | "cursor_repair",
    params: JsonObject,
    work: () => Promise<OfficialThreadListPage>,
  ): Promise<OfficialThreadListPage> {
    const started = this.now();
    let rows = 0;
    let ok = false;
    try {
      const page = await work();
      rows = page.data.length;
      ok = true;
      return page;
    } finally {
      this.end(kind === "page" ? "official_page" : "official_cursor_repair", started);
      this.officialCalls.push({
        kind,
        limit: typeof params.limit === "number" ? params.limit : 0,
        hasCursor: params.cursor != null,
        ms: rounded(this.now() - started),
        rows,
        ok,
      });
    }
  }

  report(
    requestId: string | number,
    query: DecodedThreadListRequest,
    ok: boolean,
    write: (line: string) => void,
  ): void {
    try {
      if (process.env.CODEXHOST_TRACE_SESSION_LIST !== "1") {
        if (!ok) write("[thread/list] request failed");
        return;
      }
      write(
        `[thread/list] ${JSON.stringify({
          requestId: String(requestId).slice(0, 128),
          origin: "client",
          archived: query.archived,
          limit: query.limit,
          hasCursor: query.cursor !== null,
          sortKey: query.sortKey,
          sortDirection: query.sortDirection,
          ok,
          totalMs: rounded(this.now() - this.started),
          stages: Object.fromEntries(
            Object.entries(this.stages).map(([stage, metric]) => [
              stage,
              { ms: rounded(metric.ms), calls: metric.calls, maxMs: rounded(metric.maxMs) },
            ]),
          ),
          counts: this.counts,
          officialCalls: this.officialCalls,
        })}`,
      );
    } catch {
      // Diagnostic output must never turn a successful list into an RPC error.
    }
  }
}
