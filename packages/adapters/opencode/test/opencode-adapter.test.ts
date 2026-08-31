import type {
  AssistantMessage,
  Command,
  Event,
  Part,
  PermissionRequest,
  Provider,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  TextPart,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import type { OpenCodeMessageWithParts } from "../src/history.js";
import {
  encodeOpenCodeModelRef,
  encodeOpenCodeVariant,
  type OpenCodeNativeModelRef,
  type OpenCodeProviderCatalog,
} from "../src/model-catalog.js";
import { OpenCodeAdapter, type OpenCodeAdapterDependencies } from "../src/opencode-adapter.js";
import type {
  OpenCodeCommandInput,
  OpenCodePromptInput,
  OpenCodeTransport,
  OpenCodeTransportListener,
} from "../src/protocol.js";
import type { OpenCodeServerOptions } from "../src/sdk-transport.js";

const cwd = "/synthetic";

function nativeSession(id = "session-1", directory = cwd): Session {
  return {
    id,
    slug: id,
    projectID: "project-1",
    directory,
    title: id,
    version: "1.18.25",
    time: { created: 1, updated: 2 },
  };
}

function providerCatalog(): OpenCodeProviderCatalog {
  const model = {
    id: "model-1",
    providerID: "provider-1",
    api: { id: "model-1", url: "https://example.test", npm: "synthetic" },
    name: "Model One",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: { high: {} },
  } as const;
  const provider: Provider = {
    id: "provider-1",
    name: "Provider One",
    source: "config",
    env: [],
    options: {},
    models: { "model-1": model },
  };
  return { all: [provider], connected: [provider.id], default: { [provider.id]: model.id } };
}

function userMessage(id: string, text: string): OpenCodeMessageWithParts {
  const info: UserMessage = {
    id,
    sessionID: "session-1",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "provider-1", modelID: "model-1" },
  };
  return {
    info,
    parts: [{ id: `part-${id}`, sessionID: info.sessionID, messageID: id, type: "text", text }],
  };
}

function assistantMessage(
  id: string,
  parentID: string,
  parts: Part[] = [],
  error?: AssistantMessage["error"],
): OpenCodeMessageWithParts {
  const info: AssistantMessage = {
    id,
    sessionID: "session-1",
    role: "assistant",
    time: { created: 2, completed: 3 },
    parentID,
    modelID: "model-1",
    providerID: "provider-1",
    mode: "build",
    agent: "build",
    path: { cwd, root: cwd },
    cost: 0.1,
    tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
    ...(error ? { error } : { finish: "stop" }),
  };
  return { info, parts };
}

class FakeOpenCodeTransport implements OpenCodeTransport {
  readonly cwd = cwd;
  readonly stderrTail = "";
  readonly sessions = new Map<string, Session>([["session-1", nativeSession()]]);
  readonly messages = new Map<string, OpenCodeMessageWithParts[]>([["session-1", []]]);
  readonly diffs = new Map<string, SnapshotFileDiff[]>();
  readonly promptCalls: OpenCodePromptInput[] = [];
  readonly commandCalls: OpenCodeCommandInput[] = [];
  readonly summarizeCalls: string[] = [];
  readonly forkCalls: Array<{ sessionID: string; messageID?: string }> = [];
  readonly revertCalls: Array<{ sessionID: string; messageID: string }> = [];
  readonly unrevertCalls: string[] = [];
  readonly questionReplies: Array<{ requestID: string; answers: QuestionAnswer[] }> = [];
  readonly questionRejects: string[] = [];
  readonly permissionReplies: Array<{ requestID: string; reply: "once" | "reject" }> = [];
  commandsValue: Command[] = [];
  questions: QuestionRequest[] = [];
  permissions: PermissionRequest[] = [];
  status: SessionStatus = { type: "idle" };
  listener: OpenCodeTransportListener | null = null;
  closed = 0;
  aborts = 0;
  failSubscribe = false;
  forkedSessionID = "session-fork";

  async health() {
    return { healthy: true as const, version: "1.18.25" };
  }

  async providers() {
    return providerCatalog();
  }

  async commands() {
    return this.commandsValue;
  }

  async createSession(input: { model?: OpenCodeNativeModelRef; variant?: string } = {}) {
    const session = nativeSession();
    if (input.model) {
      session.model = {
        id: input.model.modelID,
        providerID: input.model.providerID,
        ...(input.variant ? { variant: input.variant } : {}),
      };
    }
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async deleteSession(sessionID: string) {
    this.sessions.delete(sessionID);
    this.messages.delete(sessionID);
  }

  async getSession(sessionID: string) {
    const session = this.sessions.get(sessionID);
    if (!session) throw new Error("session not found");
    return session;
  }

  async getMessages(sessionID: string) {
    return [...(this.messages.get(sessionID) ?? [])];
  }

  async getStatus() {
    return this.status;
  }

  async getDiff(sessionID: string, messageID?: string) {
    void sessionID;
    return [...(this.diffs.get(messageID ?? "") ?? [])];
  }

  async forkSession(sessionID: string, messageID?: string) {
    this.forkCalls.push({ sessionID, ...(messageID ? { messageID } : {}) });
    const source = this.messages.get(sessionID) ?? [];
    const boundary = messageID
      ? source.findIndex(({ info }) => info.id === messageID)
      : source.length;
    const derived = nativeSession(this.forkedSessionID);
    this.sessions.set(derived.id, derived);
    this.messages.set(derived.id, source.slice(0, boundary < 0 ? source.length : boundary));
    return derived;
  }

  async revertSession(sessionID: string, messageID: string) {
    this.revertCalls.push({ sessionID, messageID });
    const session = await this.getSession(sessionID);
    session.revert = { messageID, snapshot: "snapshot-1" };
    return session;
  }

  async unrevertSession(sessionID: string) {
    this.unrevertCalls.push(sessionID);
    const session = await this.getSession(sessionID);
    delete session.revert;
    return session;
  }

  promptError: Error | undefined;
  promptAdmissionHook: (() => void) | undefined;

  async promptAsync(input: OpenCodePromptInput) {
    this.promptCalls.push(input);
    this.promptAdmissionHook?.();
    if (this.promptError) throw this.promptError;
    const info: UserMessage = {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: input.model ?? { providerID: "provider-1", modelID: "model-1" },
    };
    const part: TextPart = {
      id: `part-${input.messageID}`,
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "text",
      text: input.text,
    };
    this.messages.get(input.sessionID)?.push({ info, parts: [part] });
  }

  async executeCommand(input: OpenCodeCommandInput) {
    this.commandCalls.push(input);
    const info: UserMessage = {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: input.model ?? { providerID: "provider-1", modelID: "model-1" },
    };
    this.messages.get(input.sessionID)?.push({
      info,
      parts: [
        {
          id: `part-${input.messageID}`,
          sessionID: input.sessionID,
          messageID: input.messageID,
          type: "text",
          text: input.arguments,
        },
      ],
    });
  }

  async summarize(sessionID: string) {
    this.summarizeCalls.push(sessionID);
  }

  async abort() {
    this.aborts += 1;
  }

  async listQuestions() {
    return this.questions;
  }

  async replyQuestion(requestID: string, answers: QuestionAnswer[]) {
    this.questionReplies.push({ requestID, answers });
  }

  async rejectQuestion(requestID: string) {
    this.questionRejects.push(requestID);
  }

  async listPermissions() {
    return this.permissions;
  }

  async replyPermission(requestID: string, reply: "once" | "reject") {
    this.permissionReplies.push({ requestID, reply });
  }

  async subscribe(listener: OpenCodeTransportListener) {
    if (this.failSubscribe) throw new Error("synthetic subscribe failure");
    this.listener = listener;
    listener.onEvent({ id: "connected-1", type: "server.connected", properties: {} });
  }

  async close() {
    this.closed += 1;
    this.listener = null;
  }

  emit(event: Event): void {
    if (!this.listener) throw new Error("Fake OpenCode transport is not subscribed");
    this.listener.onEvent(event);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function nextOutput(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput> {
  const result = await iterator.next();
  if (result.done) throw new Error("Harness output stream ended unexpectedly");
  return result.value;
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const output = await nextOutput(iterator);
  if (output.kind !== "event") throw new Error("Expected Harness event");
  return output.event;
}

async function openFixture(transport = new FakeOpenCodeTransport()) {
  let uuid = 0;
  const connection = {
    stderrTail: "",
    client: async () => {
      throw new Error("Synthetic connection client must not be used");
    },
    close: async () => undefined,
  };
  const dependencies: OpenCodeAdapterDependencies = {
    createConnection: () => connection,
    createTransport: () => transport,
    randomUUID: () => `uuid-${++uuid}`,
  };
  const adapter = new OpenCodeAdapter({}, dependencies);
  const opened = await adapter.open({ kind: "create", cwd });
  if (!opened.ok) throw new Error(opened.error.message);
  await flush();
  return { adapter, session: opened.value, transport };
}

function turn(id: string, text = id) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text }],
  };
}

function appendTerminal(
  transport: FakeOpenCodeTransport,
  parts: Part[] = [],
  error?: AssistantMessage["error"],
) {
  const prompt = transport.promptCalls.at(-1);
  if (!prompt) throw new Error("No OpenCode prompt was admitted");
  const terminal = assistantMessage("assistant-live", prompt.messageID, parts, error);
  terminal.info.sessionID = prompt.sessionID;
  for (const part of parts) {
    part.sessionID = prompt.sessionID;
    part.messageID = terminal.info.id;
  }
  transport.messages.get(prompt.sessionID)?.push(terminal);
  return terminal.info;
}

async function completeAfterBusy(transport: FakeOpenCodeTransport): Promise<void> {
  transport.status = { type: "busy" };
  transport.emit({
    id: "busy",
    type: "session.status",
    properties: { sessionID: "session-1", status: transport.status },
  });
  await flush();
  transport.status = { type: "idle" };
  transport.emit({
    id: "idle",
    type: "session.status",
    properties: { sessionID: "session-1", status: transport.status },
  });
  await flush();
}

describe("OpenCode HarnessAdapter", () => {
  it("uses a dedicated connection and preserves per-open environment for unattended delegation", async () => {
    const connectionOptions: OpenCodeServerOptions[] = [];
    const connections = [] as Array<{
      stderrTail: string;
      client(): Promise<never>;
      close(): Promise<void>;
    }>;
    const adapter = new OpenCodeAdapter(
      { environment: { PATH: "/adapter", CODEXHOST_THREAD_ID: "parent" } },
      {
        createConnection: (options) => {
          connectionOptions.push(options);
          const connection = {
            stderrTail: "",
            client: async () => ({}) as never,
            close: async () => undefined,
          };
          connections.push(connection);
          return connection;
        },
        createTransport: () => new FakeOpenCodeTransport(),
        randomUUID: () => "uuid-1",
      },
    );
    const environment = {
      PATH: "/session",
      CODEXHOST_THREAD_ID: "child",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:9999",
      CODEXHOST_RUNTIME_TOKEN: "secret",
    };
    const opened = await adapter.open({
      kind: "create",
      cwd,
      environment,
      executionPolicy: "unattended-full-access",
    });
    expect(opened).toMatchObject({ ok: true });
    const second = await adapter.open({ kind: "create", cwd, environment });
    expect(second).toMatchObject({ ok: true });
    expect(connectionOptions).toHaveLength(2);
    expect(connectionOptions[0]?.environment).toMatchObject({
      ...environment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow" }),
    });
    expect(connectionOptions[1]?.environment).toEqual(environment);
    expect(connectionOptions[0]?.environment).not.toBe(environment);
    expect(connectionOptions[1]?.environment).not.toBe(environment);
    expect(connections).toHaveLength(2);
    expect(connections[0]).not.toBe(connections[1]);
    if (opened.ok) await opened.value.close();
    if (second.ok) await second.value.close();
    await adapter.close();
  });

  it("persists unattended execution policy through resume, fork, and rollback", async () => {
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
    ]);
    const connectionOptions: OpenCodeServerOptions[] = [];
    const adapter = new OpenCodeAdapter(
      {},
      {
        createConnection: (options) => {
          connectionOptions.push(options);
          return {
            stderrTail: "",
            client: async () => ({}) as never,
            close: async () => undefined,
          };
        },
        createTransport: () => transport,
        randomUUID: () => "uuid-1",
      },
    );
    const created = await adapter.open({
      kind: "create",
      cwd,
      executionPolicy: "unattended-full-access",
    });
    if (!created.ok) throw new Error(created.error.message);
    const nativeRef = created.value.initialState.nativeRef;
    if (!nativeRef) throw new Error("OpenCode Session did not expose a Native Ref");
    expect(nativeRef.locator).toEqual({
      directory: cwd,
      executionPolicy: "unattended-full-access",
    });
    await created.value.close();

    const resumed = await adapter.open({ kind: "resume", nativeRef, cwd });
    if (!resumed.ok) throw new Error(resumed.error.message);
    expect(resumed.value.initialState.nativeRef).toEqual(nativeRef);
    await resumed.value.close();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
    ]);

    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      checkpointId: "assistant-1",
      formatVersion: 1,
    });
    const forked = await adapter.open({ kind: "fork", sourceRef: nativeRef, checkpoint, cwd });
    if (!forked.ok) throw new Error(forked.error.message);
    expect(forked.value.initialState.nativeRef?.locator).toEqual({
      directory: cwd,
      executionPolicy: "unattended-full-access",
    });
    await forked.value.close();
    const rolledBack = await adapter.open({ kind: "rollbackLastTurn", sourceRef: nativeRef, cwd });
    if (!rolledBack.ok) throw new Error(rolledBack.error.message);
    expect(rolledBack.value.initialState.nativeRef?.locator).toEqual({
      directory: cwd,
      executionPolicy: "unattended-full-access",
    });
    await rolledBack.value.close();

    expect(
      connectionOptions.map(({ environment }) => environment?.OPENCODE_CONFIG_CONTENT),
    ).toEqual([
      JSON.stringify({ permission: "allow" }),
      JSON.stringify({ permission: "allow" }),
      JSON.stringify({ permission: "allow" }),
      JSON.stringify({ permission: "allow" }),
    ]);
    await adapter.close();
  });

  it("keeps default policy for old and default Native Session Refs", async () => {
    const transport = new FakeOpenCodeTransport();
    const connectionOptions: OpenCodeServerOptions[] = [];
    const adapter = new OpenCodeAdapter(
      {},
      {
        createConnection: (options) => {
          connectionOptions.push(options);
          return {
            stderrTail: "",
            client: async () => ({}) as never,
            close: async () => undefined,
          };
        },
        createTransport: () => transport,
        randomUUID: () => "uuid-1",
      },
    );
    const created = await adapter.open({ kind: "create", cwd });
    if (!created.ok) throw new Error(created.error.message);
    const nativeRef = created.value.initialState.nativeRef;
    if (!nativeRef) throw new Error("OpenCode Session did not expose a Native Ref");
    await created.value.close();
    const oldRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const resumed = await adapter.open({ kind: "resume", nativeRef: oldRef, cwd });
    if (!resumed.ok) throw new Error(resumed.error.message);
    expect(resumed.value.initialState.nativeRef?.locator).toEqual({
      directory: cwd,
      executionPolicy: "default",
    });
    await resumed.value.close();
    expect(
      connectionOptions.every(({ environment }) => !environment?.OPENCODE_CONFIG_CONTENT),
    ).toBe(true);
    await adapter.close();
  });

  it("preserves environment scope across create, resume, fork, and rollback", async () => {
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
    ]);
    const connectionOptions: OpenCodeServerOptions[] = [];
    const adapter = new OpenCodeAdapter(
      { environment: { PATH: "/adapter", CODEXHOST_THREAD_ID: "parent" } },
      {
        createConnection: (options) => {
          connectionOptions.push(options);
          return {
            stderrTail: "",
            client: async () => ({}) as never,
            close: async () => undefined,
          };
        },
        createTransport: () => transport,
        randomUUID: () => "uuid-1",
      },
    );
    const environment = {
      PATH: "/session",
      CODEXHOST_THREAD_ID: "child",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:9999",
      CODEXHOST_RUNTIME_TOKEN: "secret",
    };
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      checkpointId: "assistant-1",
      formatVersion: 1,
    });
    const created = await adapter.open({
      kind: "create",
      cwd,
      environment,
      executionPolicy: "unattended-full-access",
    });
    if (!created.ok) throw new Error(created.error.message);
    await created.value.close();
    const resumed = await adapter.open({ kind: "resume", nativeRef: sourceRef, cwd, environment });
    if (!resumed.ok) throw new Error(resumed.error.message);
    await resumed.value.close();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
    ]);
    const forked = await adapter.open({
      kind: "fork",
      sourceRef,
      checkpoint,
      cwd,
      environment,
    });
    if (!forked.ok) throw new Error(forked.error.message);
    await forked.value.close();
    const rolledBack = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef,
      cwd,
      environment,
    });
    if (!rolledBack.ok) throw new Error(rolledBack.error.message);
    await rolledBack.value.close();

    expect(connectionOptions).toHaveLength(4);
    expect(connectionOptions.map(({ environment: value }) => value)).toEqual([
      { ...environment, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow" }) },
      environment,
      environment,
      environment,
    ]);
    await adapter.close();
  });

  it("opens the SDK Session with native configuration and fail-closed capabilities", async () => {
    const transport = new FakeOpenCodeTransport();
    const adapter = new OpenCodeAdapter(
      {},
      {
        createConnection: () => ({
          stderrTail: "",
          client: async () => ({}) as never,
          close: async () => undefined,
        }),
        createTransport: () => transport,
        randomUUID: () => "uuid-1",
      },
    );
    const model = encodeOpenCodeModelRef({ providerID: "provider-1", modelID: "model-1" });
    const thinkingOptionId = encodeOpenCodeVariant("high");
    const opened = await adapter.open({ kind: "create", cwd, model, thinkingOptionId });
    if (!opened.ok) throw new Error(opened.error.message);

    expect(opened.value.initialState).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: thinkingOptionId,
    });
    expect(opened.value.capabilities).toEqual({
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: false,
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
    });
    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: "always" as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await opened.value.close();
    await adapter.close();
  });

  it("applies dynamic Model and Thinking selection to the next native prompt", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const model = encodeOpenCodeModelRef({ providerID: "provider-1", modelID: "model-1" });
    const thinkingOptionId = encodeOpenCodeVariant("high");

    await expect(session.execute({ type: "model.select", model })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: model },
    });
    await expect(session.execute({ type: "thinking.select", thinkingOptionId })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: model, effectiveThinkingOptionId: thinkingOptionId },
    });

    await expect(session.execute(turn("selected", "hello"))).resolves.toMatchObject({ ok: true });
    expect(transport.promptCalls.at(-1)).toMatchObject({
      model: { providerID: "provider-1", modelID: "model-1" },
      variant: "high",
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    appendTerminal(transport);
    await completeAfterBusy(transport);
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    await session.close();
    await adapter.close();
  });

  it("lists and executes native slash commands and context compaction", async () => {
    const transport = new FakeOpenCodeTransport();
    transport.commandsValue = [
      {
        name: "review",
        description: "Review the workspace",
        template: "Review $ARGUMENTS",
        hints: ["focus"],
      },
    ];
    const { adapter, session } = await openFixture(transport);
    const commands = session.commands;
    if (!commands) throw new Error("OpenCode Session did not expose commands");
    const catalog = await commands.list();
    if (!catalog.ok) throw new Error(catalog.error.message);
    expect(catalog.value.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "opencode.compact", invocation: "/compact" }),
        expect.objectContaining({ invocation: "/review", argumentMode: "text" }),
      ]),
    );
    const review = catalog.value.commands.find(({ invocation }) => invocation === "/review");
    if (!review) throw new Error("OpenCode did not publish the review command");
    expect(review.description).toBe("Review the workspace");

    transport.commandsValue = [
      {
        name: "long-description",
        description: `${"x".repeat(600)}   `,
        template: "Long $ARGUMENTS",
        hints: [],
      },
    ];
    const longCatalog = await commands.list();
    if (!longCatalog.ok) throw new Error(longCatalog.error.message);
    const longCommand = longCatalog.value.commands.find(
      ({ invocation }) => invocation === "/long-description",
    );
    expect(longCommand?.description).toHaveLength(512);
    expect(longCommand?.description?.endsWith("...")).toBe(true);
    transport.commandsValue = [
      {
        name: "review",
        description: "Review the workspace",
        template: "Review $ARGUMENTS",
        hints: ["focus"],
      },
    ];
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("native-command"),
        commandId: review.id,
        arguments: { text: "security" },
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "native-command" } });
    expect(transport.commandCalls).toEqual([
      expect.objectContaining({ command: "review", arguments: "security" }),
    ]);
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    const command = transport.commandCalls.at(-1);
    if (!command) throw new Error("OpenCode native command was not called");
    transport.messages
      .get(command.sessionID)
      ?.push(assistantMessage("assistant-command", command.messageID));
    transport.status = { type: "idle" };
    transport.emit({
      id: "command-idle",
      type: "session.idle",
      properties: { sessionID: command.sessionID },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });

    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("compact"),
        commandId: "opencode.compact",
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "compact" } });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "contextCompaction" },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    expect(transport.summarizeCalls).toEqual(["session-1"]);
    await session.close();
    await adapter.close();
  });

  it("buffers synchronous and asynchronous SSE until prompt admission commits", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    let resolveAdmission: (() => void) | undefined;
    transport.promptAdmissionHook = () => {
      transport.emit({
        id: "sync-connected",
        type: "server.connected",
        properties: {},
      });
      void Promise.resolve().then(() => {
        transport.emit({
          id: "async-status",
          type: "session.status",
          properties: { sessionID: "session-1", status: { type: "busy" } },
        });
      });
    };
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    const originalPrompt = transport.promptAsync.bind(transport);
    transport.promptAsync = async (input) => {
      transport.promptCalls.push(input);
      transport.promptAdmissionHook?.();
      await admission;
      const info = userMessage(input.messageID, input.text);
      transport.messages.get(input.sessionID)?.push(info);
    };
    const executePromise = session.execute(turn("buffered"));
    await flush();
    const pending = iterator.next();
    await flush();
    resolveAdmission?.();
    await expect(executePromise).resolves.toEqual({ ok: true, value: { turnId: "buffered" } });
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { kind: "event", event: { type: "turn.started" } },
    });
    await flush();
    appendTerminal(transport);
    transport.status = { type: "busy" };
    transport.emit({
      id: "finish-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "finish-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({ type: "turn.completed" });
    transport.promptAsync = originalPrompt;
    await session.close();
    await adapter.close();
  });

  it("returns admission failure without publishing an orphan lifecycle", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    transport.promptError = new Error("prompt rejected");
    await expect(session.execute(turn("rejected"))).resolves.toMatchObject({ ok: false });
    const next = iterator.next();
    const settled = await Promise.race([
      next.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(settled).toBe(false);
    await session.close();
    await adapter.close();
  });

  it("reconciles a terminal Turn that reaches idle before prompt admission resolves", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    let resolveAdmission: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    transport.promptAsync = async (input) => {
      transport.promptCalls.push(input);
      transport.messages.get(input.sessionID)?.push(userMessage(input.messageID, input.text));
      const terminal = assistantMessage("assistant-early", input.messageID);
      terminal.info.sessionID = input.sessionID;
      transport.messages.get(input.sessionID)?.push(terminal);
      transport.status = { type: "busy" };
      transport.emit({
        id: "early-busy",
        type: "session.status",
        properties: { sessionID: input.sessionID, status: transport.status },
      });
      transport.status = { type: "idle" };
      transport.emit({
        id: "early-idle",
        type: "session.status",
        properties: { sessionID: input.sessionID, status: transport.status },
      });
      await flush();
      await admission;
    };

    const executePromise = session.execute(turn("early-terminal"));
    await flush();
    resolveAdmission?.();
    await expect(executePromise).resolves.toEqual({
      ok: true,
      value: { turnId: "early-terminal" },
    });
    const events = [await nextEvent(iterator), await nextEvent(iterator)];
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(events[1]).toMatchObject({
      type: "turn.completed",
      turnId: "early-terminal",
      outcome: { status: "succeeded" },
    });
    await session.close();
    await adapter.close();
  });

  it("rejects prompt admission and settles close when the transport faults first", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    let resolveAdmission: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    transport.promptAsync = async (input) => {
      transport.promptCalls.push(input);
      await admission;
    };

    const executePromise = session.execute(turn("fault-during-admission"));
    await flush();
    transport.listener?.onFault(new Error("synthetic transport fault") as never);
    await expect(executePromise).resolves.toMatchObject({ ok: false });
    expect(await nextEvent(iterator)).toMatchObject({ type: "session.faulted" });
    resolveAdmission?.();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(session.close()).resolves.toBeUndefined();
    await adapter.close();
  });

  it("does not treat a stale idle status as Turn completion before observing busy", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    await expect(session.execute(turn("turn-gate", "hello"))).resolves.toMatchObject({ ok: true });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    appendTerminal(transport);

    transport.emit({
      id: "idle-early",
      type: "session.idle",
      properties: { sessionID: "session-1" },
    });
    await flush();
    const terminalOutput = iterator.next();
    const settledEarly = await Promise.race([
      terminalOutput.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15)),
    ]);
    expect(settledEarly).toBe(false);

    await completeAfterBusy(transport);
    const completed = await terminalOutput;
    expect(completed.done).toBe(false);
    if (!completed.done && completed.value.kind === "event") {
      expect(completed.value.event).toMatchObject({
        type: "turn.completed",
        outcome: { status: "succeeded" },
      });
    } else {
      throw new Error("Expected successful Turn completion");
    }
    await session.close();
    await adapter.close();
  });

  it("uses transcript reconciliation after an SSE reconnect as terminal evidence", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(turn("turn-reconnect"));
    await nextEvent(iterator);
    appendTerminal(transport);
    transport.status = { type: "idle" };
    transport.emit({ id: "connected-2", type: "server.connected", properties: {} });

    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
    await adapter.close();
  });

  it("waits for Part identity before projecting an early delta", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(turn("turn-reasoning"));
    await nextEvent(iterator);
    transport.emit({
      id: "delta-early",
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-live",
        partID: "reasoning-1",
        field: "text",
        delta: "think",
      },
    });
    const reasoning: Part = {
      id: "reasoning-1",
      sessionID: "session-1",
      messageID: "assistant-live",
      type: "reasoning",
      text: "think",
      time: { start: 1 },
    };
    transport.emit({
      id: "reasoning-start",
      type: "message.part.updated",
      properties: { sessionID: "session-1", part: reasoning, time: 1 },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "reasoning", text: "think" },
    });
    transport.emit({
      id: "reasoning-delta",
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "assistant-live",
        partID: "reasoning-1",
        field: "text",
        delta: " more",
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: " more" },
    });
    reasoning.text = "think more";
    reasoning.time.end = 2;
    transport.emit({
      id: "reasoning-end",
      type: "message.part.updated",
      properties: { sessionID: "session-1", part: reasoning, time: 2 },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
    appendTerminal(transport, [reasoning]);
    await completeAfterBusy(transport);
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    await session.close();
    await adapter.close();
  });

  it("projects native Question, Approval, Tool, and complete Diff semantics", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(turn("turn-interactions"));
    await nextEvent(iterator);
    const tool: Part = {
      id: "tool-part",
      sessionID: "session-1",
      messageID: "assistant-live",
      type: "tool",
      callID: "call-1",
      tool: "bash",
      state: { status: "running", input: { command: "pwd" }, time: { start: 1 } },
    };
    transport.emit({
      id: "tool-running",
      type: "message.part.updated",
      properties: { sessionID: "session-1", part: tool, time: 1 },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "bash" },
    });

    transport.emit({
      id: "question",
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "session-1",
        tool: { messageID: "assistant-live", callID: "call-1" },
        questions: [
          {
            header: "Targets",
            question: "Choose targets",
            options: [{ label: "A", description: "First" }],
            multiple: true,
            custom: true,
          },
        ],
      },
    });
    const questionOutput = await nextOutput(iterator);
    expect(questionOutput).toMatchObject({
      kind: "interaction",
      interaction: {
        type: "question",
        itemId: "tool-part",
        questions: [{ multiple: true, allowOther: true }],
      },
    });
    if (questionOutput.kind !== "interaction") throw new Error("Expected Question");
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: questionOutput.interaction.interactionId,
        response: { type: "question", answers: { "question-0": ["A", "custom"] } },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(transport.questionReplies).toEqual([
      { requestID: "question-1", answers: [["A", "custom"]] },
    ]);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "responded",
    });

    transport.emit({
      id: "permission",
      type: "permission.asked",
      properties: {
        id: "permission-1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: ["pwd"],
        tool: { messageID: "assistant-live", callID: "call-1" },
      },
    });
    const approvalOutput = await nextOutput(iterator);
    expect(approvalOutput).toMatchObject({
      kind: "interaction",
      interaction: {
        type: "approval",
        actions: [
          { id: "allow-once", effect: "allowOnce" },
          { id: "deny", effect: "deny" },
        ],
      },
    });
    if (approvalOutput.kind !== "interaction") throw new Error("Expected Approval");
    await session.execute({
      type: "interaction.respond",
      interactionId: approvalOutput.interaction.interactionId,
      response: { type: "approval", actionId: "deny" },
    });
    expect(transport.permissionReplies).toEqual([{ requestID: "permission-1", reply: "reject" }]);
    await nextEvent(iterator);

    tool.state = {
      status: "completed",
      input: { command: "pwd" },
      output: cwd,
      title: "pwd",
      metadata: {},
      time: { start: 1, end: 3 },
    };
    transport.emit({
      id: "tool-completed",
      type: "message.part.updated",
      properties: { sessionID: "session-1", part: tool, time: 3 },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "output.replace" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "succeeded" } },
    });

    const promptID = transport.promptCalls.at(-1)?.messageID as string;
    transport.diffs.set(promptID, [
      { file: "src/a.ts", patch: "@@ -1 +1 @@", additions: 1, deletions: 1, status: "modified" },
      { file: "src/incomplete.ts", additions: 1, deletions: 0, status: "added" },
    ]);
    appendTerminal(transport, [tool]);
    await completeAfterBusy(transport);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "fileChange",
        changes: [{ path: "src/a.ts", kind: "update", unifiedDiff: "@@ -1 +1 @@" }],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
    await adapter.close();
  });

  it("cancels an active Turn and reports the native aborted terminal", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-cancel");
    await session.execute(active);
    await nextEvent(iterator);
    await expect(session.execute({ type: "turn.cancel", turnId: active.turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.aborts).toBe(1);
    appendTerminal(transport, [], { name: "MessageAbortedError", data: { message: "aborted" } });
    transport.emit({
      id: "cancel-idle",
      type: "session.idle",
      properties: { sessionID: "session-1" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await session.close();
    await adapter.close();
  });

  it("uses exact Fork and persisted rollback transcript boundaries", async () => {
    const sourceMessages = [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ];
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      checkpointId: "assistant-1",
      formatVersion: 1,
    });

    const forkTransport = new FakeOpenCodeTransport();
    forkTransport.messages.set("session-1", sourceMessages);
    const forkFixture = await openAdapterWithInput(forkTransport, {
      kind: "fork",
      sourceRef,
      checkpoint,
      cwd,
    });
    expect(forkTransport.forkCalls).toEqual([{ sessionID: "session-1", messageID: "user-2" }]);
    await expect(forkFixture.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "one" }] }] },
    });
    await forkFixture.session.close();
    await forkFixture.adapter.close();

    const rollbackTransport = new FakeOpenCodeTransport();
    rollbackTransport.messages.set("session-1", sourceMessages);
    const rollbackFixture = await openAdapterWithInput(rollbackTransport, {
      kind: "rollbackLastTurn",
      sourceRef,
      cwd,
    });
    expect(rollbackTransport.revertCalls).toEqual([
      { sessionID: "session-1", messageID: "user-2" },
    ]);
    await expect(rollbackFixture.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "one" }] }] },
    });
    await rollbackFixture.session.close();
    await rollbackFixture.adapter.close();
  });

  it("restores a reverted worktree when Session attachment fails", async () => {
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
    ]);
    transport.failSubscribe = true;
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    await expect(adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd })).resolves.toMatchObject(
      {
        ok: false,
      },
    );
    expect(transport.revertCalls).toEqual([{ sessionID: "session-1", messageID: "user-1" }]);
    expect(transport.unrevertCalls).toEqual(["session-1"]);
    expect(transport.sessions.get("session-1")).not.toHaveProperty("revert");
    await adapter.close();
  });
});

function adapterFor(transport: FakeOpenCodeTransport): OpenCodeAdapter {
  return new OpenCodeAdapter(
    {},
    {
      createConnection: () => ({
        stderrTail: "",
        client: async () => ({}) as never,
        close: async () => undefined,
      }),
      createTransport: () => transport,
      randomUUID: () => "uuid-1",
    },
  );
}

async function openAdapterWithInput(
  transport: FakeOpenCodeTransport,
  input: Parameters<OpenCodeAdapter["open"]>[0],
): Promise<{ adapter: OpenCodeAdapter; session: HarnessSession }> {
  const adapter = adapterFor(transport);
  const opened = await adapter.open(input);
  if (!opened.ok) throw new Error(opened.error.message);
  await flush();
  return { adapter, session: opened.value };
}
