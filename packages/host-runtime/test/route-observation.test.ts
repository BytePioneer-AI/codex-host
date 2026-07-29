import { describe, expect, it } from "vitest";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";

import {
  classifyThreadPurpose,
  RequestRouteObservationTracker,
  type CreateRequestRouteObservation,
} from "../src/index.js";

const piRoute: CreateRequestRouteObservation = {
  requestMethod: "thread/start",
  modelCarrier: "pi-transport",
  selectedHarness: "pi",
  selectionSource: "transport-model",
};

const codexRoute: CreateRequestRouteObservation = {
  requestMethod: "thread/start",
  modelCarrier: "official-model",
  selectedHarness: "codex",
  selectionSource: "official-model",
};

function request(params: JsonObject): JsonRpcRequest {
  return { id: 1, method: "thread/start", params };
}

describe("request route observation", () => {
  it("classifies only the non-sensitive thread purpose", () => {
    expect(classifyThreadPurpose(request({ model: "internal", ephemeral: true }))).toBe(
      "ephemeral",
    );
    expect(classifyThreadPurpose(request({ model: "internal" }))).toBe("conversation");
  });

  it("associates Pi and official turns using anonymous create ordinals", () => {
    const tracker = new RequestRouteObservationTracker();

    const piCreate = tracker.registerCreate("pi-request", piRoute, "conversation");
    tracker.bindCreatedThread("pi-request", "pi-thread");
    const officialCreate = tracker.registerCreate("official-request", codexRoute, "ephemeral");
    tracker.bindOfficialResponse({
      id: "official-request",
      result: { thread: { id: "official-thread" } },
    });

    expect(piCreate).toEqual({
      ...piRoute,
      createOrdinal: 1,
      threadPurpose: "conversation",
    });
    expect(officialCreate).toEqual({
      ...codexRoute,
      createOrdinal: 2,
      threadPurpose: "ephemeral",
    });
    expect(tracker.observeTurn("pi-thread", "codex")).toEqual({
      requestMethod: "turn/start",
      createOrdinal: 1,
      selectedHarness: "pi",
      threadPurpose: "conversation",
      association: "matched",
    });
    expect(tracker.observeTurn("official-thread", "codex")).toEqual({
      requestMethod: "turn/start",
      createOrdinal: 2,
      selectedHarness: "codex",
      threadPurpose: "ephemeral",
      association: "matched",
    });
    tracker.forgetThread("pi-thread");
    expect(tracker.observeTurn("pi-thread", "codex")).toEqual({
      requestMethod: "turn/start",
      createOrdinal: null,
      selectedHarness: "codex",
      threadPurpose: null,
      association: "unmatched",
    });
    expect(piCreate).not.toHaveProperty("requestId");
    expect(piCreate).not.toHaveProperty("threadId");
  });

  it("marks turns without a create observation as unmatched", () => {
    const tracker = new RequestRouteObservationTracker();

    expect(tracker.observeTurn("existing-thread", "codex")).toEqual({
      requestMethod: "turn/start",
      createOrdinal: null,
      selectedHarness: "codex",
      threadPurpose: null,
      association: "unmatched",
    });
  });
});
