import { parseHostUsageRequest, type HostEvent, type HostUsage } from "@codexhost/harness-adapter";
import type { HarnessSessionUsageCapability } from "@codexhost/harness-adapter/plugin";

/** Native Codex usage translated into the same request/history events as other Harnesses. */
export class CodexUsage {
  current: HostUsage | null = null;
  private readonly abort = new AbortController();
  private reading: Promise<void> | undefined;
  private dirty = false;

  constructor(
    private readonly source: HarnessSessionUsageCapability,
    private readonly sessionId: () => string,
    private readonly model: () => string | undefined,
    private readonly emit: (event: HostEvent) => void,
    private readonly created: boolean,
  ) {}

  observe(method: string, params: Record<string, unknown>): void {
    const observation = this.source.observe({ method, params });
    if (observation?.usage) {
      this.current = {
        ...observation.usage,
        cacheWriteInputTokens: observation.usage.cacheWriteInputTokens ?? 0,
      };
      this.emit({ type: "session.usage.changed", usage: this.current });
    }
    if (method === "rawResponse/completed") {
      try {
        const usage = params.usage as Record<string, unknown> | undefined;
        const timing = observation?.requestTiming;
        const model = typeof params.model === "string" ? params.model : this.model();
        if (typeof params.responseId !== "string" || !params.responseId || !usage)
          throw new Error("Missing Codex response usage");
        this.emit({
          type: "usage.request",
          request: parseHostUsageRequest({
            requestId: `${this.sessionId()}:${params.responseId}`,
            ...(model ? { model } : {}),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: usage.cachedInputTokens }
              : {}),
            cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
            ...(usage.reasoningOutputTokens != null
              ? { reasoningOutputTokens: usage.reasoningOutputTokens }
              : {}),
            ...(timing
              ? { startedAtMs: timing.startedAtMs, completedAtMs: timing.completedAtMs }
              : {}),
          }),
        });
      } catch {
        this.emit({ type: "usage.history", complete: false });
      }
    }
    if (["thread/tokenUsage/updated", "rawResponse/completed", "turn/completed"].includes(method))
      void this.refresh();
  }

  refresh(): Promise<void> {
    this.dirty = true;
    return (this.reading ??= (async () => {
      do {
        this.dirty = false;
        try {
          const history = await this.source.read(this.sessionId(), this.abort.signal);
          if (this.abort.signal.aborted) return;
          for (const request of history?.requests ?? [])
            this.emit({ type: "usage.request", request });
          this.emit({
            type: "usage.history",
            complete: history?.complete ?? (this.created && this.current === null),
          });
          if (history?.usage && this.current === null)
            this.current = {
              ...history.usage,
              cacheWriteInputTokens: history.usage.cacheWriteInputTokens ?? 0,
            };
          if (this.current) this.emit({ type: "session.usage.changed", usage: this.current });
        } catch {
          if (!this.abort.signal.aborted) this.emit({ type: "usage.history", complete: false });
        }
      } while (this.dirty && !this.abort.signal.aborted);
    })().finally(() => {
      this.reading = undefined;
    }));
  }

  close(): void {
    this.abort.abort();
  }
}
