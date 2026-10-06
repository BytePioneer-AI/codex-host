import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createFixture,
  stopFixture,
  startPiThread,
  startPiTurn,
  turnEvent,
  readJsonLine,
} from "./app-server-host-fixture.js";

it("batches a native streaming burst without reordering completion", async () => {
  const f = createFixture();
  try {
    await f.ready;
    for (let index = 0; index < 100; index++)
      f.official.stdout.write(
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { threadId: "native", turnId: "turn", itemId: "item", delta: "🙂" },
        }) + "\n",
      );
    f.official.stdout.write(
      JSON.stringify({
        method: "item/completed",
        params: { threadId: "native", turnId: "turn", item: { id: "item" } },
      }) + "\n",
    );
    await f.collector.waitFor((message) => message.method === "item/completed");
    const deltas = f.collector.messages.filter(
      (message) => message.method === "item/agentMessage/delta",
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.params).toMatchObject({ delta: "🙂".repeat(100) });
  } finally {
    await stopFixture(f);
  }
});

it.each(["before shutdown", "during Session close"])(
  "exports the final Turn settled %s before stopping the native backend",
  async (phase) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "host-native-history-"));
    const f = createFixture({
      environment: { CODEX_HOME: home, CODEXHOST_EXPORT_HISTORY_ON_EXIT: "1" },
    });
    try {
      const threadId = await startPiThread(f);
      const turnId = await startPiTurn(f, threadId);
      const session = f.adapter.sessions[0];
      if (!session) throw new Error("Missing external Session");
      const complete = () => {
        session.appendText("Historical reply");
        session.succeedTurn();
      };
      if (phase === "before shutdown") {
        complete();
        await f.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      } else {
        const close = session.close.bind(session);
        vi.spyOn(session, "close").mockImplementation(async () => {
          complete();
          await close();
        });
      }
      expect(f.spawnOfficial).toHaveBeenCalledTimes(1);
      const stopped = stopFixture(f);
      const request = await readJsonLine(f.official.stdin);
      expect(request.method).toBe("thread/read");
      expect(request.params).toMatchObject({ includeTurns: false });
      expect(f.official.stdin.writableEnded).toBe(false);
      f.official.stdout.write(
        JSON.stringify({
          id: request.id,
          result: { thread: { id: (request.params as { threadId: string }).threadId } },
        }) + "\n",
      );
      await stopped;
      const files = (await readdir(home, { recursive: true })).filter((file) =>
        file.endsWith(".jsonl"),
      );
      expect(files).toHaveLength(1);
      const file = files[0];
      if (!file) throw new Error("Missing exported history");
      expect(await readFile(path.join(home, file), "utf8")).toContain("Historical reply");
      expect(f.official.stdin.read()).toBeNull();
    } finally {
      f.host.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
