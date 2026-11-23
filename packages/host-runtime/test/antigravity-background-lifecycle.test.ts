import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AntigravityAdapter,
  AntigravityAcpTransport,
  type AntigravityAcpTransportOptions,
} from "@codexhost/adapter-antigravity";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { CodexTurnProjector, type ProjectableHostEvent } from "@codexhost/protocol-core";
import {
  THREAD_QUESTION_RESPOND_METHOD,
  THREAD_QUESTIONS_LIST_METHOD,
  hostItemIdSchema,
  hostTurnIdSchema,
  threadQuestionsResultSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  method,
  requestId,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

// The real Adapter talks to a temporary fake ACP stdio child process. Its output
// is then replayed into the real CodexTurnProjector and the real AppServerHost,
// so the event order is the one the Adapter actually emits rather than a
// hand-written sequence. agy, a real model and Desktop are not involved.
const sessionId = "00000000-0000-4000-8000-000000000001";
const resources: Array<{ adapter: AntigravityAdapter; root: string }> = [];

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fakeAcp(root: string): Promise<string> {
  const cli = path.join(root, "fake-agy");
  await writeFile(
    cli,
    `#!${process.execPath}
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
const result = (id, value) => send({id, result:value});
const sessionId = '${sessionId}';
const update = (value) => send({method:'session/update',params:{sessionId,update:value}});
const question = () => send({id:'question',method:'elicitation/create',params:{sessionId,toolCallId:'ask',mode:'form',message:'Platforms?',requestedSchema:{type:'object',properties:{platform:{type:'array',items:{enum:['mac','win']},title:'Platforms?'}},required:['platform']}}});
const replies = {};
let late = () => {};
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (!request.method) {
    replies[request.id] = request.result;
    if (request.id === 'question' && request.result.action === 'accept')
      setTimeout(() => update({sessionUpdate:'tool_call_update',toolCallId:'ask',status:'completed',rawOutput:'answered'}), 5);
    return;
  }
  if (request.method === 'initialize') return result(request.id, {protocolVersion:1,agentCapabilities:{}});
  if (request.method === 'session/new') return result(request.id, {sessionId,configOptions:[]});
  if (request.method === 'session/close') return result(request.id, {});
  if (request.method === 'session/cancel') return result(request.id, {stopReason:'cancelled'});
  if (request.method === 'session/set_config_option') {
    if (request.params.value === 'late') late();
    return result(request.id, {configOptions:[{id:'probe',name:'Probe',currentValue:JSON.stringify(replies),options:[]}]});
  }
  if (request.method !== 'session/prompt') return result(request.id, {});
  const text = request.params.prompt[0].text;
  if (text === 'late-diff') {
    update({sessionUpdate:'tool_call',toolCallId:'edit',name:'run_command',kind:'execute',rawInput:{command:'apply edits'},status:'in_progress'});
    late = () => [
      {sessionUpdate:'tool_call_update',toolCallId:'edit',status:'in_progress',content:[{type:'diff',path:'a.ts',oldText:'before',newText:'after'}]},
      {sessionUpdate:'tool_call_update',toolCallId:'edit',status:'in_progress',content:[{type:'diff',path:'b.ts',oldText:null,newText:'added'}]},
      {sessionUpdate:'tool_call_update',toolCallId:'edit',status:'completed',rawOutput:'edited'},
    ].forEach((value, index) => setTimeout(() => update(value), index * 30));
    return result(request.id, {stopReason:'end_turn'});
  }
  if (text === 'ask' || text === 'ask-early' || text === 'next') {
    late = question;
    if (text === 'ask' || text === 'ask-early') {
      update({sessionUpdate:'tool_call',toolCallId:'ask',name:'ask_question',kind:'other',rawInput:{questions:[{question:'Platforms?'}]},status:'in_progress'});
      if (text === 'ask-early') question();
      return result(request.id, {stopReason:'end_turn'});
    }
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'next turn'}});
    return setTimeout(() => result(request.id, {stopReason:'end_turn'}), 150);
  }
});
`,
  );
  if (process.platform === "win32") {
    const shim = `${cli}.cmd`;
    const escape = (value: string) => value.replaceAll("%", "%%");
    await writeFile(shim, `@"${escape(process.execPath)}" "${escape(cli)}" %*\r\n`);
    return shim;
  }
  await chmod(cli, 0o700);
  return cli;
}

interface Opened {
  adapter: AntigravityAdapter;
  session: HarnessSession;
  outputs: HarnessOutput[];
  root: string;
  /** The Adapter creates its transport lazily, on first use. */
  readonly transport: AntigravityAcpTransport;
}

async function openReal(): Promise<Opened> {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-projection-"));
  const command = await fakeAcp(root);
  let transport: AntigravityAcpTransport | undefined;
  const adapter = new AntigravityAdapter({
    createTransport: (options: AntigravityAcpTransportOptions): AntigravityAcpTransport =>
      (transport = new AntigravityAcpTransport({ ...options, command, closeTimeoutMs: 100 })),
  });
  const opened = await adapter.open({
    kind: "create",
    cwd: root,
    environment: { HOME: root },
  });
  assert(opened.ok);
  const outputs: HarnessOutput[] = [];
  void (async () => {
    for await (const output of opened.value.outputs) outputs.push(output);
  })();
  resources.push({ adapter, root });
  return {
    adapter,
    session: opened.value,
    outputs,
    root,
    get transport() {
      assert(transport, "Expected initialized fake ACP transport");
      return transport;
    },
  };
}

/** Replays real Adapter output into real Turn projectors, like the Host does. */
function replay(outputs: HarnessOutput[], root: string) {
  const projectors = new Map<string, CodexTurnProjector>();
  const timeline: Array<{ turnId: string; type: string; open: boolean; wire: string[] }> = [];
  const faults: string[] = [];
  const messages: JsonObject[] = [];
  let error: unknown;
  for (const output of outputs) {
    try {
      if (output.kind === "interaction") {
        if (output.interaction.type !== "question") throw new Error("Unexpected Approval");
        const projector = projectors.get(output.interaction.turnId);
        if (!projector) throw new Error("Interaction references an unknown Turn");
        messages.push(
          ...projector.projectQuestion(output.interaction, hostItemIdSchema.parse(randomUUID()))
            .messages,
        );
        timeline.push(record(output.interaction.turnId, "interaction", projector));
        continue;
      }
      const { event } = output;
      // Session-level events (state, usage) are handled outside Turn projection.
      if (!("turnId" in event)) {
        if (event.type === "session.faulted") faults.push(event.type);
        continue;
      }
      if (event.type === "turn.started")
        projectors.set(
          event.turnId,
          new CodexTurnProjector({
            threadId: "thread",
            turnId: hostTurnIdSchema.parse(event.turnId),
            cwd: root,
            startedAtMs: Date.now(),
          }),
        );
      if (!projectable.has(event.type)) continue;
      const projector = projectors.get(event.turnId);
      if (!projector) throw new Error("Event references an unknown Turn");
      messages.push(...projector.project(event as ProjectableHostEvent).messages);
      timeline.push(record(event.turnId, event.type, projector));
    } catch (caught) {
      error ??= caught;
    }
  }
  return { projectors, timeline, faults, messages, error };
}

function record(turnId: string, type: string, projector: CodexTurnProjector) {
  return {
    turnId,
    type,
    open: projector.hasOpenDetachedItems,
    wire: [...projector.openDetachedWireItems().keys()],
  };
}

/** Turn-scoped events the Host's Turn projector consumes. */
const projectable = new Set<string>([
  "turn.started",
  "item.started",
  "item.updated",
  "item.completed",
  "item.detached",
  "item.background.started",
  "interaction.closed",
  "turn.completed",
]);

function events(outputs: HarnessOutput[]) {
  return outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
}

async function start(session: HarnessSession, text: string) {
  const turnId = hostTurnIdSchema.parse(randomUUID());
  expect(
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] }),
  ).toMatchObject({ ok: true });
  return turnId;
}

async function startAndWait(session: HarnessSession, outputs: HarnessOutput[], text: string) {
  const turnId = await start(session, text);
  await waitFor(
    () =>
      events(outputs).some((event) => event.type === "turn.completed" && event.turnId === turnId),
    `${text} completed`,
  );
  return turnId;
}

async function answered(transport: AntigravityAcpTransport) {
  const config = await transport.setConfigOption("probe", "read");
  return JSON.parse(config[0]?.currentValue ?? "{}") as {
    question?: { action?: string; content?: Record<string, string[]> };
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (resources.length) {
    const resource = resources.pop();
    if (!resource) continue;
    await resource.adapter.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});

describe("real Adapter output through the real Turn projector", () => {
  it("accepts a first diff that arrives after its Turn completed", async () => {
    const fixture = await openReal();
    const { session, outputs, root } = fixture;
    const turnId = await startAndWait(session, outputs, "late-diff");
    await fixture.transport.setConfigOption("probe", "late");
    await waitFor(
      () =>
        events(outputs).filter(
          (event) => event.type === "item.completed" && event.turnId === turnId,
        ).length === 2,
      "command and file summary completed",
    );

    const { projectors, timeline, faults, error } = replay(outputs, root);
    expect(error).toBeUndefined();
    expect(faults).toEqual([]);
    const types = timeline.map(({ type }) => type);
    expect(types.slice(0, 4)).toEqual([
      "turn.started",
      "item.started",
      "item.detached",
      "turn.completed",
    ]);
    // #1006 registers the late file summary itself: no second detach follows.
    expect(types.filter((type) => type === "item.detached")).toHaveLength(1);
    expect(timeline.find(({ type }) => type === "turn.completed")?.open).toBe(true);
    const summaries = timeline.filter(
      ({ type, wire }) => type === "item.started" && wire.length === 2,
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.wire.some((itemId) => itemId.endsWith("-diff"))).toBe(true);
    expect(timeline.at(-1)).toMatchObject({ type: "item.completed", open: false, wire: [] });

    const projector = projectors.get(turnId);
    assert(projector);
    const items = (projector.snapshotTurn() as { items: Array<Record<string, unknown>> }).items;
    const summary = items.find((item) => item.type === "fileChange");
    const changes = (summary?.changes ?? []) as Array<Record<string, unknown>>;
    expect(changes.map((change) => [change.path, change.kind])).toMatchObject([
      ["a.ts", { type: "update" }],
      ["b.ts", { type: "add" }],
    ]);
    expect(items.filter((item) => item.type === "fileChange")).toHaveLength(1);
    expect(session.hasBackgroundWork?.()).toBe(false);
  });

  it("keeps a detached ask_question answerable after its Turn completed", async () => {
    const fixture = await openReal();
    const { session, outputs, root } = fixture;
    const turnId = await startAndWait(session, outputs, "ask");
    await fixture.transport.setConfigOption("probe", "late");
    await waitFor(() => outputs.some((output) => output.kind === "interaction"), "late question");
    expect(events(outputs).some((event) => event.type === "turn.completed")).toBe(true);
    const output = outputs.find((entry) => entry.kind === "interaction");
    assert(output?.kind === "interaction" && output.interaction.type === "question");
    expect(output.interaction).toMatchObject({ turnId, questions: [{ multiple: true }] });
    assert(output.interaction.itemId);

    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: output.interaction.interactionId,
        response: { type: "question", answers: { platform: ["mac"] } },
      }),
    ).toMatchObject({ ok: true });
    await waitFor(() => session.hasBackgroundWork?.() === false, "ask owner released");

    const { timeline, faults, error } = replay(outputs, root);
    expect(error).toBeUndefined();
    expect(faults).toEqual([]);
    expect(timeline.map(({ type }) => type)).toEqual([
      "turn.started",
      "item.started",
      "item.detached",
      "turn.completed",
      "interaction",
      "interaction.closed",
      "item.updated",
      "item.completed",
    ]);
    expect(timeline.at(-1)).toMatchObject({ open: false, wire: [] });
    expect(events(outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId,
        snapshot: expect.objectContaining({
          item: expect.objectContaining({ type: "toolExecution", toolName: "ask_question" }),
          outcome: { status: "succeeded" },
        }),
      }),
    );
    expect(await answered(fixture.transport)).toMatchObject({
      question: { action: "accept", content: { platform: ["mac"] } },
    });
  });
});

describe("real Adapter inside the real Host", () => {
  it("keeps the previous Turn's question across completion and a successor Turn", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "antigravity-host-"));
    const command = await fakeAcp(workspace);
    let transport: AntigravityAcpTransport | undefined;
    const real = new AntigravityAdapter({
      createTransport: (options) =>
        (transport = new AntigravityAcpTransport({ ...options, command, closeTimeoutMs: 100 })),
    });
    resources.push({ adapter: real, root: workspace });
    const fixture = createFixture({
      additionalAdapters: new Map([[real.harnessId, real]]),
    });
    try {
      await fixture.ready;
      let nextId = 100;
      const request = async (method: string, params: JsonObject) => {
        const id = nextId++;
        writeRequest(fixture.desktopInput, { id, method, params });
        const response = await fixture.collector.waitFor((message) => requestId(message, id));
        expect(response, JSON.stringify(response)).not.toHaveProperty("error");
        return response.result as JsonObject;
      };
      const { thread } = (await request("thread/start", {
        model: "codexhost/antigravity-native",
        cwd: workspace,
      })) as { thread: { id: string } };
      const turnId = async (text: string) =>
        (
          (await request("turn/start", {
            threadId: thread.id,
            input: [{ type: "text", text }],
          })) as { turn: { id: string } }
        ).turn.id;
      const list = async () =>
        threadQuestionsResultSchema.parse(
          await request(THREAD_QUESTIONS_LIST_METHOD, { threadId: thread.id }),
        ).questions;
      const completed = (offset: number, id: string) =>
        fixture.collector.messages
          .slice(offset)
          .find((message) => turnEvent(message, "turn/completed", id));
      const itemEvents = (name: string, turn: string) =>
        fixture.collector.messages.filter(
          (message) => method(message, name) && turnEvent(message, name, turn),
        );
      const itemOf = (message: { params?: unknown }) =>
        (message.params as JsonObject | undefined)?.item as JsonObject | undefined;

      const first = await turnId("ask-early");
      const firstOffset = fixture.collector.messages.length;
      await waitFor(() => completed(firstOffset, first) !== undefined, "first Turn completed");
      expect(completed(firstOffset, first)).toMatchObject({
        params: { turn: { status: "completed" } },
      });
      // Asked before the prompt returned: completing the Turn keeps the card of
      // the still open owner, and the idle Thread still lists it.
      await vi.waitFor(async () => expect(await list()).toHaveLength(1));
      expect((await list())[0]).toMatchObject({
        turnId: first,
        questions: [{ type: "choice", multiple: true }],
      });

      const secondOffset = fixture.collector.messages.length;
      const second = await turnId("next");
      await waitFor(() => completed(secondOffset, second) !== undefined, "second Turn completed");
      expect(completed(secondOffset, second)).toMatchObject({
        params: { turn: { status: "completed" } },
      });
      const [question] = await list();
      expect(question).toMatchObject({
        turnId: first,
        questions: [{ type: "choice", multiple: true }],
      });
      assert(question);

      expect(
        await request(THREAD_QUESTION_RESPOND_METHOD, {
          threadId: thread.id,
          turnId: first,
          interactionId: question.interactionId,
          answers: { platform: ["mac"] },
        }),
      ).toMatchObject({ accepted: true });
      await vi.waitFor(async () => expect(await list()).toEqual([]));
      // The Desktop wire shows the settled owner tool of the already ended Turn.
      const tool = itemEvents("item/started", first).find(
        (message) =>
          itemOf(message)?.type === "dynamicToolCall" && itemOf(message)?.tool === "ask_question",
      );
      assert(tool);
      const itemId = itemOf(tool)?.id;
      await vi.waitFor(() =>
        expect(
          itemEvents("item/completed", first)
            .filter((message) => itemOf(message)?.id === itemId)
            .map((message) => itemOf(message)?.status),
        ).toEqual(["completed"]),
      );
      expect(
        fixture.collector.messages
          .filter((message) => message.method === "turn/completed")
          .map((message) => (message.params as JsonObject).turn),
      ).toMatchObject([{ status: "completed" }, { status: "completed" }]);
      expect(fixture.diagnosticOutput.read()?.toString() ?? "").not.toMatch(
        /projection|terminal event|pending Interactions/,
      );
      assert(transport, "Expected initialized fake ACP transport");
      const config = await transport.setConfigOption("probe", "read");
      expect(JSON.parse(config[0]?.currentValue ?? "{}")).toMatchObject({
        question: { action: "accept", content: { platform: ["mac"] } },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
