import { jsonObjectSchema, type JsonObject } from "@codexhost/shared-contracts";
import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";
import type { HarnessSessionUsageCapability } from "@codexhost/harness-adapter/plugin";
import { UsageMeter } from "./usage-metering.js";
import type { ModelPriceCatalog } from "./model-prices.js";

interface State {
  provider: HarnessSessionUsageCapability;
  meter: UsageMeter;
  live: HostUsage | null;
  history: HostUsage | null;
  revision: number;
  activeTurnId: string | null;
}

/** Generic read-only bridge. Native protocol and storage formats remain plugin-owned. */
export class ObservedSessionUsage {
  readonly #states = new Map<string, State>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #abort = new AbortController();
  #initializeParams: JsonObject | null = null;
  constructor(
    private readonly providers: () => readonly HarnessSessionUsageCapability[],
    private readonly prices: ModelPriceCatalog,
    private readonly diagnose: (error: unknown) => void,
  ) {}

  initialized(params: JsonObject): void {
    this.#initializeParams = params;
    for (const state of this.#states.values()) {
      state.meter.resetTurnTiming();
      state.activeTurnId = null;
    }
    for (const provider of this.providers()) {
      try {
        provider.reset?.();
      } catch (error) {
        this.diagnose(error);
      }
    }
  }

  requestOptions(method: string, params: JsonObject): JsonObject | null {
    if (this.#abort.signal.aborted) return null;
    let result: JsonObject | null = null;
    for (const provider of this.providers()) {
      try {
        const patch = provider.requestOptions?.({
          method,
          params,
          initializeParams: this.#initializeParams,
        });
        if (patch) result = Object.assign(result ?? {}, jsonObjectSchema.parse(patch));
      } catch (error) {
        this.diagnose(error);
      }
    }
    return result;
  }

  shouldForwardNotification(message: unknown): boolean {
    if (this.#abort.signal.aborted) return true;
    for (const provider of this.providers()) {
      try {
        if (provider.shouldForwardNotification?.(message) === false) return false;
      } catch (error) {
        this.diagnose(error);
      }
    }
    return true;
  }

  observe(message: unknown, now = Date.now()): string[] {
    if (this.#abort.signal.aborted) return [];
    const changed = new Set<string>();
    for (const provider of this.providers()) {
      try {
        const observation = provider.observe(message, now);
        if (!observation) continue;
        const state = this.#state(observation.sessionId, provider);
        if (state.provider !== provider) continue;
        if (observation.usage) {
          state.live = parseHostUsage(observation.usage);
          state.revision++;
        }
        const turn = observation.turn;
        if (turn?.phase === "started" && state.activeTurnId !== turn.id) {
          state.meter.resetTurnTiming();
          state.meter.turnStarted(turn.id, now);
          state.activeTurnId = turn.id;
        }
        const timing = observation.requestTiming;
        if (timing) state.meter.recordOutputTiming(timing, timing.turnId);
        if (observation.timingUnavailable)
          state.meter.invalidateOutputTiming(observation.timingUnavailable.turnId);
        if (turn?.phase === "completed") {
          state.meter.turnCompleted(turn.id);
          if (state.activeTurnId === turn.id) state.activeTurnId = null;
        }
        const firstOutput = turn?.phase === "output" && state.meter.outputObserved(turn.id, now);
        if (
          observation.usage ||
          firstOutput ||
          timing ||
          observation.timingUnavailable ||
          turn?.phase === "started" ||
          turn?.phase === "completed"
        )
          changed.add(observation.sessionId);
      } catch (error) {
        this.diagnose(error);
      }
    }
    return [...changed];
  }

  async read(sessionId: string): Promise<HostUsage | null> {
    if (this.#abort.signal.aborted) return null;
    let pending = this.#pending.get(sessionId);
    if (!pending) {
      pending = this.#refresh(sessionId).finally(() => this.#pending.delete(sessionId));
      this.#pending.set(sessionId, pending);
    }
    await pending;
    const state = this.#states.get(sessionId);
    if (!state || this.#abort.signal.aborted) return null;
    const native = state.live ?? state.history;
    const result = state.meter.derive(native, await this.prices.lookup());
    if (result?.unpricedModels?.length) this.prices.missing();
    return result;
  }

  async #refresh(sessionId: string): Promise<void> {
    const existing = this.#states.get(sessionId);
    for (const provider of existing ? [existing.provider] : this.providers()) {
      const revision = existing?.revision ?? 0;
      try {
        const history = await provider.read(sessionId, this.#abort.signal);
        if (this.#abort.signal.aborted) return;
        if (!history) {
          if (existing?.meter.metered) existing.meter.recordHistory(false);
          continue;
        }
        const state = this.#state(sessionId, provider);
        state.history = history.usage ? parseHostUsage(history.usage) : null;
        state.meter.replaceHistory(
          history.requests,
          history.complete && state.revision === revision,
        );
        return;
      } catch (error) {
        existing?.meter.recordHistory(false);
        if (!this.#abort.signal.aborted) this.diagnose(error);
      }
    }
  }

  #state(id: string, provider: HarnessSessionUsageCapability): State {
    let state = this.#states.get(id);
    if (!state) {
      state = {
        provider,
        meter: new UsageMeter(),
        live: null,
        history: null,
        revision: 0,
        activeTurnId: null,
      };
      this.#states.set(id, state);
    }
    return state;
  }

  close(): void {
    this.#abort.abort();
    this.#states.clear();
  }
}
