import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  requestId,
  startExternalThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("Grok native usage and Host TTFT", () => {
  it.each(["agentMessage", "reasoning"] as const)(
    "observes first %s output while preserving native cost and Adapter generation TPS",
    async (type) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
      const id = harnessIdSchema.parse("grok");
      const adapter = new FakeHarnessAdapter(id);
      const fixture = createFixture({ externalAdapters: new Map([[id, adapter]]) });
      try {
        const threadId = await startExternalThread(
          fixture,
          encodeHarnessPluginRoute({ harnessId: id }),
          1,
        );
        const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 2));
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
        const session = adapter.sessions[0];
        if (!session) throw Error("No Grok fixture Session");
        clock.mockReturnValue(101250);
        const itemId = hostItemIdSchema.parse("first-output");
        session.emitEvent({ type: "item.started", turnId, item: { type, itemId, text: "" } });
        session.emitEvent({
          type: "item.updated",
          turnId,
          itemId,
          update: { type: "text.append", text: "hello" },
        });
        // Same public event shape as GrokAdapter. No usage.history: native cost stays authoritative.
        session.publishUsage({
          totalCostUsd: 0.09920104,
          outputTokens: 1571,
          outputTokensPerSecond: 50,
        });
        session.succeedTurn();
        await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
        writeRequest(fixture.desktopInput, {
          id: 3,
          method: "codexhost/thread/usage/inspect",
          params: { threadId },
        });
        const response = await fixture.collector.waitFor((message) => requestId(message, 3));
        expect(response).toMatchObject({
          result: {
            usage: {
              totalCostUsd: 0.09920104,
              costSource: "native",
              timeToFirstOutputMs: 1250,
              outputTokensPerSecond: 50,
            },
          },
        });
        expect(response).not.toHaveProperty("result.usage.apiOutputTokensPerSecond");
        expect(response).not.toHaveProperty("result.usage.sessionCacheHitRatePercent");
      } finally {
        await stopFixture(fixture);
        clock.mockRestore();
      }
    },
  );
});
