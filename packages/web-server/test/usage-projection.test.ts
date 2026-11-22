import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";

import { defaultProjections, SessionLog } from "../src/session-log.ts";
import {
  applyUsageProjections,
  projectTokenUsage,
  projectUncachedInputTokens,
} from "../src/usage-projection.ts";

describe("usage projection", () => {
  it("derives uncached input from an authoritative total", () => {
    assert.equal(
      projectUncachedInputTokens({
        inputTokens: 100,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 50,
        outputTokens: 40,
        totalTokens: 1_090,
      }),
      100,
    );
  });

  it("supports normalized Host input when a total is unavailable", () => {
    assert.equal(
      projectUncachedInputTokens({
        inputTokens: 1_050,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 50,
      }),
      100,
    );
  });

  it("does not guess the input convention without an authoritative total", () => {
    assert.equal(
      projectUncachedInputTokens({
        inputTokens: 100,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 50,
      }),
      null,
    );
  });

  it("keeps real zero-cache input distinguishable from unknown cache buckets", () => {
    assert.deepEqual(
      projectTokenUsage({
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      }),
      { uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
    for (const usage of [
      null,
      { inputTokens: 100, outputTokens: 40 },
      { inputTokens: 100, outputTokens: 40, cachedInputTokens: 90 },
      { inputTokens: 100, outputTokens: 40, cacheWriteInputTokens: 0 },
      { totalTokens: 140, outputTokens: 40 },
      { inputTokens: 100, cachedInputTokens: 90, cacheWriteInputTokens: 0 },
    ]) {
      assert.deepEqual(projectTokenUsage(usage), defaultProjections().tokenUsage);
    }
  });

  it("projects complete normalized and older CH Pi counts identically", () => {
    for (const inputTokens of [100, 1_050]) {
      const projected = projectTokenUsage({
        inputTokens,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 50,
        outputTokens: 40,
        totalTokens: 1_090,
      });
      assert.deepEqual(projected, {
        uncachedInputTokens: 100,
        cacheReadTokens: 900,
        cacheWriteTokens: 50,
        outputTokens: 40,
      });
      assert.equal(
        projected.cacheReadTokens /
          (projected.uncachedInputTokens + projected.cacheReadTokens + projected.cacheWriteTokens),
        900 / 1_050,
      );
    }
  });

  it("clears a stale generic meter but preserves authoritative Host cache rates", () => {
    const log = new SessionLog(
      { version: 4, id: "usage-test", createdAt: 0, isSeeded: false },
      {
        readLines: () => [],
        readJson: (_path, fallback) => fallback,
        writeLines: () => {},
        writeJson: () => {},
        appendLine: () => {},
      },
      () => {},
    );
    applyUsageProjections(log, {
      threadId: hostThreadIdSchema.parse("usage-test"),
      usage: {
        inputTokens: 100,
        cachedInputTokens: 90,
        cacheWriteInputTokens: 0,
        outputTokens: 40,
      },
    });
    const usage = {
      inputTokens: 144_252,
      outputTokens: 32_294,
      cacheHitRatePercent: 99.51685747295453,
      sessionCacheHitRatePercent: 97.56966586569621,
    };
    applyUsageProjections(log, { threadId: hostThreadIdSchema.parse("usage-test"), usage });
    assert.deepEqual(log.projections.tokenUsage, defaultProjections().tokenUsage);
    assert.deepEqual(log.projections.codexhostUsage, { usage });
  });
});
