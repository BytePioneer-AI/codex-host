import type { HarnessSessionUsageObservation } from "@codexhost/harness-adapter/plugin";
import { object } from "./counters.js";

type TimingObservation = Pick<
  HarnessSessionUsageObservation,
  "sessionId" | "requestTiming" | "timingUnavailable"
>;
interface TurnTiming {
  id: string;
  firstOutputAtMs?: number | undefined;
  pending: boolean;
  unavailable: boolean;
  seen: Set<string>;
}
const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Only matched, live upstream completions count. Tool/turn completion is never an endpoint. */
export class CodexResponseTiming {
  readonly #turns = new Map<string, TurnTiming>();

  reset(): void {
    this.#turns.clear();
  }

  observe(message: unknown, now: number): TimingObservation | null {
    const frame = object(message);
    const params = object(frame?.params);
    if (!params || typeof params.threadId !== "string") return null;
    const sessionId = params.threadId;
    const turn = object(params.turn);
    if (frame?.method === "turn/started" && typeof turn?.id === "string") {
      // A repeated start must not discard the first output or the response dedup set.
      if (this.#turns.get(sessionId)?.id !== turn.id) {
        this.#turns.set(sessionId, {
          id: turn.id,
          pending: false,
          unavailable: false,
          seen: new Set(),
        });
      }
      return null;
    }
    const state = this.#turns.get(sessionId);
    if (!state) return null; // A mid-turn attach has no trustworthy starting boundary.
    const unavailable = (): TimingObservation => {
      state.unavailable = true;
      return { sessionId, timingUnavailable: { turnId: state.id } };
    };
    if (frame?.method === "thread/closed") {
      this.#turns.delete(sessionId);
      return unavailable();
    }
    if (frame?.method === "turn/completed" && turn?.id === state.id) {
      this.#turns.delete(sessionId);
      return state.pending || state.unavailable ? unavailable() : null;
    }
    if (params.turnId !== state.id) return null;
    if (frame?.method === "error") return unavailable(); // Retry boundaries are not exposed.
    if (frame?.method === "rawResponse/completed") {
      const id = params.responseId;
      if (typeof id !== "string" || !id) return unavailable();
      if (state.seen.has(id)) return null;
      state.seen.add(id);
      const usage = object(params.usage);
      const startedAtMs = state.firstOutputAtMs;
      state.firstOutputAtMs = undefined;
      state.pending = false;
      if (
        state.unavailable ||
        startedAtMs === undefined ||
        !nonNegativeInteger(now) ||
        now <= startedAtMs ||
        !nonNegativeInteger(usage?.outputTokens) ||
        (usage.reasoningOutputTokens != null &&
          (!nonNegativeInteger(usage.reasoningOutputTokens) ||
            usage.reasoningOutputTokens > usage.outputTokens))
      ) {
        return unavailable();
      }
      return {
        sessionId,
        requestTiming: {
          requestId: id,
          turnId: state.id,
          outputTokens: usage.outputTokens,
          startedAtMs,
          completedAtMs: now,
        },
      };
    }
    if (frame?.method === "rawResponseItem/completed") {
      // This channel also carries user input and tool RESULTS; those are not model generation.
      const item = object(params.item);
      if (
        (item?.type === "message" && item.role === "assistant") ||
        [
          "reasoning",
          "function_call",
          "custom_tool_call",
          "local_shell_call",
          "web_search_call",
          "image_generation_call",
          "tool_search_call",
        ].includes(String(item?.type))
      )
        state.pending = true;
      return null;
    }
    if (frame?.method === "item/started") {
      const item = object(params.item);
      if (item?.type === "agentMessage" || item?.type === "reasoning" || item?.type === "plan") {
        state.pending = true;
        // Like Pi/OMP/Claude, a model output block start is an observable boundary even
        // when its thinking body is hidden. Tool execution starts are not token starts.
        state.firstOutputAtMs ??= now;
      }
      return null;
    }
    const reasoning =
      frame?.method === "item/reasoning/textDelta" ||
      frame?.method === "item/reasoning/summaryTextDelta";
    if (
      (reasoning ||
        frame?.method === "item/agentMessage/delta" ||
        frame?.method === "item/plan/delta") &&
      typeof params.delta === "string" &&
      params.delta.length > 0
    ) {
      state.pending = true;
      state.firstOutputAtMs ??= now;
      // Fall back to the first available delta, as the other adapters do. Native output
      // already includes reasoning; its visibility or separate count is not required.
    }
    return null;
  }
}
