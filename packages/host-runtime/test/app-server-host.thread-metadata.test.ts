import { describe, expect, it, vi } from "vitest";
import type {
  HarnessSessionState,
  HarnessResult,
  TurnStartAccepted,
  TurnStartCommand,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { withFailedTurns } from "../src/external-turn-projection.js";

import {
  answerOfficialParentCwd,
  rollbackCapableAdapter,
  JsonLineCollector,
  closeFixture,
  createFixture,
  method,
  requestId,
  startPiThread,
  startPiTurn,
  turnEvent,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

/** A Harness that creates its native Session only when the first Turn starts. */
class DeferredNativeSessionAdapter extends FakeHarnessAdapter {
  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    const opened = await super.open(input);
    if (input.kind === "create" && opened.ok && opened.value instanceof FakeHarnessSession) {
      const state: HarnessSessionState = { ...opened.value.initialState };
      delete state.nativeRef;
      (opened.value as { initialState: HarnessSessionState }).initialState = state;
    }
    return opened;
  }
}

/** Answer official `project/read` sub-requests and empty `thread/list` pages. */
function answerOfficial(fixture: Fixture, projects: ReadonlySet<string>): JsonLineCollector {
  const official = new JsonLineCollector(fixture.official.stdin);
  fixture.official.stdin.on("data", () => {
    for (const request of official.messages.splice(0)) {
      const params = (request.params ?? {}) as JsonObject;
      const response =
        request.method === "project/read"
          ? projects.has(params.projectId as string)
            ? { id: request.id, result: { project: { id: params.projectId } } }
            : params.projectId === "mismatched"
              ? { id: request.id, result: { project: { id: "project-a" } } }
              : { id: request.id, error: { code: -32602, message: "project not found" } }
          : { id: request.id, result: { data: [], nextCursor: null, backwardsCursor: null } };
      fixture.official.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  return official;
}

async function updateMetadata(fixture: Fixture, id: number, params: JsonObject) {
  writeRequest(fixture.desktopInput, { id, method: "thread/metadata/update", params });
  return fixture.collector.waitFor((message) => requestId(message, id));
}

async function listIds(fixture: Fixture, id: number, params: JsonObject): Promise<string[]> {
  writeRequest(fixture.desktopInput, { id, method: "thread/list", params });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  return ((response.result as JsonObject).data as JsonObject[]).map((row) => row.id as string);
}

describe("External Thread failed history", () => {
  it.each(["refresh", "write failure", "reopen", "unavailable"])(
    "reads the accepted failed fifth Turn after %s",
    async (mode) => {
      let api: DelegationControlApi | undefined;
      const adapter = rollbackCapableAdapter();
      const fixture = createFixture({
        externalAdapters: new Map([["pi", adapter]]),
        onDelegationApi: (registration) => {
          api = registration;
        },
      });
      try {
        await fixture.ready;
        if (!api) throw new Error("No Delegation API");
        const starting = api.start({
          harnessId: "pi",
          task: "first input",
          cwd: "/synthetic",
          parentThreadId: "parent-thread",
        });
        await answerOfficialParentCwd(fixture);
        const { threadId, turnId: first } = await starting;
        const session = adapter.sessions[0];
        if (!session) throw new Error("Missing fake Session");
        const succeed = async (turnId: string) => {
          session.appendText("successful answer");
          session.succeedTurn();
          await fixture.collector.waitFor((message) =>
            turnEvent(message, "turn/completed", turnId),
          );
        };
        await succeed(first);
        const predecessors = [first];
        for (let index = 2; index <= 4; index++) {
          const { turnId } = await api.send({ threadId, message: `input ${index}` });
          await succeed(turnId);
          predecessors.push(turnId);
        }
        const previous = await session.readSnapshot();
        const snapshots = vi.spyOn(session, "readSnapshot").mockResolvedValue(previous);
        if (mode === "write failure") {
          vi.spyOn(fixture.mappingStore, "saveFailedTurn").mockRejectedValueOnce(
            new Error("metadata write failed"),
          );
        }
        if (mode === "unavailable") {
          vi.spyOn(adapter, "open").mockResolvedValue({
            ok: false,
            error: { code: "unavailable", message: "cannot reopen", retryable: false },
          });
        }
        const { turnId } = await api.send({
          threadId,
          message: "input missing from native history",
        });
        session.appendText("partial reply before failure");
        const failure = {
          code: "authenticationRequired",
          message: "not logged in",
          retryable: false,
        } as const;
        if (mode === "reopen" || mode === "unavailable") session.fault(failure);
        else session.failTurn(failure);
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        const expectedMessages = {
          totalTurns: 5,
          turns: [
            {
              turnId,
              turnNumber: 5,
              status: "failed",
              messages: [
                { role: "user", text: "input missing from native history" },
                { role: "agent", text: "partial reply before failure" },
              ],
            },
          ],
        };
        await expect(
          api.wait({ threadId, view: "messages", from: 5, timeoutMs: 1000 }),
        ).resolves.toMatchObject({
          ...expectedMessages,
          status: "failed",
          timedOut: false,
        });
        await expect(api.read({ threadId, view: "result" })).resolves.toMatchObject({
          status: "failed",
          turn: { turnId },
          result: { availability: "unavailable" },
        });
        const hostId = hostThreadIdSchema.parse(threadId);
        const record = await fixture.mappingStore.getThread(hostId);
        expect(record?.turnMappings.map(({ hostTurnId }) => hostTurnId)).toEqual(
          mode === "unavailable" ? [...predecessors, turnId] : predecessors,
        );
        const failureMetadata = {
          hostTurnId: turnId,
          afterTurnId: predecessors.at(-1),
          error: "authenticationRequired",
        };
        if (mode === "write failure") expect(record?.failedTurns).toBeUndefined();
        else expect(record?.failedTurns).toMatchObject([failureMetadata]);
        expect(JSON.stringify(record)).not.toContain("input missing from native history");
        expect(JSON.stringify(record)).not.toContain("partial reply before failure");
        if (mode === "reopen" || mode === "unavailable") return;

        for (const [id, method, params] of [
          [801, "thread/rollback", { threadId, numTurns: 1 }],
          [802, "thread/fork", { threadId, lastTurnId: turnId }],
        ] as const) {
          writeRequest(fixture.desktopInput, { id, method, params });
          await expect(
            fixture.collector.waitFor((message) => requestId(message, id)),
          ).resolves.toMatchObject({ error: { code: -32080 } });
        }
        const next = await api.send({ threadId, message: "next input" });
        await succeed(next.turnId);
        const native = session.persistedSnapshot();
        snapshots.mockResolvedValue({
          ok: true,
          value: {
            ...native,
            turns: native.turns.filter(({ outcome }) => outcome.status !== "failed"),
          },
        });
        await expect(api.read({ threadId, view: "result" })).resolves.toMatchObject({
          status: "completed",
          turn: { turnId: next.turnId },
        });
        writeRequest(fixture.desktopInput, {
          id: 803,
          method: "thread/rollback",
          params: { threadId, numTurns: 1 },
        });
        await expect(
          fixture.collector.waitFor((message) => requestId(message, 803)),
        ).resolves.toMatchObject({
          result: {
            thread: {
              turns: expect.arrayContaining([
                expect.objectContaining({ id: turnId, status: "failed" }),
              ]),
            },
          },
        });
        await expect(api.read({ threadId, view: "messages", from: 5 })).resolves.toMatchObject(
          expectedMessages,
        );
        const rolledBack = await fixture.mappingStore.getThread(hostId);
        expect(rolledBack?.turnMappings.map(({ hostTurnId }) => hostTurnId)).toEqual(predecessors);
        expect(rolledBack?.failedTurns).toEqual(
          mode === "write failure" ? undefined : [failureMetadata],
        );
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("preserves nativeTurnRef and suppresses preview leak when Turn mapping persistence fails", async () => {
    let api: DelegationControlApi | undefined;
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      onDelegationApi: (registration) => {
        api = registration;
      },
    });
    try {
      await fixture.ready;
      if (!api) throw new Error("No Delegation API");
      const starting = api.start({
        harnessId: "pi",
        task: "secret failed first input",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      await answerOfficialParentCwd(fixture);
      const { threadId, turnId } = await starting;
      const session = adapter.sessions[0];
      if (!session) throw new Error("Missing fake Session");
      vi.spyOn(fixture.mappingStore, "upsertTurnMappings").mockRejectedValueOnce(
        new Error("transient mapping store failure"),
      );
      session.appendText("reply before persistence failure");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      // Native history persisted the turn as completed, while Host marked it failed.
      const read = await api.read({ threadId, view: "messages" });
      expect(read).toMatchObject({
        totalTurns: 1,
        turns: [{ turnId, turnNumber: 1, status: "failed" }],
      });
      const record = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
      expect(record?.preview).toBeUndefined();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps later Host assistant reply when native failed history only saved an earlier segment", async () => {
    let api: DelegationControlApi | undefined;
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      onDelegationApi: (registration) => {
        api = registration;
      },
    });
    try {
      await fixture.ready;
      if (!api) throw new Error("No Delegation API");
      const starting = api.start({
        harnessId: "pi",
        task: "first input",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      await answerOfficialParentCwd(fixture);
      const { threadId, turnId } = await starting;
      const session = adapter.sessions[0];
      if (!session) throw new Error("Missing fake Session");
      session.appendText("earlier reply");
      const partialSnapshot = session.persistedSnapshot();
      session.appendText(" and later reply");
      session.failTurn({ code: "nativeFailure", message: "boom", retryable: false });
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

      const fullNative = session.persistedSnapshot();
      const nativeTurn = fullNative.turns[0];
      if (!nativeTurn) throw new Error("Missing persisted failed turn");
      vi.spyOn(session, "readSnapshot").mockResolvedValue({
        ok: true,
        value: {
          ...fullNative,
          turns: [
            {
              ...nativeTurn,
              items: [
                {
                  item: {
                    type: "agentMessage",
                    itemId:
                      partialSnapshot.turns[0]?.items[0]?.item.itemId ??
                      hostItemIdSchema.parse("native-agent-1"),
                    text: "earlier reply",
                  },
                  outcome: { status: "succeeded" },
                },
              ],
            },
          ],
        },
      });
      const read = await api.read({ threadId, view: "messages" });
      expect(read).toMatchObject({
        totalTurns: 1,
        turns: [
          {
            turnId,
            status: "failed",
            messages: [
              { role: "user", text: "first input" },
              { role: "agent", text: "earlier reply and later reply" },
            ],
          },
        ],
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("preserves multiple distinct live replies and accepted steer inputs when merging failed Turns", () => {
    const failedTurnId = hostTurnIdSchema.parse("failed-turn-merge");
    const failure = { hostTurnId: failedTurnId, error: "executionFailed" as const };
    const mergedReplies = withFailedTurns(
      [
        {
          id: failedTurnId,
          status: "failed",
          items: [{ type: "agentMessage", id: "n1", text: "A" }],
        },
      ],
      [failure],
      new Map([
        [
          failedTurnId,
          {
            failure,
            items: [
              { type: "agentMessage", id: "h1", text: "A" },
              { type: "agentMessage", id: "h2", text: "B" },
              { type: "agentMessage", id: "h3", text: "B with detail" },
            ],
          },
        ],
      ]),
    );
    expect(mergedReplies[0]?.items).toEqual([
      { type: "agentMessage", id: "n1", text: "A" },
      { type: "agentMessage", id: "h2", text: "B" },
      { type: "agentMessage", id: "h3", text: "B with detail" },
    ]);

    const user1 = { type: "userMessage", id: "u1", content: [{ type: "text", text: "initial" }] };
    const steer1 = { type: "userMessage", id: "u2", content: [{ type: "text", text: "steer" }] };
    const withoutNative = withFailedTurns(
      [],
      [failure],
      new Map([[failedTurnId, { failure, items: [user1, steer1] }]]),
    );
    expect(withoutNative[0]?.items).toEqual([user1, steer1]);

    const withInitialNative = withFailedTurns(
      [
        {
          id: failedTurnId,
          status: "failed",
          items: [
            {
              type: "userMessage",
              id: "native-u1",
              content: [{ type: "text", text: "initial", text_elements: [] }],
            },
          ],
        },
      ],
      [failure],
      new Map([[failedTurnId, { failure, items: [user1, steer1] }]]),
    );
    expect(withInitialNative[0]?.items).toHaveLength(2);
    expect(withInitialNative[0]?.items).toContainEqual(steer1);
  });
});

describe("External Thread metadata updates", () => {
  it("persists a project assignment and emits the official project notification", async () => {
    const fixture = createFixture();
    answerOfficial(fixture, new Set(["project-a"]));
    const threadId = await startPiThread(fixture);

    await expect(
      updateMetadata(fixture, 10, { threadId, projectId: "project-a" }),
    ).resolves.toMatchObject({
      result: { thread: { id: threadId, projectId: "project-a", gitInfo: null } },
    });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/project/updated")),
    ).resolves.toEqual({
      method: "thread/project/updated",
      params: { threadId, projectId: "project-a" },
    });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ projectId: "project-a" });

    await expect(listIds(fixture, 11, { projectId: "project-a" })).resolves.toEqual([threadId]);
    await expect(listIds(fixture, 12, { projectId: null })).resolves.toEqual([]);
    await expect(listIds(fixture, 13, { projectId: "project-b" })).resolves.toEqual([]);
    await expect(listIds(fixture, 14, {})).resolves.toEqual([threadId]);

    // An empty projectId clears the assignment.
    await expect(updateMetadata(fixture, 15, { threadId, projectId: "" })).resolves.toMatchObject({
      result: { thread: { projectId: null } },
    });
    await expect(listIds(fixture, 16, { projectId: null })).resolves.toEqual([threadId]);
    await stopFixture(fixture);
  });

  it("assigns a project before a deferred native Session exists and keeps it once ready", async () => {
    const adapter = new DeferredNativeSessionAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    answerOfficial(fixture, new Set(["project-a"]));
    const threadId = await startPiThread(fixture);
    const hostThreadId = hostThreadIdSchema.parse(threadId);
    await expect(fixture.mappingStore.getThread(hostThreadId)).resolves.toMatchObject({
      state: "creating",
    });

    await expect(
      updateMetadata(fixture, 17, { threadId, projectId: "project-a" }),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, projectId: "project-a" } } });
    // The Harness later reports its native identity, as on the first Turn.
    await fixture.mappingStore.commitReady({
      hostThreadId,
      nativeSessionRef: {
        harnessId: harnessIdSchema.parse("pi"),
        nativeSessionId: "late",
        formatVersion: 1,
      },
    });

    await expect(fixture.mappingStore.getThread(hostThreadId)).resolves.toMatchObject({
      state: "ready",
      projectId: "project-a",
    });
    await expect(listIds(fixture, 19, { projectId: "project-a" })).resolves.toEqual([threadId]);
    await stopFixture(fixture);
  });

  it.each([
    ["thread/read", true],
    ["thread/turns/list", true],
    ["thread/read", false],
    ["thread/turns/list", false],
  ] as const)(
    "%s preserves failed local history with or without native identity: %s",
    async (firstRead, deferred) => {
      const adapter = deferred
        ? new DeferredNativeSessionAdapter(harnessIdSchema.parse("pi"))
        : new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
      const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
      try {
        const threadId = await startPiThread(fixture);
        const session = adapter.sessions[0];
        if (!session) throw new Error("Fake Session was not opened");
        vi.spyOn(session, "readSnapshot").mockResolvedValue({ ok: true, value: { turns: [] } });
        const turnSession: {
          execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
        } = session;
        vi.spyOn(turnSession, "execute").mockImplementationOnce(async ({ turnId }) => ({
          ok: true,
          value: { turnId },
        }));
        const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
        session.emitEvent({ type: "turn.started", turnId });
        session.emitEvent({
          type: "turn.completed",
          turnId,
          outcome: {
            status: "failed",
            error: { code: "nativeFailure", message: "Native startup failed", retryable: false },
          },
        });
        await expect(
          fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
        ).resolves.toMatchObject({
          params: {
            turn: { id: turnId, status: "failed", error: { message: "Native startup failed" } },
          },
        });
        const expectedTurns = [{ id: turnId, status: "failed" }];
        const reads =
          firstRead === "thread/read"
            ? ["thread/read", "thread/turns/list"]
            : ["thread/turns/list", "thread/read"];
        for (const [index, read] of reads.entries()) {
          writeRequest(fixture.desktopInput, {
            id: 30 + index,
            method: read,
            params: { threadId, ...(read === "thread/read" ? { includeTurns: true } : {}) },
          });
          await expect(
            fixture.collector.waitFor((message) => requestId(message, 30 + index)),
          ).resolves.toMatchObject({
            result:
              read === "thread/read"
                ? { thread: { turns: expectedTurns } }
                : { data: expectedTurns },
          });
        }
        await expect(
          fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
        ).resolves.toMatchObject({
          state: deferred ? "creating" : "ready",
          turnMappings: [],
        });
        expect(session.readSnapshot).toHaveBeenCalledTimes(2);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("archives a loaded Thread whose deferred native Session never arrived", async () => {
    const adapter = new DeferredNativeSessionAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    answerOfficial(fixture, new Set());
    const threadId = await startPiThread(fixture);
    const hostThreadId = hostThreadIdSchema.parse(threadId);
    await expect(fixture.mappingStore.getThread(hostThreadId)).resolves.toMatchObject({
      state: "creating",
    });

    writeRequest(fixture.desktopInput, { id: 20, method: "thread/archive", params: { threadId } });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 20)),
    ).resolves.toMatchObject({ result: {} });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/archived")),
    ).resolves.toEqual({ method: "thread/archived", params: { threadId } });
    await expect(fixture.mappingStore.getThread(hostThreadId)).resolves.toMatchObject({
      state: "creating",
      archived: true,
    });

    writeRequest(fixture.desktopInput, {
      id: 21,
      method: "thread/unarchive",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 21)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId } } });
    await expect(fixture.mappingStore.getThread(hostThreadId)).resolves.toMatchObject({
      archived: false,
    });
    await stopFixture(fixture);
  });

  it("patches Git metadata and the Daybreak choice across a restart", async () => {
    const first = createFixture();
    answerOfficial(first, new Set());
    const threadId = await startPiThread(first);
    await updateMetadata(first, 20, {
      threadId,
      daybreakEnabled: true,
      gitInfo: { branch: "main", sha: "abc123" },
    });
    await expect(
      updateMetadata(first, 21, { threadId, gitInfo: { sha: null, originUrl: "git@x:y.git" } }),
    ).resolves.toMatchObject({
      result: {
        thread: {
          daybreakEnabled: true,
          gitInfo: { branch: "main", sha: null, originUrl: "git@x:y.git" },
        },
      },
    });
    expect(first.collector.messages.some((m) => method(m, "thread/project/updated"))).toBe(false);
    const directory = first.mappingStoreDirectory;
    await closeFixture(first);

    const restarted = createFixture({ mappingStoreDirectory: directory });
    answerOfficial(restarted, new Set());
    writeRequest(restarted.desktopInput, { id: 22, method: "thread/list", params: {} });
    const response = await restarted.collector.waitFor((message) => requestId(message, 22));
    expect((response.result as JsonObject).data).toEqual([
      expect.objectContaining({
        id: threadId,
        daybreakEnabled: true,
        projectId: null,
        gitInfo: { branch: "main", sha: null, originUrl: "git@x:y.git" },
      }),
    ]);
    await stopFixture(restarted);
  });

  it("rejects unsupported fields and unknown projects without partial writes", async () => {
    const fixture = createFixture();
    answerOfficial(fixture, new Set(["project-a"]));
    const threadId = await startPiThread(fixture);
    const before = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));

    await expect(
      updateMetadata(fixture, 30, { threadId, projectId: "project-a", isPinned: true }),
    ).resolves.toMatchObject({
      error: { code: -32078, message: "External Thread metadata fields are unsupported: isPinned" },
    });
    await expect(
      updateMetadata(fixture, 31, { threadId, projectId: "missing", daybreakEnabled: true }),
    ).resolves.toMatchObject({ error: { code: -32602, message: "Project is unavailable" } });
    await expect(
      updateMetadata(fixture, 34, { threadId, projectId: "mismatched" }),
    ).resolves.toMatchObject({ error: { code: -32602, message: "Project is unavailable" } });
    await expect(
      updateMetadata(fixture, 35, { threadId, gitInfo: { branch: "main", futureField: "x" } }),
    ).resolves.toMatchObject({
      error: {
        code: -32078,
        message: "External Thread metadata fields are unsupported: gitInfo.futureField",
      },
    });
    await expect(
      updateMetadata(fixture, 32, { threadId, gitInfo: { branch: "" } }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    writeRequest(fixture.desktopInput, {
      id: 33,
      method: "thread/future/manage",
      params: { threadId, futureMetadata: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 33)),
    ).resolves.toMatchObject({
      error: { code: -32076, message: "External Thread does not support thread/future/manage" },
    });

    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toEqual(before);
    expect(fixture.collector.messages.some((m) => method(m, "thread/project/updated"))).toBe(false);
    await stopFixture(fixture);
  });

  it("clears External assignments when official Codex deletes the project", async () => {
    const fixture = createFixture();
    answerOfficial(fixture, new Set(["project-a"]));
    const threadId = await startPiThread(fixture);
    await updateMetadata(fixture, 40, { threadId, projectId: "project-a" });
    await fixture.collector.waitFor((message) => method(message, "thread/project/updated"));

    const deleted = {
      method: "project/changed",
      params: { projectId: "project-a", changeType: "deleted" },
    };
    fixture.official.stdout.write(`${JSON.stringify(deleted)}\n`);
    await expect(
      fixture.collector.waitFor((message) => method(message, "project/changed")),
    ).resolves.toEqual(deleted);
    await vi.waitFor(() =>
      expect(
        fixture.collector.messages.filter((m) => method(m, "thread/project/updated")).at(-1),
      ).toEqual({ method: "thread/project/updated", params: { threadId, projectId: null } }),
    );
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.not.toHaveProperty("projectId");
    await stopFixture(fixture);
  });
});
