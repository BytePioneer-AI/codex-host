import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as globalSdk from "@qoder-ai/qoder-agent-sdk";
import * as cnSdk from "@qodercn-ai/qodercn-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QoderAdapter } from "../src/qoder-adapter.js";
import {
  createQoderUsageStatistics,
  qoderProjectsDirectory,
  readQoderUsage,
} from "../src/qoder-usage-statistics.js";

let root: string;
const signal = new AbortController().signal;
const time = "2026-09-18T12:00:00.000Z";
const usage = {
  input_tokens: 100,
  output_tokens: 40,
  cache_read_input_tokens: 200,
  cache_creation_input_tokens: 50,
};
function assistant(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    timestamp: time,
    uuid: `row-${id}`,
    message: { id, role: "assistant", model: "test-model", usage },
    ...extra,
  };
}
async function transcript(relative: string, rows: unknown[]) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qoder-statistics-")));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("Qoder usage statistics", () => {
  it("counts a message once across blocks, using final usage and its first native time", async () => {
    const file = await transcript("session.jsonl", [
      assistant("one", { message: { id: "one", model: "test-model" } }),
      assistant("one", { timestamp: "2026-09-19T00:00:00Z" }),
      assistant("one", { timestamp: "2026-09-19T00:00:01Z" }),
      // A trailing content block without usage must not erase the final usage.
      assistant("one", { message: { id: "one", model: "test-model" } }),
      { type: "result", usage },
    ]);
    expect(await readQoderUsage(file, signal)).toEqual([
      {
        id: "one",
        model: "test-model",
        occurredAtMs: Date.parse(time),
        inputTokens: 350,
        outputTokens: 40,
        cachedInputTokens: 200,
        cacheWriteInputTokens: 50,
      },
    ]);
  });

  it("attributes messages to the transcript's session and working directory", async () => {
    const file = await transcript("projects/work/s1.jsonl", [
      assistant("a", { sessionId: "s1", cwd: "/work/qoder" }),
    ]);
    expect(await readQoderUsage(file, signal)).toEqual([
      expect.objectContaining({ id: "a", sessionId: "s1", cwd: "/work/qoder" }),
    ]);
  });

  it("keeps real discarded branches, but excludes copied forks, errors and synthetic messages", async () => {
    const file = await transcript("session.jsonl", [
      assistant("discarded"),
      { type: "active-leaf", leafUuid: null },
      assistant("copy", { forkedFrom: { sessionId: "parent", messageUuid: "source" } }),
      assistant("error", { isApiErrorMessage: true }),
      assistant("synthetic", { message: { id: "synthetic", model: "<synthetic>", usage } }),
    ]);
    expect((await readQoderUsage(file, signal)).map((entry) => entry.id)).toEqual(["discarded"]);
  });

  it("preserves the native model ID and optional cache/thinking breakdown without double counting", async () => {
    const file = await transcript("session.jsonl", [
      assistant("one", {
        message: {
          id: "one",
          model: "vendor/custom",
          usage: {
            ...usage,
            cache_creation: { ephemeral_1h_input_tokens: 20 },
            output_tokens_details: { thinking_tokens: 10 },
          },
        },
      }),
      assistant("no-model", { message: { id: "no-model", usage } }),
    ]);
    const entries = await readQoderUsage(file, signal);
    expect(entries[0]).toMatchObject({
      model: "vendor/custom",
      inputTokens: 350,
      outputTokens: 40,
      cacheWrite1hInputTokens: 20,
      reasoningOutputTokens: 10,
    });
    expect(entries[1]).not.toHaveProperty("model");
  });

  it("rejects missing, negative, overflowing and inconsistent token buckets", async () => {
    const invalid = [
      { ...usage, input_tokens: -1 },
      { ...usage, output_tokens: 1.5 },
      { ...usage, cache_read_input_tokens: undefined },
      { ...usage, cache_creation_input_tokens: undefined },
      { ...usage, input_tokens: Number.MAX_SAFE_INTEGER },
      { ...usage, cache_creation: { ephemeral_1h_input_tokens: 51 } },
      { ...usage, output_tokens_details: { thinking_tokens: 41 } },
    ];
    const file = await transcript(
      "session.jsonl",
      invalid.map((value, i) =>
        assistant(String(i), {
          message: { id: String(i), model: "test-model", usage: value },
        }),
      ),
    );
    expect(await readQoderUsage(file, signal)).toEqual([]);
  });

  it("requires native identity and time, tolerates a partial JSON line and supports cancellation", async () => {
    const file = await transcript("session.jsonl", [
      assistant("bad-time", { timestamp: "invalid" }),
      assistant("no-id", { message: { model: "test-model", usage } }),
      assistant("valid"),
    ]);
    await writeFile(file, (await readFile(file, "utf8")) + '{"type":"assistant"');
    expect((await readQoderUsage(file, signal)).map((entry) => entry.id)).toEqual(["valid"]);
    await expect(readQoderUsage(file, AbortSignal.abort())).rejects.toThrow();
  });
});

for (const [variant, configKey, cliHomeKey, directory, sdk] of [
  ["global", "QODER_CONFIG_DIR", "QODER_CLI_HOME", ".qoder", globalSdk],
  ["cn", "QODERCN_CONFIG_DIR", "QODERCN_CLI_HOME", ".qoder-cn", cnSdk],
] as const)
  describe(`${variant} distribution`, () => {
    it("uses its own native paths, not the other distribution's configuration", () => {
      expect(qoderProjectsDirectory({ HOME: root }, variant)).toBe(
        path.join(root, directory, "projects"),
      );
      expect(qoderProjectsDirectory({ [cliHomeKey]: root }, variant)).toBe(
        path.join(root, directory, "projects"),
      );
      expect(qoderProjectsDirectory({ [configKey]: root, [cliHomeKey]: "/unused" }, variant)).toBe(
        path.join(root, "projects"),
      );
      const otherKey = variant === "cn" ? "QODER_CONFIG_DIR" : "QODERCN_CONFIG_DIR";
      expect(qoderProjectsDirectory({ HOME: root, [otherKey]: "/wrong" }, variant)).toBe(
        path.join(root, directory, "projects"),
      );
    });

    it("exposes the optional capability without launching or inspecting the Harness", async () => {
      const queryFactory = vi.fn(() => {
        throw new Error("must not start Qoder");
      });
      const resolveExecutable = vi.fn(() => {
        throw new Error("must not discover Qoder");
      });
      const adapter = new QoderAdapter({
        variant,
        environment: { [configKey]: root },
        queryFactory,
        resolveExecutable,
      });
      const main = await transcript("projects/project/main.jsonl", [assistant("main")]);
      const child = await transcript("projects/project/main/subagents/agent-child.jsonl", [
        assistant("child"),
      ]);
      const before = await readFile(main);
      const sources = await adapter.usageStatistics.listSources(signal);
      expect(sources.map(({ id }) => id).sort()).toEqual([main, child].sort());
      const entries = (
        await Promise.all(sources.map(({ id }) => adapter.usageStatistics.readSource(id, signal)))
      ).flat();
      expect(entries.map(({ id }) => id).sort()).toEqual(["child", "main"]);
      expect(await readFile(main)).toEqual(before);
      expect(queryFactory).not.toHaveBeenCalled();
      expect(resolveExecutable).not.toHaveBeenCalled();
      await adapter.close();
    });

    it("returns no sources for missing storage and fingerprints changed files", async () => {
      const capability = createQoderUsageStatistics({ [configKey]: root }, variant);
      expect(await capability.listSources(signal)).toEqual([]);
      const file = await transcript("projects/project/main.jsonl", [assistant("main")]);
      const first = await capability.listSources(signal);
      await transcript("projects/project/main.jsonl", [assistant("main"), assistant("next")]);
      const next = await capability.listSources(signal);
      expect(next[0]?.id).toBe(file);
      expect(next[0]?.fingerprint).not.toBe(first[0]?.fingerprint);
      if (process.platform !== "win32") {
        await symlink(file, path.join(root, "projects/project/link.jsonl"));
        expect(await capability.listSources(signal)).toHaveLength(1);
      }
      await expect(capability.listSources(AbortSignal.abort())).rejects.toThrow();
    });

    it("recognizes copies produced by the actual native SDK fork (isolated storage, no CLI)", async () => {
      vi.stubEnv(configKey, root);
      const sessionId = "00000000-0000-4000-8000-000000000001";
      const cwd = root;
      const project = cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const file = await transcript(`projects/${project}/${sessionId}.jsonl`, [
        {
          type: "user",
          uuid: "user",
          parentUuid: null,
          sessionId,
          cwd,
          timestamp: time,
          message: { role: "user", content: "test" },
        },
        assistant("answer", { parentUuid: "user", sessionId, cwd }),
      ]);
      const fork = await sdk.forkSession(sessionId, { dir: cwd });
      const forkFile = path.join(path.dirname(file), `${fork.sessionId}.jsonl`);
      expect(await readQoderUsage(file, signal)).toHaveLength(1);
      expect(await readQoderUsage(forkFile, signal)).toEqual([]);
      const copied = (await readFile(forkFile, "utf8"))
        .trim()
        .split("\n")
        .map((line: string): unknown => JSON.parse(line));
      expect(copied).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "assistant",
            message: expect.objectContaining({ id: "answer" }),
            forkedFrom: { sessionId, messageUuid: "row-answer" },
            timestamp: expect.not.stringMatching(/^2026-09-18T12:00:00/),
          }),
        ]),
      );
    });
  });
