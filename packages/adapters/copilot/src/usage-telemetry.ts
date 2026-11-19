import type { SessionEvent } from "@github/copilot-sdk";
import type { HostUsage } from "@codexhost/harness-adapter";

type Receipt = Extract<SessionEvent, { type: "assistant.usage" }>["data"];
export type LiveUsage = Pick<
  HostUsage,
  "outputTokensPerSecond" | "apiOutputTokensPerSecond" | "cacheHitRatePercent"
>;
interface Call {
  turn?: string;
  receipt?: Receipt;
  consumed?: boolean;
}
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Joins native usage to a root message before updating the current logical Turn's rates. */
export class CopilotUsageTelemetry {
  private turn: string | undefined;
  private calls = new Map<string, Call>();
  private output = 0;
  private generationMs = 0;
  private apiMs = 0;
  private generationKnown = true;
  private apiKnown = true;
  private latest: LiveUsage = {};

  begin(turn: string): void {
    this.turn = turn;
    this.output = this.generationMs = this.apiMs = 0;
    this.generationKnown = this.apiKnown = true;
  }
  snapshot(): LiveUsage {
    return { ...this.latest };
  }

  associate(apiCallId: string | undefined, turn: string): boolean {
    if (turn !== this.turn) return false;
    if (!apiCallId) {
      this.generationKnown = this.apiKnown = false;
      return false;
    }
    const call = this.entry(apiCallId);
    if (call.turn && call.turn !== turn) {
      this.generationKnown = this.apiKnown = false;
      return false;
    }
    call.turn ??= turn;
    return this.consume(call);
  }
  receive(receipt: Receipt): boolean {
    if (!receipt.apiCallId || receipt.parentToolCallId || receipt.initiator === "sub-agent")
      return false;
    const call = this.entry(receipt.apiCallId);
    if (call.receipt) return false;
    call.receipt = receipt;
    return this.consume(call);
  }
  private entry(id: string): Call {
    let call = this.calls.get(id);
    if (!call) {
      call = {};
      this.calls.set(id, call);
    }
    if (this.calls.size > 2048) {
      const oldest = this.calls.entries().next().value;
      if (oldest) {
        if (oldest[1].turn === this.turn && !oldest[1].consumed)
          this.generationKnown = this.apiKnown = false;
        this.calls.delete(oldest[0]);
      }
    }
    return call;
  }
  private consume(call: Call): boolean {
    if (call.turn !== this.turn || !call.turn || !call.receipt || call.consumed) return false;
    call.consumed = true;
    const data = call.receipt;
    if (
      count(data.inputTokens) &&
      data.inputTokens > 0 &&
      count(data.cacheReadTokens) &&
      data.cacheReadTokens <= data.inputTokens
    )
      this.latest.cacheHitRatePercent = (data.cacheReadTokens / data.inputTokens) * 100;
    if (!count(data.outputTokens) || !duration(data.duration) || data.duration <= 0) {
      this.generationKnown = this.apiKnown = false;
      return true;
    }
    this.output += data.outputTokens; // Native output already includes reasoning tokens.
    this.apiMs += data.duration;
    const first = data.outputTtftMs;
    if (!duration(first) || first >= data.duration) this.generationKnown = false;
    else this.generationMs += data.duration - first;
    if (
      !Number.isSafeInteger(this.output) ||
      !Number.isFinite(this.apiMs) ||
      !Number.isFinite(this.generationMs)
    )
      this.generationKnown = this.apiKnown = false;
    // A call whose receipt is still pending prevents a partial Turn from looking complete.
    if ([...this.calls.values()].some((entry) => entry.turn === this.turn && !entry.consumed))
      return true;
    const apiRate = this.output / (this.apiMs / 1000);
    const generationRate = this.output / (this.generationMs / 1000);
    if (this.apiKnown && this.apiMs > 0 && Number.isFinite(apiRate))
      this.latest.apiOutputTokensPerSecond = apiRate;
    if (this.generationKnown && this.generationMs > 0 && Number.isFinite(generationRate))
      this.latest.outputTokensPerSecond = generationRate;
    return true;
  }
}
