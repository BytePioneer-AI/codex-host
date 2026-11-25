import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import { AntigravityAcpTransport } from "../src/acp-transport.js";
import type { AntigravityAcpTransportLike } from "../src/acp-types.js";

// These tests spawn only a temporary fake ACP stdio child process. They do not
// invoke agy, a real model, a real Desktop, or any opt-in live integration.
const resources: Array<{ adapter: AntigravityAdapter; root: string }> = [];

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function events(outputs: HarnessOutput[]) {
  return outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
}

async function fakeAcp(root: string): Promise<string> {
  const cli = path.join(root, "fake-agy");
  await writeFile(
    cli,
    `#!${process.execPath}
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
const result = (id, value) => send({id, result:value});
const sessionId = '00000000-0000-4000-8000-000000000001';
const update = (value) => send({method:'session/update',params:{sessionId,update:value}});
const replies = {};
const permission = (name='run_command', kind='execute') => send({id:'permission',method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'old',name,kind},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});
const question = () => send({id:'question',method:'elicitation/create',params:{sessionId,toolCallId:'old',mode:'form',message:'Continue?',requestedSchema:{type:'object',properties:{answer:{type:'string'}}}}});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (!request.method) {
    replies[request.id] = request.result;
    if (request.id === 'permission' || request.id === 'question')
      setTimeout(() => update({sessionUpdate:'tool_call_update',toolCallId:'old',status:'completed',rawOutput:'done'}), 5);
    return;
  }
  if (request.method === 'initialize') return result(request.id, {protocolVersion:1,agentCapabilities:{}});
  if (request.method === 'session/new') return result(request.id, {sessionId,configOptions:[]});
  if (request.method === 'session/close') return result(request.id, {});
  if (request.method === 'session/set_config_option') {
    if (request.params.value === 'exit') return process.exit(12);
    if (request.params.value === 'late-question') question();
    return result(request.id, {configOptions:[{id:'probe',name:'Probe',currentValue:JSON.stringify(replies),options:[]}]});
  }
  if (request.method === 'session/prompt') {
    const text = request.params.prompt[0].text;
    if (text === 'terminal-tail') {
      update({sessionUpdate:'tool_call',toolCallId:'old',name:'run_command',kind:'execute',rawInput:{command:'pwd'},status:'in_progress'});
      return process.stdout.write([
        {id:request.id,result:{stopReason:'end_turn'}},
        {method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'old',status:'completed',rawOutput:'finished'}}},
      ].map(value => JSON.stringify({jsonrpc:'2.0',...value})+'\\n').join(''));
    }
    if (['first','pending','pending-edit','ask'].includes(text)) {
      update({sessionUpdate:'tool_call',toolCallId:'old',name:text === 'ask' ? 'ask_question' : text === 'pending-edit' ? 'edit_file' : 'run_command',kind:text === 'ask' || text === 'pending-edit' ? 'other' : 'execute',rawInput:{command:'sleep 10'},status:'in_progress'});
      if (text === 'pending') permission();
      if (text === 'pending-edit') permission('edit_file', 'other');
      return setTimeout(() => result(request.id, {stopReason:'end_turn'}), 30);
    }
    if (text === 'second') {
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'before-old-update'}});
      update({sessionUpdate:'tool_call',toolCallId:'old',name:'run_command',kind:'execute',status:'in_progress'});
      question();
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'after-old-update'}});
      return setTimeout(() => result(request.id, {stopReason:'end_turn'}), 150);
    }
  }
  if (request.method === 'session/cancel') return result(request.id, {stopReason:'cancelled'});
});
`,
  );
  if (process.platform === "win32") {
    const shim = `${cli}.cmd`;
    // Escape % so cmd.exe does not expand variable references hidden in the
    // executable or temporary paths; %* stays unescaped to forward arguments.
    const escape = (value: string) => value.replaceAll("%", "%%");
    await writeFile(shim, `@"${escape(process.execPath)}" "${escape(cli)}" %*\r\n`);
    return shim;
  }
  await chmod(cli, 0o700);
  return cli;
}

async function openReal() {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-background-"));
  const command = await fakeAcp(root);
  let transport: AntigravityAcpTransport | undefined;
  const adapter = new AntigravityAdapter({
    createTransport: (options): AntigravityAcpTransportLike =>
      (transport = new AntigravityAcpTransport({
        ...options,
        command,
        closeTimeoutMs: 100,
      })),
  });
  const opened = await adapter.open({ kind: "create", cwd: root, environment: { HOME: root } });
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
    get transport() {
      assert(transport, "Expected initialized fake ACP transport");
      return transport;
    },
  };
}

async function startAndWait(
  session: HarnessSession,
  outputs: HarnessOutput[],
  turnId: string,
  text: string,
) {
  expect(
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(turnId),
      input: [{ type: "text", text }],
    }),
  ).toMatchObject({ ok: true });
  await waitFor(
    () =>
      events(outputs).some((event) => event.type === "turn.completed" && event.turnId === turnId),
    `${turnId} completed`,
  );
}

async function wireReplies(
  transport: AntigravityAcpTransport,
): Promise<{ permission?: { outcome?: { outcome?: string } }; question?: { action?: string } }> {
  const config = await transport.setConfigOption("probe", "read");
  return JSON.parse(config[0]?.currentValue ?? "{}");
}

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop();
    if (!resource) continue;
    await resource.adapter.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});

describe("real ACP background owner lifecycle", () => {
  it("keeps a known tool terminal delivered immediately after the prompt response", async () => {
    const fixture = await openReal();
    await startAndWait(fixture.session, fixture.outputs, "t1", "terminal-tail");
    expect(fixture.session.hasBackgroundWork?.()).toBe(false);
    expect(events(fixture.outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: "t1",
        snapshot: expect.objectContaining({
          item: expect.objectContaining({ type: "commandExecution", output: "finished" }),
          outcome: { status: "succeeded" },
        }),
      }),
    );
  });

  it("routes known old tool updates and interactions during a successor prompt", async () => {
    const fixture = await openReal();
    await startAndWait(fixture.session, fixture.outputs, "t1", "first");
    await startAndWait(fixture.session, fixture.outputs, "t2", "second");

    const interactions = fixture.outputs.filter((output) => output.kind === "interaction");
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.interaction.type).toBe("question");
    expect(
      events(fixture.outputs).filter(
        (event) => event.type === "item.started" && event.turnId === "t1",
      ),
    ).toHaveLength(1);
    expect(
      events(fixture.outputs).filter(
        (event) =>
          event.type === "item.started" &&
          event.turnId === "t2" &&
          event.item.type === "agentMessage",
      ),
    ).toHaveLength(1);
    expect(events(fixture.outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: "t2",
        snapshot: expect.objectContaining({
          item: expect.objectContaining({
            type: "agentMessage",
            text: "before-old-updateafter-old-update",
          }),
        }),
      }),
    );
    const replies = await wireReplies(fixture.transport);
    expect(replies.permission?.outcome?.outcome).toBeUndefined();
    expect(replies.question?.action).toBeUndefined();
    expect(fixture.session.hasBackgroundWork?.()).toBe(true);

    for (const output of interactions) {
      if (output.kind !== "interaction") continue;
      const response =
        output.interaction.type === "approval"
          ? { type: "approval" as const, actionId: "allow" }
          : { type: "question" as const, answers: { answer: ["yes"] } };
      expect(
        await fixture.session.execute({
          type: "interaction.respond",
          interactionId: output.interaction.interactionId,
          response,
        }),
      ).toMatchObject({ ok: true });
    }
    await waitFor(async () => {
      const answered = await wireReplies(fixture.transport);
      return answered.question?.action === "accept";
    }, "old owner replies");
    const answered = await wireReplies(fixture.transport);
    expect(answered.permission?.outcome?.outcome).toBeUndefined();
    expect(answered.question?.action).toBe("accept");
  });

  it("cancels a pending Approval when a prompt succeeds", async () => {
    const fixture = await openReal();
    await startAndWait(fixture.session, fixture.outputs, "t1", "pending");
    await waitFor(
      () => fixture.outputs.some((output) => output.kind === "interaction"),
      "pending interaction",
    );
    const output = fixture.outputs.find((entry) => entry.kind === "interaction");
    assert(output?.kind === "interaction");
    expect(output.interaction.type).toBe("approval");
    expect(
      await fixture.session.execute({
        type: "interaction.respond",
        interactionId: output.interaction.interactionId,
        response: { type: "approval", actionId: "allow" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await wireReplies(fixture.transport)).permission?.outcome?.outcome).toBe("cancelled");
  });

  it("does not detach an ordinary tool for a pending Approval", async () => {
    const fixture = await openReal();
    await startAndWait(fixture.session, fixture.outputs, "t1", "pending-edit");
    const output = fixture.outputs.find((entry) => entry.kind === "interaction");
    assert(output?.kind === "interaction");
    const tool = events(fixture.outputs).find(
      (event) => event.type === "item.started" && event.item.type === "toolExecution",
    );
    assert(tool?.type === "item.started");
    expect(events(fixture.outputs)).not.toContainEqual(
      expect.objectContaining({ type: "item.detached", turnId: "t1", itemId: tool.item.itemId }),
    );
    expect(
      await fixture.session.execute({
        type: "interaction.respond",
        interactionId: output.interaction.interactionId,
        response: { type: "approval", actionId: "allow" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
    await waitFor(() => fixture.session.hasBackgroundWork?.() === false, "ordinary tool completed");
    expect(events(fixture.outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: "t1",
        snapshot: expect.objectContaining({
          item: expect.objectContaining({ type: "toolExecution", toolName: "edit_file" }),
        }),
      }),
    );
  });

  it("settles detached owners on process fault and close with real outcomes", async () => {
    const faulted = await openReal();
    await startAndWait(faulted.session, faulted.outputs, "t1", "first");
    await expect(faulted.transport.setConfigOption("probe", "exit")).rejects.toBeDefined();
    await waitFor(
      () => events(faulted.outputs).some((event) => event.type === "session.faulted"),
      "fault",
    );
    await waitFor(() => faulted.session.hasBackgroundWork?.() === false, "fault owner released");
    expect(events(faulted.outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: "t1",
        snapshot: expect.objectContaining({
          outcome: expect.objectContaining({ status: "failed" }),
        }),
      }),
    );

    const closed = await openReal();
    await startAndWait(closed.session, closed.outputs, "t1", "first");
    await closed.session.close();
    expect(closed.session.hasBackgroundWork?.()).toBe(false);
    expect(events(closed.outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: "t1",
        snapshot: expect.objectContaining({
          outcome: expect.objectContaining({ status: "cancelled" }),
        }),
      }),
    );
  });

  it("keeps a known ask_question owner after the prompt returns", async () => {
    const fixture = await openReal();
    await startAndWait(fixture.session, fixture.outputs, "t1", "ask");
    expect(events(fixture.outputs)).toContainEqual(
      expect.objectContaining({ type: "item.detached", turnId: "t1" }),
    );
    expect(fixture.session.hasBackgroundWork?.()).toBe(true);
    await fixture.transport.setConfigOption("probe", "late-question");
    await waitFor(
      () => fixture.outputs.some((output) => output.kind === "interaction"),
      "late question",
    );
    const output = fixture.outputs.find((entry) => entry.kind === "interaction");
    assert(output?.kind === "interaction");
    expect(output.interaction.type).toBe("question");
    expect(
      await fixture.session.execute({
        type: "interaction.respond",
        interactionId: output.interaction.interactionId,
        response: { type: "question", answers: { answer: ["yes"] } },
      }),
    ).toMatchObject({ ok: true });
    await waitFor(() => fixture.session.hasBackgroundWork?.() === false, "ask owner released");
    expect(events(fixture.outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: "t1",
        snapshot: expect.objectContaining({ outcome: { status: "succeeded" } }),
      }),
    );
    expect((await wireReplies(fixture.transport)).question?.action).toBe("accept");
  });
});
