import type { HostThreadSnapshot, OpenSessionInput } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  closeFixture,
  completePiTurn,
  createFixture,
  requestId,
  startExternalThread,
  startPiThread,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

/** The start of the boundary Desktop 26.1111 injects into every Side Chat. */
function boundary(threadId: string): string {
  return [
    "Side conversation boundary.",
    "Everything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task.",
    `Parent chat: ${JSON.stringify({ threadId, hostId: "local" })}`,
  ].join("  ");
}

async function call(
  fixture: Fixture,
  id: number,
  method: string,
  params: JsonObject,
): Promise<JsonObject> {
  writeRequest(fixture.desktopInput, { id, method, params });
  return fixture.collector.waitFor((message) => requestId(message, id));
}

/** Desktop's persistent Side Chat: an attached Fork, then its boundary. */
async function openSideChat(fixture: Fixture, sourceId: string, id: number): Promise<string> {
  const forked = await call(fixture, id, "thread/fork", {
    threadId: sourceId,
    attachToSource: true,
    excludeTurns: true,
  });
  const thread = (forked.result as JsonObject | undefined)?.thread as JsonObject | undefined;
  expect(thread).toMatchObject({ attachedToThreadId: sourceId, forkedFromId: sourceId });
  if (typeof thread?.id !== "string") throw new Error("Missing Side Chat ID");
  const injected = await call(fixture, id + 1, "thread/inject_items", {
    threadId: thread.id,
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: boundary(sourceId) }],
      },
    ],
  });
  expect(injected).toMatchObject({ result: {} });
  return thread.id;
}

/** Resumes a saved Native Session as a fresh Fake Session, as after a Host restart. */
class RestartedAdapter extends FakeHarnessAdapter {
  constructor(private readonly saved: ReadonlyMap<string, HostThreadSnapshot>) {
    super(harnessIdSchema.parse("pi"));
  }
  override async open(input: OpenSessionInput) {
    const snapshot = input.kind === "resume" && this.saved.get(input.nativeRef.nativeSessionId);
    if (input.kind !== "resume" || !snapshot) return super.open(input);
    const session = new FakeHarnessSession(
      this.harnessId,
      this.catalog,
      input.model,
      input.nativeRef,
      snapshot,
    );
    this.sessions.push(session);
    return { ok: true as const, value: session };
  }
}

describe("External Side Chats", () => {
  it("keeps inherited history as context and lists only the Side Chat's own Turns", async () => {
    const fixture = createFixture();
    let restarted: Fixture | undefined;
    try {
      const sourceId = await startExternalThread(fixture, "codexhost/pi-native", 1, {
        historyMode: "paginated",
      });
      await completePiTurn(fixture, sourceId, 2);
      const rejected = await call(fixture, 3, "thread/inject_items", {
        threadId: sourceId,
        items: [{ type: "function_call_output", call_id: "call", output: "result" }],
      });
      expect(rejected.error).toMatchObject({ code: -32602 });

      const sideChatId = await openSideChat(fixture, sourceId, 4);
      const started = await call(fixture, 6, "turn/start", {
        threadId: sideChatId,
        input: [{ type: "text", text: "question" }],
      });
      const turnId = ((started.result as JsonObject).turn as JsonObject).id as string;
      const session = fixture.adapter.sessions[1];
      if (!session) throw new Error("Missing Side Chat Session");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      session.appendText("answer");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) throw new Error("Missing Side Chat snapshot");
      // The Native Session keeps the inherited Turn; the boundary leads the first own input.
      expect(snapshot.value.turns.map(({ input }) => input[0]?.text)).toEqual([
        "synthetic",
        `${boundary(sourceId)}\n\nquestion`,
      ]);

      const saved = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(sideChatId));
      const nativeSessionId = saved?.nativeSessionRef?.nativeSessionId;
      if (!nativeSessionId) throw new Error("Missing Side Chat Native Session");
      await closeFixture(fixture);
      restarted = createFixture({
        mappingStoreDirectory: fixture.mappingStoreDirectory,
        externalAdapters: new Map([
          ["pi", new RestartedAdapter(new Map([[nativeSessionId, snapshot.value]]))],
        ]),
      });
      await restarted.ready;
      const listed = await call(restarted, 7, "thread/turns/list", {
        threadId: sideChatId,
        limit: 20,
        itemsView: "full",
      });
      const turns = (listed.result as JsonObject).data as JsonObject[];
      expect(turns.map(({ id }) => id)).toEqual([turnId]);
      const userMessage = (turns[0]?.items as JsonObject[]).find(
        (item) => item.type === "userMessage",
      );
      expect(userMessage?.content).toMatchObject([{ type: "text", text: "question" }]);
      const read = await call(restarted, 8, "thread/read", { threadId: sideChatId });
      expect(read.result).toMatchObject({ thread: { preview: "question" } });
    } finally {
      await stopFixture(restarted ?? fixture);
    }
  });

  it("attaches only to paginated sources and deletes a source after its Side Chats", async () => {
    const fixture = createFixture();
    try {
      const legacyId = await startPiThread(fixture);
      await completePiTurn(fixture, legacyId, 2);
      const legacy = await call(fixture, 3, "thread/fork", {
        threadId: legacyId,
        attachToSource: true,
      });
      expect(legacy.error).toMatchObject({ code: -32602 });

      const sourceId = await startExternalThread(fixture, "codexhost/pi-native", 4, {
        historyMode: "paginated",
      });
      await completePiTurn(fixture, sourceId, 5, 1);
      const sideChatId = await openSideChat(fixture, sourceId, 6);
      expect((await call(fixture, 8, "thread/delete", { threadId: sourceId })).error).toMatchObject(
        { code: -32602 },
      );
      expect(await call(fixture, 9, "thread/delete", { threadId: sideChatId })).toMatchObject({
        result: {},
      });
      // A Side Chat that never became ready is not listed, so it cannot block its source.
      await fixture.mappingStore.createProvisional({
        hostThreadId: hostThreadIdSchema.parse("unfinished-side-chat"),
        createRequestId: "unfinished-side-chat",
        harnessId: harnessIdSchema.parse("pi"),
        cwd: "/synthetic",
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "paginated",
        attachedToThreadId: hostThreadIdSchema.parse(sourceId),
      });
      expect(await call(fixture, 10, "thread/delete", { threadId: sourceId })).toMatchObject({
        result: {},
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
