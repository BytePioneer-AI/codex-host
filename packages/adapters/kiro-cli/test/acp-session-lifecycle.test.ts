import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessOutput,
  HarnessSession,
  HostCommand,
  InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import type * as KiroCommand from "../src/command.js";
import { KiroAdapter } from "../src/kiro-adapter.js";

interface RpcMessage {
  id: string | number;
  method?: string;
  params?: { configId?: string; value?: string };
  result?: unknown;
}

// Only process I/O and executable discovery are mocked. Requests pass through the
// real ACP SDK, KiroAcpTransport and KiroSession in both directions.
vi.mock("../src/command.js", async (original) => ({
  ...(await original<typeof KiroCommand>()),
  resolveKiroExecutable: () => process.execPath,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: () => peer.start(),
}));

class NativePeer {
  readonly child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
  });
  readonly config = { model: "adjustable", effortLevel: "low", autopilot: "off" };
  readonly responses = new Map<string | number, unknown>();
  configWrite: "confirm" | "delay" | "reject" = "confirm";
  replyToConfigWrite: (() => void) | undefined;
  promptCount = 0;
  promptId: string | number | undefined;

  configOptions() {
    return [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: this.config.model,
        options: [
          { value: "adjustable", name: "Adjustable" },
          { value: "other", name: "Other" },
        ],
      },
      {
        type: "select",
        id: "effortLevel",
        name: "Effort",
        currentValue: this.config.effortLevel,
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
      {
        type: "select",
        id: "autopilot",
        name: "Autopilot",
        currentValue: this.config.autopilot,
        options: [
          { value: "off", name: "Off" },
          { value: "on", name: "On" },
        ],
      },
    ];
  }

  send(message: Record<string, unknown>): void {
    if (this.child.exitCode === null)
      this.child.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  start() {
    let buffered = "";
    this.child.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (;;) {
        const index = buffered.indexOf("\n");
        if (index < 0) break;
        const message = JSON.parse(buffered.slice(0, index)) as RpcMessage;
        buffered = buffered.slice(index + 1);
        this.receive(message);
      }
    });
    this.child.stdin.once("finish", () => this.exit(0));
    queueMicrotask(() => this.child.emit("spawn"));
    return this.child;
  }

  receive(message: RpcMessage): void {
    const { id, method, params } = message;
    if (!method) {
      this.responses.set(id, message.result);
      return;
    }
    if (method === "initialize") this.send({ id, result: { protocolVersion: 1 } });
    else if (method === "session/new")
      this.send({ id, result: { sessionId: "native", configOptions: this.configOptions() } });
    else if (method === "session/set_config_option") {
      if (this.configWrite === "reject") {
        this.send({ id, error: { code: -32602, message: "Configuration rejected" } });
        return;
      }
      const key = params?.configId;
      if ((key === "model" || key === "effortLevel" || key === "autopilot") && params?.value)
        this.config[key] = params.value;
      const reply = () => this.send({ id, result: { configOptions: this.configOptions() } });
      if (this.configWrite === "delay") this.replyToConfigWrite = reply;
      else reply();
    } else if (method === "session/prompt") {
      this.promptId = id;
      this.promptCount++;
    } else if (method === "session/cancel") this.complete("cancelled");
    else this.send({ id, result: {} });
  }

  requestInteractions(): void {
    this.send({
      id: "approval",
      method: "session/request_permission",
      params: {
        sessionId: "native",
        toolCall: { toolCallId: "tool", title: "Tool approval" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    this.send({
      id: "question",
      method: "_kiro/userInput",
      params: { sessionId: "native", question: "Which approach?" },
    });
    this.send({
      id: "requirements",
      method: "session/request_permission",
      params: {
        sessionId: "native",
        toolCall: { toolCallId: "requirements", title: "Requirements" },
        options: [{ optionId: "proceed", name: "Proceed", kind: "allow_once" }],
        _meta: { kiro: { kind: "analyze-requirements" } },
      },
    });
  }

  complete(stopReason = "end_turn"): void {
    if (this.promptId === undefined) throw new Error("No native prompt is pending");
    this.send({ id: this.promptId, result: { stopReason } });
    this.promptId = undefined;
  }

  exit(code: number): void {
    if (this.child.exitCode !== null) return;
    this.child.exitCode = code;
    this.child.stdout.end();
    this.child.stderr.end();
    this.child.emit("exit", code, null);
  }
}

let peer: NativePeer;
let adapter: KiroAdapter;
let session: HarnessSession;
let outputs: HarnessOutput[];
let consume: Promise<void>;
const turnId = hostTurnIdSchema.parse("acp-lifecycle");

beforeEach(async () => {
  peer = new NativePeer();
  adapter = new KiroAdapter({ commandTimeoutMs: 200 }, { locateSession: async () => null });
  const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
  if (!opened.ok) throw new Error(opened.error.message);
  session = opened.value;
  outputs = [];
  consume = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
});
afterEach(async () => {
  await adapter.close();
  await consume;
});

function events(type: string) {
  return outputs.filter((output) => output.kind === "event" && output.event.type === type);
}
function interactions() {
  return outputs.flatMap((output) => (output.kind === "interaction" ? [output.interaction] : []));
}
async function startTurn(id = turnId): Promise<void> {
  await expect(
    session.execute({ type: "turn.start", turnId: id, input: [{ type: "text", text: "test" }] }),
  ).resolves.toMatchObject({ ok: true });
  await vi.waitFor(() => expect(peer.promptId).toBeDefined());
}
function verifyProjection(): void {
  const projector = new CodexTurnProjector({
    threadId: "thread",
    turnId,
    cwd: process.cwd(),
    startedAtMs: 0,
  });
  for (const output of outputs) {
    if (output.kind === "interaction") {
      if (output.interaction.type === "approval")
        projector.projectApproval(output.interaction, "Kiro CLI");
      else
        projector.projectQuestion(
          output.interaction,
          hostItemIdSchema.parse(`question-${output.interaction.interactionId}`),
        );
    } else if ("turnId" in output.event && output.event.type !== "turn.autonomous.started") {
      projector.project(output.event);
    }
  }
}

const configCommands = [
  { type: "model.select", model: harnessModelRefSchema.parse({ id: "other" }) },
  { type: "thinking.select", thinkingOptionId: harnessThinkingOptionIdSchema.parse("high") },
  {
    type: "permissionMode.select",
    permissionModeId: harnessPermissionModeIdSchema.parse("autopilot"),
  },
] as const satisfies readonly HostCommand[];

function selectConfig(command: (typeof configCommands)[number]) {
  if (command.type === "model.select") return session.execute(command);
  if (command.type === "thinking.select") return session.execute(command);
  return session.execute(command);
}

describe("Kiro ACP configuration timeouts", () => {
  it.each(configCommands)(
    "faults and blocks sends after an unconfirmed $type write",
    async (command) => {
      peer.configWrite = "delay";
      expect(await selectConfig(command)).toMatchObject({ ok: false });
      await vi.waitFor(() => expect(events("session.faulted")).toHaveLength(1));
      expect(peer.child.exitCode).toBe(0);
      expect(peer.replyToConfigWrite).toBeDefined();
      expect(peer.config).toMatchObject(
        command.type === "model.select"
          ? { model: "other" }
          : command.type === "thinking.select"
            ? { effortLevel: "high" }
            : { autopilot: "on" },
      );
      peer.replyToConfigWrite?.();
      expect(events("session.state.changed")).toHaveLength(0);
      await expect(
        session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "after timeout" }],
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
      await expect(
        session.commands?.execute({ commandId: "kiro.compact", turnId }),
      ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
      expect(peer.promptCount).toBe(0);
    },
  );

  it.each(configCommands)(
    "keeps the Session usable after an explicit $type rejection",
    async (command) => {
      peer.configWrite = "reject";
      expect(await selectConfig(command)).toMatchObject({ ok: false });
      expect(events("session.faulted")).toHaveLength(0);
      await startTurn();
      peer.complete();
      await vi.waitFor(() => expect(events("turn.completed")).toHaveLength(1));
    },
  );
});

describe("Kiro concurrent ACP interactions", () => {
  it("routes out-of-order answers and rejects duplicate or mismatched responses", async () => {
    await startTurn();
    peer.requestInteractions();
    await vi.waitFor(() => expect(interactions()).toHaveLength(3));
    const approval = interactions().find((interaction) => interaction.type === "approval");
    const question = interactions().find((interaction) => interaction.title === "Question");
    const requirements = interactions().find((interaction) => interaction.title === "Requirements");
    if (!approval || !question || !requirements) throw new Error("Missing interactions");
    const answer: InteractionRespondCommand = {
      type: "interaction.respond",
      interactionId: question.interactionId,
      response: { type: "question", answers: { "q-0": ["Use the native API"] } },
    };
    await expect(session.execute(answer)).resolves.toMatchObject({ ok: true });
    await expect(session.execute(answer)).resolves.toMatchObject({ ok: false });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: approval.interactionId,
        response: { type: "question", answers: {} },
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: approval.interactionId,
        response: { type: "approval", actionId: "allow" },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: requirements.interactionId,
        response: { type: "question", answers: { "q-0": ["proceed"] } },
      }),
    ).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(peer.responses.size).toBe(3));
    expect(peer.responses.get("approval")).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(peer.responses.get("question")).toEqual({
      action: "answered",
      answer: "Use the native API",
    });
    expect(peer.responses.get("requirements")).toEqual({
      outcome: { outcome: "selected", optionId: "proceed" },
    });
    peer.complete();
    await vi.waitFor(() => expect(events("turn.completed")).toHaveLength(1));
    expect(events("interaction.closed")).toHaveLength(3);
    verifyProjection();
  });

  it.each(["cancel", "close", "fault", "complete"] as const)(
    "closes every pending interaction on %s",
    async (ending) => {
      await startTurn();
      peer.requestInteractions();
      await vi.waitFor(() => expect(interactions()).toHaveLength(3));
      if (ending === "cancel") await session.execute({ type: "turn.cancel", turnId });
      else if (ending === "close") await session.close();
      else if (ending === "fault") peer.exit(1);
      else peer.complete();
      await vi.waitFor(() => expect(events("turn.completed")).toHaveLength(1));
      const closed = events("interaction.closed");
      expect(closed).toHaveLength(3);
      expect(closed).toEqual(
        interactions().map((interaction) => ({
          kind: "event",
          event: {
            type: "interaction.closed",
            interactionId: interaction.interactionId,
            turnId,
            reason: "cancelled",
          },
        })),
      );
      verifyProjection();
      if (ending === "cancel" || ending === "complete") {
        await vi.waitFor(() => expect(peer.responses.size).toBe(3));
        expect(peer.responses.get("approval")).toEqual({ outcome: { outcome: "cancelled" } });
        expect(peer.responses.get("question")).toEqual({ action: "dismissed" });
        expect(peer.responses.get("requirements")).toEqual({ outcome: { outcome: "cancelled" } });
        await startTurn(hostTurnIdSchema.parse("replacement"));
        const previous = interactions()[0];
        if (!previous) throw new Error("Missing previous interaction");
        await expect(
          session.execute({
            type: "interaction.respond",
            interactionId: previous.interactionId,
            response: { type: "approval", actionId: "allow" },
          }),
        ).resolves.toMatchObject({ ok: false });
        peer.complete();
        await vi.waitFor(() => expect(events("turn.completed")).toHaveLength(2));
      }
    },
  );
});
