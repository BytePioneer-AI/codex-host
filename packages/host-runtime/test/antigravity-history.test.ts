import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { decodeExternalTransportSelection } from "@codexhost/protocol-core";
import { encodeHarnessPluginRoute, harnessPluginRouteSchema } from "@codexhost/shared-contracts";
import {
  AntigravityAdapter,
  type AntigravityAcpTransportLike,
} from "@codexhost/adapter-antigravity";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import { createExternalThreadRecordInput } from "../src/external-thread-repository.js";
import { createFixture, startExternalThread, stopFixture } from "./app-server-host-fixture.js";

function protoField(field: number, value: string | Buffer): Buffer {
  const body = typeof value === "string" ? Buffer.from(value) : value;
  const tag = field * 8 + 2;
  const tagBytes = tag < 128 ? [tag] : [(tag & 0x7f) | 0x80, tag >> 7];
  return Buffer.concat([Buffer.from([...tagBytes, body.length]), body]);
}

function seedHistory(file: string, label: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);
    `);
    const insert = db.prepare("INSERT INTO steps VALUES (?, ?, 3, ?)");
    for (let i = 0; i < 12; i++) {
      insert.run(i * 2, 14, protoField(19, protoField(2, `${label} question ${i}`)));
      insert.run(i * 2 + 1, 15, protoField(20, protoField(1, `${label} answer ${i}`)));
    }
  } finally {
    db.close();
  }
}

it("returns and saves each confirmed configuration for queued cold agy selections", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "codexhost-agy-cold-config-"));
  const nativeSessionId = "11111111-1111-4111-8111-111111111111";
  const environment = { HOME: home, USERPROFILE: home };
  const modelGate = Promise.withResolvers<undefined>();
  const thinkingGate = Promise.withResolvers<undefined>();
  let config = [
    {
      id: "model",
      name: "Model",
      currentValue: "old",
      options: [
        { value: "old", name: "Old" },
        { value: "new", name: "New" },
      ],
    },
    {
      id: "thought_level",
      name: "Thinking",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];
  let handler: Parameters<AntigravityAcpTransportLike["setSessionEventHandler"]>[0];
  const setConfigOption = vi.fn(async (id: string, value: string) => {
    if (id === "model") {
      handler?.({ type: "config.update", configOptions: config });
      await modelGate.promise;
    } else {
      await thinkingGate.promise;
    }
    config = config.map((entry) =>
      entry.id === id || id === "model"
        ? { ...entry, currentValue: entry.id === id ? value : "low" }
        : entry,
    );
    return config;
  });
  const adapter = new AntigravityAdapter({
    environment,
    createTransport: (): AntigravityAcpTransportLike => ({
      sessionId: nativeSessionId,
      isClosed: false,
      skipPermissions: false,
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      openSession: async () => ({ opened: { sessionId: nativeSessionId, configOptions: config } }),
      setSessionEventHandler: (next) => {
        handler = next;
      },
      setConfigOption,
      setMode: async () => {},
      prompt: async () => {
        throw new Error("Configuration selection must not send a prompt");
      },
      cancel: async () => {},
      closeSession: async () => {},
      close: async () => {},
    }),
  });
  const fixture = createFixture({
    environment,
    mappingStoreDirectory: home,
    additionalAdapters: new Map([["antigravity", adapter]]),
  });
  try {
    await fixture.ready;
    const conversations = path.join(home, ".gemini", "antigravity-cli", "conversations");
    mkdirSync(conversations, { recursive: true });
    seedHistory(path.join(conversations, `${nativeSessionId}.db`), "old");
    const selection = { model: { id: "retired" }, thinkingOptionId: "high" };
    const transportModelId = encodeHarnessPluginRoute(
      harnessPluginRouteSchema.parse({ harnessId: adapter.harnessId, ...selection }),
    );
    const { hostThreadId: threadId } = await fixture.mappingStore.createProvisional(
      createExternalThreadRecordInput({
        harnessId: adapter.harnessId,
        cwd: home,
        title: "Cold configuration",
        transportModelId,
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
    await fixture.mappingStore.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: { harnessId: adapter.harnessId, nativeSessionId, formatVersion: 1 },
    });
    const modelReply = fixture.host.handleClientRequest("codexhost/thread/model/select", {
      threadId,
      model: { id: "new" },
    });
    await vi.waitFor(() => expect(setConfigOption).toHaveBeenCalledWith("model", "new"));
    const thinkingReply = fixture.host.handleClientRequest("codexhost/thread/thinking/select", {
      threadId,
      thinkingOptionId: "high",
    });
    expect(await fixture.mappingStore.getThread(threadId)).toMatchObject({ transportModelId });
    modelGate.resolve(undefined);
    expect(await modelReply).toMatchObject({
      result: { effectiveModel: { id: "new" }, effectiveThinkingOptionId: "low" },
    });
    const afterModel = await fixture.mappingStore.getThread(threadId);
    expect(decodeExternalTransportSelection("antigravity", afterModel?.transportModelId)).toEqual({
      model: { id: "new" },
      thinkingOptionId: "low",
    });
    thinkingGate.resolve(undefined);
    expect(await thinkingReply).toMatchObject({
      result: { effectiveModel: { id: "new" }, effectiveThinkingOptionId: "high" },
    });
    const saved = await fixture.mappingStore.getThread(threadId);
    expect(decodeExternalTransportSelection("antigravity", saved?.transportModelId)).toEqual({
      model: { id: "new" },
      thinkingOptionId: "high",
    });
  } finally {
    modelGate.resolve(undefined);
    thinkingGate.resolve(undefined);
    await stopFixture(fixture);
  }
});

it("reflects a catalog Skill reply in live agy history without moving local command output", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "codexhost-agy-command-history-"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const conversations = path.join(home, ".gemini", "antigravity-cli", "conversations");
  mkdirSync(conversations, { recursive: true });
  const db = new DatabaseSync(path.join(conversations, `${sessionId}.db`));
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);
  `);
  const insert = db.prepare("INSERT INTO steps VALUES (?, ?, 3, ?)");
  const skillPrompt = "/fixture-skill How should I test it?";
  const answer = "Use an isolated data directory.";
  const prompts: string[] = [];
  const environment = { HOME: home, USERPROFILE: home };
  const adapter = new AntigravityAdapter({
    environment,
    createTransport: (): AntigravityAcpTransportLike => ({
      sessionId,
      isClosed: false,
      skipPermissions: false,
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      openSession: async () => ({ opened: { sessionId } }),
      setSessionEventHandler: (handler) =>
        handler?.({
          type: "commands.update",
          commands: [
            { name: "fixture-skill", description: "Test a project" },
            { name: "quota", description: "Show a local result" },
          ],
        }),
      setMode: async () => {},
      setConfigOption: async () => [],
      prompt: async ([part], handler) => {
        if (part?.type !== "text") throw new Error("Expected a text prompt");
        prompts.push(part.text);
        if (part.text === "warm up" || part.text === skillPrompt) {
          const idx = part.text === skillPrompt ? 2 : 0;
          const reply = part.text === skillPrompt ? answer : "Ready.";
          insert.run(idx, 14, protoField(19, protoField(2, part.text)));
          insert.run(idx + 1, 15, protoField(20, protoField(1, reply)));
          handler.onEvent({ type: "agent.text", text: reply });
        } else {
          handler.onEvent({ type: "agent.text", text: `Local result for ${part.text}` });
        }
        return { stopReason: "end_turn" };
      },
      cancel: async () => {},
      closeSession: async () => {},
      close: async () => {},
    }),
  });
  let delegation: DelegationControlRegistration | undefined;
  const fixture = createFixture({
    environment,
    additionalAdapters: new Map([["antigravity", adapter]]),
    onDelegationApi: (api) => {
      delegation = api;
      return undefined;
    },
  });
  try {
    const threadId = await startExternalThread(
      fixture,
      encodeHarnessPluginRoute(harnessPluginRouteSchema.parse({ harnessId: "antigravity" })),
      1,
      { cwd: home },
    );
    const submit = async (text: string) => {
      const offset = fixture.collector.messages.length;
      expect(
        await fixture.host.handleClientRequest("turn/start", {
          threadId,
          input: [{ type: "text", text }],
        }),
      ).toHaveProperty("result");
      await vi.waitFor(() => {
        expect(fixture.collector.messages.slice(offset)).toEqual(
          expect.arrayContaining([expect.objectContaining({ method: "turn/completed" })]),
        );
      });
      return fixture.host.clientSnapshot(threadId);
    };
    await submit("warm up");
    const snapshot = await submit(
      "How should I test it? [@/fixture-skill](subagent://codexhost-command.fixture-skill)",
    );
    expect(prompts.at(-1)).toBe(skillPrompt);
    if (!delegation) throw new Error("Expected the delegation read API");
    const read = await delegation.read({ threadId, view: "messages" });
    expect(read.turns?.[0]).toMatchObject({
      messages: [
        expect.objectContaining({ role: "user", text: skillPrompt }),
        expect.objectContaining({ role: "agent", phase: "final", text: answer }),
      ],
    });
    expect(snapshot.turnsPage.data[0]).toMatchObject({
      id: read.turns?.[0]?.turnId,
      status: "completed",
      items: [
        { type: "userMessage", content: [{ type: "text", text: skillPrompt }] },
        { type: "agentMessage", phase: "final_answer", text: answer },
      ],
    });
    expect(snapshot.command?.turn.items).not.toContainEqual(
      expect.objectContaining({ type: "agentMessage" }),
    );
    const expectCommandCard = async (name: string) => {
      const command = await submit(`/${name}`);
      expect(prompts.at(-1)).toBe(`/${name}`);
      expect(command.turnsPage.data.map(({ id }) => id)).toEqual(
        snapshot.turnsPage.data.map(({ id }) => id),
      );
      expect(command.command).toMatchObject({
        name,
        turn: {
          status: "completed",
          items: expect.arrayContaining([
            expect.objectContaining({ type: "agentMessage", text: `Local result for /${name}` }),
          ]),
        },
      });
    };
    await expectCommandCard("compact");
    await expectCommandCard("quota");
    // An unavailable native count is not proof that a text-producing command became a Turn.
    db.exec("ALTER TABLE steps RENAME TO unavailable_steps");
    await expectCommandCard("quota");
  } finally {
    try {
      await stopFixture(fixture);
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});
