import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput, HostUsage } from "@codexhost/harness-adapter";
import { CopilotAdapter } from "../src/adapter.js";
import { createCopilotClient } from "../src/client.js";

const latest = (outputs: HarnessOutput[]): HostUsage | null | undefined =>
  outputs
    .flatMap((output) =>
      output.kind === "event" && output.event.type === "session.usage.changed"
        ? [output.event.usage]
        : [],
    )
    .at(-1);

describe.runIf(process.env.CODEXHOST_COPILOT_NATIVE_TEST === "1")(
  "Copilot native speed telemetry",
  () => {
    it("publishes native generation/API rates and cache facts, retains them on refresh, and does not fabricate restored timing", async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "copilot-usage-native-"));
      const adapter = new CopilotAdapter({ ...process.env });
      let id: string | undefined;
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const outputs: HarnessOutput[] = [];
        const reading = (async () => {
          for await (const output of opened.value.outputs) outputs.push(output);
        })();
        expect(
          (
            await opened.value.execute({
              type: "turn.start",
              turnId: hostTurnIdSchema.parse("speed-native"),
              input: [
                {
                  type: "text",
                  text: "用中文写三小段解释二分查找及复杂度，只输出解释，不调用工具。",
                },
              ],
            })
          ).ok,
        ).toBe(true);
        await vi.waitFor(
          () =>
            expect(
              outputs.some(
                (output) =>
                  output.kind === "event" &&
                  output.event.type === "turn.completed" &&
                  output.event.outcome.status === "succeeded",
              ),
            ).toBe(true),
          { timeout: 60_000, interval: 100 },
        );
        await opened.value.refreshUsage?.();
        expect(latest(outputs)?.outputTokensPerSecond).toBeGreaterThan(0);
        expect(latest(outputs)?.apiOutputTokensPerSecond).toBeGreaterThan(0);
        expect(latest(outputs)?.outputTokensPerSecond).toBeGreaterThan(
          latest(outputs)?.apiOutputTokensPerSecond ?? Infinity,
        );
        expect(latest(outputs)?.cacheHitRatePercent).toBeGreaterThanOrEqual(0);
        expect(latest(outputs)?.sessionCacheUsage?.inputTokens).toBeGreaterThan(0);
        const snapshot = await opened.value.readSnapshot();
        const ref = snapshot.ok ? snapshot.value.state?.nativeRef : undefined;
        if (!ref) throw new Error("Missing persisted native identity");
        id = ref.nativeSessionId;
        await opened.value.close();
        await reading;
        const resumed = await adapter.open({ kind: "resume", cwd, nativeRef: ref });
        if (!resumed.ok) throw new Error(resumed.error.message);
        const restored: HarnessOutput[] = [];
        const rereading = (async () => {
          for await (const output of resumed.value.outputs) restored.push(output);
        })();
        await resumed.value.refreshUsage?.();
        expect(latest(restored)?.outputTokensPerSecond).toBeUndefined();
        expect(latest(restored)?.apiOutputTokensPerSecond).toBeUndefined();
        expect(latest(restored)?.sessionCacheUsage?.inputTokens).toBeGreaterThan(0);
        await resumed.value.close();
        await rereading;
      } finally {
        await adapter.close();
        if (id) {
          const cleanup = createCopilotClient({ cwd, environment: process.env });
          try {
            await cleanup.start();
            await cleanup.deleteSession(id);
          } finally {
            await cleanup.stop();
          }
        }
        await rm(cwd, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
