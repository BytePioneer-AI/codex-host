import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MappingStore } from "@codexhost/mapping-store";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type {
  BillingSourceOpenResult,
  BillingSourceSession,
  CreateSessionInput,
  HarnessResult,
} from "@codexhost/harness-adapter";
import {
  billingSourceRefSchema,
  harnessIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  JsonLineCollector,
  closeFixture,
  createFixture,
  method,
  requestId,
  requiredMessageId,
  startExternalThread,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

function loadedSession(fixture: ReturnType<typeof createFixture>) {
  const session = fixture.adapter.sessions[0];
  if (!session) throw new Error("Expected a loaded Harness Session");
  return session;
}

async function deleteThread(fixture: ReturnType<typeof createFixture>, threadId: string, id = 10) {
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/delete",
    params: { threadId },
  });
  return fixture.collector.waitFor((message) => requestId(message, id));
}

async function expectDeleted(fixture: ReturnType<typeof createFixture>, threadId: string) {
  const notification = await fixture.collector.waitFor((message) =>
    method(message, "thread/deleted"),
  );
  expect(notification).toEqual({ method: "thread/deleted", params: { threadId } });
  expect(
    fixture.collector.messages.filter((message) => method(message, "thread/deleted")),
  ).toHaveLength(1);
  expect(await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toBeNull();
  expect(fixture.official.stdin.readableLength).toBe(0);
}

function answerEmptyOfficialLists(fixture: ReturnType<typeof createFixture>) {
  const official = new JsonLineCollector(fixture.official.stdin);
  fixture.official.stdin.on("data", () => {
    for (const request of official.messages.splice(0)) {
      writeRequest(fixture.official.stdout, {
        id: requiredMessageId(request),
        result: { data: [], nextCursor: null, backwardsCursor: null },
      });
    }
  });
}

async function listedThreadIds(fixture: ReturnType<typeof createFixture>, id = 90) {
  writeRequest(fixture.desktopInput, { id, method: "thread/list", params: {} });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  expect(response).not.toHaveProperty("error");
  return (response.result as { data: { id: string }[] }).data.map((thread) => thread.id);
}

function fakeBillingAdapter(
  confirmNativeCleanup: BillingSourceSession["confirmNativeCleanup"],
  mismatched = false,
) {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("omp"));
  const ordinaryOpen = adapter.open.bind(adapter);
  const openBillingSource = vi.fn(
    async (
      input: CreateSessionInput & { billingSourceRef: BillingSourceSession["billingSourceRef"] },
    ): Promise<BillingSourceOpenResult> => {
      const opened = await ordinaryOpen(input);
      if (!opened.ok) return { ...opened, nativeCleanup: "not-persisted" };
      const billingSourceRef = mismatched
        ? { ...input.billingSourceRef, id: "different-source" }
        : input.billingSourceRef;
      Object.defineProperty(opened.value, "initialState", {
        value: { ...opened.value.initialState, nativeRef: undefined },
      });
      return {
        ok: true,
        value: Object.assign(opened.value, { billingSourceRef, confirmNativeCleanup }),
      };
    },
  );
  return { adapter, openBillingSource };
}

describe("external Thread local deletion", () => {
  it("closes the loaded connection and publishes the native deletion notification after replying", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const close = vi.spyOn(loadedSession(fixture), "close");
      expect(await deleteThread(fixture, threadId)).toEqual({ id: 10, result: {} });
      await expectDeleted(fixture, threadId);
      expect(close).toHaveBeenCalledOnce();
      expect(
        fixture.collector.messages.findIndex((message) => requestId(message, 10)),
      ).toBeLessThan(
        fixture.collector.messages.findIndex((message) => method(message, "thread/deleted")),
      );
    } finally {
      await stopFixture(fixture);
    }
  });

  it("deletes an unloaded archived mapping without opening or deleting its native Session", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-delete-"));
    const nativeFile = path.join(directory, "native-session.jsonl");
    const history = '{"type":"message","text":"native history"}\n';
    writeFileSync(nativeFile, history);
    const mappingDirectory = path.join(directory, "host");
    const store = new MappingStore({ directory: mappingDirectory });
    const threadId = hostThreadIdSchema.parse("unloaded-thread");
    const harnessId = harnessIdSchema.parse("pi");
    await store.initialize();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "create-unloaded",
      harnessId,
      cwd: directory,
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: {
        harnessId,
        nativeSessionId: "native-session",
        locator: { sessionFile: nativeFile },
        formatVersion: 1,
      },
    });
    await store.setArchived(threadId, true);
    await store.updateMetadata(threadId, { projectId: "project" });
    await store.close();
    const fixture = createFixture({ mappingStoreDirectory: mappingDirectory });
    const open = vi.spyOn(fixture.adapter, "open");
    try {
      await fixture.ready;
      expect(await deleteThread(fixture, threadId)).toEqual({ id: 10, result: {} });
      await expectDeleted(fixture, threadId);
      expect(open).not.toHaveBeenCalled();
      expect(readFileSync(nativeFile, "utf8")).toBe(history);
    } finally {
      await closeFixture(fixture);
    }
    expect(existsSync(mappingDirectory)).toBe(true);
    const reopened = new MappingStore({ directory: mappingDirectory });
    try {
      await reopened.initialize();
      expect(await reopened.listThreads()).toEqual([]);
      expect(readFileSync(nativeFile, "utf8")).toBe(history);
    } finally {
      await reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains the mapping and emits no deletion notification when persistence fails", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const close = vi.spyOn(loadedSession(fixture), "close");
      vi.spyOn(fixture.mappingStore, "removeThread").mockRejectedValueOnce(
        new Error("disk failure"),
      );
      expect(await deleteThread(fixture, threadId)).toMatchObject({ error: { code: -32081 } });
      expect(
        await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).not.toBeNull();
      expect(close).toHaveBeenCalledOnce();
      expect(fixture.collector.messages.some((message) => method(message, "thread/deleted"))).toBe(
        false,
      );
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps failed cleanup tracked and drains the still-live output before retrying deletion", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      const session = loadedSession(fixture);
      const close = vi
        .spyOn(session, "close")
        .mockRejectedValueOnce(new Error("close failed before output ended"));
      const remove = vi.spyOn(fixture.mappingStore, "removeThread");

      expect(await deleteThread(fixture, threadId)).toMatchObject({ error: { code: -32075 } });
      expect(remove).not.toHaveBeenCalled();
      expect(
        await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).not.toBeNull();
      expect(fixture.collector.messages.some((message) => method(message, "thread/deleted"))).toBe(
        false,
      );
      session.appendText("output after the failed close");
      await fixture.collector.waitFor((message) => method(message, "item/agentMessage/delta"));

      expect(await deleteThread(fixture, threadId, 11)).toEqual({ id: 11, result: {} });
      await expectDeleted(fixture, threadId);
      expect(close).toHaveBeenCalledTimes(2);
      const completed = fixture.collector.messages.findIndex((message) =>
        method(message, "turn/completed"),
      );
      const deleted = fixture.collector.messages.findIndex((message) =>
        method(message, "thread/deleted"),
      );
      expect(completed).toBeGreaterThanOrEqual(0);
      expect(completed).toBeLessThan(deleted);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps a bound Thread after unconfirmed native cleanup, never reopens it, and acknowledges both removals separately", async () => {
    const billingSourceRef = billingSourceRefSchema.parse({ harnessId: "omp", id: "source-b" });
    const adapter = new FakeHarnessAdapter(billingSourceRef.harnessId);
    const ordinaryOpen = adapter.open.bind(adapter);
    const unbound = vi.spyOn(adapter, "open");
    const confirmNativeCleanup = vi
      .fn<() => Promise<HarnessResult<"not-persisted">>>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "nativeFailure", message: "no receipt", retryable: false },
      })
      .mockResolvedValue({ ok: true, value: "not-persisted" });
    const openBillingSource = vi.fn(
      async (
        input: CreateSessionInput & { billingSourceRef: typeof billingSourceRef },
      ): Promise<BillingSourceOpenResult> => {
        const opened = await ordinaryOpen(input);
        if (!opened.ok) return { ...opened, nativeCleanup: "not-persisted" };
        return {
          ok: true,
          value: Object.assign(opened.value, {
            billingSourceRef: input.billingSourceRef,
            confirmNativeCleanup,
          }),
        };
      },
    );
    const fixture = createFixture({
      additionalAdapters: new Map([["omp", Object.assign(adapter, { openBillingSource })]]),
    });
    try {
      await startExternalThread(fixture, "codexhost/omp-native", 1);
      expect(unbound).toHaveBeenCalledOnce();
      const threadId = await startExternalThread(fixture, "codexhost/omp-native", 2, {
        billingSourceRef,
      });
      expect(openBillingSource).toHaveBeenCalledWith(expect.objectContaining({ billingSourceRef }));
      expect(unbound).toHaveBeenCalledOnce();
      const id = hostThreadIdSchema.parse(threadId);
      await startPiTurn(fixture, threadId, 3);
      adapter.sessions[1]!.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
      const execute = vi.spyOn(adapter.sessions[1]!, "execute");
      expect(await deleteThread(fixture, threadId)).toMatchObject({
        error: { code: -32075, message: expect.stringContaining("native cleanup is unconfirmed") },
      });
      expect(await fixture.mappingStore.getThread(id)).toMatchObject({ billingSourceRef });
      expect(fixture.collector.messages.some((message) => method(message, "thread/deleted"))).toBe(
        false,
      );
      writeRequest(fixture.desktopInput, {
        id: 12,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "must not be replayed" }] },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 12))).toMatchObject({
        error: { code: -32079 },
      });
      expect(unbound).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(await deleteThread(fixture, threadId, 13)).toEqual({
        id: 13,
        result: { nativeSession: "not-persisted", hostMapping: "deleted" },
      });
      await expectDeleted(fixture, threadId);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("confirms disposable cleanup during normal Host shutdown and leaves no mapping after restart", async () => {
    const confirmNativeCleanup = vi.fn(async (): Promise<HarnessResult<"not-persisted">> => ({
      ok: true,
      value: "not-persisted",
    }));
    const { adapter, openBillingSource } = fakeBillingAdapter(confirmNativeCleanup);
    const fixture = createFixture({
      additionalAdapters: new Map([["omp", Object.assign(adapter, { openBillingSource })]]),
    });
    const billingSourceRef = billingSourceRefSchema.parse({ harnessId: "omp", id: "source-close" });
    const threadId = await startExternalThread(fixture, "codexhost/omp-native", 2, {
      billingSourceRef,
    });
    await closeFixture(fixture);
    expect(confirmNativeCleanup).toHaveBeenCalledOnce();

    const restarted = createFixture({ mappingStoreDirectory: fixture.mappingStoreDirectory });
    answerEmptyOfficialLists(restarted);
    try {
      await restarted.ready;
      expect(await listedThreadIds(restarted)).toEqual([]);
      expect(await restarted.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toBeNull();
    } finally {
      await stopFixture(restarted);
    }
  });

  it.each(["not-persisted", "invalid"] as const)(
    "settles a mismatched create after its %s cleanup receipt",
    async (receipt) => {
      const confirmNativeCleanup = vi.fn(async (): Promise<HarnessResult<"not-persisted">> => ({
        ok: true,
        value: receipt === "invalid" ? ("invalid" as "not-persisted") : receipt,
      }));
      const { adapter, openBillingSource } = fakeBillingAdapter(confirmNativeCleanup, true);
      const fixture = createFixture({
        additionalAdapters: new Map([["omp", Object.assign(adapter, { openBillingSource })]]),
      });
      try {
        const billingSourceRef = billingSourceRefSchema.parse({
          harnessId: "omp",
          id: "source-create",
        });
        writeRequest(fixture.desktopInput, {
          id: 2,
          method: "thread/start",
          params: { model: "codexhost/omp-native", cwd: "/synthetic", billingSourceRef },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
          error: { code: -32075 },
        });
        const retained = await fixture.mappingStore.listThreads();
        if (receipt === "not-persisted") {
          expect(retained).toEqual([]);
        } else {
          expect(retained).toHaveLength(1);
          const threadId = retained[0]!.hostThreadId;
          expect(retained[0]).toMatchObject({ state: "creating", billingSourceRef });
          expect(await deleteThread(fixture, threadId)).toEqual({
            id: 10,
            result: { nativeSession: "unknown", hostMapping: "deleted" },
          });
          await expectDeleted(fixture, threadId);
        }
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("lists an unknown-cleanup mapping after restart and lets the user forget it explicitly", async () => {
    const confirmNativeCleanup = vi.fn(async (): Promise<HarnessResult<"not-persisted">> => ({
      ok: false,
      error: { code: "nativeFailure", message: "native disposal failed", retryable: false },
    }));
    const { adapter, openBillingSource } = fakeBillingAdapter(confirmNativeCleanup);
    const fixture = createFixture({
      additionalAdapters: new Map([["omp", Object.assign(adapter, { openBillingSource })]]),
    });
    const billingSourceRef = billingSourceRefSchema.parse({
      harnessId: "omp",
      id: "source-failed",
    });
    const threadId = await startExternalThread(fixture, "codexhost/omp-native", 2, {
      billingSourceRef,
    });
    await closeFixture(fixture);
    expect(confirmNativeCleanup).toHaveBeenCalledOnce();

    const restarted = createFixture({ mappingStoreDirectory: fixture.mappingStoreDirectory });
    answerEmptyOfficialLists(restarted);
    try {
      await restarted.ready;
      expect(await listedThreadIds(restarted)).toEqual([threadId]);
      expect(
        await restarted.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).toMatchObject({
        state: "creating",
        billingSourceRef,
      });
      expect(await deleteThread(restarted, threadId)).toEqual({
        id: 10,
        result: { nativeSession: "unknown", hostMapping: "deleted" },
      });
      await expectDeleted(restarted, threadId);
    } finally {
      await stopFixture(restarted);
    }
  });

  it.each([
    ["approval", false],
    ["question", false],
    ["approval", true],
    ["question", true],
  ] as const)(
    "resolves pending Desktop %s when close omits terminal events (persistence failure: %s)",
    async (kind, persistenceFailure) => {
      const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
      const open = adapter.open.bind(adapter);
      let closing = false;
      vi.spyOn(adapter, "open").mockImplementation(async (input) => {
        const result = await open(input);
        if (result.ok) {
          const outputs = result.value.outputs;
          const close = result.value.close.bind(result.value);
          vi.spyOn(result.value, "close").mockImplementation(async () => {
            closing = true;
            await close();
          });
          Object.defineProperty(result.value, "outputs", {
            value: (async function* () {
              for await (const output of outputs) {
                if (!closing) yield output;
              }
            })(),
          });
        }
        return result;
      });
      const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
      try {
        const threadId = await startPiThread(fixture);
        const session = loadedSession(fixture);
        if (kind === "approval") session.requestApprovalOnNextTurn("Allow action?");
        await startPiTurn(fixture, threadId);
        if (kind === "question") {
          session.askQuestion({
            id: "value",
            type: "text",
            prompt: "Value?",
            optional: false,
            multiline: false,
            secret: false,
          });
        }
        const request = await fixture.collector.waitFor((message) =>
          method(
            message,
            kind === "approval" ? "mcpServer/elicitation/request" : "item/tool/requestUserInput",
          ),
        );
        if (persistenceFailure) {
          vi.spyOn(fixture.mappingStore, "removeThread").mockRejectedValueOnce(
            new Error("disk failure"),
          );
          expect(await deleteThread(fixture, threadId)).toMatchObject({ error: { code: -32081 } });
          expect(
            await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
          ).not.toBeNull();
          expect(
            fixture.collector.messages.some((message) => method(message, "thread/deleted")),
          ).toBe(false);
        } else {
          expect(await deleteThread(fixture, threadId)).toEqual({ id: 10, result: {} });
          await expectDeleted(fixture, threadId);
        }
        const resolved = await fixture.collector.waitFor((message) =>
          method(message, "serverRequest/resolved"),
        );
        expect(resolved).toMatchObject({ params: { requestId: request.id, threadId } });
        expect(fixture.collector.messages.indexOf(resolved)).toBeLessThan(
          fixture.collector.messages.findIndex((message) => requestId(message, 10)),
        );
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it.each(["approval", "question"])(
    "does not retire another Thread's %s with the same Harness interaction ID",
    async (kind) => {
      const fixture = createFixture();
      try {
        const firstId = await startPiThread(fixture);
        const secondId = await startExternalThread(fixture, "codexhost/pi-native", 3);
        const first = loadedSession(fixture);
        const second = fixture.adapter.sessions[1];
        if (!second) throw new Error("Expected another Harness Session");
        if (kind === "approval") {
          first.requestApprovalOnNextTurn("Allow first?");
          second.requestApprovalOnNextTurn("Allow second?");
        }
        await startPiTurn(fixture, firstId, 2);
        await startPiTurn(fixture, secondId, 4);
        if (kind === "question") {
          for (const session of [first, second]) {
            session.askQuestion({
              id: "value",
              type: "text",
              prompt: "Value?",
              optional: false,
              multiline: false,
              secret: false,
            });
          }
        }
        const request = await fixture.collector.waitFor(
          (message) =>
            method(
              message,
              kind === "approval" ? "mcpServer/elicitation/request" : "item/tool/requestUserInput",
            ) && (message.params as { threadId?: string }).threadId === secondId,
        );
        if (typeof request.id !== "number")
          throw new Error("Expected a numeric Desktop request ID");
        expect(await deleteThread(fixture, firstId)).toEqual({ id: 10, result: {} });
        await expectDeleted(fixture, firstId);
        expect(
          fixture.collector.messages.some(
            (message) =>
              method(message, "serverRequest/resolved") &&
              (message.params as { requestId?: number }).requestId === request.id,
          ),
        ).toBe(false);
        writeRequest(fixture.desktopInput, {
          id: request.id,
          result:
            kind === "approval"
              ? { action: "accept", content: {}, _meta: null }
              : { answers: { value: { answers: ["kept"] } } },
        });
        await vi.waitFor(() => expect(second.interactionResponses).toHaveLength(1));
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("retries failed cleanup during Host shutdown without declaring the Thread deleted", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const close = vi
      .spyOn(loadedSession(fixture), "close")
      .mockRejectedValueOnce(new Error("close failed"));
    try {
      expect(await deleteThread(fixture, threadId)).toMatchObject({ error: { code: -32075 } });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await stopFixture(fixture);
    }
    expect(close.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.collector.messages.some((message) => method(message, "thread/deleted"))).toBe(
      false,
    );
  });
});
