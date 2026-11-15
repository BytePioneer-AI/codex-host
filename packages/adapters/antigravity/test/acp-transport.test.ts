import type * as ChildProcess from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcpTransport } from "../src/acp-transport.js";
import { resolveAntigravityExecutable } from "../src/command.js";
import type { AntigravityAcpEvent, AntigravityActivePromptHandler } from "../src/acp-types.js";

const fixture = vi.hoisted(() => ({
  children: [] as ChildProcessWithoutNullStreams[],
  script: `
const readline = require('node:readline');
const scenario = process.env.AGY_TEST_SCENARIO;
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
const result = (id, value) => send({id, result:value});
const update = (update, sessionId='native') => send({method:'session/update',params:{sessionId,update}});
let promptId;
const replies={};
if (scenario === 'wait-term') setInterval(() => {}, 1000);
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const req=JSON.parse(line);
  if (!req.method) { replies[req.id] = req.result; return; }
  if (req.method === 'initialize') {
    if (scenario === 'stall-init') return;
    if (scenario === 'auth-code') return send({id:req.id,error:{code:-32000,message:'Credentials needed'}});
    if (scenario === 'auth-text') return send({id:req.id,error:{code:-32603,message:'Please sign in using agy login'}});
    if (scenario === 'exit') {
      process.stderr.write('Authorization: Bearer ');
      setTimeout(() => process.stderr.write('super-secret-token\\n'), 10);
      return setTimeout(() => process.exit(9), 30);
    }
    return result(req.id,{protocolVersion:1,agentCapabilities:{loadSession:true},_meta:{params:req.params,args:process.argv.slice(1),pid:process.pid}});
  }
  if (req.method === 'session/new') {
    if (scenario === 'session-auth') return send({id:req.id,error:{code:-32000,message:'Credentials needed'}});
    if (scenario === 'initial-usage') update({sessionUpdate:'usage_update',used:40,size:1000});
    update({sessionUpdate:'available_commands_update',availableCommands:[{name:'quota',description:'Quota'}]});
    return result(req.id,{sessionId:'native',models:{currentModelId:'gemini-4-carbon',availableModels:[{modelId:'gemini-4-carbon',name:JSON.stringify(req.params)}]},modes:{currentModeId:'default',availableModes:[]},configOptions:[],_meta:{antigravity:{tier:{id:'pro',name:'Pro',upgradeUri:'https://example.com'}}}});
  }
  if (req.method === 'session/load') {
    update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'Question'}},req.params.sessionId);
    update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Thinking'}},req.params.sessionId);
    update({sessionUpdate:'tool_call',toolCallId:'old-tool',name:'view_file',args:{path:'a'},status:'completed'},req.params.sessionId);
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Answer'}},req.params.sessionId);
    update({sessionUpdate:'usage_update',used:40,size:1000},req.params.sessionId);
    update({sessionUpdate:'session_info_update',title:'History'},req.params.sessionId);
    return result(req.id,{configOptions:[]});
  }
  if (req.method === 'session/resume') {
    if (scenario === 'initial-usage') update({sessionUpdate:'usage_update',used:40,size:1000},req.params.sessionId);
    return result(req.id,{configOptions:[],modes:{currentModeId:'plan',availableModes:[]}});
  }
  if (req.method === 'session/set_mode') return result(req.id,{});
  if (req.method === 'session/set_config_option') {
    if (req.params.value === 'stall') return;
    return result(req.id,{configOptions:[{id:'replies',name:'Replies',currentValue:JSON.stringify(replies),options:[]}]});
  }
  if (req.method === 'session/prompt') {
    promptId=req.id;
    if (scenario === 'exit-prompt') return setTimeout(() => process.exit(8), 10);
    if (scenario === 'stall-prompt' || scenario === 'close-stalled') return;
    if (scenario === 'callbacks' || scenario === 'prompt-ends' || scenario === 'answer-callbacks') {
      send({id:'permission',method:'session/request_permission',params:{sessionId:'native',toolCall:{toolCallId:'shell',name:'run_command',kind:'execute',args:{command:'pwd'}},options:[{optionId:'session',name:'Session',kind:'allow_session'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
      send({id:'question',method:'elicitation/create',params:{sessionId:'native',toolCallId:'ask',mode:'form',message:'The agent has a question.',requestedSchema:{type:'object',properties:{q1:{type:'array',title:'Colors',items:{type:'string',oneOf:[{const:'1',title:'Red'}]}},q1_other:{type:'string',title:'Other'}}}}});
      if (scenario !== 'prompt-ends') return;
    }
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'wrong'}},'other-session');
    update({sessionUpdate:'tool_call',toolCallId:'ask',name:'ask_question',args:{questions:[{question:'Colors?'}]},status:'in_progress'});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(req.params.prompt)}});
    return result(req.id,{stopReason:'end_turn',usage:{inputTokens:20,outputTokens:10,cachedReadTokens:3,cachedWriteTokens:2,thoughtTokens:4,totalTokens:39}});
  }
  if (req.method === 'session/cancel') {
    result(promptId,{stopReason:'cancelled'});
    if (scenario === 'callbacks') setTimeout(() => send({id:'late',method:'session/request_permission',params:{sessionId:'native',toolCall:{toolCallId:'late',name:'run_command'},options:[{optionId:'deny',name:'Deny',kind:'reject_once'}]}}),10);
    return;
  }
  if (req.method === 'session/close') {
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'late-close-notification'}});
    if (scenario === 'close-stalled') return;
    return result(req.id,{});
  }
});
`,
}));

vi.mock("../src/command.js", () => ({
  resolveAntigravityExecutable: vi.fn(() => process.execPath),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      const child = actual.spawn(
        command,
        ["-e", fixture.script, "--", ...args],
        options,
      ) as ChildProcessWithoutNullStreams;
      fixture.children.push(child);
      return child;
    }),
  };
});

const transports: AntigravityAcpTransport[] = [];
function transport(
  scenario = "normal",
  extra: Partial<ConstructorParameters<typeof AntigravityAcpTransport>[0]> = {},
) {
  const value = new AntigravityAcpTransport({
    cwd: process.cwd(),
    commandTimeoutMs: 1500,
    closeTimeoutMs: 100,
    environment: { AGY_TEST_SCENARIO: scenario },
    ...extra,
  });
  transports.push(value);
  return value;
}
function handler(events: AntigravityAcpEvent[] = []): AntigravityActivePromptHandler {
  return {
    onEvent: (event) => events.push(event),
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onElicitation: async () => ({ action: "cancel" }),
  };
}
async function open(value: AntigravityAcpTransport) {
  return value.openSession({ kind: "create", cwd: process.cwd() });
}
async function replies(value: AntigravityAcpTransport): Promise<Record<string, unknown>> {
  const options = await value.setConfigOption("inspect", "replies");
  return JSON.parse(options[0]?.currentValue ?? "");
}
afterEach(async () => {
  await Promise.all(transports.splice(0).map((value) => value.close()));
  for (const child of fixture.children.splice(0)) {
    expect(child.exitCode !== null || child.signalCode !== null || child.pid === undefined).toBe(
      true,
    );
  }
});

describe("native ACP stdio transport", () => {
  it("reports missing executables without starting a process", async () => {
    vi.mocked(resolveAntigravityExecutable).mockReturnValueOnce(undefined);
    const value = transport();
    await expect(value.initialize()).rejects.toMatchObject({ kind: "notInstalled" });
  });
  it("cleans up a failed spawn", async () => {
    vi.mocked(resolveAntigravityExecutable).mockReturnValueOnce("/missing-antigravity-cli/agy");
    const value = transport();
    await expect(value.initialize()).rejects.toMatchObject({ kind: "notInstalled" });
    expect(value.isClosed).toBe(true);
  });
  it("normalizes authentication errors from session/new", async () => {
    const value = transport("session-auth");
    await expect(open(value)).rejects.toMatchObject({ kind: "authenticationRequired" });
    expect(value.sessionId).toBeNull();
  });
  it("interrupts an in-flight prompt on unexpected process exit", async () => {
    const onFault = vi.fn();
    const value = transport("exit-prompt", { onFault });
    await open(value);
    await expect(value.prompt([], handler())).rejects.toMatchObject({ kind: "processExited" });
    await value.close();
    expect(onFault).toHaveBeenCalledOnce();
  });
  it("uses SIGTERM when closing stdin does not stop the child", async () => {
    const value = transport("wait-term");
    await open(value);
    const child = fixture.children.at(-1);
    await value.close();
    expect(child?.signalCode).toBe("SIGTERM");
  });
  it("initializes once with elicitation only and launches the correct flags", async () => {
    const value = transport("normal", { skipPermissions: true });
    const [first, second] = await Promise.all([value.initialize(), value.initialize()]);
    expect(second).toBe(first);
    expect(first._meta).toMatchObject({
      params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
      args: ["acp", "--dangerously-skip-permissions"],
    });
    expect((first._meta?.params as Record<string, unknown>).clientCapabilities).toEqual({
      elicitation: { form: {} },
    });
    expect(value.skipPermissions).toBe(true);
  });
  it("creates sessions with system append, roots, tier and queued commands", async () => {
    const value = transport();
    const mcpServers = [
      { name: "codexhost_background", command: process.execPath, args: [], env: [] },
    ];
    const { opened } = await value.openSession({
      kind: "create",
      cwd: "/repo",
      mcpServers,
      additionalDirectories: ["/extra"],
      systemPromptAppend: "Be concise",
    });
    expect(value.sessionId).toBe("native");
    expect(opened.tier).toEqual({ id: "pro", name: "Pro", upgradeUri: "https://example.com" });
    expect(opened.models?.availableModels.map(({ name }) => JSON.parse(name))).toEqual([
      {
        cwd: "/repo",
        mcpServers,
        additionalDirectories: ["/extra"],
        _meta: { antigravity: { systemPrompt: { append: "Be concise" } } },
      },
    ]);
    const sessionEvents: AntigravityAcpEvent[] = [];
    value.setSessionEventHandler((event) => sessionEvents.push(event));
    expect(sessionEvents).toEqual([
      { type: "commands.update", commands: [{ name: "quota", description: "Quota" }] },
    ]);
    await value.setMode("plan");
  });
  it("omits empty optional session parameters", async () => {
    const value = transport();
    const { opened } = await value.openSession({
      kind: "create",
      cwd: "/repo",
      additionalDirectories: [],
      systemPromptAppend: "",
    });
    expect(opened.models?.availableModels.map(({ name }) => JSON.parse(name))).toEqual([
      {
        cwd: "/repo",
        mcpServers: [],
      },
    ]);
  });
  it("resumes without replay, but load collects the complete replay before its result", async () => {
    const value = transport();
    expect(
      (await value.openSession({ kind: "resume", sessionId: "saved", cwd: "/repo" }))
        .replayedEvents,
    ).toEqual([]);
    await value.closeSession();
    const sessionEvents: AntigravityAcpEvent[] = [];
    value.setSessionEventHandler((event) => sessionEvents.push(event));
    const loaded = await value.openSession({ kind: "load", sessionId: "saved", cwd: "/repo" });
    expect(loaded.opened.sessionId).toBe("saved");
    expect(loaded.replayedEvents.map(({ type }) => type)).toEqual([
      "user.text",
      "agent.thought",
      "tool.call",
      "agent.text",
      "usage.context",
      "session.info",
    ]);
    expect(loaded.replayedEvents[2]).toMatchObject({ args: { path: "a" } });
    expect(sessionEvents).toEqual([]);
  });
  it("round-trips multipart prompts and full native usage, rejecting foreign notifications", async () => {
    const value = transport();
    await open(value);
    const events: AntigravityAcpEvent[] = [];
    const parts = [
      { type: "text" as const, text: "Hello" },
      { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" },
    ];
    const result = await value.prompt(parts, handler(events));
    expect(result).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        cachedReadTokens: 3,
        cachedWriteTokens: 2,
        thoughtTokens: 4,
        totalTokens: 39,
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "tool.call",
        args: { questions: [{ question: "Colors?" }] },
      }),
      { type: "agent.text", text: JSON.stringify(parts) },
    ]);
  });
  it.each(["auth-code", "auth-text"])("normalizes %s authentication failures", async (scenario) => {
    const value = transport(scenario);
    await expect(value.initialize()).rejects.toMatchObject({ kind: "authenticationRequired" });
    expect(value.isClosed).toBe(true);
  });
  it("reports unexpected process exit once with sanitized diagnostics", async () => {
    const onFault = vi.fn();
    const value = transport("exit", { onFault });
    await expect(value.initialize()).rejects.toMatchObject({ kind: "processExited" });
    await value.close();
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault.mock.calls[0]?.[0].diagnostic).toContain("[redacted]");
    expect(onFault.mock.calls[0]?.[0].diagnostic).not.toContain("super-secret-token");
  });
  it("times out initialization and retires the process", async () => {
    const value = transport("stall-init", { commandTimeoutMs: 200 });
    await expect(value.initialize()).rejects.toThrow("timed out");
    expect(value.isClosed).toBe(true);
  });
  it("does not apply the command timeout while waiting for a user answer", async () => {
    const value = transport("callbacks", { commandTimeoutMs: 300 });
    await open(value);
    const onElicitation = vi.fn(() => new Promise<never>(() => {}));
    let settled = false;
    const pending = value.prompt([], { ...handler(), onElicitation });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(onElicitation).toHaveBeenCalledOnce());
    await delay(450);
    expect(settled).toBe(false);
    expect(value.isClosed).toBe(false);
    await value.cancel();
    expect((await pending).stopReason).toBe("cancelled");
  });
  it.each(["create", "resume"] as const)(
    "preserves context sent before %s returns",
    async (kind) => {
      const value = transport("initial-usage");
      const opened = await value.openSession({
        kind,
        cwd: process.cwd(),
        ...(kind === "resume" ? { sessionId: "saved" } : {}),
      });
      expect(opened.replayedEvents).toEqual([]);
      const events: AntigravityAcpEvent[] = [];
      value.setSessionEventHandler((event) => events.push(event));
      expect(events).toContainEqual({ type: "usage.context", used: 40, size: 1000 });
    },
  );
  it("retire-on-timeout applies to config requests too", async () => {
    const value = transport("normal", { commandTimeoutMs: 200 });
    await open(value);
    await expect(value.setConfigOption("model", "stall")).rejects.toThrow("timed out");
    await value.close();
  });
  it("passes raw native permission and array-oneOf elicitation fields to callbacks", async () => {
    const value = transport("answer-callbacks");
    await open(value);
    const permission = vi.fn<AntigravityActivePromptHandler["onPermission"]>(async () => ({
      outcome: { outcome: "selected" as const, optionId: "session" },
    }));
    const elicitation = vi.fn<AntigravityActivePromptHandler["onElicitation"]>(async () => ({
      action: "accept" as const,
      content: { q1: ["1"], q1_other: "" },
    }));
    const pending = value.prompt([], {
      ...handler(),
      onPermission: permission,
      onElicitation: elicitation,
    });
    await vi.waitFor(() => expect(elicitation).toHaveBeenCalledOnce());
    expect(permission.mock.calls[0]).toBeDefined();
    expect(permission.mock.calls[0]?.[0]).toMatchObject({
      toolCall: { args: { command: "pwd" } },
      options: [{ kind: "allow_session" }, { kind: "reject_once" }],
    });
    expect(elicitation.mock.calls[0]?.[0]).toMatchObject({
      requestedSchema: { properties: { q1: { items: { oneOf: [{ const: "1", title: "Red" }] } } } },
    });
    await vi.waitFor(async () =>
      expect(await replies(value)).toMatchObject({
        permission: { outcome: { outcome: "selected", optionId: "session" } },
        question: { action: "accept", content: { q1: ["1"], q1_other: "" } },
      }),
    );
    await value.cancel();
    expect((await pending).stopReason).toBe("cancelled");
  });
  it.each(["cancel", "prompt-end", "close"])(
    "cleans pending callbacks on %s even when Host handlers never resolve",
    async (ending) => {
      const value = transport(ending === "prompt-end" ? "prompt-ends" : "callbacks");
      await open(value);
      const onPermission = vi.fn(() => new Promise<never>(() => {}));
      const onElicitation = vi.fn(() => new Promise<never>(() => {}));
      const pending = value.prompt([], { ...handler(), onPermission, onElicitation });
      const settled = pending.then(
        (result) => result.stopReason,
        (error: Error) => error.message,
      );
      await vi.waitFor(() => expect(onElicitation).toHaveBeenCalledOnce());
      if (ending === "cancel") await value.cancel();
      if (ending === "close") await value.closeSession();
      await settled;
      if (ending !== "close") {
        await vi.waitFor(async () =>
          expect(await replies(value)).toMatchObject({
            permission: { outcome: { outcome: "cancelled" } },
            question: { action: "cancel" },
          }),
        );
        if (ending === "cancel") {
          await delay(30);
          expect((await replies(value)).late).toEqual({ outcome: { outcome: "cancelled" } });
          expect(onPermission).toHaveBeenCalledOnce();
        }
      }
    },
  );
  it("isolates late requests and Host answers from a closed native session", async () => {
    const value = transport("callbacks");
    await open(value);
    let answerOld = () => {};
    const oldPermission = vi.fn<AntigravityActivePromptHandler["onPermission"]>(
      () =>
        new Promise((resolve) => {
          answerOld = () => resolve({ outcome: { outcome: "selected", optionId: "session" } });
        }),
    );
    const first = value.prompt([], { ...handler(), onPermission: oldPermission });
    await vi.waitFor(() => expect(oldPermission).toHaveBeenCalledOnce());
    await value.cancel();
    await first;
    await value.closeSession();
    await value.openSession({ kind: "resume", sessionId: "saved", cwd: "/repo" });
    const newPermission = vi.fn<AntigravityActivePromptHandler["onPermission"]>(
      handler().onPermission,
    );
    const next = value.prompt([], { ...handler(), onPermission: newPermission });
    await vi.waitFor(async () =>
      expect(await replies(value)).toMatchObject({
        permission: { outcome: { outcome: "cancelled" } },
      }),
    );
    answerOld();
    await delay(30);
    expect(newPermission).not.toHaveBeenCalled();
    expect((await replies(value)).permission).toEqual({ outcome: { outcome: "cancelled" } });
    await value.cancel();
    await next;
  });
  it("closing an unresponsive prompt and session/close cannot leave a process", async () => {
    const value = transport("close-stalled");
    await open(value);
    const pending = value.prompt([], handler()).catch((error: Error) => error.message);
    await delay(10);
    await value.close();
    expect(await pending).toContain("closed");
  });
  it("requires a session ID for resume and prohibits overlapping sessions/prompts", async () => {
    const value = transport("stall-prompt");
    await expect(value.openSession({ kind: "resume", cwd: "/repo" })).rejects.toThrow(
      "Session ID required",
    );
    await open(value);
    await expect(open(value)).rejects.toThrow("Close the current");
    const pending = value.prompt([], handler()).catch(() => undefined);
    await expect(value.prompt([], handler())).rejects.toThrow("already active");
    await value.close();
    await pending;
  });
});
