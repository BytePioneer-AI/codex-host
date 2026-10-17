import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeSessionInteraction } from "../src/sessions.ts";
import { EventHub } from "../src/transport.ts";

test("approval bridge rejects an answer without a matching native action", async () => {
  const frames: Array<{ eventId?: string }> = [];
  const events = new EventHub("/isolated");
  events.handler(
    {},
    {
      id: "viewer",
      closed: false,
      push: (value) => frames.push(value as { eventId?: string }),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  const invocation = bridgeSessionInteraction(events, "session", {
    type: "approval",
    interactionId: "approval",
    actions: [],
  });
  const request = frames.find((f) => f.eventId);
  assert.ok(request?.eventId);
  const rejection = assert.rejects(invocation.result, /does not offer a matching action/);
  events.settle({
    eventId: request.eventId,
    outcome: { kind: "result", value: "allowed-once" },
  } as never);
  await rejection;
});
