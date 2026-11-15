import { expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { harnessCommandDescriptorSchema, hostItemIdSchema } from "@codexhost/shared-contracts";

import {
  createFixture,
  messageParams,
  method,
  requestId,
  startPiThread,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const command = harnessCommandDescriptorSchema.parse({
  id: "fake.review",
  invocation: "/review",
  label: "Review",
  argumentMode: "text",
});

it.each([
  { source: "turn/start", clientId: "desktop-command", projected: true },
  { source: "turn/start", clientId: undefined, projected: false },
  { source: "thread/queue/start", clientId: "queued-command", projected: true },
])(
  "projects command input for $source with clientId=$clientId: $projected",
  async ({ source, clientId, projected }) => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Session was not opened");
      session.commands = {
        list: async () => ({ ok: true, value: { commands: [command] } }),
        execute: async ({ turnId }) => {
          session.publishEphemeralCommand(turnId, {
            type: "contextCompaction",
            itemId: hostItemIdSchema.parse("command-output"),
          });
          return { ok: true, value: { turnId } };
        },
      };
      const text = "/review keep  argument spacing";
      const input = [{ type: "text", text }];
      if (source === "thread/queue/start") {
        writeRequest(fixture.desktopInput, {
          id: 2,
          method: "thread/queue/add",
          params: { threadId, input, ...(clientId ? { clientUserMessageId: clientId } : {}) },
        });
        await fixture.collector.waitFor((message) => requestId(message, 2));
      }
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: source,
        params: {
          threadId,
          ...(source === "turn/start" ? { input } : {}),
          ...(clientId ? { clientUserMessageId: clientId } : {}),
        },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, 3));
      expect(response).not.toHaveProperty("error");
      const turn = (response.result as JsonObject).turn as JsonObject;
      if (typeof turn.id !== "string") throw new Error("Command response has no Turn ID");
      const turnId = turn.id;
      const completed = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      const userItems = (eventMethod: string) =>
        fixture.collector.messages
          .filter(
            (message) =>
              method(message, eventMethod) &&
              (messageParams(message).item as JsonObject)?.type === "userMessage",
          )
          .map((message) => messageParams(message).item);
      const startedItems = userItems("item/started");
      expect(startedItems).toHaveLength(projected ? 1 : 0);
      expect(userItems("item/completed")).toEqual(startedItems);
      const completedTurn = messageParams(completed).turn as JsonObject;
      expect(
        (completedTurn.items as JsonObject[]).filter((item) => item.type === "userMessage"),
      ).toEqual(startedItems);
      if (projected) {
        expect(startedItems[0]).toMatchObject({ clientId, content: [{ type: "text", text }] });
      }
    } finally {
      await stopFixture(fixture);
    }
  },
);
