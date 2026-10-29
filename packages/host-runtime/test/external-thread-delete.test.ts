import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MappingStore } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createFixture,
  method,
  requestId,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

function loadedSession(fixture: ReturnType<typeof createFixture>) {
  const session = fixture.adapter.sessions[0];
  if (!session) throw new Error("Expected a loaded Harness Session");
  return session;
}

async function deleteThread(fixture: ReturnType<typeof createFixture>, threadId: string) {
  writeRequest(fixture.desktopInput, {
    id: 10,
    method: "thread/delete",
    params: { threadId },
  });
  return fixture.collector.waitFor((message) => requestId(message, 10));
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
      await stopFixture(fixture);
    }
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

  it("keeps the connection and emits no deletion notification when persistence fails", async () => {
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
      expect(close).not.toHaveBeenCalled();
      expect(fixture.collector.messages.some((message) => method(message, "thread/deleted"))).toBe(
        false,
      );
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("still reports committed deletion when closing the detached connection fails", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = loadedSession(fixture);
      const close = session.close.bind(session);
      vi.spyOn(session, "close").mockImplementationOnce(async () => {
        await close();
        throw new Error("synthetic close failure");
      });
      expect(await deleteThread(fixture, threadId)).toEqual({ id: 10, result: {} });
      await expectDeleted(fixture, threadId);
      expect(String(fixture.diagnosticOutput.read())).toContain("synthetic close failure");
    } finally {
      await stopFixture(fixture);
    }
  });
});
