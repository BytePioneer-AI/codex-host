import { describe, expect, it, vi } from "vitest";
import type { HarnessSessionState } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";

import {
  JsonLineCollector,
  closeFixture,
  createFixture,
  method,
  requestId,
  startPiThread,
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
