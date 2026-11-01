import type { JsonObject } from "@codexhost/shared-contracts";
import type { HostUsage, HostUsageRequest } from "./usage.js";

/** Read-only metering for sessions whose execution is owned outside HarnessSession. */
export interface HarnessSessionUsageCapability {
  /** Observe an existing native connection without owning it or issuing native commands.
   * Private protocol parsing belongs to the plugin. Must be synchronous and non-blocking.
   */
  observe(message: unknown, observedAtMs?: number): HarnessSessionUsageObservation | null;
  /** Optional native notification opt-in. Only subscription/telemetry options may be added;
   * never change commands, model selection or user input. null preserves the original request.
   * Host merges the returned parameter patch without changing the request method or ID.
   */
  requestOptions?(input: {
    method: string;
    params: Readonly<JsonObject>;
    initializeParams: Readonly<JsonObject> | null;
  }): JsonObject | null;
  /** Keep plugin-only telemetry out of the native client's notification stream.
   * false suppresses forwarding, not observation. Never called for RPC requests/replies.
   * Must preserve the client's original subscription intent; failures default to forwarding.
   */
  shouldForwardNotification?(message: unknown): boolean;
  /** Forget live measurement boundaries after a connection reinitializes. */
  reset?(): void;
  /** A replacement history, not a delta. null means this plugin has no data for the session.
   * Must not launch a process or write native storage. Reject incomplete/unstable reads.
   */
  read(sessionId: string, signal: AbortSignal): Promise<HarnessSessionUsageHistory | null>;
}

export interface HarnessSessionUsageObservation {
  sessionId: string;
  usage?: HostUsage;
  /** Host timestamps receipt of normalized lifecycle facts for TTFT. */
  turn?: { id: string; phase: "started" | "output" | "completed" };
  /** Measured output interval, separate from the billing history (no duplicate billing). */
  requestTiming?: {
    turnId: string;
    requestId: string;
    outputTokens: number;
    startedAtMs: number;
    completedAtMs: number;
  };
  /** A missing/ambiguous interval invalidates this turn's aggregate speed. */
  timingUnavailable?: { turnId: string };
}

export interface HarnessSessionUsageHistory {
  usage: HostUsage | null;
  requests: readonly HostUsageRequest[];
  complete: boolean;
}
