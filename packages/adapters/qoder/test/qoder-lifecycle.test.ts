import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessOutputChannel, type HarnessOutput } from "@codexhost/harness-adapter";
import { harnessPermissionModeIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { QoderAdapter } from "../src/qoder-adapter.js";
import type { QoderOptions, QoderQuery, SDKMessage } from "../src/qoder-sdk-types.js";

class ControlledQuery implements QoderQuery {
  readonly messages = new HarnessOutputChannel<SDKMessage>();
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => this.messages.end());
  [Symbol.asyncIterator]() {
    return this.messages.outputs[Symbol.asyncIterator]();
  }
  push(message: unknown) {
    this.messages.emit(message as SDKMessage);
  }
}

const adapters: QoderAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

async function open(query: QoderQuery = new ControlledQuery()) {
  let options: QoderOptions | undefined;
  const adapter = new QoderAdapter({
    resolveExecutable: () => "D:/tools/qodercli.exe",
    queryFactory: (input) => {
      options = input.options;
      return query;
    },
  });
  adapters.push(adapter);
  const opened = await adapter.open({ kind: "create", cwd: "D:/workspace" });
  if (!opened.ok) throw new Error(opened.error.message);
  const session = opened.value;
  const outputs: HarnessOutput[] = [];
  const ended = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  const start = (id: string) =>
    session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(id),
      input: [{ type: "text", text: "Hello" }],
    });
  return { session, outputs, ended, start, options };
}

function events(outputs: HarnessOutput[], type: string) {
  return outputs.filter((output) => output.kind === "event" && output.event.type === type);
}

const result = { type: "result", subtype: "success" };

describe("Qoder failure and cancellation boundaries", () => {
  it("returns a typed open error when SDK construction fails", async () => {
    const adapter = new QoderAdapter({
      resolveExecutable: () => "qodercli",
      queryFactory: () => {
        throw new Error("authentication required");
      },
    });
    adapters.push(adapter);
    expect(await adapter.open({ kind: "create", cwd: "D:/workspace" })).toMatchObject({
      ok: false,
      error: { code: "authenticationRequired" },
    });
  });

  it("faults on a native auth result before the first Turn and rejects subsequent work", async () => {
    const query = new ControlledQuery();
    const { session, outputs, ended, start } = await open(query);
    query.push({
      type: "result",
      subtype: "error_during_execution",
      terminal_reason: "auth_required",
      errors: ['No qodercli login found. Run "qodercli login" first.'],
    });
    await ended;
    expect(events(outputs, "session.faulted")).toMatchObject([
      { event: { error: { code: "authenticationRequired" } } },
    ]);
    expect(events(outputs, "turn.completed")).toHaveLength(0);
    expect(await start("after-auth-failure")).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await session.close();
    expect(query.close).toHaveBeenCalledTimes(1);
  });

  it("faults when the native iterator throws before the first Turn", async () => {
    const query = new ControlledQuery();
    query[Symbol.asyncIterator] = async function* () {
      throw new Error("transport failed");
    };
    const { outputs, ended, start } = await open(query);
    await ended;
    expect(events(outputs, "session.faulted")).toHaveLength(1);
    expect(await start("after-fault")).toMatchObject({ ok: false });
  });

  it("closes pending interactions, items and the active Turn on unexpected EOF", async () => {
    const query = new ControlledQuery();
    const { outputs, ended, start, options } = await open(query);
    await start("active");
    query.push({ type: "stream_event", text_delta: "partial" });
    query.push({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }],
      },
    });
    if (!options?.canUseTool) throw new Error("Missing permission callback");
    const permission = options.canUseTool(
      "Bash",
      { command: "pwd" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
      },
    );
    await vi.waitFor(() => expect(events(outputs, "item.started")).toHaveLength(2));
    query.messages.end();
    await ended;
    expect(await permission).toMatchObject({ behavior: "deny" });
    expect(events(outputs, "interaction.closed")).toHaveLength(1);
    expect(events(outputs, "item.completed")).toHaveLength(2);
    expect(events(outputs, "turn.completed")).toMatchObject([
      {
        event: {
          turnId: "active",
          outcome: { status: "failed", error: { code: "processExited" } },
        },
      },
    ]);
    expect(outputs.at(-1)).toMatchObject({ event: { type: "session.faulted" } });
  });

  it("keeps the old Turn locked after the interrupt receipt until its native result", async () => {
    const query = new ControlledQuery();
    const { session, outputs, start } = await open(query);
    await start("old");
    await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("old") });
    expect(await start("new")).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(events(outputs, "turn.completed")).toHaveLength(0);
    query.push({
      type: "assistant",
      uuid: "old-response",
      message: {
        content: [{ type: "text", text: "Late old response" }],
      },
    });
    query.push({ type: "result", subtype: "error_during_execution", errors: ["interrupted"] });
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(1));
    expect(events(outputs, "item.completed")).toMatchObject([{ event: { turnId: "old" } }]);
    expect(events(outputs, "turn.completed")).toMatchObject([
      { event: { turnId: "old", outcome: { status: "cancelled" } } },
    ]);
    expect(await start("new")).toMatchObject({ ok: true });
    query.push(result);
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(2));
    expect(events(outputs, "turn.completed")[1]).toMatchObject({
      event: { turnId: "new", outcome: { status: "succeeded" } },
    });
  });

  it("does not complete a Turn when interrupt fails", async () => {
    const query = new ControlledQuery();
    query.interrupt.mockRejectedValueOnce(new Error("interrupt failed"));
    const { session, outputs, start } = await open(query);
    await start("old");
    expect(
      await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("old") }),
    ).toMatchObject({ ok: false, error: { message: "interrupt failed" } });
    expect(await start("new")).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(events(outputs, "turn.completed")).toHaveLength(0);
    query.push(result);
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(1));
    expect(events(outputs, "turn.completed")[0]).toMatchObject({
      event: { outcome: { status: "succeeded" } },
    });
  });

  it("does not alter a new Turn if the old interrupt rejects after its result", async () => {
    const query = new ControlledQuery();
    let reject!: (error: Error) => void;
    query.interrupt.mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    const { session, outputs, start } = await open(query);
    await start("old");
    const cancelling = session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("old"),
    });
    query.push(result);
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(1));
    await start("new");
    reject(new Error("late interrupt failure"));
    await cancelling;
    query.push(result);
    await vi.waitFor(() => expect(events(outputs, "turn.completed")).toHaveLength(2));
    expect(events(outputs, "turn.completed")[1]).toMatchObject({
      event: { turnId: "new", outcome: { status: "succeeded" } },
    });
  });
});

describe("Qoder unattended execution", () => {
  it.each([undefined, "bypassPermissions", "yolo"])(
    "maps policy with mode %s to native bypass",
    async (mode) => {
      const query = new ControlledQuery();
      let options: QoderOptions | undefined;
      const adapter = new QoderAdapter({
        resolveExecutable: () => "qodercli",
        queryFactory: (input) => {
          options = input.options;
          return query;
        },
      });
      adapters.push(adapter);
      const opened = await adapter.open({
        kind: "create",
        cwd: "D:/workspace",
        executionPolicy: "unattended-full-access",
        ...(mode ? { permissionModeId: harnessPermissionModeIdSchema.parse(mode) } : {}),
      });
      expect(opened.ok).toBe(true);
      expect(options).toMatchObject({
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      });
    },
  );

  it("rejects conflicting permissions before starting the SDK", async () => {
    const queryFactory = vi.fn(() => new ControlledQuery());
    const adapter = new QoderAdapter({ queryFactory, resolveExecutable: () => "qodercli" });
    adapters.push(adapter);
    expect(
      await adapter.open({
        kind: "create",
        cwd: "D:/workspace",
        executionPolicy: "unattended-full-access",
        permissionModeId: harnessPermissionModeIdSchema.parse("default"),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(queryFactory).not.toHaveBeenCalled();
  });

  it("preserves interactive defaults without the unattended policy", async () => {
    const { options } = await open();
    expect(options?.permissionMode).toBeUndefined();
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
  });
});
