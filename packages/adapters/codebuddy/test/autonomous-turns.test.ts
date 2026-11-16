import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate as tick } from "node:timers/promises";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { CodeBuddyAutonomousTurns } from "../src/autonomous.js";
import { snapshotFromHistory } from "../src/history.js";
import { fixture } from "./fixtures.js";

type Native = ReturnType<typeof fixture>;
type Client = Native["clients"][number];
type Options = NonNullable<ConstructorParameters<typeof CodeBuddyAdapter>[0]>;
const adapters: CodeBuddyAdapter[] = [];
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing test fixture value");
  return value;
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.close()));
});
const host = (id: string, input = "hello") => ({
  type: "turn.start" as const,
  turnId: hostTurnIdSchema.parse(id),
  input: [{ type: "text" as const, text: input }],
});
async function setup(custom?: (native: Native) => Partial<Options>) {
  const native = fixture();
  const readHistory = vi.fn(native.readHistory);
  const adapter = new CodeBuddyAdapter({ ...native, readHistory, ...custom?.(native) });
  adapters.push(adapter);
  const result = await adapter.open({ kind: "create", cwd: process.cwd() });
  if (!result.ok) throw Error(result.error.message);
  const session = result.value;
  const outputs: HarnessOutput[] = [];
  const closed = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  const events = () => outputs.flatMap((o) => (o.kind === "event" ? [o.event] : []));
  const ids = () =>
    events().flatMap((e) => (e.type === "turn.autonomous.started" ? [e.turnId] : []));
  const completed = async (count = 1) => {
    await vi.waitFor(() =>
      expect(events().filter((e) => e.type === "turn.completed")).toHaveLength(count),
    );
    return events().filter((e) => e.type === "turn.completed");
  };
  const texts = (id: string) =>
    events().flatMap((e) =>
      e.type === "item.updated" && e.turnId === id && e.update.type === "text.append"
        ? [e.update.text]
        : [],
    );
  return {
    native,
    session,
    client: required(native.clients[0]),
    readHistory,
    outputs,
    events,
    ids,
    completed,
    texts,
    closed,
  };
}
function announce(client: Client, requestId = "reused") {
  client.update({
    sessionUpdate: "session_info_update",
    _meta: {
      "codebuddy.ai/unsolicitedTurn": { requestId, reason: "background_drain" },
      "codebuddy.ai/requestId": requestId,
    },
  });
}
function text(client: Client, message: string, requestId = "reused") {
  client.update({
    sessionUpdate: "agent_message_chunk",
    messageId: `${message}-answer`,
    content: { type: "text", text: message },
    _meta: { "codebuddy.ai/requestId": requestId },
  });
}
function end(client: Client, requestId = "reused") {
  client.update({
    sessionUpdate: "session_end",
    stopReason: "end_turn",
    _meta: { "codebuddy.ai/requestId": requestId },
  });
}
function hidden(id: string, parentId?: unknown, extra = {}) {
  return {
    type: "message",
    role: "user",
    id,
    parentId,
    providerData: { isMeta: true, conversationRequestId: "reused", ...extra },
    content: [{ type: "input_text", text: id }],
  };
}
function persist(native: Native, id: string, extra = {}) {
  native.history.push(hidden(`${id}-user`, native.history.at(-1)?.id, extra));
  native.history.push({
    type: "message",
    role: "assistant",
    id: `${id}-answer`,
    parentId: `${id}-user`,
    status: "completed",
    content: [{ type: "output_text", text: id }],
  });
}
function gateHistory(native: Native, target: number) {
  const entered = Promise.withResolvers<undefined>(),
    release = Promise.withResolvers<undefined>();
  let count = 0;
  return {
    entered: entered.promise,
    release: () => release.resolve(undefined),
    readHistory: async () => {
      const contents = native.history.map((row) => JSON.stringify(row)).join("\n");
      if (++count === target) {
        entered.resolve(undefined);
        await release.promise;
      }
      return contents;
    },
  };
}
function noNativeRef(
  completed: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["completed"]>>,
) {
  for (const event of completed) expect(event.nativeTurnRef).toBeUndefined();
}

describe("CodeBuddy limited live autonomous Turns", () => {
  it("ends an idle round without reading history or inventing a Native Turn Ref", async () => {
    const f = await setup();
    announce(f.client);
    text(f.client, "answer");
    end(f.client);
    const completed = await f.completed();
    expect(completed).toMatchObject([{ outcome: { status: "succeeded" }, ephemeral: true }]);
    noNativeRef(completed);
    expect(f.readHistory).not.toHaveBeenCalled();
    expect(f.texts(required(f.ids()[0]))).toEqual(["answer"]);
    expect(f.events().filter((e) => e.type === "turn.started")).toHaveLength(1);
  });

  it("keeps the Host identity when a drain lands before the Host terminal snapshot", async () => {
    const f = await setup();
    await f.session.execute(host("host", "hold"));
    f.client.finishPending();
    announce(f.client);
    text(f.client, "next");
    persist(f.native, "next");
    end(f.client);
    const completed = await f.completed(2);
    expect(completed[0]).toMatchObject({
      turnId: "host",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: "user-1" },
    });
    noNativeRef(completed.slice(1));
    expect(f.texts("host")).toEqual(["Result hold"]);
    expect(f.texts(required(f.ids()[0]))).toEqual(["next"]);
  });

  it("rejects a Host start when an autonomous round arrives during admission", async () => {
    let gate!: ReturnType<typeof gateHistory>;
    const f = await setup((n) => {
      gate = gateHistory(n, 1);
      return { readHistory: gate.readHistory };
    });
    const starting = f.session.execute(host("host"));
    await gate.entered;
    announce(f.client);
    gate.release();
    expect(await starting).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(f.events().filter((e) => e.type === "turn.started" && e.turnId === "host")).toEqual([]);
    end(f.client);
    await f.completed();
  });

  it.each([false, true])(
    "keeps three buffered rounds' content separate (reused ID: %s)",
    async (reused) => {
      let gate!: ReturnType<typeof gateHistory>;
      const f = await setup((n) => {
        gate = gateHistory(n, 2);
        return { readHistory: gate.readHistory };
      });
      await f.session.execute(host("host", "hold"));
      f.client.finishPending();
      await gate.entered;
      for (const key of ["one", "two", "three"]) {
        const id = reused ? "reused" : key;
        announce(f.client, id);
        text(f.client, key, id);
        persist(f.native, key);
        end(f.client, id);
      }
      gate.release();
      await f.completed(4);
      expect(f.ids().map(f.texts)).toEqual([["one"], ["two"], ["three"]]);
      expect(f.events().filter((e) => e.type === "session.faulted")).toEqual([]);
      const sequence = f
        .events()
        .filter((e) => e.type === "turn.completed" || e.type === "turn.autonomous.started");
      expect(sequence[0]).toMatchObject({ type: "turn.completed", turnId: "host" });
    },
  );

  it("faults a genuinely overlapping announcement and settles the active Turn once", async () => {
    const f = await setup();
    announce(f.client);
    text(f.client, "partial");
    announce(f.client);
    await f.closed;
    expect(f.events().filter((e) => e.type === "session.faulted")).toMatchObject([
      { error: { code: "protocolError" } },
    ]);
    expect(await f.completed()).toMatchObject([{ outcome: { status: "failed" } }]);
    expect(f.events().filter((e) => e.type === "item.completed")).toHaveLength(1);
  });

  it.each(["approval", "question", "question-rpc"])(
    "gives an announced drain its %s before the Host prompt finally runs",
    async (kind) => {
      const f = await setup();
      await f.session.execute(host("host", "hold"));
      f.client.finishPending();
      announce(f.client);
      const questions = [{ question: "Choose?", options: [{ label: "Alpha" }, { label: "Beta" }] }];
      const answer =
        kind === "question-rpc"
          ? f.client.context.handlers.question({
              sessionId: "native-session",
              toolCallId: "ask",
              schema: { questions },
            })
          : f.client.context.handlers.permission({
              sessionId: "native-session",
              toolCall: {
                toolCallId: "call",
                rawInput: kind === "question" ? { questions } : { file_path: "probe.txt" },
                _meta: {
                  "codebuddy.ai/toolName": kind === "question" ? "AskUserQuestion" : "Write",
                },
              },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            });
      await vi.waitFor(() =>
        expect(f.outputs.filter((o) => o.kind === "interaction")).toHaveLength(1),
      );
      const output = required(f.outputs.find((o) => o.kind === "interaction"));
      if (output.kind !== "interaction") throw Error("No interaction");
      expect(output.interaction.turnId).toBe(f.ids()[0]);
      expect(output.interaction.turnId).not.toBe("host");
      const response =
        kind === "approval"
          ? { type: "approval" as const, actionId: "allow" }
          : { type: "question" as const, answers: { q_0: ["Alpha"] } };
      expect(
        await f.session.execute({
          type: "interaction.respond",
          interactionId: output.interaction.interactionId,
          response,
        }),
      ).toMatchObject({ ok: true });
      await answer;
      end(f.client);
      await f.completed(2);
    },
  );

  it("does not infer completion or a Native Turn Ref from failed Host leftovers", async () => {
    const f = await setup();
    const prompt = f.client.prompt.bind(f.client);
    f.client.prompt = async (id, input) => {
      await prompt(id, input);
      throw Error("native failed after input");
    };
    await f.session.execute(host("failed-host", "hold"));
    f.native.history.push(hidden("host-notice", "user-1"));
    f.client.finishPending();
    expect(await f.completed()).toMatchObject([{ outcome: { status: "failed" } }]);
    f.readHistory.mockClear();
    announce(f.client);
    text(f.client, "real-drain");
    persist(f.native, "real-drain");
    end(f.client);
    const completed = await f.completed(2);
    noNativeRef(completed.slice(1));
    expect(completed[1]).toMatchObject({ outcome: { status: "succeeded" } });
    expect(f.readHistory).not.toHaveBeenCalled();
  });

  it.each(["old-timestamp", "cron", "mid-run-notice", "adjacent-inputs", "incomplete-history"])(
    "does not infer live identity, grouping or outcome from %s",
    async (kind) => {
      const f = await setup();
      f.native.history.push(
        hidden("input", undefined, kind === "cron" ? { startsNewUserRequest: true } : {}),
      );
      if (kind === "old-timestamp") required(f.native.history[0]).timestamp = Date.now() - 10;
      if (kind === "mid-run-notice")
        f.native.history.push({
          type: "reasoning",
          id: "thinking",
          parentId: "input",
          content: [{ type: "output_text", text: "working" }],
        });
      if (kind === "mid-run-notice" || kind === "adjacent-inputs")
        f.native.history.push(hidden("notice", f.native.history.at(-1)?.id));
      announce(f.client);
      text(f.client, "done");
      end(f.client);
      const completed = await f.completed();
      expect(completed).toMatchObject([{ outcome: { status: "succeeded" } }]);
      noNativeRef(completed);
      expect(f.readHistory).not.toHaveBeenCalled();
    },
  );

  it("keeps read-only history's native input boundaries even when live grouping differs", async () => {
    const f = await setup();
    f.native.history.push(hidden("one"), hidden("two", "one"));
    announce(f.client);
    text(f.client, "done");
    end(f.client);
    noNativeRef(await f.completed());
    const history = snapshotFromHistory(
      await f.native.readHistory(),
      nativeSessionRefSchema.parse({
        harnessId: "codebuddy",
        nativeSessionId: "native-session",
        formatVersion: 1,
      }),
      process.cwd(),
    );
    expect(
      history.turns.map((t) => ({ key: t.nativeTurnRef.nativeTurnKey, input: t.input })),
    ).toEqual([
      { key: "one", input: [{ type: "text", text: "one" }] },
      { key: "two", input: [{ type: "text", text: "two" }] },
    ]);
    expect(f.ids()).toHaveLength(1);
  });

  it("accepts an end whose request ID changed after the announcement", async () => {
    const f = await setup();
    announce(f.client, "before-admission");
    text(f.client, "cron", "after-admission");
    end(f.client, "after-admission");
    const completed = await f.completed();
    noNativeRef(completed);
    expect(completed).toMatchObject([{ outcome: { status: "succeeded" } }]);
  });

  it("rejects Host starts during a drain and accepts the next after session_end", async () => {
    const f = await setup();
    announce(f.client);
    expect(await f.session.execute(host("blocked"))).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    end(f.client);
    await f.completed();
    expect(await f.session.execute(host("next"))).toMatchObject({ ok: true });
    await f.completed(2);
  });

  it("cancels a round before output, without merging its successor or assigning history identities", async () => {
    const f = await setup();
    announce(f.client);
    f.native.history.push(hidden("first"));
    await tick();
    const id = required(f.ids()[0]);
    const cancel = vi.spyOn(f.client, "cancel");
    await f.session.execute({ type: "turn.cancel", turnId: id });
    await f.session.execute({ type: "turn.cancel", turnId: id });
    expect(cancel).toHaveBeenCalledTimes(1);
    end(f.client);
    expect(await f.completed()).toMatchObject([{ outcome: { status: "cancelled" } }]);
    const replacement = required(f.native.clients[1]);
    f.readHistory.mockClear();
    announce(replacement);
    await expect(
      f.client.context.handlers.question({
        sessionId: "native-session",
        toolCallId: "stale",
        schema: { questions: [{ question: "Choose?", options: [{ label: "Alpha" }] }] },
      }),
    ).resolves.toEqual({ outcome: "cancelled" });
    f.client.context.handlers.fault(Error("stale fault"));
    expect(f.events().filter((e) => e.type === "session.faulted")).toEqual([]);
    persist(f.native, "second");
    text(replacement, "second");
    end(replacement);
    const completed = await f.completed(2);
    noNativeRef(completed);
    expect(completed.map((e) => e.outcome.status)).toEqual(["cancelled", "succeeded"]);
    expect(f.readHistory).not.toHaveBeenCalled();
    expect(await f.session.execute(host("after-cancel"))).toMatchObject({ ok: true });
    await f.completed(3);
  });

  it("keeps replacement-client rounds separate while cancellation recovery is pending", async () => {
    let inject = false;
    const f = await setup((native) => ({
      clientFactory: (options) => {
        const client = native.clientFactory(options),
          open = client.open.bind(client);
        client.open = async (...args) => {
          const result = await open(...args);
          if (inject) {
            inject = false;
            for (const key of ["one", "two", "three"]) {
              announce(client);
              text(client, key);
              persist(native, key);
              end(client);
            }
          }
          return result;
        };
        return client;
      },
    }));
    announce(f.client);
    persist(f.native, "cancelled");
    await tick();
    await f.session.execute({ type: "turn.cancel", turnId: required(f.ids()[0]) });
    inject = true;
    end(f.client);
    const completed = await f.completed(4);
    noNativeRef(completed);
    expect(completed.map((e) => e.outcome.status)).toEqual([
      "cancelled",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(f.ids().map(f.texts)).toEqual([[], ["one"], ["two"], ["three"]]);
    announce(f.client);
    text(f.client, "stale");
    end(f.client);
    await tick();
    expect(f.ids()).toHaveLength(4);
  });

  it.each(
    ["approval", "question", "question-rpc"].flatMap((kind) =>
      ["after-cancel", "before-delivery"].map((timing) => ({ kind, timing })),
    ),
  )("$timing: cancels $kind without reopening UI", async ({ kind, timing }) => {
    const f = await setup();
    announce(f.client);
    persist(f.native, "cancelled");
    await tick();
    const turnId = required(f.ids()[0]);
    const request = () => {
      const questions = [{ question: "Choose?", options: [{ label: "Alpha" }] }];
      if (kind === "question-rpc")
        return f.client.context.handlers.question({
          sessionId: "native-session",
          toolCallId: "late-question",
          schema: { questions },
        });
      return f.client.context.handlers
        .permission({
          sessionId: "native-session",
          toolCall: {
            toolCallId: "late-call",
            rawInput: kind === "question" ? { questions } : { file_path: "late.txt" },
            _meta: { "codebuddy.ai/toolName": kind === "question" ? "AskUserQuestion" : "Write" },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        })
        .then((answer) => answer.outcome);
    };
    let response: unknown;
    const ask = () =>
      request().then((value) => {
        response = value;
      });
    const answer = timing === "before-delivery" ? ask() : undefined;
    await f.session.execute({ type: "turn.cancel", turnId });
    const late = timing === "after-cancel" ? ask() : answer;
    await tick();
    const interactions = f.outputs.filter((o) => o.kind === "interaction").length;
    const returnedBeforeEnd = response;
    end(f.client);
    await late;
    expect(await f.completed()).toMatchObject([{ outcome: { status: "cancelled" } }]);
    expect(interactions).toBe(0);
    expect(returnedBeforeEnd).toEqual({ outcome: "cancelled" });
  });

  it("publishes 1023 buffered empty intervals without losing terminals", async () => {
    let gate!: ReturnType<typeof gateHistory>;
    const f = await setup((n) => {
      gate = gateHistory(n, 2);
      return { readHistory: gate.readHistory };
    });
    await f.session.execute(host("host", "hold"));
    f.client.finishPending();
    await gate.entered;
    for (let i = 0; i < 1023; i++) {
      announce(f.client, `empty-${i}`);
      end(f.client, `empty-${i}`);
    }
    gate.release();
    await f.completed(1024);
    expect(f.events().filter((e) => e.type === "session.faulted")).toEqual([]);
  });

  it("closes a pending approval and settles once when the Session closes", async () => {
    const f = await setup();
    announce(f.client);
    text(f.client, "partial");
    const answer = f.client.context.handlers.permission({
      sessionId: "native-session",
      toolCall: {
        toolCallId: "write",
        rawInput: { file_path: "probe.txt" },
        _meta: { "codebuddy.ai/toolName": "Write" },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    await vi.waitFor(() => expect(f.outputs.some((o) => o.kind === "interaction")).toBe(true));
    await f.session.close();
    await answer;
    await f.closed;
    expect(await f.completed()).toMatchObject([{ outcome: { status: "cancelled" } }]);
    expect(f.events().filter((e) => e.type === "item.completed")).toHaveLength(1);
  });

  it("releases an interaction waiting for an unpublished drain when the Session closes", async () => {
    const f = await setup();
    await f.session.execute(host("host", "hold"));
    announce(f.client);
    const answer = f.client.context.handlers.question({
      sessionId: "native-session",
      toolCallId: "ask",
      schema: { questions: [{ question: "Choose?", options: [{ label: "Alpha" }] }] },
    });
    await f.session.close();
    await expect(answer).resolves.toEqual({ outcome: "cancelled" });
    expect(f.ids()).toEqual([]);
  });

  it("ignores an unannounced session_end", async () => {
    const f = await setup();
    end(f.client);
    await tick();
    expect(f.events().filter((e) => e.type.startsWith("turn."))).toEqual([]);
    expect(f.readHistory).not.toHaveBeenCalled();
  });
});

describe("aggregate autonomous buffering", () => {
  function buffer(turns: CodeBuddyAutonomousTurns, id: string, payload: string) {
    const round = turns.announce(id);
    const frame = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: payload },
      _meta: { "codebuddy.ai/requestId": id },
    };
    round.frames.push(frame);
    turns.end(id);
  }
  it("bounds all pending rounds together", () => {
    const turns = new CodeBuddyAutonomousTurns(),
      payload = "x".repeat(3 * 1024 * 1024);
    expect(() => {
      buffer(turns, "one", payload);
      buffer(turns, "two", payload);
    }).toThrow(/buffer bound/u);
  });
  it("counts UTF-8 bytes instead of JavaScript characters", () => {
    const turns = new CodeBuddyAutonomousTurns();
    expect(() => buffer(turns, "one", "汉".repeat(1_500_000))).toThrow(/buffer bound/u);
  });
  it("also bounds empty rounds", () => {
    const turns = new CodeBuddyAutonomousTurns();
    expect(() => {
      for (let i = 0; i < 2049; i++) {
        turns.announce(`${i}`);
        turns.end(`${i}`);
      }
    }).toThrow(/buffer bound/u);
  });
  it("releases drained frames and finished rounds", () => {
    const turns = new CodeBuddyAutonomousTurns();
    buffer(turns, "one", "x".repeat(3 * 1024 * 1024));
    const round = required(turns.next());
    round.frames.drain();
    turns.finish(round);
    expect(() => buffer(turns, "two", "x".repeat(3 * 1024 * 1024))).not.toThrow();
    turns.close();
    expect(() => buffer(turns, "three", "x".repeat(3 * 1024 * 1024))).not.toThrow();
  });
});
