import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { NativeClientChannel } from "../src/native-client-channel.js";
import { encodeOfficialCodexModelRef } from "../src/official-codex-model-ref.js";
import { updateNativeThreadSettings } from "../src/codex-runtime/native-thread-controls.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});

it("advertises Fast only from the official priority service tier", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  let buffer = "";
  fixture.official.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const result =
        request.method === "model/list"
          ? {
              data: [
                {
                  model: "priority-capable",
                  serviceTiers: [
                    { id: "priority", name: "Fast", description: "Priority processing" },
                  ],
                },
                { model: "flex-only", serviceTiers: [{ id: "flex", name: "Fast" }] },
                { model: "legacy-fast", additionalSpeedTiers: ["fast", "priority"] },
                { model: "no-tiers" },
              ].map((model, i) => ({ ...model, displayName: model.model, isDefault: i === 0 })),
            }
          : { data: [] };
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  const reply = await fixture.host.handleClientRequest("codexhost/harness/inspect", {
    harnessId: "codex",
  });
  expect(reply).toMatchObject({
    result: {
      status: "ready",
      catalog: {
        models: [
          {
            ref: encodeOfficialCodexModelRef("priority-capable"),
            fastModel: encodeOfficialCodexModelRef("priority-capable", "priority"),
          },
          { ref: encodeOfficialCodexModelRef("flex-only") },
          { ref: encodeOfficialCodexModelRef("legacy-fast") },
          { ref: encodeOfficialCodexModelRef("no-tiers") },
        ],
      },
    },
  });
  if (!("result" in reply)) throw new Error("Missing inspection");
  const models = (reply.result as { catalog: { models: JsonObject[] } }).catalog.models;
  expect(models.slice(1).every((model) => model.fastModel === undefined)).toBe(true);
});

it("selects priority and clears it only after matching confirmation, preserving Thinking", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  let settings: JsonObject = { model: "native", serviceTier: null, effort: "high" };
  const updates: JsonObject[] = [];
  let buffer = "";
  fixture.official.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const params = request.params as JsonObject;
      if (request.method === "thread/settings/update") updates.push(params);
      const result = request.method === "thread/resume" ? settings : {};
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  const notify = (value: JsonObject) =>
    fixture.official.stdout.write(
      `${JSON.stringify({
        method: "thread/settings/updated",
        params: { threadId: "official", threadSettings: value },
      })}\n`,
    );
  for (const tier of ["priority", null, "priority"]) {
    let resolved = false;
    const selecting = fixture.host
      .handleClientRequest("codexhost/thread/model/select", {
        threadId: "official",
        model: encodeOfficialCodexModelRef("native", tier),
      })
      .then((reply) => {
        resolved = true;
        return reply;
      });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates.shift()).toEqual({ threadId: "official", model: "native", serviceTier: tier });
    // A previous Turn's settings notification must not confirm this selection.
    notify(settings);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe(false);
    settings = { ...settings, serviceTier: tier };
    notify(settings);
    expect(await selecting).toMatchObject({
      result: {
        effectiveModel: encodeOfficialCodexModelRef("native", tier),
        effectiveThinkingOptionId: "high",
      },
    });
  }
  const thinking = fixture.host.handleClientRequest("codexhost/thread/thinking/select", {
    threadId: "official",
    thinkingOptionId: "low",
  });
  await vi.waitFor(() => expect(updates).toHaveLength(1));
  expect(updates.shift()).toEqual({ threadId: "official", effort: "low" });
  settings = { ...settings, effort: "low" };
  notify(settings);
  expect(await thinking).toMatchObject({
    result: {
      effectiveModel: encodeOfficialCodexModelRef("native", "priority"),
      effectiveThinkingOptionId: "low",
    },
  });
});

it("uses native Model and priority parameters when the shared official catalog is used for delegation", async () => {
  let api: DelegationControlApi | undefined;
  const fixture = createFixture({
    onDelegationApi: (value) => {
      api = value;
      return undefined;
    },
  });
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  await vi.waitFor(() => expect(api).toBeDefined());
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let buffer = "";
  fixture.official.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      calls.push(request);
      const result =
        request.method === "model/list"
          ? {
              data: [
                {
                  model: "native",
                  serviceTiers: [{ id: "priority" }],
                  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
                },
              ],
            }
          : request.method === "thread/start"
            ? {
                thread: { id: "native-child" },
                model: "native",
                serviceTier: "priority",
              }
            : request.method === "turn/start"
              ? { turn: { id: "turn-child" } }
              : request.method === "thread/read"
                ? { thread: { id: "parent", cwd: "/synthetic" } }
                : {};
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  const fast = encodeOfficialCodexModelRef("native", "priority");
  if (!api) throw new Error("Delegation API was not registered");
  const result = await api.start({
    harnessId: "codex",
    parentThreadId: "parent",
    task: "test",
    cwd: "/synthetic",
    model: fast,
    thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
  });
  for (const method of ["thread/start", "turn/start"])
    expect(calls.find((call) => call.method === method)).toMatchObject({
      params: { model: "native", serviceTier: "priority" },
    });
  expect(calls.find((call) => call.method === "turn/start")).toMatchObject({
    params: { effort: "high" },
  });
  expect(result).toMatchObject({
    configuration: { requested: { model: fast }, effective: { effectiveModel: fast } },
  });
});

it("projects confirmed Fast on creation, resume and Desktop settings changes without a Turn override", async () => {
  const request = vi.fn(async (method: string) => ({
    result:
      method === "thread/start" || method === "thread/resume"
        ? { thread: { id: "official" }, model: "native", serviceTier: "priority", effort: "high" }
        : {},
  }));
  const channel = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request,
    respond: async () => {},
  });
  const fast = encodeOfficialCodexModelRef("native", "priority");
  await channel.request("thread/start", {});
  expect(await channel.request("codexhost/thread/inspect", { threadId: "official" })).toMatchObject(
    { result: { effectiveModel: fast } },
  );
  expect(request).toHaveBeenCalledTimes(1);
  await channel.request("thread/resume", { threadId: "official" });
  expect(await channel.request("codexhost/thread/inspect", { threadId: "official" })).toMatchObject(
    { result: { effectiveModel: fast } },
  );
  channel.observeMessage({
    method: "thread/settings/updated",
    params: {
      threadId: "official",
      threadSettings: { model: "native", serviceTier: null, effort: "low" },
    },
  });
  expect(await channel.request("codexhost/thread/inspect", { threadId: "official" })).toMatchObject(
    {
      result: {
        effectiveModel: encodeOfficialCodexModelRef("native"),
        effectiveThinkingOptionId: "low",
      },
    },
  );
  await channel.request("turn/start", { threadId: "official", input: [] });
  expect(request).toHaveBeenLastCalledWith("turn/start", { threadId: "official", input: [] });
});

it.each(["missing-tier", "rejected", "timeout"])(
  "does not report Fast confirmed on %s",
  async (failure) => {
    vi.useFakeTimers();
    const notifications = new Set<(value: JsonValue) => void>();
    const request = vi.fn(async () =>
      failure === "rejected" ? { error: { message: "Tier not available" } } : {},
    );
    const selecting = updateNativeThreadSettings(request, notifications, "official", {
      model: "native",
      serviceTier: "priority",
    });
    const rejected = expect(selecting).rejects.toThrow(
      failure === "rejected"
        ? "Tier not available"
        : failure === "timeout"
          ? "timed out"
          : "invalid service tier",
    );
    if (failure === "missing-tier")
      for (const notify of notifications)
        notify({
          method: "thread/settings/updated",
          params: { threadId: "official", threadSettings: { model: "native" } },
        });
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(notifications.size).toBe(0);
  },
);
