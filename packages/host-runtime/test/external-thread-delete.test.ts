import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MappingStore } from "@codexhost/mapping-store";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  closeFixture,
  createFixture,
  method,
  requestId,
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
