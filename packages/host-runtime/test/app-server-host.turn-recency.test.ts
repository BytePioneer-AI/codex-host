import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { MappingStore } from "@codexhost/mapping-store";
import { describe, expect, it, vi } from "vitest";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
} from "./app-server-host-fixture.js";

describe("AppServerHost Turn recency", () => {
  it("advances the stored External Thread updatedAt when a Turn starts and ends", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const mappingStoreDirectory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const mappingStore = new MappingStore({
      directory: mappingStoreDirectory,
      now: () => new Date(now),
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory });
    try {
      const threadId = await startPiThread(fixture);
      const hostThreadId = hostThreadIdSchema.parse(threadId);
      const updatedAt = async () => (await mappingStore.getThread(hostThreadId))?.updatedAt;
      expect(await updatedAt()).toBe("2026-01-01T00:00:00.000Z");

      now = Date.parse("2026-01-01T00:01:00.000Z");
      const turnId = await startPiTurn(fixture, threadId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      await vi.waitFor(async () => expect(await updatedAt()).toBe("2026-01-01T00:01:00.000Z"));

      now = Date.parse("2026-01-01T00:02:00.000Z");
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.appendText("answer");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      expect(await updatedAt()).toBe("2026-01-01T00:02:00.000Z");
    } finally {
      await stopFixture(fixture);
    }
  });
});
