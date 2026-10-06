import type { HostUsage } from "@codexhost/harness-adapter";
import { gatewayRecord } from "./gateway-transport.js";

/** Only fields actually published by Hermes; account text and credits are not USD. */
export function projectGatewayUsage(value: unknown): HostUsage | null {
  const raw = gatewayRecord(value);
  const usage: HostUsage = {};
  const tokens = [
    ["input", "inputTokens"],
    ["output", "outputTokens"],
    ["reasoning", "reasoningOutputTokens"],
    ["total", "totalTokens"],
    ["context_used", "contextUsedTokens"],
    ["context_max", "contextWindowTokens"],
  ] as const;
  for (const [native, host] of tokens) {
    const value = raw[native];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[host] = value;
  }
  if (
    typeof raw.cache_hit_pct === "number" &&
    Number.isFinite(raw.cache_hit_pct) &&
    raw.cache_hit_pct >= 0 &&
    raw.cache_hit_pct <= 100
  )
    usage.cacheHitRatePercent = raw.cache_hit_pct;
  if (
    typeof raw.context_percent === "number" &&
    Number.isFinite(raw.context_percent) &&
    raw.context_percent >= 0
  )
    usage.contextUsagePercent = raw.context_percent;
  return Object.keys(usage).length ? usage : null;
}

/** Latest native observations, with coalesced optional reads and stale-reply protection. */
export class HermesUsage {
  #latest: HostUsage | null = null;
  #revision = 0;
  #refresh: Promise<void> | null = null;
  constructor(
    readonly read: (() => Promise<HostUsage | null>) | undefined,
    readonly available: () => boolean,
    readonly publish: (usage: HostUsage) => void,
  ) {}
  merge(usage: HostUsage): HostUsage {
    this.#revision++;
    return (this.#latest = { ...this.#latest, ...usage });
  }
  observe(usage: HostUsage): void {
    if (this.available()) this.publish(this.merge(usage));
  }
  refresh(ensureFresh = false): Promise<void> {
    const read = this.read;
    if (!this.available() || !read) return Promise.resolve();
    if (ensureFresh) this.#revision++;
    if (this.#refresh) {
      // Model/Turn boundaries require a new read after an already-running poll.
      return ensureFresh ? this.#refresh.then(() => this.refresh()) : this.#refresh;
    }
    const revision = this.#revision;
    this.#refresh = (async () => {
      try {
        const usage = await read();
        if (usage && revision === this.#revision) this.observe(usage);
      } catch {
        // Optional metadata failures must not interrupt an otherwise healthy chat.
      }
    })().finally(() => {
      this.#refresh = null;
    });
    return this.#refresh;
  }
}
