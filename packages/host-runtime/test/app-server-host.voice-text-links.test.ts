import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, type JsonObject } from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";

import type { ExternalVoiceCallFactory } from "../src/external-voice-gateway.js";
import {
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

it("preserves written links and one Agent item identity when speech returns a shorter transcript", async () => {
  const answer = [
    "- [Sannysoft](https://bot.sannysoft.com/)",
    "- [Rebrowser](https://bot-detector.rebrowser.net/)",
    "- [BrowserLeaks](https://browserleaks.com/javascript)",
  ].join("\n");
  const spoken = "Here are the three browser test sites.";
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
  let onEvent: Parameters<ExternalVoiceCallFactory>[0]["onEvent"] | undefined;
  const sent: JsonObject[] = [];
  const fixture = createFixture({
    externalAdapters: new Map([["grok", adapter]]),
    createExternalVoiceCall: async (options) => {
      onEvent = options.onEvent;
      return {
        sdp: "v=0\r\nanswer",
        connect: async () => {},
        send: (event) => {
          sent.push(event);
        },
        close: async () => {},
      };
    },
  });
  try {
    const threadId = await startExternalThread(fixture, "codexhost/grok-native");
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/realtime/start",
      params: {
        threadId,
        outputModality: "audio",
        transport: { type: "existingCall", callId: "rtc_fixture" },
      },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "List the three test links." }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 3));
    const session = adapter.sessions[0];
    if (!session) throw new Error("Expected Grok Harness fixture session");
    session.appendText(answer);
    session.succeedTurn();
    const terminal = await fixture.collector.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        (message.params as JsonObject)?.threadId === threadId,
    );
    await vi.waitFor(() =>
      expect(
        sent
          .flatMap((event) => event.content as JsonObject[])
          .map((part) => part.text)
          .join(""),
      ).toBe(answer),
    );
    expect(sent.every((event) => event.type === "session.context.append")).toBe(true);

    if (!onEvent) throw new Error("Expected speech event handler");
    onEvent({ type: "turn.done", turn: { role: "assistant", transcript: spoken } });
    const transcript = await fixture.collector.waitFor(
      (message) => message.method === "thread/realtime/transcript/done",
    );
    expect(transcript.params).toMatchObject({ threadId, role: "assistant", text: spoken });

    const items = ((terminal.params as JsonObject).turn as JsonObject).items as JsonObject[];
    const answers = items.filter((item) => item.type === "agentMessage");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ text: answer, phase: "final_answer" });
    const completions = fixture.collector.messages
      .filter(
        (message) =>
          message.method === "item/completed" &&
          (message.params as JsonObject)?.threadId === threadId,
      )
      .map((message) => (message.params as JsonObject).item as JsonObject)
      .filter((item) => item.type === "agentMessage");
    expect(completions.length).toBeGreaterThan(0);
    expect(new Set(completions.map((item) => item.id))).toEqual(new Set([answers[0]?.id]));
    expect(completions.every((item) => item.text === answer)).toBe(true);
  } finally {
    await stopFixture(fixture);
  }
});
