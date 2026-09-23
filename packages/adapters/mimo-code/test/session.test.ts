import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessOutput, HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import { harnessPermissionModeIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { MimoAdapter } from "../src/adapter.js";
import { encodeModel } from "../src/protocol.js";
import { MimoCleanupError } from "../src/server.js";
import { FakeNative, assistant, textPart } from "./fixtures.js";

const resources: MimoAdapter[] = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map((adapter) => adapter.close()));
});
async function open(fake = new FakeNative()) {
  const adapter = new MimoAdapter({ environment: { BASE: "base", REMOVE: "yes" } }, fake.connect);
  resources.push(adapter);
  const result = await adapter.open({
    kind: "create",
    cwd: process.cwd(),
    environment: { BASE: "override", REMOVE: undefined },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const session = result.value;
  const outputs: HarnessOutput[] = [];
  const consumed = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return { session, outputs, fake, adapter, consumed };
}
const events = (outputs: HarnessOutput[]): HostEvent[] =>
  outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
async function start(session: HarnessSession, fake: FakeNative, id = "host-one") {
  const turnId = hostTurnIdSchema.parse(id);
  expect(
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "Hello" }] }),
  ).toEqual({ ok: true, value: { turnId } });
  await vi.waitFor(() => expect(fake.finishRequest).toBeDefined());
  return turnId;
}

describe("MiMo native session through the published SDK", () => {
  it("confirms unattended native flags before creation and restores them on resume", async () => {
    const fake = new FakeNative();
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    const opened = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      executionPolicy: "unattended-full-access",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState.effectivePermissionModeId).toBe("full-access");
    expect(fake.skipAll && fake.autoApproveDelete).toBe(true);
    const paths = fake.requests.map((request) => new URL(request.url).pathname);
    expect(paths.indexOf("/permission/auto-approve-delete")).toBeLessThan(
      paths.indexOf("/session"),
    );
    const nativeRef = opened.value.initialState.nativeRef;
    if (!nativeRef) throw new Error("Missing native ref");
    await opened.value.close();
    fake.skipAll = false;
    fake.autoApproveDelete = false;
    const resumed = await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef });
    expect(resumed.ok).toBe(true);
    expect(fake.skipAll && fake.autoApproveDelete).toBe(true);
  });

  it("fails before creating a session when native unattended permissions are not confirmed", async () => {
    const fake = new FakeNative();
    fake.confirmUnattended = false;
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    expect(
      await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
      }),
    ).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(fake.requests.some((request) => new URL(request.url).pathname === "/session")).toBe(
      false,
    );
    expect(fake.closes).toBe(1);
  });

  it("does not enable unattended flags for ordinary sessions", async () => {
    const { fake } = await open();
    expect(
      fake.requests.some((request) => new URL(request.url).pathname.startsWith("/permission/")),
    ).toBe(false);
  });

  it("switches the next prompt during an active turn without reverting on old model events", async () => {
    const { session, outputs, fake } = await open();
    await start(session, fake);
    const selected = encodeModel({ providerID: "mimo", modelID: "other" });
    expect(await session.execute({ type: "model.select", model: selected })).toMatchObject({
      ok: true,
    });
    const info = {
      ...assistant(fake.promptID),
      finish: "stop",
      time: { created: 2, completed: 3 },
    };
    fake.finish(info, [textPart(info.id, "done")]);
    await vi.waitFor(() =>
      expect(events(outputs).some((event) => event.type === "turn.completed")).toBe(true),
    );
    expect(await session.readSnapshot()).toMatchObject({
      value: { state: { effectiveModel: selected } },
    });
    const states = events(outputs).filter((event) => event.type === "session.state.changed");
    expect(states.at(-1)).toMatchObject({ state: { effectiveModel: selected } });
    fake.finishRequest = undefined;
    await start(session, fake, "host-next");
    expect(fake.promptBody.model).toEqual({ providerID: "mimo", modelID: "other" });
  });

  it("rejects unknown models before creating a session and preserves a valid live selection", async () => {
    const { adapter, session, fake } = await open();
    const unknown = encodeModel({ providerID: "mimo", modelID: "missing" });
    const before = fake.requests.filter((request) => request.method === "POST").length;
    expect(
      await adapter.open({ kind: "create", cwd: process.cwd(), model: unknown }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(before);
    const selected = encodeModel({ providerID: "mimo", modelID: "tiny" });
    expect(await session.execute({ type: "model.select", model: selected })).toMatchObject({
      ok: true,
    });
    expect(await session.execute({ type: "model.select", model: unknown })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    await start(session, fake);
    expect(fake.promptBody.model).toEqual({ providerID: "mimo", modelID: "tiny" });
  });

  it("streams reasoning, text and tools, then reconciles stable complete read-only history", async () => {
    const { session, outputs, fake } = await open();
    expect(fake.connections[0]?.environment).toEqual({ BASE: "override" });
    await start(session, fake);
    const info = assistant(fake.promptID);
    fake.emit({ type: "message.updated", properties: { sessionID: info.sessionID, info } });
    fake.emit({
      type: "message.part.updated",
      properties: { sessionID: info.sessionID, time: 2, part: textPart(info.id, "Hello") },
    });
    fake.emit({
      type: "message.part.delta",
      properties: {
        sessionID: info.sessionID,
        messageID: info.id,
        partID: "prt_text",
        field: "text",
        delta: " world",
      },
    });
    const reasoning = {
      id: "prt_reason",
      sessionID: info.sessionID,
      messageID: info.id,
      type: "reasoning" as const,
      text: "Summary",
      time: { start: 1, end: 2 },
    };
    const tool = {
      id: "prt_tool",
      sessionID: info.sessionID,
      messageID: info.id,
      type: "tool" as const,
      callID: "call_1",
      tool: "read",
      state: {
        status: "completed" as const,
        input: { path: "file" },
        output: "content",
        title: "Read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    fake.finish({ ...info, time: { created: 2, completed: 3 }, finish: "stop" }, [
      textPart(info.id, "Hello world"),
      reasoning,
      tool,
    ]);
    await vi.waitFor(() =>
      expect(events(outputs).filter((event) => event.type === "turn.completed")).toHaveLength(1),
    );
    const deltas = events(outputs).flatMap((event) =>
      event.type === "item.updated" && event.update.type === "text.append"
        ? [event.update.text]
        : [],
    );
    expect(deltas).toEqual(["Hello", " world", "Summary"]);
    const first = await session.readSnapshot();
    const count = outputs.length;
    const second = await session.readSnapshot();
    expect(second).toEqual(first);
    expect(outputs).toHaveLength(count);
    expect(first.ok && first.value.turns[0]?.items.map((item) => item.item.type)).toEqual([
      "agentMessage",
      "reasoning",
      "toolExecution",
    ]);
    expect(events(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      nativeTurnRef: { nativeTurnKey: fake.promptID },
      outcome: { status: "succeeded" },
    });
  });

  it("waits for native admission before abort and native prompt terminal before the next turn", async () => {
    const fake = new FakeNative();
    fake.autoAdmit = false;
    const { session, outputs } = await open(fake);
    const turnId = await start(session, fake);
    expect((await session.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
    expect(fake.requests.some((request) => request.url.endsWith("/abort"))).toBe(false);
    fake.admit();
    await vi.waitFor(() =>
      expect(fake.requests.some((request) => request.url.endsWith("/abort"))).toBe(true),
    );
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("next"),
        input: [{ type: "text", text: "next" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(events(outputs).some((event) => event.type === "turn.completed")).toBe(false);
    const info = assistant(fake.promptID);
    fake.finish(
      {
        ...info,
        time: { created: 2, completed: 3 },
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      },
      [textPart(info.id, "Partial")],
    );
    await vi.waitFor(() =>
      expect(events(outputs).filter((event) => event.type === "turn.completed")).toHaveLength(1),
    );
    expect(events(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      outcome: { status: "cancelled" },
    });
    const oldId = fake.promptID;
    fake.finishRequest = undefined;
    fake.autoAdmit = true;
    await start(session, fake, "next");
    fake.emit({
      type: "message.updated",
      properties: { sessionID: "ses_test", info: assistant(oldId, "msg_late") },
    });
    fake.emit({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        time: 4,
        part: textPart("msg_late", "late", "prt_late"),
      },
    });
    const next = assistant(fake.promptID, "msg_next");
    fake.finish({ ...next, time: { created: 4, completed: 5 }, finish: "stop" }, [
      textPart(next.id, "Next result", "prt_next"),
    ]);
    await vi.waitFor(() =>
      expect(events(outputs).filter((event) => event.type === "turn.completed")).toHaveLength(2),
    );
    expect(JSON.stringify(outputs)).not.toContain("prt_late");
  });

  it("validates approval and question answers and closes each interaction once", async () => {
    const { session, outputs, fake } = await open();
    await start(session, fake);
    fake.emit({
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: "ses_test",
        permission: "read",
        patterns: ["file"],
        metadata: {},
        always: ["*"],
      },
    });
    fake.emit({
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID: "ses_test",
        questions: [
          {
            question: "Choose",
            header: "Choose",
            options: [{ label: "A", description: "First" }],
            custom: false,
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(outputs.filter((output) => output.kind === "interaction")).toHaveLength(2),
    );
    const interactions = outputs.flatMap((output) =>
      output.kind === "interaction" ? [output.interaction] : [],
    );
    const approval = interactions[0];
    const question = interactions[1];
    if (!approval || !question) throw new Error("Missing native interactions");
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: approval.interactionId,
        response: { type: "approval", actionId: "always" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: approval.interactionId,
          response: { type: "approval", actionId: "once" },
        })
      ).ok,
    ).toBe(true);
    fake.emit({
      type: "permission.replied",
      properties: { sessionID: "ses_test", requestID: "per_1", reply: "once" },
    });
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: question.interactionId,
        response: { type: "question", answers: { "0": ["B"] } },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: question.interactionId,
          response: { type: "question", answers: {}, cancelled: true },
        })
      ).ok,
    ).toBe(true);
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: question.interactionId,
        response: { type: "question", answers: { "0": ["A"] } },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
    await vi.waitFor(() =>
      expect(events(outputs).filter((event) => event.type === "interaction.closed")).toHaveLength(
        2,
      ),
    );
    expect(
      fake.requests.some((request) => new URL(request.url).pathname === "/question/que_1/reject"),
    ).toBe(true);
  });

  it("faults and cleans up on SSE loss, with one item/turn terminal and no next turn", async () => {
    const { session, outputs, fake, consumed } = await open();
    await start(session, fake);
    const info = assistant(fake.promptID);
    fake.emit({ type: "message.updated", properties: { sessionID: "ses_test", info } });
    fake.emit({
      type: "message.part.updated",
      properties: { sessionID: info.sessionID, time: 2, part: textPart(info.id, "partial") },
    });
    if (!fake.stream) throw new Error("Missing native stream");
    fake.stream.close();
    await consumed;
    expect(
      events(outputs)
        .map((event) => event.type)
        .slice(-3),
    ).toEqual(["item.completed", "turn.completed", "session.faulted"]);
    expect(fake.closes).toBe(1);
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("later"),
        input: [{ type: "text", text: "later" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
    await session.close();
    expect(fake.closes).toBe(1);
  });

  it("confirms permission configuration and selects a native catalog model", async () => {
    const fake = new FakeNative();
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    const ask = harnessPermissionModeIdSchema.parse("ask");
    const opened = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      permissionModeId: ask,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(session.initialState.effectivePermissionModeId).toBe("ask");
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("allow"),
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(
      await session.execute({
        type: "model.select",
        model: encodeModel({ providerID: "mimo", modelID: "tiny" }),
      }),
    ).toMatchObject({ ok: true, value: { completed: true } });
    expect(await session.readSnapshot()).toMatchObject({
      value: { state: { effectiveModel: encodeModel({ providerID: "mimo", modelID: "tiny" }) } },
    });
  });

  it("inspects without a session, rejects unsupported opens and cleans failed resume", async () => {
    const fake = new FakeNative();
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    expect(await adapter.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "ready",
      capabilities: { configuration: { selectModel: true, selectPermissionMode: true } },
    });
    expect(fake.requests.some((request) => new URL(request.url).pathname === "/session")).toBe(
      false,
    );
    expect(
      await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
        permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(fake.connections).toHaveLength(1);
    fake.missing = true;
    expect(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: { harnessId: adapter.harnessId, nativeSessionId: "ses_test", formatVersion: 1 },
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
    expect(fake.closes).toBe(2);
  });

  it("does not treat native server access and built-in connected catalogs as model authentication", async () => {
    const fake = new FakeNative();
    fake.authenticated = false;
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    expect(await adapter.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "unavailable",
      error: { code: "authenticationRequired" },
    });
    expect(fake.closes).toBe(1);
    expect(fake.requests.some((request) => request.method !== "GET")).toBe(false);
  });

  it("reserves a native identity across racing opens and releases it after close or failed open", async () => {
    const fake = new FakeNative();
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    const input = {
      kind: "resume" as const,
      cwd: process.cwd(),
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: "ses_test",
        formatVersion: 1 as const,
      },
    };
    const [first, second] = await Promise.all([adapter.open(input), adapter.open(input)]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(fake.connections).toHaveLength(1);
    if (!first.ok) throw new Error("Missing opened session");
    await first.value.close();
    fake.missing = true;
    expect(await adapter.open(input)).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    fake.missing = false;
    const reopened = await adapter.open(input);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error("Missing reopened session");
    await reopened.value.close();
    const count = fake.closes;
    await adapter.close();
    expect(fake.closes).toBe(count);
  });

  it("does not drop an approval that precedes assistant metadata", async () => {
    const { session, outputs, fake } = await open();
    await start(session, fake);
    fake.emit({
      type: "permission.asked",
      properties: {
        id: "per_early",
        sessionID: "ses_test",
        permission: "edit",
        patterns: ["file"],
        metadata: {},
        always: [],
        tool: { messageID: "msg_not_yet_received", callID: "call_early" },
      },
    });
    await vi.waitFor(() =>
      expect(outputs.some((output) => output.kind === "interaction")).toBe(true),
    );
    const interaction = outputs.find((output) => output.kind === "interaction");
    if (interaction?.kind !== "interaction") throw new Error("Missing early approval");
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: interaction.interaction.interactionId,
          response: { type: "approval", actionId: "reject" },
        })
      ).ok,
    ).toBe(true);
  });

  it("validates the initial model and configures subsequent native prompts", async () => {
    const fake = new FakeNative();
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    const result = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      model: encodeModel({ providerID: "mimo", modelID: "tiny" }),
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.initialState.effectiveModel).toEqual(
      encodeModel({ providerID: "mimo", modelID: "tiny" }),
    );
    await start(result.value, fake);
    expect(fake.promptBody.model).toEqual({ providerID: "mimo", modelID: "tiny" });
  });

  it("reports an empty native prompt result without a fabricated success or generic TypeError", async () => {
    const { session, outputs, fake } = await open();
    await start(session, fake);
    fake.finishRequest?.(Response.json({}));
    await vi.waitFor(() =>
      expect(events(outputs).some((event) => event.type === "turn.completed")).toBe(true),
    );
    expect(events(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      outcome: {
        status: "failed",
        error: { code: "protocolError", message: "MiMo has no final assistant result" },
      },
    });
    expect(events(outputs).some((event) => event.type === "session.faulted")).toBe(false);
  });

  it("returns typed inspection cleanup failure and retains the resource for close retry", async () => {
    const fake = new FakeNative();
    fake.closeFailures = 1;
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    expect(await adapter.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "unavailable",
      error: {
        code: "unavailable",
        retryable: true,
        message: expect.stringContaining("may still be running"),
      },
    });
    expect(fake.closes).toBe(1);
    await adapter.close();
    expect(fake.closes).toBe(2);
  });

  it("preserves a failed-open reservation when cleanup fails and retries the owned resource", async () => {
    const fake = new FakeNative();
    fake.missing = true;
    fake.closeFailures = 1;
    const adapter = new MimoAdapter({}, fake.connect);
    resources.push(adapter);
    const input = {
      kind: "resume" as const,
      cwd: process.cwd(),
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: "ses_test",
        formatVersion: 1 as const,
      },
    };
    expect(await adapter.open(input)).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    fake.missing = false;
    expect(await adapter.open(input)).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(fake.connections).toHaveLength(1);
    await adapter.close();
    expect(fake.closes).toBe(2);
  });

  it("allows Adapter.close to retry a Session cleanup rejection without losing ownership", async () => {
    const { fake, adapter } = await open();
    fake.closeFailures = 1;
    await expect(adapter.close()).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.closes).toBe(1);
    await adapter.close();
    expect(fake.closes).toBe(2);
    await adapter.close();
    expect(fake.closes).toBe(2);
  });

  it("retains startup cleanup ownership even when connect never returns a client", async () => {
    let retries = 0;
    const adapter = new MimoAdapter({}, async () => {
      throw new MimoCleanupError(async () => {
        retries++;
      });
    });
    resources.push(adapter);
    expect(await adapter.open({ kind: "create", cwd: process.cwd() })).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringContaining("may still be running") },
    });
    await adapter.close();
    expect(retries).toBe(1);
  });
});
