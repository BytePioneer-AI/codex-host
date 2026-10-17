import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, type JsonObject } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import type { ExternalVoiceCallFactory } from "../src/external-voice-gateway.js";
import {
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

function transport() {
  let input: Parameters<ExternalVoiceCallFactory>[0];
  const sent: JsonObject[] = [];
  const close = vi.fn(async () => {});
  const createCall: ExternalVoiceCallFactory = vi.fn(async (options) => {
    input = options;
    return {
      sdp: "v=0\r\nanswer",
      connect: async () => {},
      send: (event: JsonObject) => {
        sent.push(event);
      },
      close,
    };
  });
  return {
    createCall,
    close,
    sent,
    event: (event: JsonObject) => input.onEvent(event),
    fail: () => input.onError(),
  };
}

describe("external native voice routing", () => {
  it.each(["grok", "claude-code"])(
    "uses the selected %s session and never starts a Codex task",
    async (name) => {
      const adapter = new FakeHarnessAdapter(harnessIdSchema.parse(name));
      const call = transport();
      const fixture = createFixture({
        externalAdapters: new Map([[name, adapter]]),
        createExternalVoiceCall: call.createCall,
      });
      try {
        const threadId = await startExternalThread(fixture, `codexhost/${name}-native`);
        writeRequest(fixture.desktopInput, {
          id: 2,
          method: "thread/realtime/start",
          params: {
            threadId,
            outputModality: "audio",
            transport: { type: "webrtc", sdp: "v=0\r\noffer" },
          },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
          result: {},
        });
        expect(fixture.collector.messages).toContainEqual(
          expect.objectContaining({
            method: "thread/realtime/sdp",
            params: { threadId, sdp: "v=0\r\nanswer" },
          }),
        );
        const delegation = {
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id: "task-one",
            content: [{ type: "input_text", text: "Three plus two" }],
          },
        };
        call.event(delegation);
        call.event(delegation);
        const session = adapter.sessions[0];
        if (!session) throw new Error("Expected selected Harness session");
        await fixture.collector.waitFor(
          (message) =>
            message.method === "turn/started" &&
            (message.params as JsonObject)?.threadId === threadId,
        );
        session.startReasoning("PRIVATE REASONING MUST NOT BE SPOKEN");
        session.appendText("Five");
        session.succeedTurn();
        await vi.waitFor(() => expect(call.sent).toHaveLength(1));
        expect(call.sent[0]).toEqual({
          type: "delegation.context.append",
          delegation_item_id: "task-one",
          channel: "speakable",
          content: [{ type: "input_text", text: "Five" }],
        });
        expect(adapter.sessions).toHaveLength(1);
        expect(fixture.official.stdin.readableLength).toBe(0);
        writeRequest(fixture.desktopInput, {
          id: 3,
          method: "thread/realtime/stop",
          params: { threadId },
        });
        await fixture.collector.waitFor((message) => requestId(message, 3));
        expect(call.close).toHaveBeenCalledTimes(1);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("closes a failed call and permits an explicit retry", async () => {
    const call = transport();
    const fixture = createFixture({ createExternalVoiceCall: call.createCall });
    try {
      const threadId = await startExternalThread(fixture, "codexhost/pi-native");
      const params = {
        threadId,
        outputModality: "audio",
        transport: { type: "webrtc", sdp: "v=0\r\noffer" },
      };
      writeRequest(fixture.desktopInput, { id: 2, method: "thread/realtime/start", params });
      await fixture.collector.waitFor((message) => requestId(message, 2));
      call.fail();
      await fixture.collector.waitFor((message) => message.method === "thread/realtime/closed");
      expect(call.close).toHaveBeenCalledTimes(1);
      writeRequest(fixture.desktopInput, { id: 3, method: "thread/realtime/start", params });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: {},
      });
      expect(call.createCall).toHaveBeenCalledTimes(2);
    } finally {
      await stopFixture(fixture);
    }
  });
});
