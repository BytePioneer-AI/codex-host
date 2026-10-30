import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { CodeBuddyClient, CodeBuddyClientFactory } from "../src/acp-client.js";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { pendingNativeHistoryRewind } from "../src/history.js";
import { configOptions } from "./fixtures.js";

const adapters: CodeBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});
const ref = nativeSessionRefSchema.parse({
  harnessId: "codebuddy",
  nativeSessionId: "derived",
  formatVersion: 1,
  locator: {
    codebuddyDerived: 1,
    configuration: { model: "other", mode: "plan", thinking: "high" },
  },
});
const lines = (rows: Record<string, unknown>[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n");
const message = (id: string, role: string, parentId?: string) => ({
  type: "message",
  id,
  role,
  parentId,
  content: id,
  status: "completed",
});
const turn = (input: string) => ({
  type: "turn.start" as const,
  turnId: hostTurnIdSchema.parse(input),
  input: [{ type: "text" as const, text: input }],
});

/** Model the native bug: a new process ignores rewind notices when choosing its cursor. */
function setup(
  point: string | null = "kept-result",
  configureClient: (client: CodeBuddyClient, index: number) => void = () => {},
) {
  const history: Record<string, unknown>[] = [
    message("kept-user", "user"),
    message("kept-answer", "assistant", "kept-user"),
    {
      type: "function_call",
      id: "kept-tool",
      parentId: "kept-answer",
      callId: "call",
      name: "Bash",
      arguments: '{"command":"pwd"}',
    },
    {
      type: "function_call_result",
      id: "kept-result",
      parentId: "kept-tool",
      callId: "call",
      status: "completed",
      output: "workspace",
    },
    message("discarded-user", "user", "kept-result"),
    message("discarded-answer", "assistant", "discarded-user"),
    {
      ...message("fork-command", "user", "discarded-answer"),
      content: "<command-name>/fork</command-name>",
      providerData: { skipRun: true },
    },
    { type: "resend-fork-notice", id: "rewind", parentId: point ?? undefined },
  ];
  const clients: ReturnType<typeof createClient>[] = [];
  let clientCount = 0;
  function createClient({ handlers }: Parameters<CodeBuddyClientFactory>[0]) {
    let head: string | undefined;
    let options = configOptions();
    let pending: ((result: Record<string, unknown>) => void) | undefined;
    let pendingId: string | undefined;
    const client = {
      initialize: vi.fn(async () => ({ protocolVersion: 1 })),
      open: vi.fn(async () => {
        head = history.findLast((row) =>
          ["message", "reasoning", "function_call", "function_call_result"].includes(
            String(row.type),
          ),
        )?.id as string | undefined;
        return { configOptions: options };
      }),
      rollback: vi.fn(async (_sessionId: string, forkPointId: string | null) => {
        head = forkPointId ?? undefined;
        history.push({
          type: "resend-fork-notice",
          id: `rewind-${history.length}`,
          parentId: head,
        });
        return { applied: true, actualForkPointId: forkPointId };
      }),
      configure: vi.fn(async (_sessionId: string, id: string, value: string) => {
        options = options.map((option) => ({
          ...option,
          currentValue: option.id === id ? value : option.currentValue,
        }));
        return { configOptions: options };
      }),
      prompt: vi.fn(async (_sessionId: string, input: string): Promise<Record<string, unknown>> => {
        if (input !== "hold-before-write") {
          pendingId = `user-${history.length}`;
          history.push({ ...message(pendingId, "user", head), content: input });
          head = pendingId;
        }
        if (input.startsWith("hold"))
          return new Promise((resolve) => {
            pending = resolve;
          });
        const userMessageId = head;
        const answerId = `answer-${history.length}`;
        history.push(message(answerId, "assistant", head));
        head = answerId;
        handlers.update({
          sessionId: ref.nativeSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: answerId },
          },
        });
        return { stopReason: "end_turn", userMessageId };
      }),
      cancel: vi.fn(async () => {
        pending?.({ stopReason: "cancelled", userMessageId: pendingId });
      }),
      answer: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    configureClient(client, clientCount++);
    return client;
  }
  const adapter = new CodeBuddyAdapter({
    environment: {},
    clientFactory: (options) => {
      const client = createClient(options);
      clients.push(client);
      return client;
    },
    readHistory: async () => lines(history),
  });
  adapters.push(adapter);
  const open = () => adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref });
  const resume = async () => {
    const result = await open();
    if (!result.ok) throw Error(result.error.message);
    return result.value;
  };
  return { history, clients, open, resume };
}

function collect(session: HarnessSession) {
  const events: HarnessOutput[] = [];
  const closed = (async () => {
    for await (const output of session.outputs) events.push(output);
  })();
  const completed = () =>
    events.filter((o) => o.kind === "event" && o.event.type === "turn.completed");
  return {
    events,
    closed,
    completed: async (count = 1) => {
      await vi.waitFor(() => expect(completed()).toHaveLength(count));
      return completed();
    },
  };
}
async function inputs(session: HarnessSession) {
  const snapshot = await session.readSnapshot();
  if (!snapshot.ok) throw Error(snapshot.error.message);
  return snapshot.value.turns.map((t) => t.input.map((i) => i.text).join(""));
}

describe("pending native rewind", () => {
  it("uses the latest notice even when titles or file snapshots follow it", () => {
    expect(
      pendingNativeHistoryRewind(
        lines([
          message("last", "assistant"),
          { type: "resend-fork-notice", parentId: "last" },
          { type: "resend-fork-notice" },
          { type: "custom-title" },
          { type: "summary" },
          { type: "file-history-snapshot" },
        ]),
      ),
    ).toEqual({ forkPointId: null });
  });
  it.each(["message", "reasoning", "function_call", "function_call_result"])(
    "does not rewind again after a new %s anchors the branch",
    (type) =>
      expect(
        pendingNativeHistoryRewind(
          lines([
            { type: "resend-fork-notice", parentId: "old" },
            { type, id: "new" },
          ]),
        ),
      ).toBeUndefined(),
  );
  it("does not invent a rewind for ordinary or empty history", () => {
    expect(pendingNativeHistoryRewind("")).toBeUndefined();
    expect(pendingNativeHistoryRewind(lines([message("user", "user")]))).toBeUndefined();
  });
});

describe("native Session branch restoration", () => {
  it.each(["kept-result", null])(
    "restores %j in the writable process before its first prompt",
    async (point) => {
      const native = setup(point);
      native.history.push({ type: "summary", id: "metadata-after-rewind" });
      const session = await native.resume();
      const events = collect(session);
      const client = native.clients[0];
      if (!client) throw Error("No native client");
      expect(client.rollback).toHaveBeenCalledExactlyOnceWith("derived", point);
      expect(client.open.mock.invocationCallOrder[0]).toBeLessThan(
        Number(client.rollback.mock.invocationCallOrder[0]),
      );
      expect(client.rollback.mock.invocationCallOrder[0]).toBeLessThan(
        Number(client.configure.mock.invocationCallOrder[0]),
      );
      expect(session.initialState).toMatchObject({
        effectivePermissionModeId: "plan",
        effectiveThinkingOptionId: "high",
      });
      expect(await inputs(session)).toEqual(point ? ["kept-user"] : []);
      expect(await session.execute(turn("next"))).toMatchObject({ ok: true });
      expect(await events.completed()).toMatchObject([
        { event: { outcome: { status: "succeeded" } } },
      ]);
      expect(native.history.find((row) => row.content === "next")?.parentId).toBe(
        point ?? undefined,
      );
      expect(await inputs(session)).toEqual(point ? ["kept-user", "next"] : ["next"]);
    },
  );

  it("restores again if closed before a Turn, but never discards later valid Turns on resume", async () => {
    const native = setup();
    const first = await native.resume();
    await first.close();
    const second = await native.resume();
    expect(native.clients[1]?.rollback).toHaveBeenCalledOnce();
    const secondEvents = collect(second);
    await second.execute(turn("continued"));
    await secondEvents.completed();
    await second.close();
    const third = await native.resume();
    expect(native.clients[2]?.rollback).not.toHaveBeenCalled();
    expect(await inputs(third)).toEqual(["kept-user", "continued"]);
    const thirdEvents = collect(third);
    await third.execute(turn("resumed"));
    expect(await thirdEvents.completed()).toMatchObject([
      { event: { outcome: { status: "succeeded" } } },
    ]);
    expect(await inputs(third)).toEqual(["kept-user", "continued", "resumed"]);
  });

  it.each(["hold-before-write", "hold-after-write"])(
    "restores the current branch after cancelling %s",
    async (input) => {
      const native = setup();
      const session = await native.resume();
      const events = collect(session);
      await session.execute(turn(input));
      await vi.waitFor(() => expect(native.clients[0]?.prompt).toHaveBeenCalledOnce());
      await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse(input) });
      expect(await events.completed()).toMatchObject([
        { event: { outcome: { status: "cancelled" } } },
      ]);
      expect(native.clients[1]?.rollback).toHaveBeenCalledTimes(
        input === "hold-before-write" ? 1 : 0,
      );
      await session.execute(turn("after-cancel"));
      expect((await events.completed(2))[1]).toMatchObject({
        event: { outcome: { status: "succeeded" } },
      });
      expect(await inputs(session)).toEqual([
        "kept-user",
        ...(input === "hold-after-write" ? [input] : []),
        "after-cancel",
      ]);
    },
  );

  it.each(["missing", "refused", "wrong-point", "throws"])(
    "fails closed when cursor restoration is %s",
    async (failure) => {
      const native = setup("kept-result", (client) => {
        if (failure === "missing") delete client.rollback;
        else
          client.rollback = async () => {
            if (failure === "throws") throw Error("rewind failed");
            return { applied: failure !== "refused", actualForkPointId: "wrong" };
          };
      });
      expect(await native.open()).toMatchObject({ ok: false });
      expect(native.clients[0]?.close).toHaveBeenCalled();
      expect(native.clients[0]?.prompt).not.toHaveBeenCalled();
      expect(native.clients[0]?.configure).not.toHaveBeenCalled();
    },
  );

  it("rejects a mismatched rewind acknowledgement for the empty prefix", async () => {
    const native = setup(null, (client) => {
      client.rollback = async () => ({ applied: true, actualForkPointId: "discarded-answer" });
    });
    expect(await native.open()).toMatchObject({ error: { code: "nativeFailure" } });
    expect(native.clients[0]?.close).toHaveBeenCalled();
  });

  it("validates the history and returned Session identity before rewinding", async () => {
    const invalidHistory = setup("missing-parent");
    expect(await invalidHistory.open()).toMatchObject({ error: { code: "protocolError" } });
    expect(invalidHistory.clients[0]?.open).not.toHaveBeenCalled();
    const wrongIdentity = setup("kept-result", (client) => {
      client.open = async () => ({ sessionId: "another-session", configOptions: configOptions() });
    });
    expect(await wrongIdentity.open()).toMatchObject({ error: { code: "protocolError" } });
    expect(wrongIdentity.clients[0]?.rollback).not.toHaveBeenCalled();
  });

  it("faults cancellation recovery rather than accepting prompts on an unconfirmed branch", async () => {
    const native = setup("kept-result", (client, index) => {
      if (index === 1) client.rollback = async () => ({ applied: false });
    });
    const session = await native.resume();
    const events = collect(session);
    await session.execute(turn("hold-before-write"));
    await vi.waitFor(() => expect(native.clients[0]?.prompt).toHaveBeenCalledOnce());
    await session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("hold-before-write"),
    });
    await events.closed;
    expect(await events.completed()).toMatchObject([{ event: { outcome: { status: "failed" } } }]);
    expect(await session.execute(turn("late"))).toMatchObject({ error: { code: "invalidState" } });
    expect(native.clients[1]?.prompt).not.toHaveBeenCalled();
  });
});
