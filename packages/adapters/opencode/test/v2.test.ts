import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OpenCodeClient,
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  PermissionRequest,
} from "@opencode/client";
import {
  HarnessOutputChannel,
  type HarnessOutput,
  type HostEvent,
} from "@codexhost/harness-adapter";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { harnessModelCatalogSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { openCodeMajor } from "../src/version.js";
import { assistantItems, projectHistory, readMessages } from "../src/v2/history.js";
import { v2Locator, v2Permissions, v2Ref } from "../src/v2/state.js";
import { V2Session } from "../src/v2/session.js";
import { formInteraction, replyInteraction } from "../src/v2/interactions.js";
import { readCatalog } from "../src/v2/catalog.js";

const info: SessionInfo = {
  id: "session",
  projectID: "project",
  location: { directory: "/workspace" },
  time: { created: 1, updated: 1 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const user = (id = "user"): SessionMessageInfo => ({
  id,
  type: "user",
  text: id,
  metadata: { "codexhost.turnId": "host-turn" },
  time: { created: 1 },
});
const assistant = (text: string): SessionMessageAssistant => ({
  id: "assistant",
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "model" },
  time: { created: 2 },
  content: [{ type: "text", text }],
});
const idle = (
  outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
): SessionMessageInfo => ({ id: "idle", type: "idle", time: { created: 3 }, outcome });
const catalog = harnessModelCatalogSchema.parse({ models: [], thinkingOptions: [] });
const sessions: V2Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

function fixture() {
  const native = new HarnessOutputChannel<OpenCodeEvent>();
  const messages: SessionMessageInfo[] = [];
  const events: HarnessOutput[] = [];
  /** Host usage metering events, kept apart from the lifecycle the other tests assert. */
  const usage: HostEvent[] = [];
  const prompt = vi.fn(async () => {
    messages.push(user());
    return { id: "inbox" };
  });
  const interrupt = vi.fn(async () => ({ interrupted: true }));
  const client = {
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        signal.addEventListener("abort", () => native.end(), { once: true });
        return native.outputs;
      },
    },
    message: { list: vi.fn(async () => ({ data: structuredClone(messages), cursor: {} })) },
    session: {
      get: vi.fn(async () => structuredClone(info)),
      active: vi.fn(async () => ({})),
      prompt,
      interrupt,
      form: { list: vi.fn(async () => []) },
      diff: vi.fn(async () => []),
    },
    permission: { list: vi.fn(async (): Promise<PermissionRequest[]> => []), reply: vi.fn() },
  };
  const connection = { options: { closeTimeoutMs: 20 }, close: vi.fn(async () => undefined) };
  const session = new V2Session(
    client as unknown as OpenCodeClient,
    connection,
    info,
    catalog,
    "default",
    64_000,
    () => {},
  );
  sessions.push(session);
  void (async () => {
    for await (const event of session.outputs) {
      if (
        event.kind === "event" &&
        (event.event.type === "usage.request" || event.event.type === "usage.history")
      )
        usage.push(event.event);
      else events.push(event);
    }
  })();
  const emit = (type: string, data: object = {}) =>
    native.emit({ type, data: { sessionID: info.id, ...data } } as OpenCodeEvent);
  const start = async () => {
    const started = session.start();
    emit("server.connected");
    await started;
  };
  const turn = () =>
    session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("host-turn"),
      input: [{ type: "text", text: "Hello" }],
    });
  const completed = () =>
    events.filter((e) => e.kind === "event" && e.event.type === "turn.completed");
  return {
    session,
    connection,
    client,
    native,
    messages,
    events,
    usage,
    prompt,
    interrupt,
    emit,
    start,
    turn,
    completed,
  };
}

describe("OpenCode protocol versions", () => {
  it.each([
    ["1.18.25\n", 1],
    ["opencode v2.0.16\n", 2],
    ["2.0.0-beta.1", 2],
  ])("identifies %s", (text, major) => {
    expect(openCodeMajor(String(text))).toBe(major);
  });
  it.each(["3.0.0", "0.9.0", "opencode v2", "warning\n2.0.16"])(
    "rejects unknown version %s",
    (text) => {
      expect(() => openCodeMajor(text)).toThrow("Unsupported");
    },
  );
  it("keeps native protocol separate from the public Ref format", () => {
    const ref = v2Ref(info, "default");
    expect(ref.formatVersion).toBe(1);
    expect(v2Locator(ref)).toEqual({ directory: "/workspace", executionPolicy: "default" });
    expect(() => v2Locator({ ...ref, locator: { directory: "/workspace" } })).toThrow(
      "v2 Native Ref",
    );
  });
});

describe("OpenCode v2 native history", () => {
  it("groups steered prompts by durable idle and never guesses a terminal", () => {
    const snapshot = projectHistory(
      info,
      [user(), user("steered"), assistant("done"), idle("interrupted"), user("next")],
      100,
    );
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      input: [{ text: "user" }, { text: "steered" }],
      outcome: { status: "cancelled" },
      checkpoint: { checkpointId: "idle" },
    });
    expect(snapshot.turns[1]).toMatchObject({ outcome: { status: "unknown" } });
    expect(
      projectHistory(info, [user(), assistant("stop is not idle")], 100).turns[0]?.outcome.status,
    ).toBe("unknown");
  });
  it("preserves a failed tool even when the execution succeeds and bounds its output", () => {
    const message = assistant("done");
    message.content.push({
      type: "tool",
      id: "call",
      name: "shell",
      time: { created: 1 },
      state: {
        status: "error",
        input: { command: "false" },
        error: { type: "tool", message: "exit 1" },
        content: [{ type: "text", text: "123456" }],
      },
    });
    const items = assistantItems(message, 3);
    expect(items[1]).toMatchObject({
      outcome: { status: "failed" },
      item: { output: { truncated: true, content: [{ text: "123" }] } },
    });
    expect(projectHistory(info, [user(), message, idle()], 3).turns[0]?.outcome.status).toBe(
      "succeeded",
    );
  });
  it("keeps type-local text ordinals independent of interleaved tools and other content", () => {
    const message = assistant("first");
    message.content = [
      { type: "reasoning", text: "plan" },
      { type: "text", text: "first" },
      {
        type: "tool",
        id: "call",
        name: "shell",
        time: { created: 1 },
        state: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] },
      },
      { type: "text", text: "second" },
      { type: "reasoning", text: "check" },
    ];
    expect(assistantItems(message, 100).map(({ item }) => item.itemId)).toEqual([
      "assistant:reasoning:0",
      "assistant:text:0",
      "assistant:tool:call",
      "assistant:text:1",
      "assistant:reasoning:1",
    ]);
  });
  it("uses only the cursor for subsequent pages and rejects repeated cursors", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [user()], cursor: { next: "page" } })
      .mockResolvedValueOnce({ data: [idle()], cursor: {} });
    const client = { message: { list } } as unknown as OpenCodeClient;
    expect(await readMessages(client, "session")).toHaveLength(2);
    expect(list.mock.calls[1]?.[0]).toEqual({ sessionID: "session", cursor: "page" });
    list.mockResolvedValue({ data: [], cursor: { next: "page" } });
    await expect(readMessages(client, "session")).rejects.toThrow("did not advance");
  });
});

describe("OpenCode v2 Session lifecycle", () => {
  it.each([false, true])(
    "completes reasoning and text with independent ordinals (before admission: %s)",
    async (beforeAdmission) => {
      const f = fixture();
      await f.start();
      const stream = () => {
        f.emit("session.step.started", { assistantMessageID: "assistant" });
        for (const [type, delta] of [
          ["reasoning", "Thinking."],
          ["text", "Done."],
        ]) {
          f.emit(`session.${type}.delta`, {
            assistantMessageID: "assistant",
            ordinal: 0,
            delta,
          });
        }
      };
      if (beforeAdmission) {
        f.prompt.mockImplementationOnce(async () => {
          f.messages.push(user());
          stream();
          // Let the event pump consume the deltas before admitting the Host Turn.
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { id: "inbox" };
        });
      }
      expect((await f.turn()).ok).toBe(true);
      if (!beforeAdmission) stream();
      await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain("Done."));
      const message = assistant("Done.");
      message.content.unshift({ type: "reasoning", text: "Thinking." });
      f.messages.push(message, idle());
      f.emit("session.execution.succeeded");
      await vi.waitFor(() => expect(f.completed()).toHaveLength(1));

      const ui = new CodexTurnProjector({
        threadId: "thread",
        turnId: hostTurnIdSchema.parse("host-turn"),
        cwd: "/workspace",
        startedAtMs: 1,
      });
      for (const output of f.events) {
        if (output.kind !== "event") continue;
        const event = output.event;
        if (
          event.type === "turn.started" ||
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed" ||
          event.type === "turn.completed"
        )
          ui.project(event);
      }
      expect(ui.completed).toBe(true);
      expect(f.completed()[0]).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      const started = f.events.flatMap((output) =>
        output.kind === "event" && output.event.type === "item.started" ? [output.event.item] : [],
      );
      expect(started).toEqual([
        { type: "reasoning", itemId: "assistant:reasoning:0", text: "Thinking." },
        { type: "agentMessage", itemId: "assistant:text:0", text: "Done." },
      ]);
      const snapshot = await f.session.readSnapshot();
      expect(snapshot.ok && snapshot.value.turns[0]?.items.map(({ item }) => item)).toEqual(
        started,
      );
      expect(
        f.events.some(
          (output) => output.kind === "event" && output.event.type === "session.faulted",
        ),
      ).toBe(false);
    },
  );

  it("keeps native cancellation when transient text was not committed", async () => {
    const f = fixture();
    await f.start();
    await f.turn();
    f.emit("session.step.started", { assistantMessageID: "assistant" });
    f.emit("session.text.delta", { assistantMessageID: "assistant", ordinal: 0, delta: "partial" });
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain("partial"));
    f.messages.push(assistant(""), idle("interrupted"));
    f.emit("session.execution.interrupted");
    await vi.waitFor(() => expect(f.completed()).toHaveLength(1));
    expect(f.completed()[0]).toMatchObject({ event: { outcome: { status: "cancelled" } } });
    expect(f.events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({ item: expect.objectContaining({ text: "" }) }),
        }),
      }),
    );
    expect(f.events.some((e) => e.kind === "event" && e.event.type === "session.faulted")).toBe(
      false,
    );
  });

  it("does not interrupt work owned by another native client when rejecting a start", async () => {
    const f = fixture();
    await f.start();
    f.client.session.active.mockResolvedValue({ session: { type: "running" } });
    expect((await f.turn()).ok).toBe(false);
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("buffers pre-admission deltas and reconciles durable text without duplication", async () => {
    const f = fixture();
    await f.start();
    let accept!: () => void;
    f.prompt.mockImplementationOnce(async () => {
      f.messages.push(user());
      f.emit("session.step.started", { assistantMessageID: "assistant" });
      f.emit("session.text.delta", { assistantMessageID: "assistant", ordinal: 0, delta: "Hello" });
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
      return { id: "inbox" };
    });
    const starting = f.turn();
    await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
    expect(f.events).toEqual([]);
    accept();
    expect((await starting).ok).toBe(true);
    f.messages.push(assistant("Hello world"));
    f.emit("session.text.ended", {
      assistantMessageID: "assistant",
      ordinal: 0,
      text: "Hello world",
    });
    await vi.waitFor(() => expect(JSON.stringify(f.events)).toContain(" world"));
    // A delayed transient delta must not be appended to an already newer durable value.
    f.emit("session.text.delta", { assistantMessageID: "assistant", ordinal: 0, delta: " world" });
    f.messages.push(idle());
    f.emit("session.execution.succeeded");
    await vi.waitFor(() => expect(f.completed()).toHaveLength(1));
    expect(f.completed()[0]).toMatchObject({ event: { outcome: { status: "succeeded" } } });
    const starts = f.events.filter((e) => e.kind === "event" && e.event.type === "item.started");
    expect(starts).toHaveLength(1);
    expect(
      f.events.filter((e) => e.kind === "event" && e.event.type === "item.updated"),
    ).toHaveLength(1);
  });
  it("does not finish on interrupt acknowledgement and ignores late old-turn deltas", async () => {
    const f = fixture();
    await f.start();
    await f.turn();
    expect(
      await f.session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("host-turn") }),
    ).toMatchObject({ ok: true });
    expect(f.completed()).toHaveLength(0);
    f.messages.push(idle("interrupted"));
    f.emit("session.execution.interrupted");
    await vi.waitFor(() => expect(f.completed()).toHaveLength(1));
    expect(f.completed()[0]).toMatchObject({ event: { outcome: { status: "cancelled" } } });
    const length = f.events.length;
    f.emit("session.text.delta", { assistantMessageID: "old", ordinal: 0, delta: "late" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.events).toHaveLength(length);
  });
  it("replays metered history on open and meters each finished step once", async () => {
    const f = fixture();
    f.messages.push(user("earlier"), {
      ...assistant("earlier answer"),
      id: "assistant-earlier",
      time: { created: 2, streamed: 3, completed: 9 },
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 30, write: 5 } },
    });
    // An unfinished step has no Tokens and no usage.
    f.messages.push({ ...assistant("cut off"), id: "assistant-unfinished" });
    f.messages.push({ ...idle(), id: "idle-earlier" });
    await f.start();
    expect(f.usage).toEqual([
      {
        type: "usage.request",
        request: {
          requestId: "assistant-earlier",
          historical: true,
          model: "model",
          provider: "test",
          inputTokens: 45,
          cachedInputTokens: 30,
          cacheWriteInputTokens: 5,
          outputTokens: 6,
          reasoningOutputTokens: 2,
        },
      },
      { type: "usage.history", complete: true },
    ]);

    await f.turn();
    const beforeOutput = Date.now();
    f.emit("session.step.started", { assistantMessageID: "assistant-live" });
    f.emit("session.reasoning.delta", {
      assistantMessageID: "assistant-live",
      ordinal: 0,
      delta: "thinking",
    });
    const afterOutput = Date.now();
    const completed = afterOutput + 2_000;
    f.messages.push({
      ...assistant("live answer"),
      id: "assistant-live",
      // OpenCode's `streamed` marks the end of streaming, just before completion.
      time: { created: beforeOutput - 5_000, streamed: completed - 40, completed },
      tokens: { input: 1, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    f.emit("session.step.ended", { assistantMessageID: "assistant-live" });
    f.messages.push(idle());
    f.emit("session.execution.succeeded");
    await vi.waitFor(() => expect(f.completed()).toHaveLength(1));
    const live = f.usage.filter(
      (event) => event.type === "usage.request" && event.request.requestId === "assistant-live",
    );
    expect(live).toEqual([
      {
        type: "usage.request",
        request: expect.objectContaining({ outputTokens: 8, completedAtMs: completed }),
      },
    ]);
    expect(live[0]).not.toHaveProperty("request.historical");
    const started = live[0]?.type === "usage.request" ? live[0].request.startedAtMs : undefined;
    // Timed from the observed first output, not from creation or OpenCode's `streamed`.
    expect(started).toBeGreaterThanOrEqual(beforeOutput);
    expect(started).toBeLessThanOrEqual(afterOutput);
  });
  it("rejects concurrent starts and emits no lifecycle for rejected admission", async () => {
    const f = fixture();
    await f.start();
    f.prompt.mockRejectedValueOnce(new Error("rejected"));
    expect((await f.turn()).ok).toBe(false);
    expect(f.events).toEqual([]);
    await f.turn();
    expect((await f.turn()).ok).toBe(false);
    expect(
      f.events.filter((e) => e.kind === "event" && e.event.type === "turn.started"),
    ).toHaveLength(1);
  });
  it("closes the owned connection if rejected admission cannot be interrupted", async () => {
    const f = fixture();
    await f.start();
    f.prompt.mockRejectedValueOnce(new Error("lost admission response"));
    f.interrupt.mockRejectedValue(new Error("unavailable"));
    expect((await f.turn()).ok).toBe(false);
    expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({ type: "session.faulted" }),
      }),
    );
    expect((await f.turn()).ok).toBe(false);
  });
  it("does not reopen a settled approval from a stale native list", async () => {
    const f = fixture();
    await f.start();
    f.client.permission.list.mockResolvedValue([
      { id: "permission", sessionID: info.id, action: "edit", resources: ["file"] },
    ]);
    await f.turn();
    await vi.waitFor(() => expect(f.events.some((e) => e.kind === "interaction")).toBe(true));
    const pending = f.events.find((e) => e.kind === "interaction");
    if (pending?.kind !== "interaction") throw new Error("Missing approval");
    expect(
      (
        await f.session.execute({
          type: "interaction.respond",
          interactionId: pending.interaction.interactionId,
          response: { type: "approval", actionId: "once" },
        })
      ).ok,
    ).toBe(true);
    f.client.permission.list.mockClear();
    f.emit("session.updated");
    await vi.waitFor(() => expect(f.client.permission.list).toHaveBeenCalled());
    expect(f.events.filter((e) => e.kind === "interaction")).toHaveLength(1);
  });
});

describe("OpenCode v2 catalog readiness", () => {
  it("waits for configuration activation instead of caching an initially empty catalog", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({
        data: ["provider", "agent", "policy"].map((name) => ({
          id: `opencode.config.${name}`,
          state: { status: "active" },
        })),
      });
    const models = vi.fn(async () => ({ data: [] }));
    const client = {
      plugin: { list },
      model: { list: models, default: async () => ({ data: null }) },
    } as unknown as OpenCodeClient;
    const reading = readCatalog(client, "/workspace", 1000);
    expect(models).not.toHaveBeenCalled();
    await expect(reading).resolves.toMatchObject({ models: [] });
    expect(list).toHaveBeenCalledTimes(2);
    expect(models).toHaveBeenCalledTimes(1);
  });
});

describe("OpenCode v2 forms", () => {
  it("maps native choices and converts numeric answers without changing permission scope", async () => {
    const form = {
      id: "form",
      sessionID: "session",
      title: "Configure",
      fields: [{ key: "count", type: "integer" as const, required: true }] as [
        { key: string; type: "integer"; required: boolean },
      ],
    };
    const pending = formInteraction(form, hostTurnIdSchema.parse("turn"));
    const reply = vi.fn();
    await replyInteraction({ session: { form: { reply } } } as unknown as OpenCodeClient, pending, {
      type: "interaction.respond",
      interactionId: pending.interaction.interactionId,
      response: { type: "question", answers: { count: ["2"] } },
    });
    expect(reply).toHaveBeenCalledWith({
      sessionID: "session",
      formID: "form",
      answer: { count: 2 },
    });
    expect(
      v2Permissions([{ action: "shell", resource: "rm *", effect: "deny" }], "allow" as never),
    ).toEqual([
      { action: "shell", resource: "rm *", effect: "deny" },
      { action: "*", resource: "*", effect: "allow" },
    ]);
  });
});
