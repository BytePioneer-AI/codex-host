import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi, type Mock } from "vitest";
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
  const createCall: Mock<ExternalVoiceCallFactory> = vi.fn(async (options) => {
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
    "forwards %s attachment-task progress and completion to an already open call",
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
            transport: { type: "existingCall", callId: "rtc_fixture" },
          },
        });
        await fixture.collector.waitFor((message) => requestId(message, 2));
        writeRequest(fixture.desktopInput, {
          id: 3,
          method: "turn/start",
          params: { threadId, input: [{ type: "text", text: "Read the attached audit task." }] },
        });
        const response = await fixture.collector.waitFor((message) => requestId(message, 3));
        const turnId = (response.result as JsonObject).turn as JsonObject;
        const session = adapter.sessions[0];
        if (!session) throw new Error("Expected selected Harness session");
        session.startReasoning("PRIVATE REASONING MUST NOT BE SPOKEN");
        const command = session.startCommandExecution("PRIVATE TOOL MUST NOT BE SPOKEN");
        session.completeItem(command, { status: "succeeded" });
        const item = {
          type: "agentMessage" as const,
          itemId: hostItemIdSchema.parse("44444444-4444-4444-8444-444444444444"),
          text: "Both scouts have returned. Checking their findings.",
        };
        const activeTurnId = hostTurnIdSchema.parse(turnId.id);
        session.emitEvent({ type: "item.started", turnId: activeTurnId, item });
        session.emitEvent({
          type: "item.completed",
          turnId: activeTurnId,
          snapshot: { item, outcome: { status: "succeeded" } },
        });
        const validation = session.startCommandExecution("PRIVATE VALIDATION MUST NOT BE SPOKEN");
        session.completeItem(validation, { status: "succeeded" });
        await vi.waitFor(() => expect(call.sent).toHaveLength(1));
        session.appendText("Audit complete. The focused tests passed.");
        session.succeedTurn();
        await fixture.collector.waitFor(
          (message) =>
            message.method === "turn/completed" &&
            ((message.params as JsonObject).turn as JsonObject)?.id === turnId.id,
        );
        await vi.waitFor(() => expect(call.sent).toHaveLength(2));
        expect(call.sent).toEqual([
          {
            type: "session.context.append",
            content: [{ type: "input_text", text: item.text }],
          },
          {
            type: "session.context.append",
            content: [{ type: "input_text", text: "Audit complete. The focused tests passed." }],
          },
        ]);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it.each([
    { hangup: false, label: "forwards completion of work already running when voice opens" },
    { hangup: true, label: "suppresses completion after hangup without cancelling existing work" },
  ])("$label", async ({ hangup }) => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const call = transport();
    const fixture = createFixture({
      externalAdapters: new Map([["claude-code", adapter]]),
      createExternalVoiceCall: call.createCall,
    });
    try {
      const threadId = await startExternalThread(fixture, "codexhost/claude-code-native");
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "Audit the voice lifecycle." }] },
      });
      await fixture.collector.waitFor((message) => requestId(message, 2));
      const params = {
        threadId,
        outputModality: "audio",
        transport: { type: "existingCall", callId: "rtc_fixture" },
      };
      writeRequest(fixture.desktopInput, { id: 3, method: "thread/realtime/start", params });
      await fixture.collector.waitFor((message) => requestId(message, 3));
      if (hangup) {
        writeRequest(fixture.desktopInput, {
          id: 4,
          method: "thread/realtime/stop",
          params: { threadId },
        });
        await fixture.collector.waitFor((message) => requestId(message, 4));
      }
      const session = adapter.sessions[0];
      if (!session) throw new Error("Expected selected Harness session");
      session.appendText("Audit complete.");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => message.method === "turn/completed");
      if (!hangup) {
        await vi.waitFor(() =>
          expect(call.sent).toEqual([
            {
              type: "session.context.append",
              content: [{ type: "input_text", text: "Audit complete." }],
            },
          ]),
        );
        return;
      }
      expect(call.sent).toEqual([]);
      writeRequest(fixture.desktopInput, { id: 5, method: "thread/realtime/start", params });
      await fixture.collector.waitFor((message) => requestId(message, 5));
      expect(call.createCall).toHaveBeenCalledTimes(2);
      expect(call.sent).toEqual([]);
    } finally {
      await stopFixture(fixture);
    }
  });

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
            handoff_id: "handoff-one",
            user_bidi_turn_id: "user-one",
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
        call.event({
          type: "turn.done",
          turn: { id: "user-one", role: "user", transcript: "Three plus two" },
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(
          fixture.collector.messages.filter(
            (message) =>
              message.method === "turn/started" &&
              (message.params as JsonObject)?.threadId === threadId,
          ),
        ).toHaveLength(1);
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

  it("still projects command and turn completion after hangup, and late interrupt is a no-op", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
    const call = transport();
    const fixture = createFixture({
      externalAdapters: new Map([["grok", adapter]]),
      createExternalVoiceCall: call.createCall,
    });
    try {
      const threadId = await startExternalThread(fixture, "codexhost/grok-native");
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/realtime/start",
        params: {
          threadId,
          outputModality: "audio",
          transport: { type: "webrtc", sdp: "v=0\r\noffer" },
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 2));
      call.event({
        type: "turn.done",
        turn: { role: "user", transcript: "list files" },
      });
      const session = adapter.sessions[0];
      if (!session) throw new Error("Expected selected Harness session");
      await fixture.collector.waitFor(
        (message) =>
          message.method === "turn/started" &&
          (message.params as JsonObject)?.threadId === threadId,
      );
      const turnStarted = fixture.collector.messages.find(
        (message) =>
          message.method === "turn/started" &&
          (message.params as JsonObject)?.threadId === threadId,
      );
      const turnId = ((turnStarted?.params as JsonObject)?.turn as JsonObject | undefined)?.id;
      if (typeof turnId !== "string") throw new Error("Expected voice Turn id");
      const commandId = session.startCommandExecution("ls -la");
      await fixture.collector.waitFor(
        (message) =>
          message.method === "item/started" &&
          ((message.params as JsonObject).item as JsonObject | undefined)?.type ===
            "commandExecution",
      );
      session.completeItem(commandId, { status: "succeeded" });
      await fixture.collector.waitFor(
        (message) =>
          message.method === "item/completed" &&
          ((message.params as JsonObject).item as JsonObject | undefined)?.type ===
            "commandExecution",
      );
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "thread/realtime/stop",
        params: { threadId },
      });
      await fixture.collector.waitFor((message) => requestId(message, 3));
      session.appendText("Only empty outputs/ and work/.");
      session.succeedTurn();
      const completed = await fixture.collector.waitFor(
        (message) =>
          message.method === "turn/completed" &&
          (message.params as JsonObject)?.threadId === threadId,
      );
      expect(completed).toMatchObject({ params: { turn: { status: "completed" } } });
      expect(
        fixture.collector.messages.some(
          (message) =>
            message.method === "item/completed" &&
            ((message.params as JsonObject).item as JsonObject | undefined)?.type ===
              "commandExecution",
        ),
      ).toBe(true);
      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "turn/interrupt",
        params: { threadId, turnId },
      });
      await expect(fixture.collector.waitFor((message) => requestId(message, 4))).resolves.toEqual({
        id: 4,
        result: {},
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("seeds a reopened call with prior Thread messages and routes a user transcript without delegation", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
    const call = transport();
    const fixture = createFixture({
      externalAdapters: new Map([["grok", adapter]]),
      createExternalVoiceCall: call.createCall,
    });
    try {
      const threadId = await startExternalThread(fixture, "codexhost/grok-native");
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "list files" }] },
      });
      await fixture.collector.waitFor((message) => requestId(message, 2));
      const first = adapter.sessions[0];
      if (!first) throw new Error("Expected selected Harness session");
      first.appendText("Only empty outputs/ and work/.");
      first.succeedTurn();
      await fixture.collector.waitFor(
        (message) =>
          message.method === "turn/completed" &&
          (message.params as JsonObject)?.threadId === threadId,
      );
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "thread/realtime/start",
        params: {
          threadId,
          outputModality: "audio",
          transport: { type: "webrtc", sdp: "v=0\r\noffer" },
        },
      });
      await fixture.collector.waitFor((message) => requestId(message, 3));
      expect(call.createCall).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: [expect.objectContaining({ text: "Only empty outputs/ and work/." })],
            }),
          ]),
        }),
      );
      const startedBefore = fixture.collector.messages.filter(
        (message) => message.method === "turn/started",
      ).length;
      call.event({
        type: "turn.done",
        turn: { role: "user", transcript: "你啱啱搵到咩檔案" },
      });
      await fixture.collector.waitFor(
        (message) =>
          message.method === "turn/started" &&
          (message.params as JsonObject)?.threadId === threadId &&
          fixture.collector.messages.filter((entry) => entry.method === "turn/started").length >
            startedBefore,
      );
      const second = adapter.sessions[0];
      if (!second) throw new Error("Expected follow-up Harness session");
      second.appendText("The workspace still has only empty outputs/ and work/.");
      second.succeedTurn();
      await vi.waitFor(() =>
        expect(call.sent.some((event) => event.type === "session.context.append")).toBe(true),
      );
    } finally {
      await stopFixture(fixture);
    }
  });

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
