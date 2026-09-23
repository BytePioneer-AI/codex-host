import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { KimiCodeAdapter } from "../src/adapter.js";
import {
  KimiError,
  HARNESS_ID,
  type KimiTransport,
  type NativeEvent,
  type NativeSnapshot,
  type NativeStatus,
  type NativeTurn,
  type TransportOptions,
} from "../src/protocol.js";
import { catalog, modelRef, projectTurn, readTurns, readActiveTurn } from "../src/projection.js";
import {
  harnessInspectionSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type {
  HarnessOutput,
  HarnessSession,
  HostItem,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";

const cwd = process.cwd();
const nativeHome = cwd;
const ref: NativeSessionRef = {
  harnessId: HARNESS_ID,
  nativeSessionId: "session_test",
  formatVersion: 1,
  locator: { nativeHome },
};
const turnId = hostTurnIdSchema.parse("host-1");
const secondId = hostTurnIdSchema.parse("host-2");
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeTransport implements KimiTransport {
  requests: Array<{ route: string; method: string; body: unknown }> = [];
  cursors: Array<{ seq: number; epoch: string }> = [];
  options: TransportOptions | undefined;
  closeCount = 0;
  failClose = false;
  ready = true;
  defaultModel = "provider/model";
  ignoreConfiguration = false;
  beforeRequest: ((route: string) => Promise<void>) | undefined;
  subscribeGate: Promise<void> | undefined;
  listener: ((event: NativeEvent) => void) | undefined;
  fault: ((error: KimiError) => void) | undefined;
  turns: NativeTurn[] = [];
  status: NativeStatus = {
    busy: false,
    model: "provider/model",
    thinking_level: "high",
    permission: "manual",
    plan_mode: false,
    swarm_mode: false,
  };
  snapshot: NativeSnapshot = {
    as_of_seq: 0,
    epoch: "epoch-1",
    session: {
      id: "session_test",
      busy: false,
      metadata: { cwd },
      agent_config: { model: "provider/model" },
    },
    in_flight_turn: null,
    pending_approvals: [],
    pending_questions: [],
  };
  async request(route: string, method = "GET", body?: unknown): Promise<unknown> {
    this.requests.push({ route, method, body });
    await this.beforeRequest?.(route);
    if (route === "/api/v1/models")
      return {
        items: [
          { provider: "provider", model: "provider/model", support_efforts: ["low", "high"] },
          { provider: "other", model: "other/model", support_efforts: ["high"] },
        ],
      };
    if (route === "/api/v1/config")
      return { default_model: this.defaultModel, default_permission_mode: "manual" };
    if (route === "/api/v1/auth") return { models_ready: this.ready };
    if (route.endsWith("/snapshot")) return structuredClone(this.snapshot);
    if (route.endsWith("/status")) return structuredClone(this.status);
    if (route.includes("/transcript?"))
      return { agent_id: "main", items: structuredClone(this.turns), has_more: false };
    if (route.endsWith("/profile") && method === "POST") {
      const config = z
        .object({
          agent_config: z.object({
            model: z.string().optional(),
            thinking: z.string().optional(),
            permission_mode: z.enum(["manual", "yolo", "auto"]).optional(),
          }),
        })
        .parse(body).agent_config;
      if (!this.ignoreConfiguration) {
        if (config.model) this.status.model = config.model;
        if (config.thinking) this.status.thinking_level = config.thinking;
        if (config.permission_mode) this.status.permission = config.permission_mode;
      }
      return structuredClone(this.snapshot.session);
    }
    if (route.endsWith("/prompts") && method === "POST") {
      const input = z
        .object({ prompt_id: z.string(), content: z.array(z.object({ text: z.string() })) })
        .parse(body);
      const ordinal = this.turns.length + 1;
      this.turns.push({
        kind: "turn",
        turnId: `turn-${ordinal}`,
        triggerPromptId: input.prompt_id,
        ordinal,
        state: "running",
        prompt: input.content.map((part) => part.text).join("\n"),
        steps: [{ stepId: `step-${ordinal}`, state: "running", frames: [] }],
      });
      this.busy(true);
      return { prompt_id: input.prompt_id, status: "running" };
    }
    if (route.endsWith(":abort")) return { aborted: true, at_seq: this.snapshot.as_of_seq };
    if (route.includes("/approvals/")) return { resolved: true };
    if (route.includes("/questions/")) return { resolved: true };
    return structuredClone(this.snapshot.session);
  }
  busy(value: boolean): void {
    this.status.busy = value;
    this.snapshot.session.busy = value;
    this.snapshot.session.main_turn_active = value;
  }
  emit(type: string, payload: Record<string, unknown> = {}): void {
    this.snapshot.as_of_seq++;
    this.listener?.({
      type,
      session_id: "session_test",
      seq: this.snapshot.as_of_seq,
      epoch: this.snapshot.epoch,
      payload,
    });
  }
  end(state: "completed" | "cancelled" | "failed" = "completed"): void {
    const turn = required(this.turns.at(-1));
    turn.state = state;
    required(turn.steps[0]).state = "completed";
    this.busy(false);
    this.snapshot.pending_questions = [];
    this.snapshot.pending_approvals = [];
    this.emit("turn.ended");
  }
  async connect(
    onEvent: (event: NativeEvent) => void,
    onFault: (error: KimiError) => void,
  ): Promise<void> {
    this.listener = onEvent;
    this.fault = onFault;
  }
  async subscribe(_id: string, cursor: { seq: number; epoch: string }): Promise<void> {
    this.cursors.push(cursor);
    await this.subscribeGate;
  }
  async close(): Promise<void> {
    this.closeCount++;
    if (this.failClose) throw new KimiError("processExited", "Owned process did not terminate");
  }
}
const adapters: KimiCodeAdapter[] = [];
function adapter(fake: FakeTransport, environment: NodeJS.ProcessEnv = {}): KimiCodeAdapter {
  const instance = new KimiCodeAdapter({
    environment: { KIMI_CODE_HOME: nativeHome, ...environment },
    createTransport: async (options) => {
      fake.options = options;
      return fake;
    },
  });
  adapters.push(instance);
  return instance;
}
async function opened(fake = new FakeTransport()) {
  const owner = adapter(fake);
  const result = await owner.open({ kind: "create", cwd });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const outputs: HarnessOutput[] = [];
  const pump = (async () => {
    for await (const output of result.value.outputs) outputs.push(output);
  })();
  return { fake, owner, session: result.value, outputs, pump };
}
function events(outputs: HarnessOutput[], type: string) {
  return outputs.filter((output) => output.kind === "event" && output.event.type === type);
}
async function start(session: HarnessSession, id = turnId) {
  expect(
    await session.execute({
      type: "turn.start",
      turnId: id,
      input: [{ type: "text", text: "Tiny test" }],
    }),
  ).toEqual({ ok: true, value: { turnId: id } });
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((owner) => owner.close()));
});

describe("Kimi Code native adapter", () => {
  it("reports a missing model before submitting a prompt in an existing session", async () => {
    const { fake, session } = await opened();
    fake.status.model = "";
    expect(
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "test" }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", message: expect.stringContaining("select a model") },
    });
    expect(fake.requests.some((request) => request.route.endsWith("/prompts"))).toBe(false);
    expect(
      await session.execute({ type: "model.select", model: modelRef("provider/model") }),
    ).toMatchObject({ ok: true });
    await start(session);
  });

  it("initializes a delegated session from the native default when model is omitted", async () => {
    const fake = new FakeTransport();
    fake.status.model = "";
    fake.snapshot.session.agent_config.model = "";
    const result = await adapter(fake).open({
      kind: "create",
      cwd,
      executionPolicy: "unattended-full-access",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.initialState.effectiveModel).toEqual(
      modelRef("provider/model"),
    );
    expect(fake.requests.find((request) => request.route.endsWith("/profile"))?.body).toEqual({
      agent_config: { model: "provider/model", permission_mode: "yolo" },
    });
  });

  it.each(["", "missing/model"])(
    "rejects unusable native default %s before creating a session",
    async (defaultModel) => {
      const fake = new FakeTransport();
      fake.defaultModel = defaultModel;
      const result = await adapter(fake).open({
        kind: "create",
        cwd,
        executionPolicy: "unattended-full-access",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalidRequest", message: expect.stringContaining("default_model") },
      });
      expect(fake.requests.some((request) => request.route === "/api/v1/sessions")).toBe(false);
      expect(fake.closeCount).toBe(1);
    },
  );

  it("honors an explicit model even when the native default is absent", async () => {
    const fake = new FakeTransport();
    fake.defaultModel = "";
    const result = await adapter(fake).open({
      kind: "create",
      cwd,
      model: modelRef("other/model"),
    });
    expect(result.ok && result.value.initialState.effectiveModel).toEqual(modelRef("other/model"));
    expect(fake.requests.some((request) => request.route === "/api/v1/config")).toBe(false);
  });

  it("awaits native transcript binding and backfill before making the session writable", async () => {
    const fake = new FakeTransport(),
      gate = deferred(),
      owner = adapter(fake);
    fake.beforeRequest = async (route) => {
      if (route.includes("/transcript?")) await gate.promise;
    };
    let ready = false;
    const opening = owner.open({ kind: "create", cwd }).then((result) => {
      ready = true;
      return result;
    });
    await vi.waitFor(() =>
      expect(
        fake.requests.some((request) =>
          request.route.endsWith("/transcript?agent_id=main&page_size=1"),
        ),
      ).toBe(true),
    );
    expect(ready).toBe(false);
    expect(fake.cursors).toHaveLength(0);
    expect(fake.requests.some((request) => request.route.endsWith("/prompts"))).toBe(false);
    gate.resolve();
    expect((await opening).ok).toBe(true);
  });
  it("retains native reservations after session cleanup fails and retries cleanup", async () => {
    const { fake, owner, session } = await opened();
    fake.failClose = true;
    await expect(session.close()).rejects.toThrow("did not terminate");
    expect(await owner.open({ kind: "resume", nativeRef: ref, cwd })).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    fake.failClose = false;
    await session.close();
    expect((await owner.open({ kind: "resume", nativeRef: ref, cwd })).ok).toBe(true);
  });
  it("retains failed-open transports and locks until adapter cleanup succeeds", async () => {
    const fake = new FakeTransport(),
      owner = adapter(fake);
    fake.beforeRequest = async (route) => {
      if (route.endsWith("/snapshot")) throw new KimiError("protocolError", "Bad snapshot");
    };
    fake.failClose = true;
    expect(await owner.open({ kind: "resume", nativeRef: ref, cwd })).toMatchObject({
      ok: false,
      error: { code: "processExited" },
    });
    expect(await owner.open({ kind: "resume", nativeRef: ref, cwd })).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    await expect(owner.close()).rejects.toThrow("did not terminate");
    fake.failClose = false;
    await owner.close();
    expect(fake.closeCount).toBeGreaterThanOrEqual(3);
  });
  it("keeps a missing native default absent instead of selecting the first alias", () => {
    const value = catalog([{ provider: "one", model: "one/model" }], "missing/alias");
    expect(value.defaultModel).toBeUndefined();
    expect(value.models[0]?.ref).toEqual(modelRef("one/model"));
  });
  it("limits active refresh to the newest transcript page even with large older history", async () => {
    const fake = new FakeTransport();
    const request = vi.fn(async () => ({ agent_id: "main", items: [], has_more: true }));
    fake.request = request;
    expect(await readActiveTurn(fake, "session_test", "not-yet-persisted")).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported history operations before starting a native process", async () => {
    const fake = new FakeTransport(),
      owner = adapter(fake);
    expect(await owner.open({ kind: "rollbackLastTurn", sourceRef: ref, cwd })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(fake.options).toBeUndefined();
  });
  it("inspects real model readiness without creating sessions and closes inspection resources", async () => {
    const fake = new FakeTransport();
    const inspection = await adapter(fake).inspect({ cwd });
    expect(harnessInspectionSchema.safeParse(inspection).success).toBe(true);
    expect(inspection.status).toBe("ready");
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
    expect(fake.closeCount).toBe(1);
    const unready = new FakeTransport();
    unready.ready = false;
    expect(await adapter(unready).inspect({ cwd })).toMatchObject({
      status: "unavailable",
      error: { code: "authenticationRequired" },
    });
  });
  it("waits for the native subscription acknowledgment before returning a writable session", async () => {
    const fake = new FakeTransport(),
      gate = deferred();
    fake.subscribeGate = gate.promise;
    const owner = adapter(fake);
    let resolved = false;
    const pending = owner.open({ kind: "create", cwd }).then((result) => {
      resolved = true;
      return result;
    });
    await vi.waitFor(() => expect(fake.cursors).toHaveLength(1));
    expect(resolved).toBe(false);
    gate.resolve();
    expect((await pending).ok).toBe(true);
  });
  it("propagates per-open environment and confirms profile settings instead of trusting create", async () => {
    const fake = new FakeTransport(),
      owner = adapter(fake, { TEST_VALUE: "base" });
    const result = await owner.open({
      kind: "create",
      cwd,
      environment: { TEST_VALUE: "thread" },
      model: modelRef("other/model"),
      executionPolicy: "unattended-full-access",
    });
    expect(fake.options?.environment.TEST_VALUE).toBe("thread");
    expect(result.ok && result.value.initialState.effectiveModel).toEqual(modelRef("other/model"));
    expect(result.ok && result.value.initialState.effectivePermissionModeId).toBe("yolo");
    expect(fake.requests.find((request) => request.route === "/api/v1/sessions")?.body).toEqual({
      metadata: { cwd },
    });
    expect(fake.requests.find((request) => request.route.endsWith("/profile"))?.body).toEqual({
      agent_config: { model: "other/model", permission_mode: "yolo" },
    });
  });
  it("serializes duplicate native opens including rejected-open cleanup and releases its lock", async () => {
    const fake = new FakeTransport(),
      gate = deferred(),
      owner = adapter(fake);
    fake.subscribeGate = gate.promise;
    const first = owner.open({
      kind: "resume",
      nativeRef: ref,
      cwd,
      environment: { RESUME_VALUE: "resumed" },
    });
    await vi.waitFor(() => expect(fake.cursors).toHaveLength(1));
    for (let i = 0; i < 2; i++)
      expect(await owner.open({ kind: "resume", nativeRef: ref, cwd })).toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
    expect(fake.options?.environment.RESUME_VALUE).toBe("resumed");
    gate.resolve();
    const ready = await first;
    expect(ready.ok).toBe(true);
    if (ready.ok) await ready.value.close();
    expect((await owner.open({ kind: "resume", nativeRef: ref, cwd })).ok).toBe(true);
  });
  it("releases a failed open and rejects foreign refs and cwd changes without creating replacements", async () => {
    const fake = new FakeTransport(),
      owner = adapter(fake);
    fake.beforeRequest = async (route) => {
      if (route.endsWith("/snapshot")) throw new KimiError("sessionNotFound", "Missing session");
    };
    expect(await owner.open({ kind: "resume", nativeRef: ref, cwd })).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    fake.beforeRequest = undefined;
    expect((await owner.open({ kind: "resume", nativeRef: ref, cwd })).ok).toBe(true);
    expect(fake.requests.filter((request) => request.route === "/api/v1/sessions")).toHaveLength(0);
  });
  it("projects text, reasoning and tools with the same canonical IDs as complete read-only history", async () => {
    const { fake, session, outputs } = await opened();
    await start(session);
    const turn = required(fake.turns[0]);
    required(turn.steps[0]).frames.push(
      { kind: "thinking", frameId: "f1", text: "checking" },
      { kind: "text", frameId: "f2", role: "assistant", text: "Hello" },
      {
        kind: "tool",
        frameId: "f3",
        toolCallId: "tool-1",
        name: "ReadFile",
        input: { path: "test" },
        state: "running",
      },
    );
    fake.emit("tool.call.started");
    await vi.waitFor(() => expect(events(outputs, "item.started")).toHaveLength(3));
    required(turn.steps[0]).frames[1] = {
      kind: "text",
      frameId: "f2",
      role: "assistant",
      text: "Hello world",
    };
    required(turn.steps[0]).frames[2] = {
      kind: "tool",
      frameId: "f3",
      toolCallId: "tool-1",
      name: "ReadFile",
      input: { path: "test" },
      state: "error",
      output: "missing file",
    };
    fake.end();
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(1));
    const first = await session.readSnapshot(),
      second = await session.readSnapshot();
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    const completed = events(outputs, "item.completed").map((entry) =>
      entry.kind === "event" && entry.event.type === "item.completed"
        ? entry.event.snapshot
        : undefined,
    );
    if (first.ok) {
      expect(first.value.turns[0]?.items).toEqual(completed);
      expect(first.value.turns[0]?.outcome.status).toBe("succeeded");
    }
    expect(fake.requests.filter((request) => request.route.endsWith("/prompts"))).toHaveLength(1);
  });
  it("keeps cancellation busy until native terminal, then ignores late old-turn output", async () => {
    const { fake, session, outputs } = await opened();
    await start(session);
    expect(await session.execute({ type: "turn.cancel", turnId })).toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(
      await session.execute({
        type: "turn.start",
        turnId: secondId,
        input: [{ type: "text", text: "next" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(events(outputs, "turn.completed")).toHaveLength(0);
    fake.end("cancelled");
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(1));
    await start(session, secondId);
    fake.emit("assistant.delta", { turnId: 1, agentId: "main", delta: "late" });
    required(required(fake.turns[1]).steps[0]).frames.push({
      kind: "text",
      frameId: "new",
      role: "assistant",
      text: "second",
    });
    fake.end();
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(2));
    expect(JSON.stringify(outputs)).not.toContain("late");
  });
  it("recovers offset gaps, epoch changes and resync using snapshots without duplicate text", async () => {
    const { fake, session, outputs } = await opened();
    await start(session);
    required(required(fake.turns[0]).steps[0]).frames.push({
      kind: "text",
      frameId: "frame",
      role: "assistant",
      text: "abc",
    });
    fake.listener?.({
      type: "assistant.delta",
      session_id: ref.nativeSessionId,
      volatile: true,
      offset: 0,
      epoch: "epoch-1",
      payload: { turnId: 1, agentId: "main", delta: "abc" },
    });
    await vi.waitFor(() => expect(events(outputs, "item.started")).toHaveLength(1));
    required(required(fake.turns[0]).steps[0]).frames[0] = {
      kind: "text",
      frameId: "frame",
      role: "assistant",
      text: "abcdefgh",
    };
    fake.listener?.({
      type: "assistant.delta",
      session_id: ref.nativeSessionId,
      volatile: true,
      offset: 6,
      epoch: "epoch-1",
      payload: { turnId: 1, agentId: "main", delta: "gh" },
    });
    await vi.waitFor(() => expect(fake.cursors.length).toBeGreaterThan(1));
    fake.snapshot.epoch = "epoch-2";
    fake.snapshot.as_of_seq = 0;
    fake.listener?.({ type: "resync_required", payload: { session_id: ref.nativeSessionId } });
    await vi.waitFor(() => expect(fake.cursors.at(-1)?.epoch).toBe("epoch-2"));
    fake.listener?.({ type: "transport.reconnected" });
    await vi.waitFor(() => expect(fake.cursors.length).toBeGreaterThan(3));
    fake.end();
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(1));
    expect(events(outputs, "item.started")).toHaveLength(1);
    const updates = events(outputs, "item.updated");
    expect(JSON.stringify(updates)).toContain("defgh");
  });
  it("validates approval/question responses and preserves native answer variants", async () => {
    const { fake, session, outputs } = await opened();
    await start(session);
    fake.snapshot.pending_approvals.push({
      approval_id: "approve",
      agent_id: "main",
      tool_call_id: "tool",
      tool_name: "Shell",
      action: "run command",
      expires_at: "2099-01-01T00:00:00Z",
    });
    fake.emit("event.approval.requested");
    await vi.waitFor(() =>
      expect(outputs.filter((entry) => entry.kind === "interaction")).toHaveLength(1),
    );
    const approval = required(outputs.find((entry) => entry.kind === "interaction"));
    if (approval.kind !== "interaction") throw new Error("Missing approval");
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: approval.interaction.interactionId,
        response: { type: "approval", actionId: "always" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: approval.interaction.interactionId,
        response: { type: "approval", actionId: "session" },
      }),
    ).toMatchObject({ ok: true });
    expect(fake.requests.find((request) => request.route.includes("/approvals/"))?.body).toEqual({
      decision: "approved",
      scope: "session",
    });
    fake.snapshot.pending_approvals = [];
    fake.snapshot.pending_questions.push({
      question_id: "question",
      agent_id: "main",
      questions: [
        {
          id: "q",
          question: "Choose",
          options: [{ id: "a", label: "A" }],
          multi_select: true,
          allow_other: true,
        },
      ],
    });
    fake.emit("event.question.requested");
    let question: HostQuestionInteraction | undefined;
    await vi.waitFor(() => {
      const entry = outputs.find(
        (entry) => entry.kind === "interaction" && entry.interaction.type === "question",
      );
      question =
        entry?.kind === "interaction" && entry.interaction.type === "question"
          ? entry.interaction
          : undefined;
      expect(question).toBeDefined();
    });
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: required(question).interactionId,
        response: { type: "question", answers: { q: ["a", "custom"] } },
      }),
    ).toMatchObject({ ok: true });
    expect(fake.requests.find((request) => request.route.includes("/questions/"))?.body).toEqual({
      answers: { q: { kind: "multi_with_other", option_ids: ["a"], other_text: "custom" } },
    });
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: required(question).interactionId,
        response: { type: "question", answers: { q: ["a"] } },
      }),
    ).toMatchObject({ ok: false });
    fake.snapshot.pending_questions = [];
    fake.end();
  });
  it("allows native-confirmed configuration during a turn and never reports an ignored request effective", async () => {
    const { fake, session, outputs } = await opened();
    await start(session);
    expect(
      await session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      }),
    ).toMatchObject({ ok: true });
    fake.ignoreConfiguration = true;
    expect(
      await session.execute({ type: "model.select", model: modelRef("other/model") }),
    ).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(JSON.stringify(events(outputs, "session.state.changed"))).not.toContain(
      modelRef("other/model").id,
    );
  });
  it("faults the active lifecycle exactly once, closes resources, and rejects later commands", async () => {
    const { fake, session, outputs, pump } = await opened();
    await start(session);
    required(required(fake.turns[0]).steps[0]).frames.push({
      kind: "text",
      frameId: "partial",
      role: "assistant",
      text: "partial",
    });
    fake.emit("assistant.delta");
    await vi.waitFor(() => expect(events(outputs, "item.started")).toHaveLength(1));
    fake.fault?.(new KimiError("processExited", "Native process exited"));
    await pump;
    expect(events(outputs, "item.completed")).toHaveLength(1);
    expect(events(outputs, "turn.completed")).toHaveLength(1);
    expect(events(outputs, "session.faulted")).toHaveLength(1);
    expect(fake.closeCount).toBe(1);
    expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await session.close();
    expect(fake.closeCount).toBe(1);
  });
  it("returns stable command and reasoning history across all turn pages", async () => {
    const makeTurn = (number: number): NativeTurn => ({
      kind: "turn",
      turnId: `t${number}`,
      ordinal: number,
      state: "completed",
      prompt: `input-${number}`,
      steps: [
        {
          stepId: `s${number}`,
          state: "completed",
          frames: [
            {
              kind: "tool",
              frameId: "shell",
              toolCallId: `c${number}`,
              name: "Shell",
              state: "done",
              input: { command: "pwd" },
              display: { kind: "command", command: "pwd", cwd },
              output: "directory",
            },
          ],
        },
      ],
    });
    const fake = new FakeTransport();
    fake.request = async (route) =>
      route.includes("before_turn=t2")
        ? { agent_id: "main", items: [makeTurn(1)], has_more: false }
        : { agent_id: "main", items: [makeTurn(2), makeTurn(3)], has_more: true };
    const turns = await readTurns(fake, "session_test");
    expect(turns.map((turn) => turn.turnId)).toEqual(["t1", "t2", "t3"]);
    const projected = projectTurn("session_test", required(turns[0]));
    expect(projected.items[0]?.item).toMatchObject({
      type: "commandExecution",
      command: "pwd",
      output: "directory",
    } satisfies Partial<HostItem>);
    fake.request = async () => ({ agent_id: "main", items: [makeTurn(2)], has_more: true });
    await expect(readTurns(fake, "session_test")).rejects.toThrow("overlap");
  });
});
