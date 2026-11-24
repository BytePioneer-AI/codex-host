import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { decodeExternalTransportSelection } from "@codexhost/protocol-core";
import {
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import {
  AntigravityAdapter,
  type AntigravityAcpTransportLike,
} from "@codexhost/adapter-antigravity";
import {
  answerStep,
  createNativeHistoryDatabase,
  planModeSwitch,
  systemStep,
  userStep,
} from "../../../tests/fixtures/antigravity/native-history-fixture.js";
import { createExternalThreadRecordInput } from "../src/external-thread-repository.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

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

it.each([
  { boundary: 2, occupied: 2, next: 3 },
  { boundary: 377, occupied: 594, next: 594 },
])(
  "resumes sparse Antigravity history ($occupied → $boundary) and settles new Turns",
  async ({ boundary, occupied, next }) => {
    const home = mkdtempSync(path.join(tmpdir(), "codexhost-agy-turn-identity-"));
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const conversations = path.join(home, ".gemini", "antigravity-cli", "conversations");
    mkdirSync(conversations, { recursive: true });
    const db = new DatabaseSync(path.join(conversations, `${sessionId}.db`));
    db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);
  `);
    const insert = db.prepare("INSERT INTO steps VALUES (?, ?, 3, ?)");
    const visible = [...new Set([0, boundary, next - 1])];
    // Batch fixture writes to avoid a disk sync for every sparse history row.
    db.exec("BEGIN");
    for (let index = 0; index < next; index++) {
      if (visible.includes(index)) {
        insert.run(index * 2, 14, protoField(19, protoField(2, `history ${index}`)));
        insert.run(index * 2 + 1, 15, protoField(20, protoField(1, `reply ${index}`)));
      } else insert.run(index * 2, 14, protoField(19, ""));
    }
    db.exec("COMMIT");
    let liveIndex = next;
    const environment = { HOME: home, USERPROFILE: home };
    const adapter = new AntigravityAdapter({
      environment,
      createTransport: (): AntigravityAcpTransportLike => ({
        sessionId,
        isClosed: false,
        skipPermissions: false,
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        openSession: async () => ({ opened: { sessionId } }),
        setSessionEventHandler: () => {},
        setMode: async () => {},
        setConfigOption: async () => [],
        prompt: async ([part], handler) => {
          if (part?.type !== "text") throw new Error("Expected a text prompt");
          const index = liveIndex++;
          const reply = `reply to ${part.text}`;
          insert.run(index * 2, 14, protoField(19, protoField(2, part.text)));
          insert.run(index * 2 + 1, 15, protoField(20, protoField(1, reply)));
          handler.onEvent({ type: "agent.text", text: reply });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        closeSession: async () => {},
        close: async () => {},
      }),
    });
    const fixture = createFixture({
      environment,
      additionalAdapters: new Map([["antigravity", adapter]]),
    });
    try {
      await fixture.ready;
      const { hostThreadId: threadId } = await fixture.mappingStore.createProvisional(
        createExternalThreadRecordInput({
          harnessId: adapter.harnessId,
          cwd: home,
          transportModelId: encodeHarnessPluginRoute(
            harnessPluginRouteSchema.parse({ harnessId: adapter.harnessId }),
          ),
          ephemeral: false,
          historyMode: "paginated",
        }),
      );
      const nativeSessionRef = nativeSessionRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: sessionId,
        formatVersion: 1,
      });
      const mapping = (index: number, key = index) => ({
        hostTurnId: hostTurnIdSchema.parse(`saved-${index}`),
        nativeTurnRef: { ...nativeSessionRef, nativeTurnKey: `turn-${key}` },
        nativeCheckpointRef: { ...nativeSessionRef, checkpointId: `turn-${index}` },
      });
      await fixture.mappingStore.commitReady({
        hostThreadId: threadId,
        nativeSessionRef,
        turnMappings: visible.map((index) => mapping(index, index === boundary ? occupied : index)),
      });
      expect(await fixture.host.handleClientRequest("thread/resume", { threadId })).toHaveProperty(
        "result",
      );

      for (let index = next; index < next + 3; index++) {
        const offset = fixture.collector.messages.length;
        expect(
          await fixture.host.handleClientRequest("turn/start", {
            threadId,
            input: [{ type: "text", text: `live ${index}` }],
          }),
        ).toHaveProperty("result");
        await vi.waitFor(() =>
          expect(fixture.collector.messages.slice(offset)).toEqual(
            expect.arrayContaining([expect.objectContaining({ method: "turn/completed" })]),
          ),
        );
        expect(
          fixture.collector.messages
            .slice(offset)
            .find(({ method }) => method === "turn/completed"),
        ).toMatchObject({ params: { turn: { status: "completed" } } });
      }

      expect(await fixture.host.handleClientRequest("thread/resume", { threadId })).toHaveProperty(
        "result",
      );
      const saved = await fixture.mappingStore.getThread(threadId);
      expect(saved?.failedTurns ?? []).toEqual([]);
      expect(saved?.turnMappings.slice(0, visible.length)).toEqual(
        visible.map((index) => mapping(index)),
      );
      expect(
        saved?.turnMappings
          .slice(visible.length)
          .map(({ nativeTurnRef, nativeCheckpointRef }) => [
            nativeTurnRef.nativeTurnKey,
            nativeCheckpointRef?.checkpointId,
          ]),
      ).toEqual(
        Array.from({ length: 3 }, (_, offset) => [
          `turn-${next + offset}`,
          `turn-${next + offset}`,
        ]),
      );
      expect(fixture.diagnosticOutput.read()?.toString() ?? "").not.toContain("mapping conflicts");
    } finally {
      await stopFixture(fixture);
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

it("removes an obsolete Plan wake mapping on resume without rekeying neighboring Turns", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "codexhost-agy-plan-identity-"));
  const environment = { HOME: home, USERPROFILE: home };
  const adapter = new AntigravityAdapter({ environment });
  const nativeSessionRef = nativeSessionRefSchema.parse({
    harnessId: adapter.harnessId,
    nativeSessionId: "plan-history",
    formatVersion: 1,
  });
  const db = await createNativeHistoryDatabase(home, nativeSessionRef.nativeSessionId);
  try {
    userStep(db, 0, "Plan and implement", "plan");
    planModeSwitch(db, 1, "plan", "execute");
    answerStep(db, 4, "Execution reply", "execute");
    systemStep(db, 5, "wake", "task_notification");
    answerStep(db, 6, "Independent reply", "wake");
  } finally {
    db.close();
  }
  const fixture = createFixture({
    environment,
    additionalAdapters: new Map([[adapter.harnessId, adapter]]),
  });
  try {
    await fixture.ready;
    const { hostThreadId: threadId } = await fixture.mappingStore.createProvisional(
      createExternalThreadRecordInput({
        harnessId: adapter.harnessId,
        cwd: home,
        transportModelId: encodeHarnessPluginRoute(
          harnessPluginRouteSchema.parse({ harnessId: adapter.harnessId }),
        ),
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
    const mapping = (key: string) => ({
      hostTurnId: hostTurnIdSchema.parse(`saved-${key}`),
      nativeTurnRef: { ...nativeSessionRef, nativeTurnKey: key },
      nativeCheckpointRef: { ...nativeSessionRef, checkpointId: key },
    });
    const user = mapping("turn-0");
    const wake = mapping("wake-5");
    await fixture.mappingStore.commitReady({
      hostThreadId: threadId,
      nativeSessionRef,
      turnMappings: [user, mapping("wake-3"), wake],
    });
    expect(await fixture.host.handleClientRequest("thread/resume", { threadId })).toHaveProperty(
      "result",
    );
    expect((await fixture.mappingStore.getThread(threadId))?.turnMappings).toEqual([user, wake]);
    expect(
      await fixture.host.handleClientRequest("thread/turns/list", {
        threadId,
        sortDirection: "asc",
        itemsView: "full",
      }),
    ).toMatchObject({
      result: {
        data: [
          {
            id: user.hostTurnId,
            items: expect.arrayContaining([
              expect.objectContaining({ type: "agentMessage", text: "Execution reply" }),
            ]),
          },
          { id: wake.hostTurnId },
        ],
      },
    });
  } finally {
    await stopFixture(fixture);
    rmSync(home, { recursive: true, force: true });
  }
});

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
