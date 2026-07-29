import type { JsonRpcRequest } from "@codexhost/protocol-core";

export interface CreateRequestRouteObservation {
  requestMethod: "thread/start";
  modelCarrier: "official-model" | "pi-transport";
  selectedHarness: "codex" | "pi";
  selectionSource: "default-agent" | "official-model" | "transport-model";
}

export type ThreadPurpose = "conversation" | "ephemeral";

export interface TrackedCreateRouteObservation extends CreateRequestRouteObservation {
  createOrdinal: number;
  threadPurpose: ThreadPurpose;
}

export interface TurnRequestRouteObservation {
  requestMethod: "turn/start";
  createOrdinal: number | null;
  selectedHarness: "codex" | "pi";
  threadPurpose: ThreadPurpose | null;
  association: "matched" | "unmatched";
}

export type RequestRouteObservation = TrackedCreateRouteObservation | TurnRequestRouteObservation;

interface TrackedCreate {
  createOrdinal: number;
  selectedHarness: "codex" | "pi";
  threadPurpose: ThreadPurpose;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyThreadPurpose(request: JsonRpcRequest): ThreadPurpose {
  return isRecord(request.params) && request.params.ephemeral === true
    ? "ephemeral"
    : "conversation";
}

export class RequestRouteObservationTracker {
  #nextCreateOrdinal = 0;
  readonly #pendingByRequestId = new Map<unknown, TrackedCreate>();
  readonly #createByThreadId = new Map<string, TrackedCreate>();

  registerCreate(
    requestId: unknown,
    route: CreateRequestRouteObservation,
    threadPurpose: ThreadPurpose,
  ): TrackedCreateRouteObservation {
    const tracked: TrackedCreate = {
      createOrdinal: ++this.#nextCreateOrdinal,
      selectedHarness: route.selectedHarness,
      threadPurpose,
    };
    this.#pendingByRequestId.set(requestId, tracked);
    return { ...route, createOrdinal: tracked.createOrdinal, threadPurpose };
  }

  bindCreatedThread(requestId: unknown, threadId: string): void {
    const tracked = this.#pendingByRequestId.get(requestId);
    if (!tracked) return;
    this.#pendingByRequestId.delete(requestId);
    this.#createByThreadId.set(threadId, tracked);
  }

  bindOfficialResponse(response: unknown): void {
    if (!isRecord(response) || !("id" in response)) return;
    const tracked = this.#pendingByRequestId.get(response.id);
    if (!tracked) return;
    this.#pendingByRequestId.delete(response.id);
    const result = response.result;
    const thread = isRecord(result) ? result.thread : null;
    if (isRecord(thread) && typeof thread.id === "string") {
      this.#createByThreadId.set(thread.id, tracked);
    }
  }

  observeTurn(threadId: string, fallbackHarness: "codex" | "pi"): TurnRequestRouteObservation {
    const tracked = this.#createByThreadId.get(threadId);
    if (!tracked) {
      return {
        requestMethod: "turn/start",
        createOrdinal: null,
        selectedHarness: fallbackHarness,
        threadPurpose: null,
        association: "unmatched",
      };
    }
    return {
      requestMethod: "turn/start",
      createOrdinal: tracked.createOrdinal,
      selectedHarness: tracked.selectedHarness,
      threadPurpose: tracked.threadPurpose,
      association: "matched",
    };
  }

  clear(): void {
    this.#pendingByRequestId.clear();
    this.#createByThreadId.clear();
  }
}
