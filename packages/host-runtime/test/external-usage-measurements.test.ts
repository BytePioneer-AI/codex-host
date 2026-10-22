import { readFile, readdir, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  threadUsageInspectionSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  closeFixture,
  stopFixture,
  startPiThread,
  startPiTurn,
  writeRequest,
  turnEvent,
} from "./app-server-host-fixture.js";

it("flushes external metrics at completion into metadata and restores them with a new Host meter", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  const first = createFixture();
  let second: ReturnType<typeof createFixture> | undefined;
  let closed = false;
  let request = 800;
  const inspect = async (f: ReturnType<typeof createFixture>, threadId: string) => {
    const id = request++;
    writeRequest(f.desktopInput, {
      id,
      method: "codexhost/thread/usage/inspect",
      params: { threadId },
    });
    const response = await f.collector.waitFor((message) => message.id === id);
    return threadUsageInspectionSchema.parse(response.result).usage;
  };
  try {
    const id = await startPiThread(first);
    const turn = await startPiTurn(first, id);
    await first.collector.waitFor((message) => turnEvent(message, "turn/started", turn));
    const session = first.adapter.sessions[0];
    if (!session) throw new Error("Missing session");
    clock.mockReturnValue(100020);
    session.appendText("first output");
    await first.collector.waitFor((message) => message.method === "item/agentMessage/delta");
    session.emitEvent({ type: "usage.history", complete: true });
    for (let n = 0; n < 10; n++)
      session.emitEvent({
        type: "usage.request",
        request: {
          requestId: `r${n}`,
          inputTokens: 100,
          outputTokens: 10,
          startedAtMs: 100030 + n * 100,
          completedAtMs: 100080 + n * 100,
        },
      });
    await vi.waitFor(async () =>
      expect((await inspect(first, id))?.outputTokensPerSecond).toBe(200),
    );
    const metadata = join(first.mappingStoreDirectory, "thread-metadata", `${id}.json`);
    expect(JSON.parse(await readFile(metadata, "utf8")).usageMeasurements).toBeUndefined();
    session.succeedTurn();
    await first.collector.waitFor((message) => turnEvent(message, "turn/completed", turn));
    const saved = JSON.parse(await readFile(metadata, "utf8"));
    expect(saved.usageMeasurements.values).toMatchObject({
      outputTokensPerSecond: { value: 200, turnId: turn },
      timeToFirstOutputMs: { value: 20, turnId: turn },
    });
    expect(await readdir(first.mappingStoreDirectory)).not.toContain("usage-measurements-v1");
    const snapshot = session.persistedSnapshot();
    const ref = session.initialState.nativeRef;
    if (!ref) throw new Error("Missing native ref");
    await closeFixture(first);
    closed = true;
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    vi.spyOn(adapter, "open").mockImplementation(async (input) => {
      if (input.kind !== "resume") throw new Error("Expected native resume");
      const resumed = new FakeHarnessSession(
        adapter.harnessId,
        adapter.catalog,
        adapter.catalog.defaultModel,
        ref,
        snapshot,
      );
      adapter.sessions.push(resumed);
      return { ok: true, value: resumed };
    });
    second = createFixture({
      mappingStoreDirectory: first.mappingStoreDirectory,
      externalAdapters: new Map([[adapter.harnessId, adapter]]),
    });
    expect(await inspect(second, id)).toMatchObject({
      outputTokensPerSecond: 200,
      timeToFirstOutputMs: 20,
    });
    clock.mockReturnValue(200000);
    const next = await startPiTurn(second, id, 2);
    await second.collector.waitFor((message) => turnEvent(message, "turn/started", next));
    const resumed = adapter.sessions[0];
    if (!resumed) throw new Error("Missing resumed session");
    clock.mockReturnValue(200050);
    resumed.appendText("new output");
    await second.collector.waitFor((message) => message.method === "item/agentMessage/delta");
    resumed.emitEvent({ type: "usage.history", complete: true });
    resumed.emitEvent({
      type: "usage.request",
      request: {
        requestId: "new",
        inputTokens: 100,
        outputTokens: 20,
        startedAtMs: 200100,
        completedAtMs: 200300,
      },
    });
    const reopened = second;
    await vi.waitFor(async () =>
      expect(await inspect(reopened, id)).toMatchObject({
        outputTokensPerSecond: 100,
        timeToFirstOutputMs: 50,
      }),
    );
    resumed.succeedTurn();
    await second.collector.waitFor((message) => turnEvent(message, "turn/completed", next));
  } finally {
    if (second) await stopFixture(second);
    else {
      if (!closed) await closeFixture(first);
      await rm(first.mappingStoreDirectory, { recursive: true, force: true });
    }
    clock.mockRestore();
  }
});

it("optional metadata write failure does not turn successful native work into a failed Turn", async () => {
  const f = createFixture();
  try {
    const id = await startPiThread(f);
    const turn = await startPiTurn(f, id);
    const session = f.adapter.sessions[0];
    if (!session) throw new Error("Missing session");
    session.appendText("answer");
    await f.collector.waitFor((message) => message.method === "item/agentMessage/delta");
    const metadata = join(f.mappingStoreDirectory, "thread-metadata", `${id}.json`);
    await rm(metadata, { force: true });
    await mkdir(metadata);
    session.succeedTurn();
    const complete = await f.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", turn),
    );
    expect(complete).toMatchObject({ params: { turn: { status: "completed" } } });
    const record = JSON.parse(
      await readFile(join(f.mappingStoreDirectory, "threads", `${id}.json`), "utf8"),
    );
    expect(record.turnMappings.at(-1).hostTurnId).toBe(hostTurnIdSchema.parse(turn));
  } finally {
    await stopFixture(f);
  }
});
