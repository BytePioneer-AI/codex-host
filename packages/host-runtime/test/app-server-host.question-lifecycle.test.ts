import { PassThrough } from "node:stream";
import { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";
import type { DelegationControlApi } from "../src/delegation-types.js";
import {
  bindOfficialThread,
  createFixture,
  method,
  readJsonLine,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("Question and native Turn lifecycle boundaries", () => {
  it("rejects a stale answer after a Thread releases and resumes its Session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    try {
      const threadId = await startPiThread(fixture);
      const firstTurn = await startPiTurn(fixture, threadId);
      const first = fixture.adapter.sessions[0];
      if (!first || !api) throw new Error("Missing delegation fixture");
      const question = {
        id: "value",
        type: "text" as const,
        prompt: "Value?",
        multiline: false,
        optional: false,
        secret: false,
      };
      const nativeId = first.askQuestion(question);
      await fixture.collector.waitFor((m) => method(m, "item/tool/requestUserInput"));
      const oldId = (await api.read({ threadId, view: "result" })).pendingQuestions?.[0]
        ?.interactionId;
      if (!oldId) throw new Error("Missing original Question");
      await api.answer({
        threadId,
        interactionId: oldId,
        result: { answers: { value: { answers: ["first answer"] } } },
      });
      first.succeedTurn();
      await fixture.collector.waitFor((m) => turnEvent(m, "turn/completed", firstTurn));
      const snapshot = await first.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const close = vi.spyOn(first, "close");
      const open = fixture.adapter.open.bind(fixture.adapter);
      let resumed: FakeHarnessSession | undefined;
      vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
        if (input.kind !== "resume") return open(input);
        resumed = new FakeHarnessSession(
          fixture.adapter.harnessId,
          fixture.adapter.catalog,
          undefined,
          input.nativeRef,
          snapshot.value,
        );
        return { ok: true, value: resumed };
      });
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((m) => requestId(m, 900));
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      const secondTurn = await startPiTurn(fixture, threadId, 902);
      if (!resumed) throw new Error("Session was not resumed");
      expect(resumed.askQuestion(question)).toBe(nativeId);
      await fixture.collector.waitFor(
        (m) =>
          method(m, "item/tool/requestUserInput") && (m.params as JsonObject).turnId === secondTurn,
      );
      await expect(
        api.answer({
          threadId,
          interactionId: oldId,
          result: { answers: { value: { answers: ["stale first answer"] } } },
        }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
      expect(resumed.interactionResponses).toEqual([]);
      const newId = (await api.read({ threadId, view: "result" })).pendingQuestions?.[0]
        ?.interactionId;
      if (!newId) throw new Error("Missing resumed Question");
      expect(newId).not.toBe(oldId);
      await expect(
        api.answer({
          threadId,
          interactionId: newId,
          result: { answers: { value: { answers: ["new answer"] } } },
        }),
      ).resolves.toMatchObject({ turnId: secondTurn });
      expect(resumed.interactionResponses).toMatchObject([
        { interactionId: nativeId, response: { answers: { value: ["new answer"] } } },
      ]);
    } finally {
      await stopFixture(fixture);
      vi.useRealTimers();
    }
  });

  it.each(["running", "rejected", "completed-before-response"] as const)(
    "preserves a later start across an earlier terminal write (%s)",
    async (outcome) => {
      let release: (() => void) | undefined;
      const output = new PassThrough({ highWaterMark: 1 });
      const transform = output._transform.bind(output);
      output._transform = (chunk, encoding, callback) => {
        if (String(chunk).includes('"turn/completed"') && !release) {
          output.push(chunk);
          let released = false;
          release = () => {
            if (!released) {
              released = true;
              callback();
            }
          };
        } else transform(chunk, encoding, callback);
      };
      const fixture = createFixture({ desktopOutput: output, officialExitsOnInputEnd: false });
      const threadId = "019cbe86-76cf-7721-b5e4-978934e18757";
      const firstTurn = "019cbe86-8eef-79d0-8658-cf2c64aa38cf";
      const secondTurn = "019cbe86-8eef-79d0-8658-cf2c64aa38d0";
      const emit = (value: JsonObject) => writeRequest(fixture.official.stdout, value);
      const completed = (turnId: string) =>
        emit({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        });
      try {
        await bindOfficialThread(fixture, threadId);
        writeRequest(fixture.desktopInput, {
          id: 1,
          method: "turn/start",
          params: { threadId, input: [{ type: "text", text: "first" }] },
        });
        await readJsonLine(fixture.official.stdin);
        emit({ id: 1, result: { turn: { id: firstTurn } } });
        await fixture.collector.waitFor((m) => requestId(m, 1));
        completed(firstTurn);
        await fixture.collector.waitFor((m) => turnEvent(m, "turn/completed", firstTurn));
        writeRequest(fixture.desktopInput, {
          id: 2,
          method: "turn/start",
          params: { threadId, input: [{ type: "text", text: "second" }] },
        });
        expect(await readJsonLine(fixture.official.stdin)).toMatchObject({
          id: 2,
          method: "turn/start",
        });
        fixture.host.disconnect();
        if (!release) throw new Error("Terminal frame was not held");
        release();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(fixture.official.stdin.writableEnded).toBe(false);
        expect(fixture.official.kill).not.toHaveBeenCalled();
        if (outcome === "rejected") {
          emit({ id: 2, error: { code: -32000, message: "rejected" } });
        } else {
          if (outcome === "completed-before-response") {
            // Two terminal IDs may precede the response; neither can settle a different start.
            completed(firstTurn);
            completed(secondTurn);
          }
          emit({ id: 2, result: { turn: { id: secondTurn } } });
        }
        await fixture.collector.waitFor((m) => requestId(m, 2));
        if (outcome === "running") {
          // A late terminal for the first Turn must not clear the second active Turn.
          completed(firstTurn);
          await vi.waitFor(() =>
            expect(
              fixture.collector.messages.filter((m) => turnEvent(m, "turn/completed", firstTurn)),
            ).toHaveLength(2),
          );
          await new Promise((resolve) => setImmediate(resolve));
          expect(fixture.official.stdin.writableEnded).toBe(false);
          completed(secondTurn);
        }
        await expect(fixture.running).resolves.toBe(0);
      } finally {
        release?.();
        await stopFixture(fixture);
      }
    },
  );
});
