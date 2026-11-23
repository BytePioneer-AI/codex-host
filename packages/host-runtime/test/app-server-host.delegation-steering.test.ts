import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { HarnessSession, HostCommand } from "@codexhost/harness-adapter";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../src/official-app-server-connection.js";
import {
  bindOfficialThread,
  createFixture,
  method,
  messageParams,
  readJsonLine,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
} from "./app-server-host-fixture.js";

describe("Delegation steering through CLI and Host", () => {
  it("steers a running official Thread with turn/steer instead of starting another Turn", async () => {
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    await bindOfficialThread(fixture, "native-thread");
    if (!api) throw new Error("Missing Delegation API");
    try {
      const sending = api.send({
        threadId: "native-thread",
        message: "also inspect the tests",
        steer: true,
      });
      const read = await readJsonLine(fixture.official.stdin);
      expect(read).toMatchObject({ method: "thread/read", params: { threadId: "native-thread" } });
      fixture.official.stdout.write(
        `${JSON.stringify({
          id: read.id,
          result: {
            thread: {
              id: "native-thread",
              status: { type: "active" },
              turns: [{ id: "running-turn", status: "inProgress", items: [] }],
            },
          },
        })}\n`,
      );
      const steer = await readJsonLine(fixture.official.stdin);
      expect(steer).toMatchObject({
        method: "turn/steer",
        params: {
          threadId: "native-thread",
          expectedTurnId: "running-turn",
          input: [{ type: "text", text: "also inspect the tests" }],
        },
      });
      fixture.official.stdout.write(
        `${JSON.stringify({ id: steer.id, result: { turnId: "running-turn" } })}\n`,
      );
      await expect(sending).resolves.toMatchObject({
        threadId: "native-thread",
        turnId: "running-turn",
        harnessId: "codex",
      });
      expect(fixture.official.stdin.read()).toBeNull();
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([true, false])(
    "uses the upstream delivery operation with native support=%s",
    async (native) => {
      let api: DelegationControlApi | undefined;
      const fixture = createFixture({
        onDelegationApi: (value) => {
          api = value;
          return undefined;
        },
      });
      fixture.adapter.supportsSteer = native;
      const threadId = await startPiThread(fixture);
      const originalTurnId = await startPiTurn(fixture, threadId);
      if (!api) throw new Error("Missing Delegation API");
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      if (!native) session.completeCancellationOnRequest();
      const server = await startDelegationControlServer({ token: "test-token", api });
      try {
        const environment = {
          CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
          CODEXHOST_RUNTIME_TOKEN: "test-token",
        };
        const output = new PassThrough();
        const diagnostics = new PassThrough();
        const args = ["thread", "send", threadId, "--message", "also inspect the tests"];
        expect(
          await runDelegationCli({
            arguments: args,
            environment,
            output,
            diagnosticOutput: diagnostics,
          }),
        ).toBe(1);
        expect(JSON.parse(String(diagnostics.read()))).toMatchObject({
          error: { code: "THREAD_BUSY" },
        });
        expect(
          await runDelegationCli({
            arguments: [...args, "--steer", "true"],
            environment,
            output,
            diagnosticOutput: diagnostics,
          }),
        ).toBe(0);
        const result = JSON.parse(String(output.read())) as { turnId: string };
        if (native) {
          expect(result.turnId).toBe(originalTurnId);
          expect(session.steers).toEqual([
            expect.objectContaining({
              turnId: originalTurnId,
              input: [{ type: "text", text: "also inspect the tests" }],
            }),
          ]);
          expect(
            fixture.collector.messages.filter((message) => message.method === "turn/started"),
          ).toHaveLength(1);
        } else {
          expect(result.turnId).not.toBe(originalTurnId);
          expect(session.steers).toEqual([]);
          expect(
            fixture.collector.messages.filter((message) => message.method === "turn/started"),
          ).toHaveLength(2);
          // CLI input has no Desktop echo, so the stop-then-start path must publish it.
          await expect(
            fixture.collector.waitFor(
              (message) =>
                method(message, "item/started") &&
                (messageParams(message).item as JsonObject).type === "userMessage",
            ),
          ).resolves.toMatchObject({
            params: {
              turnId: result.turnId,
              item: {
                content: [{ type: "text", text: "also inspect the tests" }],
              },
            },
          });
        }
      } finally {
        await server.close();
        await stopFixture(fixture);
      }
    },
  );

  it("reports an unknown steering outcome without claiming it was not started", async () => {
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    fixture.adapter.supportsSteer = true;
    const threadId = await startPiThread(fixture);
    await startPiTurn(fixture, threadId);
    if (!api) throw new Error("Missing Delegation API");
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Missing Session");
    const execute = session.execute.bind(session);
    vi.spyOn(session, "execute").mockImplementation(async (command: HostCommand) => {
      if (command.type === "turn.steer") {
        await execute(command);
        throw new Error("native reply lost");
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const server = await startDelegationControlServer({ token: "test-token", api });
    try {
      const diagnostics = new PassThrough();
      expect(
        await runDelegationCli({
          arguments: ["thread", "send", threadId, "--message", "adjust", "--steer", "true"],
          environment: {
            CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
            CODEXHOST_RUNTIME_TOKEN: "test-token",
          },
          output: new PassThrough(),
          diagnosticOutput: diagnostics,
        }),
      ).toBe(1);
      expect(JSON.parse(String(diagnostics.read()))).toEqual({
        error: { code: "DELEGATION_FAILED", message: "native reply lost" },
      });
    } finally {
      await server.close();
      await stopFixture(fixture);
    }
  });

  it("keeps Pi stop-and-resend steering and follow-up turns running in list and duplicate start, then settles to completed", async () => {
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    fixture.adapter.supportsSteer = false;
    const parentThreadId = await startPiThread(fixture);
    if (!api) throw new Error("Missing Delegation API");
    const releaseReplacement = Promise.withResolvers<undefined>();
    try {
      const startInput = {
        harnessId: "pi" as const,
        task: "initial task",
        cwd: "/synthetic",
        parentThreadId,
        requestId: "req-pi-steer-live",
      };
      const started = await api.start(startInput);
      const childSession = fixture.adapter.sessions[1];
      if (!childSession) throw new Error("Missing child Pi Session");
      childSession.completeCancellationOnRequest();

      const replacementReady = Promise.withResolvers<undefined>();
      const execute = childSession.execute.bind(childSession);
      let replacementIntercepted = false;
      childSession.execute = (async (command: HostCommand) => {
        if (command.type === "turn.start") {
          if (!replacementIntercepted) {
            replacementIntercepted = true;
            replacementReady.resolve(undefined);
            await releaseReplacement.promise;
          }
          return execute(command);
        }
        if (command.type === "turn.cancel") return execute(command);
        throw new Error(`Unexpected command: ${command.type}`);
      }) as typeof childSession.execute;

      const steering = api.send({
        threadId: started.threadId,
        message: "redirect task",
        steer: true,
      });
      await replacementReady.promise;

      // Turn 1 cancelled and persisted "interrupted", while Turn 2 has not started yet.
      await expect(
        api.list({ parentThreadId, limit: 25, sort: "created-desc" }),
      ).resolves.toMatchObject({
        threads: [expect.objectContaining({ threadId: started.threadId, status: "running" })],
      });
      await expect(api.start(startInput)).resolves.toMatchObject({
        threadId: started.threadId,
        status: "running",
      });
      await expect(api.read({ threadId: started.threadId, view: "result" })).resolves.toMatchObject(
        { status: "running" },
      );

      releaseReplacement.resolve(undefined);
      const steered = await steering;
      expect(steered.turnId).not.toBe(started.turnId);

      await expect(
        api.list({ parentThreadId, limit: 25, sort: "created-desc" }),
      ).resolves.toMatchObject({
        threads: [expect.objectContaining({ threadId: started.threadId, status: "running" })],
      });

      childSession.appendText("steered done");
      childSession.succeedTurn();
      await fixture.collector.waitFor((msg) => turnEvent(msg, "turn/completed", steered.turnId));
      await vi.waitFor(async () => {
        await expect(
          api?.list({ parentThreadId, limit: 25, sort: "created-desc" }),
        ).resolves.toMatchObject({
          threads: [expect.objectContaining({ threadId: started.threadId, status: "completed" })],
        });
      });

      // A follow-up turn on the settled child overlays running again and settles back to completed.
      const followUp = await api.send({ threadId: started.threadId, message: "follow up" });
      await expect(
        api.list({ parentThreadId, limit: 25, sort: "created-desc" }),
      ).resolves.toMatchObject({
        threads: [expect.objectContaining({ threadId: started.threadId, status: "running" })],
      });
      await expect(api.start(startInput)).resolves.toMatchObject({
        threadId: started.threadId,
        status: "running",
      });

      childSession.appendText("follow up done");
      childSession.succeedTurn();
      await fixture.collector.waitFor((msg) => turnEvent(msg, "turn/completed", followUp.turnId));
      await vi.waitFor(async () => {
        await expect(
          api?.list({ parentThreadId, limit: 25, sort: "created-desc" }),
        ).resolves.toMatchObject({
          threads: [expect.objectContaining({ threadId: started.threadId, status: "completed" })],
        });
      });
    } finally {
      releaseReplacement.resolve(undefined);
      await stopFixture(fixture);
    }
  });

  it("surfaces interrupted immediately when stop-and-resend replacement fails to start", async () => {
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    fixture.adapter.supportsSteer = false;
    const parentThreadId = await startPiThread(fixture);
    if (!api) throw new Error("Missing Delegation API");
    try {
      const startInput = {
        harnessId: "pi" as const,
        task: "initial task",
        cwd: "/synthetic",
        parentThreadId,
        requestId: "req-pi-steer-fail",
      };
      const started = await api.start(startInput);
      const childSession = fixture.adapter.sessions[1];
      if (!childSession) throw new Error("Missing child Pi Session");
      childSession.completeCancellationOnRequest();

      const execute = childSession.execute.bind(childSession);
      childSession.execute = (async (command: HostCommand) => {
        if (command.type === "turn.start") {
          return {
            ok: false,
            error: { code: "nativeFailure", message: "replacement failed", retryable: false },
          };
        }
        if (command.type === "turn.cancel") return execute(command);
        throw new Error(`Unexpected command: ${command.type}`);
      }) as typeof childSession.execute;

      await expect(
        api.send({ threadId: started.threadId, message: "redirect", steer: true }),
      ).rejects.toThrow("replacement failed");

      await expect(
        api.list({ parentThreadId, limit: 25, sort: "created-desc" }),
      ).resolves.toMatchObject({
        threads: [expect.objectContaining({ threadId: started.threadId, status: "interrupted" })],
      });
      await expect(api.start(startInput)).resolves.toMatchObject({
        threadId: started.threadId,
        status: "interrupted",
      });
      await expect(api.read({ threadId: started.threadId, view: "result" })).resolves.toMatchObject(
        { status: "interrupted" },
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("does not mask a settled Pi child as running while a remote capability read is pending", async () => {
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    fixture.adapter.supportsSteer = false;
    const parentThreadId = await startPiThread(fixture);
    if (!api) throw new Error("Missing Delegation API");
    let resolveCapabilities: (() => void) | undefined;
    try {
      const startInput = {
        harnessId: "pi" as const,
        task: "initial task",
        cwd: "/synthetic",
        parentThreadId,
        requestId: "req-pi-cap-read",
      };
      const started = await api.start(startInput);
      const childSession = fixture.adapter.sessions[1];
      if (!childSession) throw new Error("Missing child Pi Session");

      const readCapabilities = Promise.withResolvers<typeof childSession.capabilities>();
      resolveCapabilities = () =>
        readCapabilities.resolve({ ...childSession.capabilities, steer: true });
      (childSession as HarnessSession).readCapabilities = () => readCapabilities.promise;

      const steering = api.send({ threadId: started.threadId, message: "redirect", steer: true });
      childSession.appendText("finished first");
      childSession.succeedTurn();
      await fixture.collector.waitFor((msg) => turnEvent(msg, "turn/completed", started.turnId));

      await vi.waitFor(async () => {
        await expect(
          api?.list({ parentThreadId, limit: 25, sort: "created-desc" }),
        ).resolves.toMatchObject({
          threads: [expect.objectContaining({ threadId: started.threadId, status: "completed" })],
        });
      });
      await expect(api.start(startInput)).resolves.toMatchObject({
        threadId: started.threadId,
        status: "completed",
      });

      resolveCapabilities();
      await expect(steering).rejects.toThrow("no longer active");
    } finally {
      resolveCapabilities?.();
      await stopFixture(fixture);
    }
  });

  it("overlays running in list, duplicate start, and read when another shared-scope client runs an official Turn", async () => {
    const connections: Array<{
      stdin: PassThrough;
      stdout: PassThrough;
      close(): void;
    }> = [];
    let peerCompleted = false;
    const closed = Promise.withResolvers<OfficialAppServerExit>();
    const backend: OwnedOfficialBackend = {
      closed: closed.promise,
      start: async () => undefined,
      connect: async (): Promise<OfficialAppServerConnection> => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const connClosed = Promise.withResolvers<OfficialAppServerExit>();
        const close = () => {
          stdin.end();
          stdout.end();
          stderr.end();
          connClosed.resolve({ code: 0, signal: null });
        };
        let buffer = "";
        stdin.setEncoding("utf8");
        stdin.on("data", (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const req = JSON.parse(line) as JsonObject;
            if (req.method === "initialize") {
              stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
            } else if (req.method === "turn/start") {
              stdout.write(
                `${JSON.stringify({
                  id: req.id,
                  result: { turn: { id: "peer-turn", status: "inProgress" } },
                })}\n`,
              );
            } else if (req.method === "thread/read") {
              const threadId = (req.params as JsonObject | undefined)?.threadId;
              stdout.write(
                `${JSON.stringify({
                  id: req.id,
                  result: {
                    thread:
                      threadId === "native-child"
                        ? {
                            id: "native-child",
                            cwd: "/synthetic",
                            status: { type: peerCompleted ? "idle" : "active" },
                            turns: [
                              {
                                id: "peer-turn",
                                status: peerCompleted ? "completed" : "inProgress",
                                items: [],
                              },
                            ],
                          }
                        : { id: threadId, cwd: "/synthetic" },
                  },
                })}\n`,
              );
            }
            newline = buffer.indexOf("\n");
          }
        });
        connections.push({ stdin, stdout, close });
        return { stdin, stdout, stderr, closed: connClosed.promise, close };
      },
      stop: async () => {
        for (const conn of connections) conn.close();
        closed.resolve({ code: 0, signal: null });
      },
    };
    const scope = new OfficialRuntimeScope({
      diagnosticOutput: new PassThrough(),
      permanentHome: "/synthetic/.codex",
      createBackend: () => backend,
    });
    const peer = scope.owner.attach(async () => undefined);
    await scope.start();

    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      officialRuntimeScope: scope,
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    if (!api) throw new Error("Missing Delegation API");
    try {
      await fixture.ready;
      const peerConn = connections[0];
      if (!peerConn) throw new Error("Expected peer official connection");

      const requestId = "req-shared-official";
      const startInput = {
        harnessId: "codex" as const,
        task: "shared native task",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId,
      };
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            task: startInput.task,
            cwd: startInput.cwd,
            model: null,
            thinkingOptionId: null,
          }),
        )
        .digest("hex");
      await vi.waitFor(() => fixture.mappingStore.listDelegations());
      await fixture.mappingStore.createDelegation({
        delegationId: hostThreadIdSchema.parse("deleg-shared-official"),
        parentHostThreadId: hostThreadIdSchema.parse("parent-thread"),
        childHostThreadId: hostThreadIdSchema.parse("native-child"),
        sourceHarnessId: harnessIdSchema.parse("codex"),
        targetHarnessId: harnessIdSchema.parse("codex"),
        status: "completed",
        requestId,
        taskDigest: digest,
      });

      // Peer client starts a follow-up Turn on native-child.
      await peer.request("turn/start", {
        threadId: "native-child",
        input: [{ type: "text", text: "peer turn" }],
      });

      // Host sees running in list, duplicate start, send guard, and read.
      await expect(
        api.list({ parentThreadId: "parent-thread", limit: 25, sort: "created-desc" }),
      ).resolves.toMatchObject({
        threads: [expect.objectContaining({ threadId: "native-child", status: "running" })],
      });
      await expect(api.start(startInput)).resolves.toMatchObject({
        threadId: "native-child",
        turnId: "peer-turn",
        status: "running",
      });
      await expect(
        api.send({ threadId: "native-child", message: "blocked while peer runs" }),
      ).rejects.toMatchObject({ code: "THREAD_BUSY" });
      await expect(api.read({ threadId: "native-child", view: "result" })).resolves.toMatchObject({
        status: "running",
      });

      // Peer's active Turn on another connection must not interfere with this Host's parent inference.
      await expect(
        api.start({ harnessId: "pi", task: "no local parent", cwd: "/synthetic" }),
      ).rejects.toMatchObject({ code: "PARENT_THREAD_AMBIGUOUS" });
      const localParent = await startPiThread(fixture);
      await startPiTurn(fixture, localParent);
      await expect(
        api.start({ harnessId: "pi", task: "infer local parent", cwd: "/synthetic" }),
      ).resolves.toMatchObject({ parentThreadId: localParent });

      // When the peer Turn finishes, list and duplicate start return to completed.
      peerCompleted = true;
      peerConn.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { threadId: "native-child", turn: { id: "peer-turn", status: "completed" } },
        })}\n`,
      );
      await vi.waitFor(async () => {
        await expect(
          api?.list({ parentThreadId: "parent-thread", limit: 25, sort: "created-desc" }),
        ).resolves.toMatchObject({
          threads: [expect.objectContaining({ threadId: "native-child", status: "completed" })],
        });
      });
      await expect(api.start(startInput)).resolves.toMatchObject({
        threadId: "native-child",
        turnId: "peer-turn",
        status: "completed",
      });
    } finally {
      peer.close();
      await stopFixture(fixture);
      await scope.close();
    }
  });

  it("self-heals orphaned official Turns in send and cancel and reconciles failed turn/interrupt against thread/read", async () => {
    const connections: Array<{
      stdin: PassThrough;
      stdout: PassThrough;
      close(): void;
    }> = [];
    const threadStates = new Map<
      string,
      { status: "idle" | "active"; turnId: string; turnStatus: "completed" | "inProgress" }
    >();
    let nextTurnSeq = 0;
    const interruptErrors = new Set<string>();
    const closed = Promise.withResolvers<OfficialAppServerExit>();
    const backend: OwnedOfficialBackend = {
      closed: closed.promise,
      start: async () => undefined,
      connect: async (): Promise<OfficialAppServerConnection> => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const connClosed = Promise.withResolvers<OfficialAppServerExit>();
        const close = () => {
          stdin.end();
          stdout.end();
          stderr.end();
          connClosed.resolve({ code: 0, signal: null });
        };
        let buffer = "";
        stdin.setEncoding("utf8");
        stdin.on("data", (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const req = JSON.parse(line) as JsonObject;
            const params = (req.params ?? {}) as JsonObject;
            const threadId = typeof params.threadId === "string" ? params.threadId : "unknown";
            if (req.method === "initialize") {
              stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
            } else if (req.method === "turn/start") {
              const turnId = `turn-${++nextTurnSeq}`;
              threadStates.set(threadId, { status: "active", turnId, turnStatus: "inProgress" });
              stdout.write(
                `${JSON.stringify({
                  id: req.id,
                  result: { turn: { id: turnId, status: "inProgress" } },
                })}\n`,
              );
            } else if (req.method === "thread/read" || req.method === "thread/resume") {
              const state = threadStates.get(threadId) ?? {
                status: "idle" as const,
                turnId: "turn-done",
                turnStatus: "completed" as const,
              };
              stdout.write(
                `${JSON.stringify({
                  id: req.id,
                  result: {
                    thread: {
                      id: threadId,
                      cwd: "/synthetic",
                      status: { type: state.status },
                      turns: [{ id: state.turnId, status: state.turnStatus, items: [] }],
                    },
                  },
                })}\n`,
              );
            } else if (req.method === "turn/interrupt") {
              if (interruptErrors.has(threadId)) {
                stdout.write(
                  `${JSON.stringify({
                    id: req.id,
                    error: { code: -32600, message: "no active turn to interrupt" },
                  })}\n`,
                );
              } else {
                stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
              }
            }
            newline = buffer.indexOf("\n");
          }
        });
        connections.push({ stdin, stdout, close });
        return { stdin, stdout, stderr, closed: connClosed.promise, close };
      },
      stop: async () => {
        for (const conn of connections) conn.close();
        closed.resolve({ code: 0, signal: null });
      },
    };
    const scope = new OfficialRuntimeScope({
      diagnosticOutput: new PassThrough(),
      permanentHome: "/synthetic/.codex",
      createBackend: () => backend,
    });
    const peerSend = scope.owner.attach(async () => undefined);
    const peerCancel = scope.owner.attach(async () => undefined);
    const peerLiveRace = scope.owner.attach(async () => undefined);
    await scope.start();

    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      officialRuntimeScope: scope,
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    if (!api) throw new Error("Missing Delegation API");
    try {
      await fixture.ready;
      await vi.waitFor(() => fixture.mappingStore.listDelegations());

      // 1. Disconnected peer leaves an orphaned Turn on an already-idle Thread: send() reconciles and starts a new Turn.
      await peerSend.request("turn/start", { threadId: "orphan-send", input: [] });
      peerSend.close();
      threadStates.set("orphan-send", {
        status: "idle",
        turnId: "turn-1",
        turnStatus: "completed",
      });
      expect(scope.owner.hasActiveTurn("orphan-send")).toBe(true);
      expect(scope.owner.hasLiveActiveTurn("orphan-send")).toBe(false);

      const sent = await api.send({ threadId: "orphan-send", message: "recover" });
      expect(sent).toMatchObject({
        threadId: "orphan-send",
        harnessId: "codex",
        status: "running",
      });
      expect(sent.turnId).not.toBe("turn-1");

      // 2. Disconnected peer leaves an orphaned Turn on an already-idle Thread: cancel() reconciles and returns cancelled: false.
      await peerCancel.request("turn/start", { threadId: "orphan-cancel", input: [] });
      peerCancel.close();
      threadStates.set("orphan-cancel", {
        status: "idle",
        turnId: "turn-3",
        turnStatus: "completed",
      });
      expect(scope.owner.hasActiveTurn("orphan-cancel")).toBe(true);

      await expect(api.cancel({ threadId: "orphan-cancel" })).resolves.toEqual({
        threadId: "orphan-cancel",
        turnId: null,
        harnessId: "codex",
        cancelled: false,
      });
      expect(scope.owner.hasActiveTurn("orphan-cancel")).toBe(false);

      // 3. Live peer's Turn finishes right before turn/interrupt: error falls back to thread/read and returns cancelled: false.
      await peerLiveRace.request("turn/start", { threadId: "race-cancel", input: [] });
      interruptErrors.add("race-cancel");
      threadStates.set("race-cancel", {
        status: "idle",
        turnId: "turn-4",
        turnStatus: "completed",
      });
      await expect(api.cancel({ threadId: "race-cancel" })).resolves.toEqual({
        threadId: "race-cancel",
        turnId: null,
        harnessId: "codex",
        cancelled: false,
      });
      expect(scope.owner.hasActiveTurn("race-cancel")).toBe(false);

      // 4. Genuine turn/interrupt failure while the Thread is still active still throws DELEGATION_FAILED.
      await peerLiveRace.request("turn/start", { threadId: "real-cancel-fail", input: [] });
      interruptErrors.add("real-cancel-fail");
      await expect(api.cancel({ threadId: "real-cancel-fail" })).rejects.toMatchObject({
        code: "DELEGATION_FAILED",
      });
    } finally {
      peerSend.close();
      peerCancel.close();
      peerLiveRace.close();
      await stopFixture(fixture);
      await scope.close();
    }
  });

  it("does not stick an official delegation at running when turn/completed precedes the turn/start response", async () => {
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (value) => {
        api = value;
        return undefined;
      },
    });
    await bindOfficialThread(fixture, "parent-thread");
    if (!api) throw new Error("Missing Delegation API");
    let buffer = "";
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const req = JSON.parse(line) as JsonObject;
        if (req.method === "thread/read") {
          const threadId = (req.params as JsonObject | undefined)?.threadId;
          fixture.official.stdout.write(
            `${JSON.stringify({ id: req.id, result: { thread: { id: threadId, cwd: "/synthetic" } } })}\n`,
          );
        } else if (req.method === "model/list") {
          fixture.official.stdout.write(
            `${JSON.stringify({ id: req.id, result: { data: [] } })}\n`,
          );
        } else if (req.method === "thread/start") {
          fixture.official.stdout.write(
            `${JSON.stringify({
              id: req.id,
              result: { thread: { id: "fast-child", cwd: "/synthetic" } },
            })}\n`,
          );
        } else if (req.method === "thread/name/set") {
          fixture.official.stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
        } else if (req.method === "turn/start") {
          // Emit turn/completed BEFORE responding to turn/start.
          fixture.official.stdout.write(
            `${JSON.stringify({
              method: "turn/completed",
              params: { threadId: "fast-child", turn: { id: "fast-turn", status: "completed" } },
            })}\n`,
          );
          fixture.official.stdout.write(
            `${JSON.stringify({
              id: req.id,
              result: { turn: { id: "fast-turn", status: "inProgress" } },
            })}\n`,
          );
        }
        newline = buffer.indexOf("\n");
      }
    });
    try {
      const startInput = {
        harnessId: "codex" as const,
        task: "fast native task",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId: "req-fast-official",
      };
      await expect(api.start(startInput)).resolves.toMatchObject({
        threadId: "fast-child",
        turnId: "fast-turn",
        status: "completed",
      });
      await expect(
        api.list({ parentThreadId: "parent-thread", limit: 25, sort: "created-desc" }),
      ).resolves.toMatchObject({
        threads: [expect.objectContaining({ threadId: "fast-child", status: "completed" })],
      });
      await expect(api.start(startInput)).resolves.toMatchObject({
        threadId: "fast-child",
        status: "completed",
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
