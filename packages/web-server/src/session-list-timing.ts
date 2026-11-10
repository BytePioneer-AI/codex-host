import { performance } from "node:perf_hooks";

type ListTimingStage =
  | "workspace_wait"
  | "catalog_wait"
  | "host_catalog"
  | "pins"
  | "project_definitions"
  | "projects"
  | "workspace_sync"
  | "archive_sync"
  | "catalog_publish"
  | "summaries"
  | "serialize"
  | "compress";

type ListCounter =
  | "unarchivedRows"
  | "archivedRows"
  | "ownershipIds"
  | "visibleRows"
  | "projects"
  | "workspaceReferences"
  | "resultRows";

interface StageTiming {
  ms: number;
  calls: number;
  maxMs: number;
}

interface TimingSnapshot {
  totalMs: number;
  stages: Partial<Record<ListTimingStage, StageTiming>>;
  counts: Partial<Record<ListCounter, number>>;
}

const rounded = (value: number): number => Math.round(value * 100) / 100;

/** Aggregate only timing and counts; never retain Thread metadata or request payloads. */
export class SessionListTiming {
  private readonly started: number;
  private readonly stages: TimingSnapshot["stages"] = {};
  private readonly counts: TimingSnapshot["counts"] = {};
  catalog: (TimingSnapshot & { mode: "started" | "joined" }) | undefined;
  responseBytes = 0;

  constructor(
    private readonly rpcId?: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.started = now();
  }

  private start(stage: ListTimingStage): () => void {
    const started = this.now();
    const metric = (this.stages[stage] ??= { ms: 0, calls: 0, maxMs: 0 });
    metric.calls++;
    return () => {
      const ms = this.now() - started;
      metric.ms += ms;
      metric.maxMs = Math.max(metric.maxMs, ms);
    };
  }

  async measure<T>(stage: ListTimingStage, work: () => Promise<T>): Promise<T> {
    const end = this.start(stage);
    try {
      return await work();
    } finally {
      end();
    }
  }

  measureSync<T>(stage: ListTimingStage, work: () => T): T {
    const end = this.start(stage);
    try {
      return work();
    } finally {
      end();
    }
  }

  count(name: ListCounter, value: number): void {
    this.counts[name] = (this.counts[name] ?? 0) + value;
  }

  snapshot(): TimingSnapshot {
    return {
      totalMs: rounded(this.now() - this.started),
      stages: Object.fromEntries(
        Object.entries(this.stages).map(([name, metric]) => [
          name,
          { ms: rounded(metric.ms), calls: metric.calls, maxMs: rounded(metric.maxMs) },
        ]),
      ),
      counts: { ...this.counts },
    };
  }

  serverTiming(): string {
    const snapshot = this.snapshot();
    return [
      `list_total;dur=${snapshot.totalMs}`,
      ...Object.entries(snapshot.stages).map(([name, metric]) => `${name};dur=${metric.ms}`),
      ...Object.entries(this.catalog?.stages ?? {}).map(
        ([name, metric]) => `catalog_${name};dur=${metric.ms}`,
      ),
    ].join(", ");
  }

  report(ok: boolean, encodedBytes?: number): void {
    if (process.env.CODEXHOST_TRACE_SESSION_LIST !== "1") {
      if (!ok) console.error("[session/list] request failed");
      return;
    }
    console.info(
      `[session/list] ${JSON.stringify({
        rpcId: this.rpcId?.slice(0, 128),
        ok,
        ...this.snapshot(),
        catalog: this.catalog,
        responseBytes: this.responseBytes,
        ...(encodedBytes === undefined ? {} : { encodedBytes }),
      })}`,
    );
  }
}
