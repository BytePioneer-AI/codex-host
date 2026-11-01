import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DelegationControlApi } from "../src/delegation-types.js";
import {
  answerOfficialParentCwd,
  createFixture,
  closeFixture,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";
import type { JsonObject } from "@codexhost/shared-contracts";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";

const enabled = process.env.CODEXHOST_COPILOT_NATIVE_TEST === "1";

describe.runIf(enabled)("Copilot native reception through the public Host Coordinator", () => {
  it("publishes native speed and cache metrics through the public usage protocol", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "copilot-usage-host-"));
    const plugins = path.join(directory, "plugins");
    const cwd = path.join(directory, "workspace");
    await mkdir(cwd, { recursive: true });
    await cp(
      path.resolve("packages/host-runtime/dist/plugins/copilot"),
      path.join(plugins, "copilot"),
      { recursive: true },
    );
    await writeFile(
      path.join(plugins, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["copilot"] }),
    );
    let control: DelegationControlApi | undefined;
    const fixture = createFixture({
      pluginDirectory: plugins,
      environment: { ...process.env },
      onDelegationApi: (api) => {
        control = api;
        return undefined;
      },
    });
    try {
      await fixture.ready;
      if (!control) throw new Error("Missing public delegation API");
      const accepting = control.start({
        harnessId: "copilot",
        cwd,
        parentThreadId: "parent-thread",
        task: "用中文写三小段解释二分查找及其复杂度，只输出解释，不调用工具。",
      });
      await answerOfficialParentCwd(fixture);
      const started = await accepting;
      expect(
        (await control.wait({ threadId: started.threadId, view: "result", timeoutMs: 60_000 }))
          .status,
      ).toBe("completed");
      let requestId = 9100;
      await vi.waitFor(
        async () => {
          const id = ++requestId;
          writeRequest(fixture.desktopInput, {
            id,
            method: "codexhost/thread/usage/inspect",
            params: { threadId: started.threadId, refresh: "exact" },
          });
          const response = await fixture.collector.waitFor((message) => message.id === id);
          expect(response).not.toHaveProperty("error");
          const usage = (response.result as JsonObject).usage as JsonObject;
          expect(usage.outputTokensPerSecond).toBeGreaterThan(0);
          expect(usage.apiOutputTokensPerSecond).toBeGreaterThan(0);
          expect(usage.cacheHitRatePercent).toBeGreaterThanOrEqual(0);
          expect(usage.sessionCacheHitRatePercent).toBeGreaterThanOrEqual(0);
          expect(usage.timeToFirstOutputMs).toBeGreaterThanOrEqual(0);
          expect(usage).not.toHaveProperty("sessionCacheUsage");
        },
        { timeout: 30_000, interval: 200 },
      );
    } finally {
      await stopFixture(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
  it("serves native account quota through the public settings protocol", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "copilot-account-host-"));
    const plugins = path.join(directory, "plugins");
    await cp(
      path.resolve("packages/host-runtime/dist/plugins/copilot"),
      path.join(plugins, "copilot"),
      { recursive: true },
    );
    await writeFile(
      path.join(plugins, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["copilot"] }),
    );
    const fixture = createFixture({ pluginDirectory: plugins, environment: { ...process.env } });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 9001,
        method: "codexhost/harness/accounts/sources",
        params: {},
      });
      await vi.waitFor(
        () =>
          expect(fixture.collector.messages.find((m) => m.id === 9001)).toMatchObject({
            result: { sources: [{ harnessId: "copilot", harnessName: "GitHub Copilot" }] },
          }),
        { timeout: 30_000 },
      );
      writeRequest(fixture.desktopInput, {
        id: 9002,
        method: "codexhost/harness/accounts/inspect",
        params: { harnessId: "copilot", refresh: true },
      });
      await vi.waitFor(
        () =>
          expect(fixture.collector.messages.find((m) => m.id === 9002)).toMatchObject({
            result: {
              harnessId: "copilot",
              account: {
                credits: {
                  unit: "AI Credits",
                  usedPercent: expect.any(Number),
                  limit: expect.any(Number),
                },
              },
            },
          }),
        { timeout: 45_000 },
      );
    } finally {
      await stopFixture(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
  it("loads the plugin and receives, observes, cancels, and continues native Turns", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-copilot-host-"));
    const plugins = path.join(directory, "plugins");
    const cwd = path.join(directory, "workspace");
    await mkdir(cwd, { recursive: true });
    await cp(
      path.resolve("packages/host-runtime/dist/plugins/copilot"),
      path.join(plugins, "copilot"),
      { recursive: true },
    );
    await writeFile(
      path.join(plugins, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["copilot"] }),
    );
    let control: DelegationControlApi | undefined;
    let fixture = createFixture({
      pluginDirectory: plugins,
      environment: { ...process.env },
      onDelegationApi: (api) => {
        control = api;
        return undefined;
      },
    });
    try {
      await fixture.ready;
      if (!control) throw new Error("Missing public delegation API");
      expect((await control.inspect({ harnessId: "copilot", cwd })).inspection.status).toBe(
        "ready",
      );
      const accepting = control.start({
        harnessId: "copilot",
        cwd,
        parentThreadId: "parent-thread",
        task: "Reply exactly COORDINATOR_ONE. Do not use tools.",
      });
      await answerOfficialParentCwd(fixture);
      const first = await accepting;
      const read = { threadId: first.threadId, view: "result" as const };
      const completed = await control.wait({ ...read, timeoutMs: 60_000 });
      expect(completed.status).toBe("completed");
      expect(completed.result.text).toContain("COORDINATOR_ONE");
      const sent = await control.send({
        threadId: first.threadId,
        message: "Write a list of 1000 distinct words, one word per line. Do not use tools.",
      });
      await expect(
        control.send({ threadId: first.threadId, message: "Must be rejected while busy." }),
      ).rejects.toThrow();
      expect((await control.cancel({ threadId: first.threadId })).cancelled).toBe(true);
      const cancelled = await control.wait({ ...read, timeoutMs: 45_000 });
      expect(cancelled.status).toBe("interrupted");
      expect(cancelled.turn?.turnId).toBe(sent.turnId);
      await control.send({
        threadId: first.threadId,
        message: "Reply exactly COORDINATOR_CONTINUED. Do not use tools.",
      });
      const continued = await control.wait({ ...read, timeoutMs: 60_000 });
      expect(continued.status).toBe("completed");
      expect(continued.result.text).toContain("COORDINATOR_CONTINUED");
      const messages = await control.read({ ...read, view: "messages", limit: 100 });
      expect(messages.messages?.length).toBeGreaterThan(0);
      const threadId = hostThreadIdSchema.parse(first.threadId);
      const beforeRollback = await fixture.mappingStore.getThread(threadId);
      writeRequest(fixture.desktopInput, {
        id: 8000,
        method: "thread/rollback",
        params: { threadId: first.threadId, numTurns: 1 },
      });
      await vi.waitFor(
        () => expect(fixture.collector.messages.some((message) => message.id === 8000)).toBe(true),
        { timeout: 45_000, interval: 100 },
      );
      const rollback = fixture.collector.messages.find((message) => message.id === 8000);
      expect(rollback).not.toHaveProperty("error");
      expect(rollback).toMatchObject({
        result: { thread: { id: first.threadId, turns: [{}, {}] } },
      });
      const afterRollback = await fixture.mappingStore.getThread(threadId);
      expect(afterRollback?.nativeSessionRef?.nativeSessionId).not.toBe(
        beforeRollback?.nativeSessionRef?.nativeSessionId,
      );
      expect(afterRollback?.turnMappings).toEqual(
        beforeRollback?.turnMappings.slice(0, -1).map((mapping) => ({
          ...mapping,
          nativeTurnRef: {
            ...mapping.nativeTurnRef,
            nativeSessionId: afterRollback?.nativeSessionRef?.nativeSessionId,
          },
          nativeCheckpointRef: {
            ...mapping.nativeCheckpointRef,
            nativeSessionId: afterRollback?.nativeSessionRef?.nativeSessionId,
          },
        })),
      );
      await control.send({
        threadId: first.threadId,
        message:
          "Use ask_user to ask me to choose Alpha or Beta. Wait for my answer, then repeat the choice. Do not answer for me.",
      });
      await vi.waitFor(
        () =>
          expect(
            fixture.collector.messages.some(
              (message) => message.method === "item/tool/requestUserInput",
            ),
          ).toBe(true),
        { timeout: 60_000, interval: 100 },
      );
      const question = fixture.collector.messages.find(
        (message) => message.method === "item/tool/requestUserInput",
      );
      if (!question || typeof question.id !== "number")
        throw new Error("Missing public question request");
      const questions = (question.params as JsonObject).questions;
      if (!Array.isArray(questions)) throw new Error("Missing public question fields");
      const field = questions[0] as JsonObject;
      if (typeof field.id !== "string") throw new Error("Missing public question ID");
      for (const [id, permissionModeId] of [
        [8001, "manual"],
        [8002, "allow-all"],
      ] as const) {
        writeRequest(fixture.desktopInput, {
          id,
          method: "codexhost/thread/permission-mode/select",
          params: { threadId: first.threadId, permissionModeId },
        });
        const selected = await fixture.collector.waitFor((message) => message.id === id);
        expect(selected).not.toHaveProperty("error");
      }
      writeRequest(fixture.desktopInput, {
        id: question.id,
        result: { answers: { [field.id]: { answers: ["Alpha"] } } },
      });
      expect((await control.wait({ ...read, timeoutMs: 60_000 })).status).toBe("completed");
      const mappingStoreDirectory = fixture.mappingStoreDirectory;
      await closeFixture(fixture);
      control = undefined;
      fixture = createFixture({
        pluginDirectory: plugins,
        mappingStoreDirectory,
        environment: { ...process.env },
        onDelegationApi: (api) => {
          control = api;
          return undefined;
        },
      });
      await fixture.ready;
      const restarted = control as DelegationControlApi | undefined;
      if (!restarted) throw new Error("Missing restarted public delegation API");
      await restarted.send({
        threadId: first.threadId,
        message: `Use bash to run test "$CODEXHOST_THREAD_ID" = "${first.threadId}" && printf COORDINATOR_RESTART_ENV_OK. Then reply exactly COORDINATOR_RESTARTED. Do not use other tools.`,
      });
      const restored = await restarted.wait({ ...read, timeoutMs: 60_000 });
      expect(restored.status).toBe("completed");
      expect(restored.result.text).toContain("COORDINATOR_RESTARTED");
    } finally {
      await stopFixture(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
