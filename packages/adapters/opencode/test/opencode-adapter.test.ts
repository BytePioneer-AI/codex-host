import type {
  AssistantMessage,
  Command,
  Event,
  Part,
  PermissionRequest,
  PermissionRuleset,
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
import { describe, expect, it, vi } from "vitest";

import type { OpenCodeMessageWithParts } from "../src/history.js";
import {
  encodeOpenCodeModelRef,
  encodeOpenCodeVariant,
  type OpenCodeNativeModelRef,
  type OpenCodeProviderCatalog,
} from "../src/model-catalog.js";
import { OpenCodeMessageIdGenerator, parseOpenCodeMessageGroup } from "../src/message-grouping.js";
import { OpenCodeAdapter, type OpenCodeAdapterDependencies } from "../src/opencode-adapter.js";
import {
  OpenCodeTransportError,
  type OpenCodeCommandInput,
  type OpenCodePromptInput,
  type OpenCodeTransport,
  type OpenCodeTransportListener,
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

function userMessage(id: string, text: string, sessionID = "session-1"): OpenCodeMessageWithParts {
  const info: UserMessage = {
    id,
    sessionID,
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
  sessionID = "session-1",
): OpenCodeMessageWithParts {
  const info: AssistantMessage = {
    id,
    sessionID,
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
  readonly promptInputCalls: OpenCodePromptInput[] = [];
  readonly promptCalls: Array<OpenCodePromptInput & { messageID: string }> = [];
  readonly commandCalls: Array<OpenCodeCommandInput & { messageID: string }> = [];
  readonly summarizeCalls: string[] = [];
  readonly metadataUpdates: Array<{ sessionID: string; metadata: Record<string, unknown> }> = [];
  readonly permissionUpdates: Array<{ sessionID: string; permission: PermissionRuleset }> = [];
  readonly createSessionCalls: Array<{
    model?: OpenCodeNativeModelRef;
    variant?: string;
    permission?: PermissionRuleset;
  }> = [];
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
  paths = { directory: cwd, worktree: cwd };
  healthVersion = "1.18.25";

  async health() {
    return { healthy: true as const, version: this.healthVersion };
  }

  async providers() {
    return providerCatalog();
  }

  async commands() {
    return this.commandsValue;
  }

  async createSession(
    input: {
      model?: OpenCodeNativeModelRef;
      variant?: string;
      permission?: PermissionRuleset;
    } = {},
  ) {
    this.createSessionCalls.push(input);
    const session = nativeSession();
    if (input.model) {
      session.model = {
        id: input.model.modelID,
        providerID: input.model.providerID,
        ...(input.variant ? { variant: input.variant } : {}),
      };
    }
    if (input.permission) session.permission = input.permission;
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

  async getPaths() {
    return this.paths;
  }

  async updateSessionMetadata(sessionID: string, metadata: Record<string, unknown>) {
    this.metadataUpdates.push({ sessionID, metadata });
    if (this.metadataError) throw this.metadataError;
    const session = await this.getSession(sessionID);
    session.metadata = metadata;
    return session;
  }

  async updateSessionPermission(sessionID: string, permission: PermissionRuleset) {
    this.permissionUpdates.push({ sessionID, permission });
    if (this.permissionError) throw this.permissionError;
    const session = await this.getSession(sessionID);
    session.permission = permission;
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
    const derived = nativeSession(
      this.forkedSessionID,
      this.sessions.get(sessionID)?.directory ?? cwd,
    );
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
  emitPromptUserEvents = true;
  metadataError: Error | undefined;
  permissionError: Error | undefined;
  nativeMessageOrdinal = 0;

  async promptAsync(input: OpenCodePromptInput) {
    this.promptInputCalls.push({ ...input });
    const messageID = input.messageID ?? `msg_native_${++this.nativeMessageOrdinal}`;
    this.promptCalls.push({ ...input, messageID });
    this.promptAdmissionHook?.();
    if (this.promptError) throw this.promptError;
    const info: UserMessage = {
      id: messageID,
      sessionID: input.sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: input.model ?? { providerID: "provider-1", modelID: "model-1" },
    };
    const part: TextPart = {
      id: `part-${messageID}`,
      sessionID: input.sessionID,
      messageID,
      type: "text",
      text: input.text,
    };
    this.messages.get(input.sessionID)?.push({ info, parts: [part] });
    if (this.emitPromptUserEvents) {
      this.listener?.onEvent({
        id: `event-${messageID}`,
        type: "message.updated",
        properties: { sessionID: input.sessionID, info },
      });
    }
  }

  async executeCommand(
    input: OpenCodeCommandInput,
  ): Promise<OpenCodeMessageWithParts & { info: AssistantMessage }> {
    const messageID = `msg_native_${++this.nativeMessageOrdinal}`;
    this.commandCalls.push({ ...input, messageID });
    const info: UserMessage = {
      id: messageID,
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
          id: `part-${messageID}`,
          sessionID: input.sessionID,
          messageID,
          type: "text",
          text: input.arguments,
        },
      ],
    });
    this.listener?.onEvent({
      id: `event-${messageID}`,
      type: "message.updated",
      properties: { sessionID: input.sessionID, info },
    });
    return assistantMessage(
      `assistant-result-${messageID}`,
      messageID,
    ) as OpenCodeMessageWithParts & {
      info: AssistantMessage;
    };
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

async function openFixture(
  transport = new FakeOpenCodeTransport(),
  options: OpenCodeServerOptions = {},
) {
  let uuid = 0;
  const connection = {
    stderrTail: "",
    closed: 0,
    client: async () => {
      throw new Error("Synthetic connection client must not be used");
    },
    async close() {
      this.closed += 1;
    },
  };
  const dependencies: OpenCodeAdapterDependencies = {
    createConnection: () => connection,
    createTransport: () => transport,
    randomUUID: () => `uuid-${++uuid}`,
  };
  const adapter = new OpenCodeAdapter(options, dependencies);
  const opened = await adapter.open({ kind: "create", cwd });
  if (!opened.ok) throw new Error(opened.error.message);
  await flush();
  return { adapter, session: opened.value, transport, connection };
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
  if (!prompt.messageID) throw new Error("OpenCode prompt has no native Message ID");
  const terminal = assistantMessage("assistant-live", prompt.messageID, parts, error);
  terminal.info.sessionID = prompt.sessionID;
  for (const part of parts) {
    part.sessionID = prompt.sessionID;
    part.messageID = terminal.info.id;
  }
  transport.messages.get(prompt.sessionID)?.push(terminal);
  return terminal.info;
}

function appendTerminalForPrompt(
  transport: FakeOpenCodeTransport,
  prompt: FakeOpenCodeTransport["promptCalls"][number],
  assistantID: string,
  parts: Part[] = [],
  error?: AssistantMessage["error"],
) {
  const terminal = assistantMessage(assistantID, prompt.messageID, parts, error);
  terminal.info.sessionID = prompt.sessionID;
  for (const part of parts) {
    part.sessionID = prompt.sessionID;
    part.messageID = terminal.info.id;
  }
  transport.messages.get(prompt.sessionID)?.push(terminal);
  return terminal.info;
}

function textPart(id: string, text: string): TextPart {
  return {
    id,
    sessionID: "session-1",
    messageID: "pending",
    type: "text",
    text,
    time: { start: 1, end: 2 },
  };
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
  it.each([false, true])(
    "distinguishes a native default sentinel from an advertised variant (named=%s)",
    async (named) => {
      const transport = new FakeOpenCodeTransport();
      transport.providers = async () => {
        const catalog = providerCatalog();
        const model = catalog.all[0]?.models["model-1"];
        if (!model) throw new Error("Missing fixture Model");
        model.variants = named ? { default: {} } : {};
        return catalog;
      };
      const create = transport.createSession.bind(transport);
      transport.createSession = async (input) => {
        const session = await create(input);
        session.model = { providerID: "provider-1", id: "model-1", variant: "default" };
        return session;
      };
      const { adapter, session } = await openFixture(transport);
      try {
        const expected = encodeOpenCodeVariant(named ? "default" : undefined);
        expect(session.initialState.effectiveThinkingOptionId).toBe(expected);
        await expect(session.readSnapshot()).resolves.toMatchObject({
          ok: true,
          value: { state: { effectiveThinkingOptionId: expected } },
        });
      } finally {
        await adapter.close();
      }
    },
  );

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

  it("opens the SDK Session with native configuration and selectable permissions", async () => {
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
      effectivePermissionModeId: "default",
    });
    expect(opened.value.capabilities).toEqual({
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: true,
        permissionModeScope: "live",
      },
      history: {
        fork: true,
        forkAcrossCwd: false,
        rollbackLastTurn: true,
        replacementFence: true,
      },
      activeTurns: { steer: true },
    });
    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: "invalid" as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await opened.value.close();
    await adapter.close();
  });

  it("fails closed for steering on an unverified native version", async () => {
    const transport = new FakeOpenCodeTransport();
    transport.healthVersion = "1.18.24";
    const adapter = adapterFor(transport);

    const inspection = await adapter.inspect({ cwd, refresh: true });
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") throw new Error(inspection.error.message);
    expect(inspection.capabilities.activeTurns).toBeUndefined();
    const opened = await adapter.open({ kind: "create", cwd });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.capabilities.activeTurns).toBeUndefined();
    await expect(
      opened.value.execute({
        type: "turn.steer",
        turnId: hostTurnIdSchema.parse("unverified-steer"),
        input: [{ type: "text", text: "must not be admitted" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(transport.promptCalls).toHaveLength(0);

    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    const active = turn("unverified-root", "ordinary prompt");
    await expect(opened.value.execute(active)).resolves.toEqual({
      ok: true,
      value: { turnId: active.turnId },
    });
    await nextEvent(iterator);
    expect(transport.promptInputCalls[0]).not.toHaveProperty("messageID");
    appendTerminal(transport);
    transport.status = { type: "busy" };
    transport.emit({
      id: "unverified-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "unverified-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({ type: "turn.completed" });
    await opened.value.close();
    await adapter.close();
  });

  it("creates, selects, and restores native Permission Modes", async () => {
    const transport = new FakeOpenCodeTransport();
    const adapter = adapterFor(transport);
    const created = await adapter.open({
      kind: "create",
      cwd,
      permissionModeId: "ask" as never,
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(transport.createSessionCalls.at(-1)?.permission).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
    ]);
    expect(created.value.initialState.effectivePermissionModeId).toBe("ask");
    const iterator = created.value.outputs[Symbol.asyncIterator]();

    await expect(
      created.value.execute({ type: "permissionMode.select", permissionModeId: "ask" as never }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.permissionUpdates).toHaveLength(0);

    await expect(
      created.value.execute({ type: "permissionMode.select", permissionModeId: "allow" as never }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.permissionUpdates.at(-1)).toEqual({
      sessionID: "session-1",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "allow" },
    });
    await expect(
      created.value.execute({
        type: "permissionMode.select",
        permissionModeId: "default" as never,
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.permissionUpdates.at(-1)).toEqual({
      sessionID: "session-1",
      permission: [],
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "default" },
    });
    await created.value.execute({
      type: "permissionMode.select",
      permissionModeId: "allow" as never,
    });
    await nextEvent(iterator);
    const nativeRef = created.value.initialState.nativeRef;
    if (!nativeRef) throw new Error("OpenCode Session did not expose a Native Ref");
    await created.value.close();

    const resumed = await adapter.open({ kind: "resume", nativeRef, cwd });
    if (!resumed.ok) throw new Error(resumed.error.message);
    expect(resumed.value.initialState.effectivePermissionModeId).toBe("allow");
    await resumed.value.close();
    await adapter.close();
  });

  it("does not publish a Permission Mode when native persistence fails", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    transport.permissionError = new Error("permission rejected");

    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: "ask" as never }),
    ).resolves.toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    const pending = iterator.next();
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(settled).toBe(false);
    await session.close();
    await adapter.close();
  });

  it("requires Allow permission for unattended create", async () => {
    const transport = new FakeOpenCodeTransport();
    const adapter = adapterFor(transport);

    await expect(
      adapter.open({
        kind: "create",
        cwd,
        executionPolicy: "unattended-full-access",
        permissionModeId: "ask" as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    const opened = await adapter.open({
      kind: "create",
      cwd,
      executionPolicy: "unattended-full-access",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState.effectivePermissionModeId).toBe("allow");
    expect(transport.createSessionCalls.at(-1)?.permission).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
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
    expect(transport.metadataUpdates.at(-1)).toMatchObject({
      sessionID: "session-1",
      metadata: {
        "codexhost.selection.v1": { providerID: "provider-1", modelID: "model-1" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: model },
    });
    await expect(session.execute({ type: "thinking.select", thinkingOptionId })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    expect(transport.metadataUpdates.at(-1)).toMatchObject({
      metadata: {
        "codexhost.selection.v1": {
          providerID: "provider-1",
          modelID: "model-1",
          variant: "high",
        },
      },
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

  it("does not publish a Model selection when metadata persistence fails", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const model = encodeOpenCodeModelRef({ providerID: "provider-1", modelID: "model-1" });
    transport.metadataError = new Error("metadata rejected");

    await expect(session.execute({ type: "model.select", model })).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure" },
    });
    const pending = iterator.next();
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(settled).toBe(false);
    await session.close();
    await adapter.close();
  });

  it("restores persisted Model and Thinking after reopening the Session", async () => {
    const transport = new FakeOpenCodeTransport();
    const { adapter, session } = await openFixture(transport);
    const sessionInfo = transport.sessions.get("session-1");
    if (!sessionInfo) throw new Error("Missing synthetic Session");
    sessionInfo.metadata = { other: "preserved" };
    const model = encodeOpenCodeModelRef({ providerID: "provider-1", modelID: "model-1" });
    const thinkingOptionId = encodeOpenCodeVariant("high");
    const nativeRef = session.initialState.nativeRef;
    if (!nativeRef) throw new Error("OpenCode Session did not expose a Native Ref");

    await session.execute({ type: "model.select", model });
    await session.execute({ type: "thinking.select", thinkingOptionId });
    expect(transport.sessions.get("session-1")?.metadata).toMatchObject({
      other: "preserved",
      "codexhost.selection.v1": {
        providerID: "provider-1",
        modelID: "model-1",
        variant: "high",
      },
    });
    await session.close();

    const resumed = await adapter.open({ kind: "resume", nativeRef, cwd });
    if (!resumed.ok) throw new Error(resumed.error.message);
    expect(resumed.value.initialState).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: thinkingOptionId,
    });
    await resumed.value.close();
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
    if (!command?.messageID) throw new Error("OpenCode native command has no Message ID");
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
      const messageID = input.messageID ?? `msg_native_${++transport.nativeMessageOrdinal}`;
      transport.promptCalls.push({ ...input, messageID });
      transport.promptAdmissionHook?.();
      await admission;
      const message = userMessage(messageID, input.text);
      transport.messages.get(input.sessionID)?.push(message);
      transport.listener?.onEvent({
        id: `event-${messageID}`,
        type: "message.updated",
        properties: { sessionID: input.sessionID, info: message.info },
      });
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
      const messageID = input.messageID ?? `msg_native_${++transport.nativeMessageOrdinal}`;
      transport.promptCalls.push({ ...input, messageID });
      transport.messages.get(input.sessionID)?.push(userMessage(messageID, input.text));
      const terminal = assistantMessage("assistant-early", messageID);
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
    const { adapter, session, transport, connection } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    let resolveAdmission: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    transport.promptAsync = async (input) => {
      const messageID = input.messageID ?? `msg_native_${++transport.nativeMessageOrdinal}`;
      transport.promptCalls.push({ ...input, messageID });
      await admission;
    };

    const executePromise = session.execute(turn("fault-during-admission"));
    await flush();
    transport.listener?.onFault(new Error("synthetic transport fault") as never);
    await expect(executePromise).resolves.toMatchObject({ ok: false });
    expect(await nextEvent(iterator)).toMatchObject({ type: "session.faulted" });
    resolveAdmission?.();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => {
      expect(transport.closed).toBe(1);
      expect(connection.closed).toBe(1);
    });
    await expect(session.close()).resolves.toBeUndefined();
    expect(transport.closed).toBe(1);
    expect(connection.closed).toBe(1);
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

  it("admits ordered steering messages exactly once and completes one logical Turn", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer", "initial request");
    await expect(session.execute(active)).resolves.toEqual({
      ok: true,
      value: { turnId: active.turnId },
    });
    expect(session.capabilities.activeTurns).toEqual({ steer: true });
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "steer-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const firstCommand = {
      type: "turn.steer" as const,
      turnId: active.turnId,
      input: [{ type: "text" as const, text: "focus on tests" }],
      clientUserMessageId: "client-steer-1",
    };
    const first = session.execute(firstCommand);
    const duplicate = session.execute(firstCommand);
    await expect(first).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    await expect(duplicate).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    await expect(
      session.execute({
        ...firstCommand,
        input: [{ type: "text", text: "different retry" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "keep the public API generic" }],
        clientUserMessageId: "client-steer-2",
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });

    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial request",
      "focus on tests",
      "keep the public API generic",
    ]);
    const groups = transport.promptCalls.map(({ messageID }) =>
      parseOpenCodeMessageGroup(messageID),
    );
    expect(groups.map((group) => group?.sequence)).toEqual([0, 1, 2]);
    expect(new Set(groups.map((group) => group?.token)).size).toBe(1);
    expect(transport.promptCalls.map(({ messageID }) => messageID)).toEqual(
      [...transport.promptCalls.map(({ messageID }) => messageID)].sort(),
    );

    const [rootPrompt, firstSteerPrompt, secondSteerPrompt] = transport.promptCalls;
    if (!rootPrompt || !firstSteerPrompt || !secondSteerPrompt) {
      throw new Error("OpenCode steering prompts are missing");
    }
    appendTerminalForPrompt(transport, rootPrompt, "assistant-root", [
      textPart("text-root", "draft"),
    ]);
    appendTerminalForPrompt(transport, firstSteerPrompt, "assistant-steer-1", [
      textPart("text-steer-1", "tested"),
    ]);
    appendTerminalForPrompt(transport, secondSteerPrompt, "assistant-steer-2", [
      textPart("text-steer-2", "final"),
    ]);
    transport.status = { type: "idle" };
    transport.emit({
      id: "steer-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const events = [];
    for (;;) {
      const event = await nextEvent(iterator);
      events.push(event);
      if (event.type === "turn.completed") break;
    }
    expect(events.filter(({ type }) => type === "item.started")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      nativeTurnRef: { nativeTurnKey: rootPrompt.messageID },
      outcome: { status: "succeeded", checkpoint: { checkpointId: "assistant-steer-2" } },
    });
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeTurnKey: rootPrompt.messageID },
            input: [
              { type: "text", text: "initial request" },
              { type: "text", text: "focus on tests" },
              { type: "text", text: "keep the public API generic" },
            ],
            items: [
              { item: { type: "agentMessage", text: "draft" } },
              { item: { type: "agentMessage", text: "tested" } },
              { item: { type: "agentMessage", text: "final" } },
            ],
          },
        ],
      },
    });
    await session.close();
    await adapter.close();
  });

  it("reconciles a steering admission whose response fails after native persistence", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-ambiguous", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "ambiguous-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const originalPrompt = transport.promptAsync.bind(transport);
    transport.promptAsync = async (input) => {
      await originalPrompt(input);
      if (input.text === "persisted adjustment") throw new Error("response was lost");
    };
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "persisted adjustment" }],
        clientUserMessageId: "ambiguous-steer",
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial",
      "persisted adjustment",
    ]);

    const steerPrompt = transport.promptCalls.at(-1);
    if (!steerPrompt) throw new Error("OpenCode steer prompt is missing");
    appendTerminalForPrompt(transport, steerPrompt, "assistant-after-ambiguous-steer");
    transport.status = { type: "idle" };
    transport.emit({
      id: "ambiguous-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
    await adapter.close();
  });

  it("recovers an admitted steering message left unanswered at an idle boundary", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-orphan-recovery", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "orphan-recovery-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-orphan");
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "orphaned adjustment" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });

    transport.status = { type: "idle" };
    transport.emit({
      id: "orphan-recovery-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await vi.waitFor(() => expect(transport.promptCalls).toHaveLength(3));
    const recoveryPrompt = transport.promptCalls[2];
    if (!recoveryPrompt) throw new Error("OpenCode recovery prompt is missing");
    expect(parseOpenCodeMessageGroup(recoveryPrompt.messageID)).toMatchObject({
      kind: "recovery",
      sequence: 2,
    });
    appendTerminalForPrompt(transport, recoveryPrompt, "assistant-after-orphan-recovery");
    transport.status = { type: "busy" };
    transport.emit({
      id: "orphan-recovery-resumed",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "orphan-recovery-completed",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [
              { type: "text", text: "initial" },
              { type: "text", text: "orphaned adjustment" },
            ],
            checkpoint: { checkpointId: "assistant-after-orphan-recovery" },
          },
        ],
      },
    });
    await session.close();
    await adapter.close();
  });

  it("can re-arm orphan recovery after a stable-idle check observes busy", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-rearm-recovery", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "rearm-recovery-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-rearmed-recovery");
    transport.emitPromptUserEvents = false;
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "adjust before missed idle" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });

    transport.status = { type: "idle" };
    transport.emit({
      id: "rearm-recovery-first-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await flush();
    transport.status = { type: "busy" };
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(transport.promptCalls).toHaveLength(2);
    transport.emit({
      id: "rearm-recovery-observed-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.status = { type: "idle" };
    transport.emit({ id: "rearm-recovery-reconnect", type: "server.connected", properties: {} });

    await vi.waitFor(() => expect(transport.promptCalls).toHaveLength(3));
    const recoveryPrompt = transport.promptCalls[2];
    if (!recoveryPrompt) throw new Error("OpenCode recovery prompt is missing");
    appendTerminalForPrompt(transport, recoveryPrompt, "assistant-after-rearmed-recovery");
    transport.status = { type: "busy" };
    transport.emit({
      id: "rearm-recovery-final-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "rearm-recovery-final-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
    await adapter.close();
  });

  it("does not admit recovery when busy resumes after its idle status snapshot", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-busy-during-recovery-preflight", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "busy-during-recovery-initial",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-busy-preflight");
    await session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "orphaned adjustment" }],
    });
    await flush();

    const originalGetMessages = transport.getMessages.bind(transport);
    const preflightStarted = Promise.withResolvers<undefined>();
    const releasePreflight = Promise.withResolvers<undefined>();
    let messageReads = 0;
    transport.getMessages = async (sessionID) => {
      messageReads += 1;
      const snapshot = await originalGetMessages(sessionID);
      if (messageReads === 3) {
        preflightStarted.resolve(undefined);
        await releasePreflight.promise;
      }
      return snapshot;
    };
    transport.status = { type: "idle" };
    transport.emit({
      id: "busy-during-recovery-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await preflightStarted.promise;

    transport.status = { type: "busy" };
    transport.emit({
      id: "busy-during-recovery-resumed",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await flush();
    releasePreflight.resolve(undefined);
    await vi.waitFor(() => expect(messageReads).toBeGreaterThanOrEqual(4));
    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial",
      "orphaned adjustment",
    ]);

    await expect(session.execute({ type: "turn.cancel", turnId: active.turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "busy-during-recovery-cancelled",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await session.close();
    await adapter.close();
  });

  it("does not admit recovery when the orphan Assistant arrives during preflight", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-assistant-during-recovery-preflight", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "assistant-during-recovery-initial",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-assistant-preflight");
    await session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "orphaned adjustment" }],
    });
    await flush();

    const originalGetMessages = transport.getMessages.bind(transport);
    const preflightStarted = Promise.withResolvers<undefined>();
    const releasePreflight = Promise.withResolvers<undefined>();
    let messageReads = 0;
    transport.getMessages = async (sessionID) => {
      messageReads += 1;
      const snapshot = await originalGetMessages(sessionID);
      if (messageReads === 3) {
        preflightStarted.resolve(undefined);
        await releasePreflight.promise;
      }
      return snapshot;
    };
    transport.status = { type: "idle" };
    transport.emit({
      id: "assistant-during-recovery-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await preflightStarted.promise;

    const orphanPrompt = transport.promptCalls[1];
    if (!orphanPrompt) throw new Error("OpenCode orphan steer prompt is missing");
    const terminal = appendTerminalForPrompt(
      transport,
      orphanPrompt,
      "assistant-during-recovery-preflight",
    );
    transport.emit({
      id: "assistant-during-recovery-arrived",
      type: "message.updated",
      properties: { sessionID: "session-1", info: terminal },
    });
    await flush();
    releasePreflight.resolve(undefined);

    for (;;) {
      const event = await nextEvent(iterator);
      if (event.type === "turn.completed") {
        expect(event.outcome).toMatchObject({
          status: "succeeded",
          checkpoint: { checkpointId: terminal.id },
        });
        break;
      }
    }
    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial",
      "orphaned adjustment",
    ]);
    await session.close();
    await adapter.close();
  });

  it("does not admit recovery after a transient Interaction during preflight", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-interaction-during-recovery-preflight", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "interaction-during-recovery-initial",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-interaction-preflight");
    await session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "orphaned adjustment" }],
    });
    await flush();

    const originalGetMessages = transport.getMessages.bind(transport);
    const preflightStarted = Promise.withResolvers<undefined>();
    const releasePreflight = Promise.withResolvers<undefined>();
    let messageReads = 0;
    transport.getMessages = async (sessionID) => {
      messageReads += 1;
      const snapshot = await originalGetMessages(sessionID);
      if (messageReads === 3) {
        preflightStarted.resolve(undefined);
        await releasePreflight.promise;
      }
      return snapshot;
    };
    transport.status = { type: "idle" };
    transport.emit({
      id: "interaction-during-recovery-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await preflightStarted.promise;

    transport.emit({
      id: "interaction-during-recovery-opened",
      type: "question.asked",
      properties: {
        id: "recovery-preflight-question",
        sessionID: "session-1",
        questions: [
          {
            header: "Continue",
            question: "Choose how to continue",
            options: [{ label: "A", description: "First" }],
            multiple: false,
            custom: false,
          },
        ],
      },
    });
    await expect(nextOutput(iterator)).resolves.toMatchObject({
      kind: "interaction",
      interaction: { type: "question", interactionId: "recovery-preflight-question" },
    });
    transport.emit({
      id: "interaction-during-recovery-closed",
      type: "question.rejected",
      properties: { sessionID: "session-1", requestID: "recovery-preflight-question" },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "interaction.closed",
      interactionId: "recovery-preflight-question",
    });
    releasePreflight.resolve(undefined);
    await vi.waitFor(() => expect(messageReads).toBeGreaterThanOrEqual(4));
    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial",
      "orphaned adjustment",
    ]);

    await expect(session.execute({ type: "turn.cancel", turnId: active.turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    transport.emit({
      id: "interaction-during-recovery-cancelled",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await session.close();
    await adapter.close();
  });

  it("lets a newer steer replace recovery while its idle preflight is pending", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-during-recovery-preflight", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "steer-during-recovery-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-recovery-preflight");
    await session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "orphaned adjustment" }],
    });
    await flush();

    const originalGetMessages = transport.getMessages.bind(transport);
    const preflightStarted = Promise.withResolvers<undefined>();
    const releasePreflight = Promise.withResolvers<undefined>();
    let messageReads = 0;
    transport.getMessages = async (sessionID) => {
      messageReads += 1;
      // Idle reconciliation reads once before and once after the grace timer.
      // The third read is the recovery admission's final preflight.
      if (messageReads === 3) {
        preflightStarted.resolve(undefined);
        await releasePreflight.promise;
      }
      return originalGetMessages(sessionID);
    };
    transport.status = { type: "idle" };
    transport.emit({
      id: "steer-during-recovery-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await preflightStarted.promise;

    const latestSteer = session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "newer adjustment" }],
    });
    await flush();
    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial",
      "orphaned adjustment",
    ]);
    releasePreflight.resolve(undefined);
    await expect(latestSteer).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial",
      "orphaned adjustment",
      "newer adjustment",
    ]);
    const latestPrompt = transport.promptCalls[2];
    if (!latestPrompt) throw new Error("OpenCode latest steer prompt is missing");
    appendTerminalForPrompt(transport, latestPrompt, "assistant-after-newer-steer");
    transport.status = { type: "busy" };
    transport.emit({
      id: "steer-during-recovery-resumed",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "steer-during-recovery-completed",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    for (;;) {
      const event = await nextEvent(iterator);
      if (event.type === "turn.completed") {
        expect(event.outcome).toMatchObject({
          status: "succeeded",
          checkpoint: { checkpointId: "assistant-after-newer-steer" },
        });
        break;
      }
    }
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [
              { text: "initial" },
              { text: "orphaned adjustment" },
              { text: "newer adjustment" },
            ],
          },
        ],
      },
    });
    await session.close();
    await adapter.close();
  });

  it("does not admit recovery when cancellation enters during its idle preflight", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-cancel-during-recovery-preflight", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "cancel-during-recovery-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "orphaned adjustment" }],
    });
    await flush();

    const originalGetMessages = transport.getMessages.bind(transport);
    const preflightStarted = Promise.withResolvers<undefined>();
    const releasePreflight = Promise.withResolvers<undefined>();
    let messageReads = 0;
    transport.getMessages = async (sessionID) => {
      messageReads += 1;
      if (messageReads === 3) {
        preflightStarted.resolve(undefined);
        await releasePreflight.promise;
      }
      return originalGetMessages(sessionID);
    };
    transport.status = { type: "idle" };
    transport.emit({
      id: "cancel-during-recovery-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await preflightStarted.promise;

    const cancellation = session.execute({ type: "turn.cancel", turnId: active.turnId });
    await flush();
    expect(transport.aborts).toBe(0);
    releasePreflight.resolve(undefined);
    await expect(cancellation).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.aborts).toBe(1);
    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial",
      "orphaned adjustment",
    ]);
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
      nativeTurnRef: { nativeTurnKey: transport.promptCalls[0]?.messageID },
    });
    await session.close();
    await adapter.close();
  });

  it("does not create a recovery prompt for an unanswered root prompt", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-root-without-assistant", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "root-without-assistant-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "root-without-assistant-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(transport.promptCalls.map(({ text }) => text)).toEqual(["initial"]);

    transport.emit({
      id: "root-without-assistant-error",
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: { name: "UnknownError", data: { message: "synthetic cleanup failure" } },
      },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({ type: "turn.completed" });
    await session.close();
    await adapter.close();
  });

  it("does not create a recovery prompt after steering admission fails", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-failed-steer-without-assistant", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "failed-steer-without-assistant-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.promptError = new Error("synthetic admission failure");
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "failed adjustment" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    transport.promptError = undefined;
    transport.status = { type: "idle" };
    transport.emit({
      id: "failed-steer-without-assistant-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(transport.promptCalls.map(({ text }) => text)).toEqual(["initial", "failed adjustment"]);

    transport.emit({
      id: "failed-steer-without-assistant-error",
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: { name: "UnknownError", data: { message: "synthetic cleanup failure" } },
      },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({ type: "turn.completed" });
    await session.close();
    await adapter.close();
  });

  it("does not finish a Turn when steering arrives before terminal reconciliation commits", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-race", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "race-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-steer");

    const transcriptReadStarted = Promise.withResolvers<undefined>();
    const releaseTranscriptRead = Promise.withResolvers<undefined>();
    const originalGetMessages = transport.getMessages.bind(transport);
    let blockOnce = true;
    transport.getMessages = async (sessionID) => {
      if (blockOnce) {
        blockOnce = false;
        transcriptReadStarted.resolve(undefined);
        await releaseTranscriptRead.promise;
      }
      return originalGetMessages(sessionID);
    };
    transport.status = { type: "idle" };
    transport.emit({
      id: "race-idle-before-steer",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await transcriptReadStarted.promise;

    const steering = session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "adjust while finishing" }],
      clientUserMessageId: "race-steer",
    });
    await expect(steering).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    releaseTranscriptRead.resolve(undefined);
    await flush();
    const pending = iterator.next();
    const completedEarly = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(completedEarly).toBe(false);

    const steerPrompt = transport.promptCalls[1];
    if (!steerPrompt) throw new Error("OpenCode steer prompt is missing");
    appendTerminalForPrompt(transport, steerPrompt, "assistant-after-steer");
    transport.status = { type: "busy" };
    transport.emit({
      id: "race-busy-after-steer",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "race-idle-after-steer",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: {
        kind: "event",
        event: {
          type: "turn.completed",
          outcome: { checkpoint: { checkpointId: "assistant-after-steer" } },
        },
      },
    });
    await session.close();
    await adapter.close();
  });

  it("rejects late steering after transcript reconciliation observes terminal idle", async () => {
    const transport = new FakeOpenCodeTransport();
    transport.emitPromptUserEvents = false;
    const { adapter, session } = await openFixture(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-after-native-terminal", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "late-steer-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-late-steer");
    const diffStarted = Promise.withResolvers<undefined>();
    const releaseDiff = Promise.withResolvers<undefined>();
    const originalGetDiff = transport.getDiff.bind(transport);
    let blockOnce = true;
    transport.getDiff = async (sessionID, messageID) => {
      if (blockOnce) {
        blockOnce = false;
        diffStarted.resolve(undefined);
        await releaseDiff.promise;
      }
      return originalGetDiff(sessionID, messageID);
    };
    transport.status = { type: "idle" };
    transport.emit({
      id: "late-steer-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await diffStarted.promise;

    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "too late" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(transport.promptCalls.map(({ text }) => text)).toEqual(["initial"]);
    releaseDiff.resolve(undefined);
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
    await adapter.close();
  });

  it("keeps steering open for an intermediate terminal Assistant while native state is busy", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-after-intermediate-assistant", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "intermediate-assistant-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    const intermediate = appendTerminalForPrompt(
      transport,
      rootPrompt,
      "assistant-intermediate-tool-segment",
    );
    transport.emit({
      id: "intermediate-assistant-terminal",
      type: "message.updated",
      properties: { sessionID: "session-1", info: intermediate },
    });

    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "adjust during tool execution" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    const steerPrompt = transport.promptCalls[1];
    if (!steerPrompt) throw new Error("OpenCode steer prompt is missing");
    appendTerminalForPrompt(transport, steerPrompt, "assistant-after-tool-steer");
    transport.status = { type: "idle" };
    transport.emit({
      id: "intermediate-assistant-final-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
    await adapter.close();
  });

  it("waits for a pending steering admission without reconciliation polling", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-pending", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "pending-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const originalPrompt = transport.promptAsync.bind(transport);
    const steerStarted = Promise.withResolvers<undefined>();
    const releaseSteer = Promise.withResolvers<undefined>();
    transport.promptAsync = async (input) => {
      if (input.text === "slow adjustment") {
        steerStarted.resolve(undefined);
        await releaseSteer.promise;
      }
      return originalPrompt(input);
    };
    const messagesSpy = vi.spyOn(transport, "getMessages");
    const steering = session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "slow adjustment" }],
    });
    await steerStarted.promise;
    const callsBeforeIdle = messagesSpy.mock.calls.length;
    transport.status = { type: "idle" };
    transport.emit({
      id: "pending-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messagesSpy.mock.calls.length - callsBeforeIdle).toBe(1);

    releaseSteer.resolve(undefined);
    await expect(steering).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    const steerPrompt = transport.promptCalls.at(-1);
    if (!steerPrompt) throw new Error("OpenCode steer prompt is missing");
    appendTerminalForPrompt(transport, steerPrompt, "assistant-after-pending-steer");
    transport.emit({
      id: "pending-final-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
    await adapter.close();
  });

  it("defers a native Session error until in-flight steering is reconciled", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-session-error", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "session-error-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const originalPrompt = transport.promptAsync.bind(transport);
    const steerStarted = Promise.withResolvers<undefined>();
    const releaseSteer = Promise.withResolvers<undefined>();
    transport.promptAsync = async (input) => {
      if (input.text === "adjust before error") {
        steerStarted.resolve(undefined);
        await releaseSteer.promise;
      }
      return originalPrompt(input);
    };
    const steering = session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "adjust before error" }],
    });
    await steerStarted.promise;
    transport.emit({
      id: "session-error-during-steer",
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: { name: "UnknownError", data: { message: "synthetic native failure" } },
      },
    });
    const completion = iterator.next();
    const completedBeforeAdmission = await Promise.race([
      completion.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(completedBeforeAdmission).toBe(false);
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "late adjustment" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    releaseSteer.resolve(undefined);
    await expect(steering).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    expect(transport.promptCalls.map(({ text }) => text)).toEqual([
      "initial",
      "adjust before error",
    ]);
    const completed = await completion;
    expect(completed).toMatchObject({
      done: false,
      value: {
        kind: "event",
        event: {
          type: "turn.completed",
          outcome: {
            status: "failed",
            error: { code: "nativeFailure", message: "synthetic native failure" },
          },
          nativeTurnRef: { nativeTurnKey: transport.promptCalls[0]?.messageID },
        },
      },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "session-error-late-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await session.close();
    await adapter.close();
  });

  it("reports a transport fault as failed after cancellation was already requested", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-fault-after-cancel", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "fault-after-cancel-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await expect(session.execute({ type: "turn.cancel", turnId: active.turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.aborts).toBe(1);

    transport.status = { type: "idle" };
    transport.listener?.onFault(
      new OpenCodeTransportError("unavailable", "synthetic fault after cancel"),
    );
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "turn.completed",
      turnId: active.turnId,
      outcome: {
        status: "failed",
        error: { code: "unavailable", message: "synthetic fault after cancel" },
      },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.faulted",
      error: { code: "unavailable", message: "synthetic fault after cancel" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await session.close();
    await adapter.close();
  });

  it("settles a transport fault behind in-flight steering before ending output", async () => {
    const { adapter, session, transport, connection } = await openFixture(
      new FakeOpenCodeTransport(),
      { closeTimeoutMs: 10 },
    );
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-transport-fault", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "transport-fault-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const originalPrompt = transport.promptAsync.bind(transport);
    const steerStarted = Promise.withResolvers<undefined>();
    const releaseSteer = Promise.withResolvers<undefined>();
    transport.promptAsync = async (input) => {
      if (input.text === "adjust before transport fault") {
        steerStarted.resolve(undefined);
        await releaseSteer.promise;
      }
      return originalPrompt(input);
    };
    const steering = session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "adjust before transport fault" }],
    });
    await steerStarted.promise;
    transport.listener?.onFault(
      new OpenCodeTransportError("unavailable", "synthetic transport fault"),
    );
    await flush();
    const closing = session.close();
    const completion = iterator.next();
    const [completedBeforeAdmission, closedBeforeAdmission] = await Promise.all([
      Promise.race([
        completion.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
      ]),
      Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
      ]),
    ]);
    expect(completedBeforeAdmission).toBe(false);
    expect(closedBeforeAdmission).toBe(false);
    expect(transport.aborts).toBe(0);
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "late adjustment" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    releaseSteer.resolve(undefined);
    await expect(steering).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    await expect(completion).resolves.toMatchObject({
      done: false,
      value: {
        kind: "event",
        event: {
          type: "turn.completed",
          outcome: {
            status: "failed",
            error: { code: "unavailable", message: "synthetic transport fault" },
          },
          nativeTurnRef: { nativeTurnKey: transport.promptCalls[0]?.messageID },
        },
      },
    });
    expect(transport.aborts).toBe(1);
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.faulted",
      error: { code: "unavailable", message: "synthetic transport fault" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => {
      expect(transport.closed).toBe(1);
      expect(connection.closed).toBe(1);
    });
    await expect(closing).resolves.toBeUndefined();
    expect(transport.closed).toBe(1);
    expect(connection.closed).toBe(1);
    await adapter.close();
  });

  it("waits for an admitted steer to become transcript-visible after a fault", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-delayed-visibility-fault", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "delayed-visibility-fault-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-delayed-visibility-fault");

    const originalPrompt = transport.promptAsync.bind(transport);
    transport.promptAsync = async (input) => {
      await originalPrompt(input);
      if (input.text !== "adjust with delayed visibility") return;
      const messages = transport.messages.get(input.sessionID) ?? [];
      transport.messages.set(
        input.sessionID,
        messages.filter(({ info }) => info.id !== input.messageID),
      );
    };
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "adjust with delayed visibility" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    await flush();
    const latePrompt = transport.promptCalls[1];
    if (!latePrompt) throw new Error("OpenCode delayed steer prompt is missing");

    const originalGetMessages = transport.getMessages.bind(transport);
    const firstFaultRead = Promise.withResolvers<undefined>();
    let faultReadSignalled = false;
    transport.getMessages = async (sessionID) => {
      const snapshot = await originalGetMessages(sessionID);
      if (!faultReadSignalled) {
        faultReadSignalled = true;
        firstFaultRead.resolve(undefined);
      }
      return snapshot;
    };
    transport.status = { type: "idle" };
    transport.listener?.onFault(
      new OpenCodeTransportError("unavailable", "synthetic delayed visibility stream loss"),
    );
    await firstFaultRead.promise;

    transport.messages
      .get("session-1")
      ?.push(
        userMessage(latePrompt.messageID, latePrompt.text),
        assistantMessage("assistant-after-delayed-visibility-fault", latePrompt.messageID),
      );
    transport.diffs.set(latePrompt.messageID, [
      {
        file: "src/delayed-steer.ts",
        patch: "@@ -1 +1 @@\n-before\n+after",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);

    const outputs: HarnessOutput[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      outputs.push(next.value);
    }
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.started",
            item: expect.objectContaining({
              type: "fileChange",
              changes: [expect.objectContaining({ path: "src/delayed-steer.ts" })],
            }),
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: { status: "failed", error: expect.objectContaining({ code: "unavailable" }) },
            nativeTurnRef: expect.objectContaining({ nativeTurnKey: rootPrompt.messageID }),
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({ type: "session.faulted" }),
        }),
      ]),
    );
    await session.close();
    await adapter.close();
  });

  it("reconciles a steer that persists late after prompt admission loses its response", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-late-persisted-fault", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "late-persisted-fault-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-late-persisted-fault");

    const originalPrompt = transport.promptAsync.bind(transport);
    transport.promptAsync = async (input) => {
      if (input.text !== "adjust with lost response") return originalPrompt(input);
      transport.promptError = new OpenCodeTransportError(
        "unavailable",
        "synthetic prompt response loss",
      );
      try {
        await originalPrompt(input);
      } finally {
        transport.promptError = undefined;
      }
    };
    const originalGetMessages = transport.getMessages.bind(transport);
    const firstFaultRead = Promise.withResolvers<undefined>();
    let rejectAdmissionRead = true;
    let faultStarted = false;
    let faultReadSignalled = false;
    transport.getMessages = async (sessionID) => {
      if (rejectAdmissionRead) {
        rejectAdmissionRead = false;
        throw new OpenCodeTransportError("unavailable", "synthetic admission transcript outage");
      }
      const snapshot = await originalGetMessages(sessionID);
      if (faultStarted && !faultReadSignalled) {
        faultReadSignalled = true;
        firstFaultRead.resolve(undefined);
      }
      return snapshot;
    };

    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "adjust with lost response" }],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", message: "synthetic prompt response loss" },
    });
    await flush();
    const latePrompt = transport.promptCalls[1];
    if (!latePrompt) throw new Error("OpenCode late steer prompt is missing");
    transport.status = { type: "idle" };
    faultStarted = true;
    transport.listener?.onFault(new OpenCodeTransportError("unavailable", "synthetic stream loss"));
    await firstFaultRead.promise;

    transport.messages
      .get("session-1")
      ?.push(
        userMessage(latePrompt.messageID, latePrompt.text),
        assistantMessage(
          "assistant-after-late-persisted-fault",
          latePrompt.messageID,
          [],
          undefined,
        ),
      );
    transport.diffs.set(latePrompt.messageID, [
      {
        file: "src/late-steer.ts",
        patch: "@@ -1 +1 @@\n-before\n+after",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);

    const outputs: HarnessOutput[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      outputs.push(next.value);
    }
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.started",
            item: expect.objectContaining({
              type: "fileChange",
              changes: [expect.objectContaining({ path: "src/late-steer.ts" })],
            }),
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: { status: "failed", error: expect.objectContaining({ code: "unavailable" }) },
            nativeTurnRef: expect.objectContaining({ nativeTurnKey: rootPrompt.messageID }),
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({ type: "session.faulted" }),
        }),
      ]),
    );
    await session.close();
    await adapter.close();
  });

  it("compares identified steering retries by structured input", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-structured-retry", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "structured-retry-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
        clientUserMessageId: "structured-retry",
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "first\nsecond" }],
        clientUserMessageId: "structured-retry",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(transport.promptCalls.map(({ text }) => text)).toEqual(["initial", "first\nsecond"]);

    const steerPrompt = transport.promptCalls.at(-1);
    if (!steerPrompt) throw new Error("OpenCode steer prompt is missing");
    appendTerminalForPrompt(transport, steerPrompt, "assistant-structured-retry");
    transport.status = { type: "idle" };
    transport.emit({
      id: "structured-retry-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
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
    const promptID = transport.promptCalls.at(-1)?.messageID;
    if (!promptID) throw new Error("OpenCode prompt has no Message ID");
    transport.emit({
      id: "assistant-reasoning",
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: assistantMessage("assistant-live", promptID).info,
      },
    });
    await flush();
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
    const promptID = transport.promptCalls.at(-1)?.messageID;
    if (!promptID) throw new Error("OpenCode prompt has no Message ID");
    transport.emit({
      id: "assistant-interactions",
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: assistantMessage("assistant-live", promptID).info,
      },
    });
    await flush();
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

  it("serializes cancellation behind admitted steering and rejects queued steering", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-cancel", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "steer-cancel-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const originalPrompt = transport.promptAsync.bind(transport);
    const firstSteerStarted = Promise.withResolvers<undefined>();
    const releaseFirstSteer = Promise.withResolvers<undefined>();
    transport.promptAsync = async (input) => {
      if (input.text === "first adjustment") {
        firstSteerStarted.resolve(undefined);
        await releaseFirstSteer.promise;
      }
      return originalPrompt(input);
    };
    const firstSteerCommand = {
      type: "turn.steer" as const,
      turnId: active.turnId,
      input: [{ type: "text" as const, text: "first adjustment" }],
      clientUserMessageId: "cancel-steer-1",
    };
    const firstSteer = session.execute(firstSteerCommand);
    await firstSteerStarted.promise;
    const queuedSteer = session.execute({
      type: "turn.steer",
      turnId: active.turnId,
      input: [{ type: "text", text: "must not run" }],
      clientUserMessageId: "cancel-steer-2",
    });
    const cancellation = session.execute({ type: "turn.cancel", turnId: active.turnId });
    const firstSteerRetryAfterCancel = session.execute(firstSteerCommand);
    await expect(
      session.execute({
        ...firstSteerCommand,
        input: [{ type: "text", text: "conflicting adjustment" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await flush();
    expect(transport.aborts).toBe(0);

    releaseFirstSteer.resolve(undefined);
    await expect(firstSteer).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    await expect(firstSteerRetryAfterCancel).resolves.toEqual({
      ok: true,
      value: { turnId: active.turnId },
    });
    await expect(queuedSteer).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(cancellation).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    await expect(session.execute({ type: "turn.cancel", turnId: active.turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.aborts).toBe(1);
    expect(transport.promptCalls.map(({ text }) => text)).toEqual(["initial", "first adjustment"]);

    const rootPrompt = transport.promptCalls[0];
    if (!rootPrompt) throw new Error("OpenCode root prompt is missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-root-aborted", [], {
      name: "MessageAbortedError",
      data: { message: "aborted" },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "steer-cancel-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const completed = await nextEvent(iterator);
    expect(completed).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
      nativeTurnRef: { nativeTurnKey: rootPrompt.messageID },
    });
    if (completed.type !== "turn.completed") throw new Error("Expected Turn completion");
    expect("checkpoint" in completed.outcome).toBe(false);
    await session.close();
    await adapter.close();
  });

  it("waits for an admitted steering message to persist before completing cancellation", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-steer-delayed-persistence", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "delayed-persistence-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const originalPrompt = transport.promptAsync.bind(transport);
    transport.promptAsync = async (input) => {
      if (input.text !== "delayed adjustment") return originalPrompt(input);
      if (!input.messageID) throw new Error("Expected a caller-supplied steering Message ID");
      transport.promptCalls.push({ ...input, messageID: input.messageID });
    };
    await expect(
      session.execute({
        type: "turn.steer",
        turnId: active.turnId,
        input: [{ type: "text", text: "delayed adjustment" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: active.turnId } });
    await expect(session.execute({ type: "turn.cancel", turnId: active.turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });

    const [rootPrompt, steerPrompt] = transport.promptCalls;
    if (!rootPrompt || !steerPrompt) throw new Error("OpenCode prompt IDs are missing");
    appendTerminalForPrompt(transport, rootPrompt, "assistant-before-delayed-persistence", [], {
      name: "MessageAbortedError",
      data: { message: "aborted" },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "delayed-persistence-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    const completion = iterator.next();
    const completedBeforePersistence = await Promise.race([
      completion.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(completedBeforePersistence).toBe(false);

    const persistedSteer = userMessage(steerPrompt.messageID, steerPrompt.text);
    transport.messages.get("session-1")?.push(persistedSteer);
    transport.emit({
      id: "delayed-persistence-user",
      type: "message.updated",
      properties: { sessionID: "session-1", info: persistedSteer.info },
    });
    await expect(completion).resolves.toMatchObject({
      done: false,
      value: {
        kind: "event",
        event: {
          type: "turn.completed",
          outcome: { status: "cancelled" },
          nativeTurnRef: { nativeTurnKey: rootPrompt.messageID },
        },
      },
    });
    await session.close();
    await adapter.close();
  });

  it("shares native cancellation between an explicit cancel and Session close", async () => {
    const { adapter, session, transport } = await openFixture();
    const iterator = session.outputs[Symbol.asyncIterator]();
    const active = turn("turn-cancel-close", "initial");
    await session.execute(active);
    await nextEvent(iterator);
    transport.status = { type: "busy" };
    transport.emit({
      id: "cancel-close-busy",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });

    const cancellation = session.execute({ type: "turn.cancel", turnId: active.turnId });
    const closing = session.close();
    await expect(cancellation).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.aborts).toBe(1);

    appendTerminal(transport, [], {
      name: "MessageAbortedError",
      data: { message: "aborted" },
    });
    transport.status = { type: "idle" };
    transport.emit({
      id: "cancel-close-idle",
      type: "session.status",
      properties: { sessionID: "session-1", status: transport.status },
    });
    await closing;
    expect(transport.aborts).toBe(1);
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
    const rollbackSource = rollbackTransport.sessions.get("session-1");
    if (!rollbackSource) throw new Error("Rollback source Session is missing");
    rollbackSource.model = {
      providerID: "provider-1",
      id: "model-1",
      variant: "high",
    };
    rollbackSource.permission = [{ permission: "*", pattern: "*", action: "allow" }];
    const rollbackFixture = await openAdapterWithInput(rollbackTransport, {
      kind: "rollbackLastTurn",
      sourceRef,
      cwd,
    });
    expect(rollbackTransport.forkCalls).toEqual([{ sessionID: "session-1", messageID: "user-2" }]);
    expect(rollbackTransport.revertCalls).toEqual([]);
    expect(rollbackFixture.session.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "session-fork" },
      effectiveThinkingOptionId: expect.any(String),
      effectivePermissionModeId: "allow",
    });
    await expect(rollbackFixture.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "one" }] }] },
    });
    expect(rollbackTransport.messages.get("session-1")).toEqual(sourceMessages);
    expect(rollbackTransport.sessions.get("session-1")).not.toHaveProperty("revert");
    await rollbackFixture.session.close();
    await rollbackFixture.adapter.close();
  });

  it("rolls back a final steered Turn from its root native message", async () => {
    const generator = new OpenCodeMessageIdGenerator();
    const group = generator.createGroup("adapter-last-steered-turn");
    const root = generator.next(group, 1_000);
    const steer = generator.next(group, 1_001);
    const recovery = generator.nextRecovery(group, 1_002);
    const sourceMessages = [
      userMessage("prefix-user", "prefix"),
      assistantMessage("prefix-assistant", "prefix-user"),
      userMessage(root, "initial"),
      assistantMessage("assistant-root", root),
      userMessage(steer, "adjust"),
      assistantMessage("assistant-steer", steer),
      userMessage(recovery, "recover"),
      assistantMessage("assistant-recovery", recovery),
    ];
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", sourceMessages);

    const fixture = await openAdapterWithInput(transport, {
      kind: "rollbackLastTurn",
      sourceRef,
      cwd,
    });

    expect(transport.forkCalls).toEqual([{ sessionID: "session-1", messageID: root }]);
    await expect(fixture.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "prefix" }] }] },
    });
    expect(transport.messages.get("session-1")).toEqual(sourceMessages);
    await fixture.session.close();
    await fixture.adapter.close();
  });

  it("accepts a rollback Fork that regenerates Native history identities", async () => {
    const sourceMessages = [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1", [
        {
          id: "answer-source-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "text",
          text: "answer one",
        },
      ]),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ];
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", sourceMessages);
    transport.forkSession = vi.fn(async (sessionID: string, messageID?: string) => {
      transport.forkCalls.push({ sessionID, ...(messageID ? { messageID } : {}) });
      const derived = nativeSession("session-fork");
      transport.sessions.set(derived.id, derived);
      transport.messages.set(derived.id, [
        userMessage("derived-user-1", "one", derived.id),
        assistantMessage(
          "derived-assistant-1",
          "derived-user-1",
          [
            {
              id: "answer-derived-1",
              sessionID: derived.id,
              messageID: "derived-assistant-1",
              type: "text",
              text: "answer one",
            },
          ],
          undefined,
          derived.id,
        ),
      ]);
      return derived;
    });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    const opened = await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd });
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(transport.forkCalls).toEqual([{ sessionID: "session-1", messageID: "user-2" }]);
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: {
              nativeSessionId: "session-fork",
              nativeTurnKey: "derived-user-1",
            },
            checkpoint: {
              nativeSessionId: "session-fork",
              checkpointId: "derived-assistant-1",
            },
            items: [{ item: { itemId: "answer-derived-1", text: "answer one" } }],
          },
        ],
      },
    });
    expect(transport.messages.get("session-1")).toEqual(sourceMessages);
    await opened.value.close();
    await adapter.close();
  });

  it("matches absolute Patch files to workspace-relative FileChanges", async () => {
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1", [
        {
          id: "patch-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "patch",
          hash: "snapshot-1",
          files: [`${cwd}/src/fixture.txt`],
        },
      ]),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ]);
    transport.diffs.set("user-1", [
      {
        file: "src/fixture.txt",
        patch: "@@ -1 +1 @@\n-before\n+after",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    const opened = await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd });
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) throw new Error(opened.error.message);
    const snapshot = await opened.value.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            type: "fileChange",
            changes: [expect.objectContaining({ path: "src/fixture.txt" })],
          }),
        }),
      ]),
    );
    await opened.value.close();
    await adapter.close();
  });

  it("anchors strict FileChange identity to the OpenCode worktree for a nested cwd", async () => {
    const nestedCwd = `${cwd}/packages/app`;
    const transport = new FakeOpenCodeTransport();
    const source = transport.sessions.get("session-1");
    if (!source) throw new Error("Source Session is missing");
    source.directory = nestedCwd;
    transport.paths = { directory: nestedCwd, worktree: cwd };
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1", [
        {
          id: "patch-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "patch",
          hash: "snapshot-1",
          files: [`${cwd}/src/shared.ts`],
        },
      ]),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ]);
    transport.diffs.set("user-1", [
      {
        file: "src/shared.ts",
        patch: "@@ -1 +1 @@\n-before\n+after",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: nestedCwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    const opened = await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd: nestedCwd });
    expect(opened).toMatchObject({ ok: true });
    if (opened.ok) await opened.value.close();
    await adapter.close();
  });

  it("rejects rollback when OpenCode cannot provide authoritative worktree paths", async () => {
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ]);
    transport.getPaths = vi.fn(async () => {
      throw new Error("synthetic Path failure");
    });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    await expect(adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd })).resolves.toMatchObject(
      { ok: false, error: { code: "protocolError" } },
    );
    expect(transport.forkCalls).toEqual([]);
    await adapter.close();
  });

  it("rejects a rollback Fork that changes a retained FileChange", async () => {
    const sourceMessages = [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ];
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", sourceMessages);
    transport.diffs.set("user-1", [
      {
        file: "fixture.txt",
        patch: "@@ -1 +1 @@\n-before\n+after",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);
    transport.forkSession = vi.fn(async (sessionID: string, messageID?: string) => {
      transport.forkCalls.push({ sessionID, ...(messageID ? { messageID } : {}) });
      const derived = nativeSession("session-fork");
      transport.sessions.set(derived.id, derived);
      transport.messages.set(derived.id, [
        userMessage("derived-user-1", "one", derived.id),
        assistantMessage("derived-assistant-1", "derived-user-1", [], undefined, derived.id),
      ]);
      transport.diffs.set("derived-user-1", [
        {
          file: "fixture.txt",
          patch: "@@ -1 +1 @@\n-before\n+unexpected",
          additions: 1,
          deletions: 1,
          status: "modified",
        },
      ]);
      return derived;
    });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    await expect(adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd })).resolves.toMatchObject(
      { ok: false, error: { code: "protocolError" } },
    );
    expect(transport.forkCalls).toEqual([{ sessionID: "session-1", messageID: "user-2" }]);
    expect(transport.sessions.has("session-fork")).toBe(false);
    expect(transport.messages.get("session-1")).toEqual(sourceMessages);
    expect(transport.diffs.get("user-1")).toEqual([
      expect.objectContaining({ patch: "@@ -1 +1 @@\n-before\n+after" }),
    ]);
    await adapter.close();
  });

  it("rejects a rollback Fork when retained FileChange history cannot be verified", async () => {
    const sourceMessages = [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ];
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", sourceMessages);
    transport.diffs.set("user-1", [
      {
        file: "fixture.txt",
        patch: "@@ -1 +1 @@\n-before\n+after",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);
    const readDiff = transport.getDiff.bind(transport);
    transport.getDiff = vi.fn(async (sessionID: string, messageID?: string) => {
      if (sessionID === "session-fork") {
        throw new Error("synthetic derived diff failure");
      }
      return readDiff(sessionID, messageID);
    });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    await expect(adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd })).resolves.toMatchObject(
      { ok: false, error: { code: "protocolError" } },
    );
    expect(transport.sessions.has("session-fork")).toBe(false);
    expect(transport.messages.get("session-1")).toEqual(sourceMessages);
    await adapter.close();
  });

  it("rejects rollback when a retained Patch never exposes a reliable FileChange", async () => {
    vi.useFakeTimers();
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1", [
        {
          id: "patch-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "patch",
          hash: "snapshot-1",
          files: ["fixture.txt"],
        },
      ]),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ]);
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    try {
      const opening = adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd });
      await vi.runAllTimersAsync();
      await expect(opening).resolves.toMatchObject({
        ok: false,
        error: { code: "protocolError" },
      });
      expect(transport.forkCalls).toEqual([]);
      expect(transport.messages.get("session-1")).toHaveLength(4);
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  it.each([
    {
      failure: "returns a mixed reliable and incomplete diff set",
      patchFiles: ["src/a.ts", "src/b.ts"],
      diffs: [
        {
          file: "src/a.ts",
          patch: "@@ -1 +1 @@\n-before a\n+after a",
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
        {
          file: "src/b.ts",
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
      ],
    },
    {
      failure: "omits one file named by the retained Patch",
      patchFiles: ["src/a.ts", "src/b.ts"],
      diffs: [
        {
          file: "src/a.ts",
          patch: "@@ -1 +1 @@\n-before a\n+after a",
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
      ],
    },
    {
      failure: "reports the same basename from a different directory",
      patchFiles: ["src/a.ts", "src/b.ts"],
      diffs: [
        {
          file: "src/a.ts",
          patch: "@@ -1 +1 @@\n-before a\n+after a",
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
        {
          file: "other/b.ts",
          patch: "@@ -1 +1 @@\n-before b\n+after b",
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
      ],
    },
    {
      failure: "only correlates an out-of-workspace traversal",
      patchFiles: ["src/a.ts", "/outside/b.ts"],
      diffs: [
        {
          file: "src/a.ts",
          patch: "@@ -1 +1 @@\n-before a\n+after a",
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
        {
          file: "../outside/b.ts",
          patch: "@@ -1 +1 @@\n-before b\n+after b",
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
      ],
    },
  ])("rejects rollback when OpenCode $failure", async ({ diffs, patchFiles }) => {
    vi.useFakeTimers();
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1", [
        {
          id: "patch-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "patch",
          hash: "snapshot-1",
          files: patchFiles,
        },
      ]),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ]);
    transport.diffs.set("user-1", diffs);
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    try {
      const opening = adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd });
      await vi.runAllTimersAsync();
      await expect(opening).resolves.toMatchObject({
        ok: false,
        error: { code: "protocolError" },
      });
      expect(transport.forkCalls).toEqual([]);
      expect(transport.messages.get("session-1")).toHaveLength(4);
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  it("keeps rollback candidate history reads strict through Host precommit validation", async () => {
    const sourceMessages = [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ];
    const transport = new FakeOpenCodeTransport();
    transport.messages.set("session-1", sourceMessages);
    transport.diffs.set("user-1", [
      {
        file: "fixture.txt",
        patch: "@@ -1 +1 @@\n-before\n+after",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);
    const opened = await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd });
    if (!opened.ok) throw new Error(opened.error.message);
    const readDiff = transport.getDiff.bind(transport);
    transport.getDiff = vi.fn(async (sessionID: string, messageID?: string) => {
      if (sessionID === "session-fork") {
        throw new Error("synthetic precommit diff failure");
      }
      return readDiff(sessionID, messageID);
    });

    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError" },
    });
    expect(transport.messages.get("session-1")).toEqual(sourceMessages);
    await opened.value.close();
    await adapter.close();
  });

  it("deletes a derived rollback Session when attachment fails without changing the source", async () => {
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
    expect(transport.forkCalls).toEqual([{ sessionID: "session-1", messageID: "user-1" }]);
    expect(transport.revertCalls).toEqual([]);
    expect(transport.unrevertCalls).toEqual([]);
    expect(transport.sessions.get("session-1")?.revert).toBeUndefined();
    expect(transport.sessions.get("session-1")).not.toHaveProperty("revert");
    expect(transport.sessions.has("session-fork")).toBe(false);
    await adapter.close();
  });

  it("does not delete the source when a rollback Fork aliases its Native Session", async () => {
    const transport = new FakeOpenCodeTransport();
    const sourceMessages = [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
    ];
    transport.messages.set("session-1", sourceMessages);
    const source = transport.sessions.get("session-1");
    if (!source) throw new Error("Rollback source Session is missing");
    transport.forkSession = vi.fn(async () => source);
    const deleteSession = vi.spyOn(transport, "deleteSession");
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    await expect(adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd })).resolves.toMatchObject(
      { ok: false, error: { code: "protocolError" } },
    );
    expect(deleteSession).not.toHaveBeenCalled();
    expect(transport.sessions.get("session-1")).toBe(source);
    expect(transport.messages.get("session-1")).toEqual(sourceMessages);
    await adapter.close();
  });

  it("deletes a rollback Fork whose retained transcript is the wrong same-length prefix", async () => {
    const transport = new FakeOpenCodeTransport();
    const sourceMessages = [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ];
    transport.messages.set("session-1", sourceMessages);
    transport.forkSession = vi.fn(async () => {
      const derived = nativeSession("session-fork");
      transport.sessions.set(derived.id, derived);
      transport.messages.set(derived.id, [
        userMessage("wrong-user", "wrong"),
        assistantMessage("wrong-assistant", "wrong-user"),
      ]);
      return derived;
    });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      locator: { directory: cwd },
      formatVersion: 1,
    });
    const adapter = adapterFor(transport);

    await expect(adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd })).resolves.toMatchObject(
      { ok: false, error: { code: "protocolError" } },
    );
    expect(transport.sessions.has("session-fork")).toBe(false);
    expect(transport.messages.get("session-1")).toEqual(sourceMessages);
    await adapter.close();
  });

  it("does not delete the source when a history Fork aliases its Native Session", async () => {
    const transport = new FakeOpenCodeTransport();
    const sourceMessages = [
      userMessage("user-1", "one"),
      assistantMessage("assistant-1", "user-1"),
      userMessage("user-2", "two"),
      assistantMessage("assistant-2", "user-2"),
    ];
    transport.messages.set("session-1", sourceMessages);
    const source = transport.sessions.get("session-1");
    if (!source) throw new Error("Fork source Session is missing");
    transport.forkSession = vi.fn(async () => source);
    const deleteSession = vi.spyOn(transport, "deleteSession");
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
    const adapter = adapterFor(transport);

    await expect(adapter.open({ kind: "fork", sourceRef, checkpoint, cwd })).resolves.toMatchObject(
      { ok: false, error: { code: "protocolError" } },
    );
    expect(deleteSession).not.toHaveBeenCalled();
    expect(transport.sessions.get("session-1")).toBe(source);
    expect(transport.messages.get("session-1")).toEqual(sourceMessages);
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
