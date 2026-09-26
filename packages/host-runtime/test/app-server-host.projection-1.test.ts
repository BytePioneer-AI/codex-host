import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import type { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { type ExternalHarnessId, type JsonObject } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostItemIdSchema,
  type CodexAccountListResult,
} from "@codexhost/shared-contracts";
import { SingleNativeCodexAccount } from "../src/account/codex-account-control.js";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "../src/official-app-server-connection.js";
import type { HostUpdateCoordinator } from "../src/update-coordinator.js";

import {
  method,
  requestId,
  requiredMessageId,
  messageParams,
  threadStatus,
  turnEvent,
  writeRequest,
  readJsonLine,
  createFixture,
  startPiThread,
  startPiTurn,
  closeFixture,
  stopFixture,
  bindOfficialThread,
} from "./app-server-host-fixture.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("uses an injected shared listener connection without spawning a stdio app-server", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const closed = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>();
    const connected = Promise.withResolvers<undefined>();
    const close = vi.fn(() => {
      stdin.destroy();
      stdout.end();
      closed.resolve({ code: 0, signal: null });
    });
    const createOfficialConnection = vi.fn(() => {
      connected.resolve(undefined);
      return { stdin, stdout, stderr, closed: closed.promise, close };
    });
    const fixture = createFixture({ createOfficialConnection });

    try {
      await connected.promise;
      expect(createOfficialConnection).toHaveBeenCalledTimes(1);
      expect(fixture.spawnOfficial).not.toHaveBeenCalled();

      fixture.host.close();

      await expect(fixture.running).resolves.toBe(0);
      expect(close).toHaveBeenCalled();
    } finally {
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps external Harness requests available after official startup failure", async () => {
    const createOfficialConnection = vi.fn(() => {
      throw new Error("synthetic startup failure");
    });
    const fixture = createFixture({ createOfficialConnection });
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      writeRequest(fixture.desktopInput, { id: 902, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 902),
      ).resolves.toMatchObject({ error: { code: -32001 } });
      expect(createOfficialConnection).toHaveBeenCalledOnce();
      expect(fixture.desktopInput.destroyed).toBe(false);
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it.each([false, true])("preserves native auth with account management=%s", async (managed) => {
    const accountControl = Object.assign(
      new SingleNativeCodexAccount(() => ({
        version: 2,
        currentAccountId: null,
        phase: "ready",
        revision: 7,
        accounts: [],
      })),
      {
        refresh: vi.fn(async () => {
          throw new Error("synthetic identity refresh failure");
        }),
      },
    );
    const fixture = createFixture(managed ? { accountControl } : {});
    try {
      await fixture.ready;
      const requests: JsonObject[] = [
        { id: 903, method: "account/logout" },
        { id: 904, method: "account/logout", params: null },
        { id: 905, method: "account/logout", params: {} },
        { id: 906, method: "account/login/start", params: { type: "chatgpt", futureField: true } },
        { id: 907, method: "account/login/start", params: { type: "future-native-mode" } },
        {
          id: 908,
          method: "account/login/cancel",
          params: { loginId: "native-id", futureField: 1 },
        },
        { id: 909, method: "account/login/future", params: {} },
        { id: 910, method: "account/login/start" },
        { id: 911, method: "account/logout", params: false },
        { id: 913, method: "account/logout", params: [] },
        { id: 914, method: "account/login/cancel" },
      ];
      for (const request of requests) {
        writeRequest(fixture.desktopInput, request);
        expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
        const response =
          request.id === 906
            ? {
                id: request.id,
                result: { type: "chatgpt", loginId: "native-id", futureField: "kept" },
              }
            : request.id === 908
              ? { id: request.id, result: { status: "canceled", futureField: true } }
              : request.id === 907 || request.id === 910 || request.id === 911
                ? {
                    id: request.id,
                    error: {
                      code: -32602,
                      message: "native rejection",
                      data: { futureField: true },
                    },
                  }
                : { id: request.id, result: {} };
        fixture.official.stdout.write(`${JSON.stringify(response)}\n`);
        expect(await fixture.collector.waitFor((message) => message.id === request.id)).toEqual(
          response,
        );
      }
      for (const notification of [
        {
          method: "account/login/completed",
          params: { loginId: "native-id", success: true, futureField: true },
        },
        { method: "account/updated", params: { authMode: null, futureField: "kept" } },
      ]) {
        fixture.official.stdout.write(`${JSON.stringify(notification)}\n`);
        expect(
          await fixture.collector.waitFor((message) => message.method === notification.method),
        ).toEqual(notification);
      }
      if (managed) await vi.waitFor(() => expect(accountControl.refresh).toHaveBeenCalled());
      writeRequest(fixture.desktopInput, { id: 912, method: "account/read", params: {} });
      expect(await readJsonLine(fixture.official.stdin)).toEqual({
        id: 912,
        method: "account/read",
        params: {},
      });
      fixture.official.stdout.write(`${JSON.stringify({ id: 912, result: { account: null } })}\n`);
      await expect(
        fixture.collector.waitFor((message) => message.id === 912),
      ).resolves.toMatchObject({ result: { account: null } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("refreshes native-derived Account selection before returning an Account list", async () => {
    const stale: CodexAccountListResult = {
      version: 2,
      currentAccountId: null,
      phase: "ready",
      revision: 1,
      accounts: [],
    };
    const fresh: CodexAccountListResult = {
      ...stale,
      currentAccountId: "native",
      revision: 2,
      accounts: [{ accountId: "native", label: "Observed native Account" }],
    };
    const refresh = vi.fn(async () => fresh);
    const accountControl = Object.assign(new SingleNativeCodexAccount(() => stale), { refresh });
    const fixture = createFixture({ accountControl });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, { id: 908, method: "codexhost/account/list", params: {} });
      await expect(fixture.collector.waitFor((message) => message.id === 908)).resolves.toEqual({
        id: 908,
        result: fresh,
      });
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each([
    "codexhost/account/switch",
    "codexhost/account/logout",
    "codexhost/account/login/start",
    "codexhost/account/login/cancel",
    "codexhost/account/delete",
    "codexhost/account/recover",
    "codexhost/account/rate-limit-reset/consume",
  ])("forwards leftover Host account method %s as an unknown method", async (methodName) => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      const request = { id: 910, method: methodName, params: { accountId: "account-b" } };
      writeRequest(fixture.desktopInput, request);
      expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
      fixture.official.stdout.write(
        `${JSON.stringify({ id: 910, error: { code: -32601, message: "Method not found" } })}\n`,
      );
      await expect(fixture.collector.waitFor((message) => message.id === 910)).resolves.toEqual({
        id: 910,
        error: { code: -32601, message: "Method not found" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("hydrates the native summary list and preserves Subagent identity through parent history", async () => {
    const fixture = createFixture();
    try {
      const parentId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, parentId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fixture Session");
      const child = {
        subagentId: "call-child",
        nativeSubagentId: "native-child",
        description: "Summary child",
        role: "explorer",
        background: false,
        status: "running" as const,
      };
      const itemId = session.startSubagentDelegation(child);
      const started = await fixture.collector.waitFor(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === parentId,
      );
      const childId = (messageParams(started).thread as JsonObject).id;
      const list = async (id: number, sourceParams: JsonObject) => {
        writeRequest(fixture.desktopInput, {
          id,
          method: "thread/list",
          params: {
            limit: 200,
            sourceKinds: ["subAgentThreadSpawn"],
            useStateDbOnly: true,
            ...sourceParams,
          },
        });
        const official = await readJsonLine(fixture.official.stdin);
        expect(official.method).toBe("thread/list");
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(official),
          result: { data: [], nextCursor: null },
        });
        return fixture.collector.waitFor((message) => requestId(message, id));
      };
      expect(await list(90, { ancestorThreadId: parentId })).toMatchObject({
        result: {
          data: [
            {
              id: childId,
              parentThreadId: parentId,
              name: "Summary child",
              agentRole: "explorer",
              status: { type: "active" },
              canAcceptDirectInput: false,
            },
          ],
        },
      });
      session.replaceSubagents(itemId, [{ ...child, status: "completed" }]);
      session.completeItem(itemId, { status: "succeeded" });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      expect(await list(91, { parentThreadId: parentId })).toMatchObject({
        result: {
          data: [
            {
              id: childId,
              status: { type: "idle" },
            },
          ],
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 92,
        method: "thread/turns/list",
        params: {
          threadId: parentId,
          limit: 20,
          itemsView: "full",
        },
      });
      const history = await fixture.collector.waitFor((message) => requestId(message, 92));
      expect(history).toMatchObject({
        result: {
          data: [
            {
              items: expect.arrayContaining([
                expect.objectContaining({
                  type: "collabAgentToolCall",
                  senderThreadId: parentId,
                  receiverThreadIds: [childId],
                }),
              ]),
            },
          ],
        },
      });
      expect(
        (await fixture.mappingStore.listThreads()).filter((record) => record.subagent),
      ).toHaveLength(1);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("materializes a Subagent receiver as a readable Child Host Thread", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    let subagentPhase: "started" | "temporarily-empty" | "working" | "completed" = "started";
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => {
          const subagentSnapshot: HostThreadSnapshot = {
            turns:
              subagentPhase === "temporarily-empty"
                ? []
                : [
                    {
                      nativeTurnRef: {
                        harnessId: harnessIdSchema.parse("pi"),
                        nativeSessionId: input.parent.nativeSessionId,
                        nativeTurnKey: "native-subagent-turn",
                        formatVersion: 1,
                      },
                      input:
                        subagentPhase === "started"
                          ? [{ type: "text", text: "Analyze files" }]
                          : [],
                      items:
                        subagentPhase === "started"
                          ? []
                          : [
                              {
                                item: {
                                  type: "commandExecution",
                                  itemId: hostItemIdSchema.parse("subagent-command"),
                                  command: "pwd",
                                  output: "/synthetic",
                                  exitCode: 0,
                                },
                                outcome: { status: "succeeded" },
                              },
                              ...(subagentPhase === "completed"
                                ? [
                                    {
                                      item: {
                                        type: "agentMessage" as const,
                                        itemId: hostItemIdSchema.parse("subagent-answer"),
                                        text: "Analysis complete",
                                      },
                                      outcome: { status: "succeeded" as const },
                                    },
                                  ]
                                : []),
                            ],
                      outcome: { status: "unknown", reason: "Synthetic history" },
                    },
                  ],
          };
          return { ok: true as const, value: subagentSnapshot };
        }),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    const itemId = session.startSubagentDelegation({
      subagentId: "agent-call",
      nativeSubagentId: "native-agent-1",
      description: "Analyze files",
      background: false,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    expect(messageParams(childStarted).thread).toMatchObject({
      status: { type: "active" },
      canAcceptDirectInput: false,
    });
    const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;
    writeRequest(fixture.desktopInput, {
      id: 98,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const initialHistory = await fixture.collector.waitFor((message) => requestId(message, 98));
    expect(initialHistory).toMatchObject({
      result: { data: [{ items: [expect.objectContaining({ type: "userMessage" })] }] },
    });

    subagentPhase = "temporarily-empty";
    session.emitSubagentTranscriptChanged("native-agent-1");
    writeRequest(fixture.desktopInput, {
      id: 97,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const retainedHistory = await fixture.collector.waitFor((message) => requestId(message, 97));
    expect(retainedHistory).toMatchObject({
      result: { data: [{ items: [expect.objectContaining({ type: "userMessage" })] }] },
    });

    subagentPhase = "working";
    session.emitSubagentTranscriptChanged("native-agent-1");
    const childTurnStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/started") &&
        messageParams(message).threadId === childThreadId &&
        ((messageParams(message).turn as JsonObject | undefined)?.status as string | undefined) ===
          "inProgress",
    );
    const childTurnStartedIndex = fixture.collector.messages.indexOf(childTurnStarted);
    const childCommandCompleted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        messageParams(message).threadId === childThreadId &&
        (messageParams(message).item as JsonObject | undefined)?.type === "commandExecution" &&
        (messageParams(message).item as JsonObject | undefined)?.command === "pwd",
    );
    expect(childTurnStartedIndex).toBeLessThan(
      fixture.collector.messages.indexOf(childCommandCompleted),
    );
    writeRequest(fixture.desktopInput, {
      id: 96,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const mergedHistory = await fixture.collector.waitFor((message) => requestId(message, 96));
    expect(mergedHistory).toMatchObject({
      result: {
        data: [
          {
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "userMessage",
                content: [expect.objectContaining({ text: "Analyze files" })],
              }),
              expect.objectContaining({ type: "commandExecution", command: "pwd" }),
            ]),
          },
        ],
      },
    });

    subagentPhase = "completed";
    session.replaceSubagents(itemId, [
      {
        subagentId: "agent-call",
        nativeSubagentId: "native-agent-1",
        description: "Analyze files",
        background: false,
        status: "completed",
        resultSummary: "Analysis complete",
      },
    ]);
    session.completeItem(itemId, { status: "succeeded" });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    expect(
      fixture.collector.messages.filter(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "commandExecution",
      ),
    ).toHaveLength(1);
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "agentMessage" &&
          (messageParams(message).item as JsonObject | undefined)?.text === "Analysis complete",
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "turn/completed") && messageParams(message).threadId === childThreadId,
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/status/changed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).status as JsonObject | undefined)?.type === "idle",
      ),
    ).resolves.toBeTruthy();
    const completed = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        (messageParams(message).item as JsonObject | undefined)?.type === "collabAgentToolCall",
    );
    const completedChildThreadId = (
      (messageParams(completed).item as JsonObject).receiverThreadIds as string[]
    )[0];
    expect(completedChildThreadId).toBe(childThreadId);
    expect(childThreadId).toBeTruthy();
    expect(childThreadId).not.toBe("agent-call");
    if (!childThreadId) throw new Error("Projected Subagent has no Child Thread ID");

    writeRequest(fixture.desktopInput, {
      id: 99,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    const history = await fixture.collector.waitFor((message) => requestId(message, 99));
    expect(history).toMatchObject({
      result: {
        data: [
          {
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "commandExecution",
                command: "pwd",
                aggregatedOutput: "/synthetic",
              }),
              expect.objectContaining({ type: "agentMessage", text: "Analysis complete" }),
            ]),
          },
        ],
      },
    });
    expect(adapter.subagents.readSnapshot).toHaveBeenCalledWith({
      parent: expect.objectContaining({ nativeSessionId: expect.any(String) }),
      nativeSubagentId: "native-agent-1",
      cwd: "/synthetic",
    });
    await stopFixture(fixture);
  });

  it("keeps the Parent Thread active until all background Subagents settle", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    let completed = false;
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "background-child-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect files" }],
                items: completed
                  ? [
                      {
                        item: {
                          type: "agentMessage" as const,
                          itemId: hostItemIdSchema.parse("background-child-answer"),
                          text: "Inspection complete",
                        },
                        outcome: { status: "succeeded" as const },
                      },
                    ]
                  : [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    const itemId = session.startSubagentDelegation({
      subagentId: "background-agent-call",
      nativeSubagentId: "native-background-agent",
      description: "Inspect files",
      background: true,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    const childThreadId = (messageParams(childStarted).thread as JsonObject).id as string;
    writeRequest(fixture.desktopInput, {
      id: 95,
      method: "thread/turns/list",
      params: { threadId: childThreadId, limit: 20, itemsView: "full" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 95));
    session.completeItem(itemId, { status: "succeeded" });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(
      fixture.collector.messages.some((message) => threadStatus(message, threadId, "idle")),
    ).toBe(false);
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, threadId, "active")),
    ).toBe(true);

    completed = true;
    session.emitSubagentState("native-background-agent", "completed", "Inspection complete");
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle")),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/completed") &&
          messageParams(message).threadId === childThreadId &&
          (messageParams(message).item as JsonObject | undefined)?.type === "agentMessage" &&
          (messageParams(message).item as JsonObject | undefined)?.text === "Inspection complete",
      ),
    ).resolves.toBeTruthy();
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle")),
    ).resolves.toBeTruthy();
    await stopFixture(fixture);
  });

  it("keeps a Subagent Thread active when it is opened while its Subagent runs", async () => {
    const base = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const adapter = Object.assign(base, {
      subagents: {
        readSnapshot: vi.fn(async (input: { parent: { nativeSessionId: string } }) => ({
          ok: true as const,
          value: {
            turns: [
              {
                nativeTurnRef: {
                  harnessId: harnessIdSchema.parse("pi"),
                  nativeSessionId: input.parent.nativeSessionId,
                  nativeTurnKey: "open-while-running-turn",
                  formatVersion: 1,
                },
                input: [{ type: "text", text: "Inspect files" }],
                items: [],
                outcome: { status: "unknown" as const, reason: "Background work" },
              },
            ],
          },
        })),
      },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const childStartedPromise = fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === threadId,
    );
    session.startSubagentDelegation({
      subagentId: "open-while-running-call",
      nativeSubagentId: "native-open-while-running",
      description: "Inspect files",
      background: true,
      status: "running",
    });
    const childStarted = await childStartedPromise;
    const childThread = messageParams(childStarted).thread as JsonObject;
    const childThreadId = childThread.id as string;
    expect(childThread.status).toEqual({ type: "active", activeFlags: [] });

    writeRequest(fixture.desktopInput, {
      id: 96,
      method: "thread/resume",
      params: { threadId: childThreadId, excludeTurns: true },
    });
    const opened = await fixture.collector.waitFor((message) => requestId(message, 96));
    expect((opened.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "active", activeFlags: [] } }),
    );
    expect(
      fixture.collector.messages.some((message) => threadStatus(message, childThreadId, "idle")),
    ).toBe(false);

    session.emitSubagentState("native-open-while-running", "completed", "Inspection complete");
    await expect(
      fixture.collector.waitFor((message) => threadStatus(message, childThreadId, "idle")),
    ).resolves.toBeTruthy();
    writeRequest(fixture.desktopInput, {
      id: 97,
      method: "thread/resume",
      params: { threadId: childThreadId, excludeTurns: true },
    });
    const reopened = await fixture.collector.waitFor((message) => requestId(message, 97));
    expect((reopened.result as JsonObject).thread).toEqual(
      expect.objectContaining({ id: childThreadId, status: { type: "idle" } }),
    );
    await stopFixture(fixture);
  });

  it("terminates the official app-server when its Host session closes", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    fixture.official.kill.mockImplementationOnce(() => {
      fixture.official.stdout.end();
      fixture.official.emit("exit", null, "SIGTERM");
      return true;
    });

    try {
      await fixture.ready;
      expect(fixture.spawnOfficial).toHaveBeenCalledTimes(1);
      expect(() => fixture.host.close()).not.toThrow();
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("accepts confirmed graceful EOF shutdown without signaling the exited process", async () => {
    const fixture = createFixture();
    const exited = vi.fn();
    fixture.official.once("exit", exited);
    try {
      await fixture.ready;
      fixture.host.close();
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.stdin.writableEnded).toBe(true);
      expect(exited).toHaveBeenCalledExactlyOnceWith(0, null);
      expect(fixture.official.kill).not.toHaveBeenCalled();
    } finally {
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("lets an active official Turn reach its terminal event after Desktop disconnects", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    const threadId = "019cbe86-76cf-7721-b5e4-978934e18757";
    const turnId = "019cbe86-8eef-79d0-8658-cf2c64aa38cf";

    try {
      await bindOfficialThread(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "keep running" }] },
      });
      await readJsonLine(fixture.official.stdin);
      fixture.official.stdout.write(
        `${JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId } } })}\n`,
      );
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));

      fixture.host.disconnect();
      const beforeTerminal = await Promise.race([
        fixture.running.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);

      expect(beforeTerminal).toBe("pending");
      expect(fixture.official.kill).not.toHaveBeenCalled();

      fixture.official.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        })}\n`,
      );
      await expect(
        fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
      ).resolves.toBeTruthy();
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps a forwarded official turn/start alive across the pre-response disconnect race", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    const threadId = "019cbe87-ae18-7543-97f1-c60deeb61b17";
    const turnId = "019cbe87-b77a-78a2-a16a-c6ad1fc2a026";

    try {
      await bindOfficialThread(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "start then disconnect" }] },
      });
      await readJsonLine(fixture.official.stdin);
      fixture.host.disconnect();

      const beforeResponse = await Promise.race([
        fixture.running.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);
      expect(beforeResponse).toBe("pending");

      fixture.official.stdout.write(
        `${JSON.stringify({ id: 1, result: { turn: { id: turnId } } })}\n`,
      );
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 1)),
      ).resolves.toBeTruthy();
      expect(fixture.official.stdin.writableEnded).toBe(false);

      fixture.official.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        })}\n`,
      );
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("releases a disconnected Host session when pending official turn/start fails", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    const threadId = "019cbe88-9a77-78ae-919f-79cfe1468e11";

    try {
      await bindOfficialThread(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "rejected start" }] },
      });
      await readJsonLine(fixture.official.stdin);
      fixture.host.disconnect();
      fixture.official.stdout.write(
        `${JSON.stringify({ id: 1, error: { code: -32000, message: "synthetic rejection" } })}\n`,
      );

      await expect(
        fixture.collector.waitFor((message) => requestId(message, 1)),
      ).resolves.toBeTruthy();
      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("releases a disconnected Host when official completion precedes the start response", async () => {
    const fixture = createFixture({ officialExitsOnInputEnd: false });
    const threadId = "019cbe89-91f5-71c8-b24d-0410e73a2ef4";
    const turnId = "019cbe89-9e78-7e49-ac62-3958b8db3881";

    try {
      await bindOfficialThread(fixture, threadId);
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "finish immediately" }] },
      });
      await readJsonLine(fixture.official.stdin);
      fixture.host.disconnect();
      fixture.official.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        })}\n`,
      );
      fixture.official.stdout.write(
        `${JSON.stringify({ id: 1, result: { turn: { id: turnId } } })}\n`,
      );

      await expect(fixture.running).resolves.toBe(0);
      expect(fixture.official.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("lets an active external Harness Turn finish after Desktop disconnects", async () => {
    const fixture = createFixture();
    let session: FakeHarnessSession | undefined;

    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const close = vi.spyOn(session, "close");
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));

      fixture.host.disconnect();
      const beforeTerminal = await Promise.race([
        fixture.running.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);

      expect(beforeTerminal).toBe("pending");
      expect(close).not.toHaveBeenCalled();

      session.appendText("completed after transport disconnect");
      session.succeedTurn();
      await expect(
        fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
      ).resolves.toBeTruthy();
      await expect(fixture.running).resolves.toBe(0);
      expect(close).toHaveBeenCalled();
    } finally {
      try {
        session?.succeedTurn();
      } catch {
        // A failing implementation may already have interrupted the synthetic Turn.
      }
      fixture.host.close();
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("preserves an external Turn and rejects official retries after backend failure", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const close = vi.spyOn(session, "close");
      fixture.official.emit("exit", 1, null);
      await vi.waitFor(() => expect(fixture.official.stdout.destroyed).toBe(true));
      writeRequest(fixture.desktopInput, { id: 901, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 901),
      ).resolves.toMatchObject({ id: 901, error: { code: -32001 } });
      expect(fixture.desktopInput.destroyed).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(fixture.spawnOfficial).toHaveBeenCalledOnce();
      session.appendText("external output after official exit");
      session.succeedTurn();
      await expect(
        fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
      ).resolves.toBeTruthy();
      expect(close).not.toHaveBeenCalled();
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Desktop initialization and external Harnesses available after failed startup cleanup cannot prove exit", async () => {
    const exit = { code: 1, signal: null };
    const stopProcess = vi.fn(async (): Promise<OfficialAppServerExit> => {
      throw new Error("synthetic exit unconfirmed");
    });
    const connection: OfficialAppServerConnection = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      closed: Promise.resolve(exit),
      stopProcess,
      close: vi.fn(),
    };
    const fixture = createFixture({ createOfficialConnection: () => connection });
    const outcomes: unknown[] = [];
    void fixture.running.then(
      (code) => outcomes.push(code),
      (error: unknown) => outcomes.push(error),
    );
    try {
      await vi.waitFor(() => expect(stopProcess).toHaveBeenCalled());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcomes).toEqual([]);
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "initialize",
        params: { clientInfo: { name: "codex_desktop", version: "synthetic" } },
      });
      const initializationResponse = await fixture.collector.waitFor(
        (message) => message.id === 901,
      );
      expect(initializationResponse.error).toBeUndefined();
      expect(initializationResponse).toMatchObject({ id: 901, result: expect.any(Object) });
      writeRequest(fixture.desktopInput, { method: "initialized", params: {} });
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.appendText("external output despite unconfirmed native exit");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      writeRequest(fixture.desktopInput, { id: 902, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 902),
      ).resolves.toMatchObject({
        id: 902,
        error: { code: -32001 },
      });
      expect(outcomes).toEqual([]);
    } finally {
      stopProcess.mockImplementation(async () => exit);
      fixture.host.close();
      await fixture.running.catch(() => undefined);
      connection.stdin.destroy();
      connection.stdout.destroy();
      connection.stderr.destroy();
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the initialized Desktop client attached through managed Account recovery", async () => {
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const nativeRequests: JsonObject[] = [];
    stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as JsonObject;
      nativeRequests.push(request);
      if (!("id" in request)) return;
      writeRequest(stdout, {
        id: request.id ?? null,
        result: request.method === "initialize" ? { userAgent: "synthetic-native" } : { data: [] },
      });
    });
    const createBackend = vi.fn((): OwnedOfficialBackend => ({
      closed: exit.promise,
      start: async () => {},
      connect: async () => ({
        stdin,
        stdout,
        stderr,
        closed: exit.promise,
        close: () => {},
      }),
      stop: async () => {
        stdin.end();
        stdout.end();
        stderr.end();
        exit.resolve({ code: 0, signal: null });
      },
    }));
    const scope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/permanent",
      createBackend: createBackend.mockImplementationOnce(() => {
        throw new Error("Synthetic initial startup failure");
      }),
      diagnosticOutput: new PassThrough(),
    });
    const accountControl = new SingleNativeCodexAccount(() => ({
      version: 2,
      currentAccountId: null,
      phase: scope.gate.phase,
      revision: scope.gate.revision,
      accounts: [],
    }));
    const fixture = createFixture({ officialRuntimeScope: scope, accountControl });
    const params = {
      clientInfo: { name: "codex_desktop", version: "synthetic" },
    };
    try {
      writeRequest(fixture.desktopInput, { id: 901, method: "initialize", params });
      const initial = await fixture.collector.waitFor((message) => message.id === 901);
      expect(initial.error).toBeUndefined();
      expect(initial).toMatchObject({ result: { codexHome: "/synthetic/permanent" } });
      expect(scope.gate.phase).toBe("unavailable");
      expect(createBackend).toHaveBeenCalledOnce();
      writeRequest(fixture.desktopInput, { method: "initialized" });
      await scope.owner.start();
      scope.gate.initialized();
      expect(nativeRequests).toContainEqual(
        expect.objectContaining({ method: "initialize", params }),
      );
      expect(nativeRequests).toContainEqual({ method: "initialized" });
      writeRequest(fixture.desktopInput, { id: 903, method: "model/list", params: {} });
      await expect(
        fixture.collector.waitFor((message) => message.id === 903),
      ).resolves.toMatchObject({
        result: { data: [] },
      });
      expect(fixture.collector.messages.filter((message) => message.id === 901)).toHaveLength(1);
      expect(createBackend).toHaveBeenCalledTimes(2);
    } finally {
      fixture.host.close();
      await fixture.running;
      await scope.close();
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("drains recovered native work only after actual writer exit, not a one-shot startup failure", async () => {
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const proof = Promise.withResolvers<undefined>();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as JsonObject;
      if ("id" in request)
        writeRequest(stdout, { id: request.id ?? null, result: { userAgent: "synthetic-native" } });
    });
    const stop = vi.fn(async () => {
      await proof.promise;
      stdin.end();
      stdout.end();
      stderr.end();
    });
    const scope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/permanent",
      diagnosticOutput: new PassThrough(),
      createBackend: vi
        .fn(() => ({
          closed: exit.promise,
          start: async () => {},
          stop,
          connect: async () => ({ stdin, stdout, stderr, closed: exit.promise, close: () => {} }),
        }))
        .mockImplementationOnce(() => {
          throw new Error("Synthetic initial startup failure");
        }),
    });
    const fixture = createFixture({ officialRuntimeScope: scope });
    let finished = false;
    void fixture.running.then(() => {
      finished = true;
    });
    try {
      writeRequest(fixture.desktopInput, { id: 901, method: "initialize", params: {} });
      await fixture.collector.waitFor((message) => message.id === 901);
      await scope.owner.start();
      scope.gate.initialized();
      writeRequest(stdout, {
        method: "turn/started",
        params: {
          threadId: "synthetic-native-thread",
          turn: { id: "synthetic-native-turn", status: "inProgress", items: [] },
        },
      });
      await fixture.collector.waitFor((message) => message.method === "turn/started");
      // Admission leases are independent from the Host's active-Turn draining.
      expect(scope.gate.busy).toBe(false);
      exit.resolve({ code: 1, signal: null });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      fixture.host.disconnect();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(scope.gate.busy).toBe(false);
      proof.resolve(undefined);
      await scope.owner.stop();
      await vi.waitFor(() => expect(finished).toBe(true));
    } finally {
      exit.resolve({ code: 1, signal: null });
      proof.resolve(undefined);
      fixture.host.close();
      await fixture.running;
      await scope.close();
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Host alive when official app-server output closes before Desktop input", async () => {
    const fixture = createFixture();

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
      fixture.official.stdout.end();

      const outcome = await Promise.race([
        fixture.running,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 100);
        }),
      ]);

      expect(outcome).toBe("timed-out");
      expect(fixture.desktopInput.destroyed).toBe(false);
      expect(fixture.official.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Host alive when official output closes while Desktop output is backpressured", async () => {
    const fixture = createFixture({ desktopOutput: new PassThrough({ highWaterMark: 1 }) });

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
      fixture.desktopOutput.pause();
      fixture.official.stdout.write(
        `${JSON.stringify({ method: "synthetic/event", params: { payload: "x".repeat(32_768) } })}\n`,
      );
      await vi.waitFor(() =>
        expect(fixture.desktopOutput.listenerCount("drain")).toBeGreaterThan(0),
      );
      fixture.official.stdout.end();

      const outcome = await Promise.race([
        fixture.running,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);

      expect(outcome).toBe("timed-out");
      expect(fixture.desktopInput.destroyed).toBe(false);
      expect(fixture.official.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      fixture.host.close();
      fixture.desktopOutput.resume();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Host alive when the official app-server exits while its output stays open", async () => {
    const fixture = createFixture();

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
      expect(
        fixture.official.stdin.write(Buffer.alloc(fixture.official.stdin.writableHighWaterMark)),
      ).toBe(false);
      writeRequest(fixture.desktopInput, { id: 90, method: "model/list", params: {} });
      await vi.waitFor(() =>
        expect(fixture.official.stdin.listenerCount("drain")).toBeGreaterThan(0),
      );
      fixture.official.emit("exit", 0, null);

      const outcome = await Promise.race([
        fixture.running,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);

      expect(outcome).toBe("timed-out");
      expect(fixture.desktopInput.destroyed).toBe(false);
      expect(fixture.spawnOfficial).toHaveBeenCalledOnce();
      expect(fixture.official.stdout.destroyed).toBe(true);
      // A confirmed exit releases process ownership; do not signal it again.
      expect(fixture.official.kill).not.toHaveBeenCalled();
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("keeps Desktop-first official app-server shutdown successful", async () => {
    const fixture = createFixture();

    try {
      await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
      fixture.desktopInput.end();

      await expect(fixture.running).resolves.toBe(0);
    } finally {
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("can share one initialized Mapping Store across concurrent remote sessions", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-shared-"));
    const mappingStore = new MappingStore({ directory });
    await mappingStore.initialize();
    const close = vi.spyOn(mappingStore, "close");
    const backendClosed = Promise.withResolvers<OfficialAppServerExit>();
    const connections = new Set<OfficialAppServerConnection>();
    const officialRuntimeScope = new OfficialRuntimeScope({
      permanentHome: "/synthetic/shared-home",
      diagnosticOutput: new PassThrough(),
      createBackend: (): OwnedOfficialBackend => ({
        closed: backendClosed.promise,
        async start() {},
        async connect() {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          const closed = Promise.withResolvers<OfficialAppServerExit>();
          const connection: OfficialAppServerConnection = {
            stdin,
            stdout,
            stderr,
            closed: closed.promise,
            close() {
              stdin.end();
              stdout.end();
              stderr.end();
              closed.resolve({ code: 0, signal: null });
              connections.delete(connection);
            },
          };
          connections.add(connection);
          return connection;
        },
        async stop() {
          for (const connection of [...connections]) connection.close();
          backendClosed.resolve({ code: 0, signal: null });
        },
      }),
    });
    const accountControl = new SingleNativeCodexAccount(() => ({
      version: 2,
      currentAccountId: null,
      phase: officialRuntimeScope.gate.phase,
      revision: officialRuntimeScope.gate.revision,
      accounts: [],
    }));
    // This checks shared Mapping Store lifetime with explicit shared Host composition.
    const first = createFixture({
      mappingStore,
      mappingStoreDirectory: directory,
      closeMappingStoreOnExit: false,
      officialRuntimeScope,
      accountControl,
    });
    const second = createFixture({
      mappingStore,
      mappingStoreDirectory: directory,
      closeMappingStoreOnExit: false,
      officialRuntimeScope,
      accountControl,
    });

    try {
      await Promise.all([closeFixture(first), closeFixture(second)]);
      expect(close).not.toHaveBeenCalled();
    } finally {
      await officialRuntimeScope.close();
      await mappingStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes fixed update controls locally without requesting Desktop quit", async () => {
    const updateCoordinator: HostUpdateCoordinator = {
      check: vi.fn(async () => ({
        currentVersion: "1.2.2",
        installation: "npm" as const,
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: "Safer updates",
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
        status: null,
        error: null,
      })),
      start: vi.fn(async () => ({
        status: {
          version: "1.2.3",
          installation: "npm" as const,
          phase: "prepared" as const,
          updatedAt: 10,
          error: null,
        },
      })),
      status: vi.fn(async () => ({ status: null })),
    };
    const fixture = createFixture({ updateCoordinator });

    writeRequest(fixture.desktopInput, {
      id: 20,
      method: "codexhost/update/check",
      params: {},
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 20)),
    ).resolves.toMatchObject({ result: { latestVersion: "1.2.3", updateAvailable: true } });

    writeRequest(fixture.desktopInput, {
      id: 21,
      method: "codexhost/update/start",
      params: {},
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 21)),
    ).resolves.toMatchObject({ result: { status: { phase: "prepared" } } });
    expect(updateCoordinator.start).toHaveBeenCalledOnce();
    await stopFixture(fixture);
  });

  it("rejects privileged update params and unavailable composition", async () => {
    const fixture = createFixture();
    writeRequest(fixture.desktopInput, {
      id: 22,
      method: "codexhost/update/start",
      params: { url: "https://example.com/update.exe" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 22)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    writeRequest(fixture.desktopInput, {
      id: 24,
      method: "codexhost/update/status",
      params: null,
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 24)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    writeRequest(fixture.desktopInput, {
      id: 23,
      method: "codexhost/update/check",
      params: {},
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 23)),
    ).resolves.toMatchObject({ error: { code: -32090 } });
    await stopFixture(fixture);
  });

  it("handles Pi inspection locally without opening a Thread Session", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 30,
      method: "codexhost/harness/inspect",
      params: { harnessId: "pi", cwd: "/synthetic", refresh: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 30)),
    ).resolves.toMatchObject({
      result: {
        status: "ready",
        catalog: { models: [{ label: "Fake Primary" }, { label: "Fake Secondary" }] },
        capabilities: {
          configuration: { selectModel: true, selectThinkingOption: true },
          history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        },
      },
    });
    expect(fixture.adapter.inspectionCalls).toBe(1);
    expect(fixture.adapter.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });
});
