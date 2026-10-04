import { expect, it, vi } from "vitest";
import { CODEX_SERVICE_TIER_SETTINGS_METHOD } from "@codexhost/shared-contracts";
import { CodexServiceTierControl } from "../src/account/codex-service-tier-control.js";
import {
  createFixture,
  stopFixture,
  writeRequest,
  readJsonLine,
  requestId,
  requiredMessageId,
  startPiThread,
  startPiTurn,
} from "./app-server-host-fixture.js";
import type { JsonObject } from "@codexhost/protocol-core";

function nativeRequest() {
  return vi.fn(async (method: string): Promise<JsonObject> => {
    if (method === "config/read")
      return { result: { config: { model_provider: "custom", model: "model-a" } } };
    if (method === "thread/read")
      return { result: { thread: { modelProvider: "custom", model: "model-a" } } };
    if (method === "model/list")
      return {
        result: {
          data: [{ model: "model-a", serviceTiers: [{ id: "priority" }, { id: "ultrafast" }] }],
          nextCursor: null,
        },
      };
    throw new Error(`Unexpected method: ${method}`);
  });
}

function calls(request: ReturnType<typeof nativeRequest>, method: string): number {
  return request.mock.calls.filter(([called]) => called === method).length;
}

it("switches the same thread between Fast, Ultrafast and default without retaining a stale tier", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  const params: JsonObject = {
    threadId: "thread",
    input: [{ type: "text", text: "rewritten delegation input" }],
    serviceTier: "fast",
    serviceTierForTurn: "ultrafast",
  };
  const snapshot = structuredClone(params);
  for (const [settings, expected] of [
    [{ enabled: true, tier: "fast" }, "priority"],
    [{ enabled: true, tier: "ultrafast" }, "ultrafast"],
    [{ enabled: false, tier: "ultrafast" }, "default"],
    [{ enabled: true, tier: "fast" }, "priority"],
  ] as const) {
    await control.apply(settings, request);
    expect(await control.tierForTurn(params, request)).toBe(expected);
  }
  expect(params).toEqual(snapshot);
  // One thread read and one catalog read serve every later turn of the process.
  expect(calls(request, "thread/read")).toBe(1);
  expect(calls(request, "model/list")).toBe(1);
  expect(
    request.mock.calls.every(
      ([method]) => !method.startsWith("config/") || method === "config/read",
    ),
  ).toBe(true);
});

it("reports the effect of each setting instead of rejecting inactive tiers", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  await expect(control.apply({ enabled: true, tier: "ultrafast" }, request)).resolves.toEqual({
    settings: { enabled: true, tier: "ultrafast" },
    effect: { state: "active" },
  });
  await expect(control.apply({ enabled: false, tier: "fast" }, request)).resolves.toEqual({
    settings: { enabled: false, tier: "fast" },
    effect: { state: "off" },
  });
  request.mockResolvedValueOnce({ result: { config: { model_provider: "openai" } } });
  await expect(control.apply({ enabled: true, tier: "fast" }, request)).resolves.toMatchObject({
    effect: { state: "inactive", reason: "officialProvider" },
  });
  request.mockResolvedValueOnce({
    result: { config: { model_provider: "custom", model: "model-b" } },
  });
  await expect(control.apply({ enabled: true, tier: "fast" }, request)).resolves.toEqual({
    settings: { enabled: true, tier: "fast" },
    effect: { state: "active", notice: "notAdvertised" },
  });
  // An unreadable catalog cannot confirm a notice; the tier is still forced.
  const unreadable = new CodexServiceTierControl();
  const failing = nativeRequest();
  failing.mockImplementation(async (method: string): Promise<JsonObject> => {
    if (method === "config/read") return { result: { config: { model_provider: "custom" } } };
    throw new Error("model/list unavailable");
  });
  await expect(unreadable.apply({ enabled: true, tier: "fast" }, failing)).resolves.toMatchObject({
    effect: { state: "active" },
  });
});

it("forwards turns unchanged and without native reads when nothing would change", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  expect(await control.tierForTurn({ threadId: "t", serviceTier: "fast" }, request)).toBeNull();
  await control.apply({ enabled: false, tier: "fast" }, request);
  expect(await control.tierForTurn({ threadId: "t", input: [] }, request)).toBeNull();
  expect(await control.tierForTurn({ input: [] }, request)).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("does not modify official OpenAI threads or turns whose thread cannot be read", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  await control.apply({ enabled: true, tier: "ultrafast" }, request);
  request.mockResolvedValueOnce({ result: { thread: { modelProvider: "openai" } } });
  expect(await control.tierForTurn({ threadId: "official" }, request)).toBeNull();
  request.mockRejectedValueOnce(new Error("native unavailable"));
  expect(await control.tierForTurn({ threadId: "unreadable" }, request)).toBeNull();
  // A failed read is not cached as a decision.
  expect(await control.tierForTurn({ threadId: "unreadable" }, request)).toBe("ultrafast");
});

it("uses observed thread metadata so a send needs no native round trip", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  await control.apply({ enabled: true, tier: "fast" }, request);
  request.mockClear();
  control.observe({
    method: "thread/started",
    params: { thread: { id: "started", modelProvider: "custom", model: "model-a" } },
  });
  control.observe({
    id: 7,
    result: {
      model: "model-a",
      modelProvider: "custom",
      thread: { id: "resumed", modelProvider: "custom", model: null },
    },
  });
  control.observe({
    method: "thread/started",
    params: { thread: { id: "native", modelProvider: "openai", model: "gpt" } },
  });
  expect(await control.tierForTurn({ threadId: "started" }, request)).toBe("priority");
  expect(await control.tierForTurn({ threadId: "resumed" }, request)).toBe("priority");
  expect(await control.tierForTurn({ threadId: "native" }, request)).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("forces the tier for custom-provider models the catalog does not advertise", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  await control.apply({ enabled: true, tier: "ultrafast" }, request);
  expect(await control.tierForTurn({ threadId: "t", model: "unsupported" }, request)).toBe(
    "ultrafast",
  );
  control.observe({
    method: "thread/settings/updated",
    params: { threadId: "t", threadSettings: { model: "model-b" } },
  });
  expect(await control.tierForTurn({ threadId: "t" }, request)).toBe("ultrafast");
  // Turns never consult the catalog; it only shapes the settings notice.
  expect(calls(request, "thread/read")).toBe(1);
  expect(calls(request, "model/list")).toBe(1);
});

it("rebuilds caches for a replacement native process", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  await control.apply({ enabled: true, tier: "fast" }, request);
  await control.tierForTurn({ threadId: "t" }, request);
  control.reset();
  await control.tierForTurn({ threadId: "t" }, request);
  expect(calls(request, "thread/read")).toBe(2);
  await control.apply({ enabled: true, tier: "fast" }, request);
  expect(calls(request, "model/list")).toBe(2);
});

it("preserves the confirmed setting when a later change fails", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  await control.apply({ enabled: true, tier: "fast" }, request);
  request.mockResolvedValueOnce({ error: { code: -32000 } });
  await expect(control.apply({ enabled: true, tier: "ultrafast" }, request)).rejects.toThrow();
  expect(await control.tierForTurn({ threadId: "thread" }, request)).toBe("priority");
});

it("waits for pending settings and serializes changes across clients", async () => {
  const control = new CodexServiceTierControl();
  const request = nativeRequest();
  const deferred = Promise.withResolvers<JsonObject>();
  request.mockReturnValueOnce(deferred.promise);
  const enable = control.apply({ enabled: true, tier: "ultrafast" }, request);
  const disable = control.apply({ enabled: false, tier: "ultrafast" }, request);
  const turn = control.tierForTurn({ threadId: "t", serviceTier: "fast" }, request);
  deferred.resolve({ result: { config: { model_provider: "custom", model: "model-a" } } });
  await Promise.all([enable, disable]);
  expect(await turn).toBe("default");
});

it("routes settings and final official turn frames through the Host without config writes", async () => {
  const fixture = createFixture();
  try {
    await fixture.ready;
    writeRequest(fixture.desktopInput, {
      id: 801,
      method: CODEX_SERVICE_TIER_SETTINGS_METHOD,
      params: { enabled: true, tier: "ultrafast" },
    });
    for (const [method, result] of [
      ["config/read", { config: { model_provider: "custom", model: "model-a" } }],
      ["model/list", { data: [{ model: "model-a", serviceTiers: [{ id: "ultrafast" }] }] }],
    ] satisfies [string, JsonObject][]) {
      const outgoing = await readJsonLine(fixture.official.stdin);
      expect(outgoing.method).toBe(method);
      writeRequest(fixture.official.stdout, { id: requiredMessageId(outgoing), result });
    }
    expect(await fixture.collector.waitFor((message) => requestId(message, 801))).toMatchObject({
      result: { settings: { enabled: true, tier: "ultrafast" }, effect: { state: "active" } },
    });
    const params: JsonObject = {
      threadId: "native",
      input: [{ type: "text", text: "hello" }],
      serviceTier: "fast",
    };
    writeRequest(fixture.desktopInput, { id: 802, method: "turn/start", params });
    const read = await readJsonLine(fixture.official.stdin);
    expect(read.method).toBe("thread/read");
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(read),
      result: { thread: { modelProvider: "custom", model: "model-a" } },
    });
    // The catalog read during settings is reused; the frame gains only `serviceTierForTurn`.
    const turn = await readJsonLine(fixture.official.stdin);
    expect(turn.method).toBe("turn/start");
    expect(turn.params).toEqual({ ...params, serviceTierForTurn: "ultrafast" });
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(turn),
      result: { turn: { id: "turn" } },
    });
    await fixture.collector.waitFor((message) => requestId(message, 802));
    // A warm cache sends the next turn with no native round trip.
    writeRequest(fixture.desktopInput, { id: 805, method: "turn/start", params });
    const next = await readJsonLine(fixture.official.stdin);
    expect(next).toMatchObject({
      method: "turn/start",
      params: { serviceTierForTurn: "ultrafast" },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it("rejects invalid settings and maps native read failures to a settings error", async () => {
  const fixture = createFixture();
  try {
    await fixture.ready;
    writeRequest(fixture.desktopInput, {
      id: 803,
      method: CODEX_SERVICE_TIER_SETTINGS_METHOD,
      params: { enabled: true, tier: "turbo" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 803))).toMatchObject({
      error: { code: -32602 },
    });
    expect(fixture.official.stdin.readableLength).toBe(0);
    writeRequest(fixture.desktopInput, {
      id: 804,
      method: CODEX_SERVICE_TIER_SETTINGS_METHOD,
      params: { enabled: true, tier: "fast" },
    });
    const outgoing = await readJsonLine(fixture.official.stdin);
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(outgoing),
      error: { code: -32000, message: "native unavailable" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 804))).toMatchObject({
      error: { code: -32000 },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it.each<JsonObject>([
  { method: "turn/start" },
  { method: "turn/start", params: "future-params-shape" },
  { method: "turn/start", params: ["future-params-shape"] },
  { method: "turn/start", params: { threadId: { id: "native" }, future: true } },
  { method: "turn/steer", params: { threadId: "native", future: ["unchanged"] } },
])("preserves unrecognized official parameters with the tier enabled: $method", async (request) => {
  const fixture = createFixture();
  try {
    await fixture.ready;
    writeRequest(fixture.desktopInput, {
      id: 820,
      method: CODEX_SERVICE_TIER_SETTINGS_METHOD,
      params: { enabled: true, tier: "fast" },
    });
    for (const [method, result] of [
      ["config/read", { config: { model_provider: "custom", model: "model-a" } }],
      ["model/list", { data: [{ model: "model-a", serviceTiers: [{ id: "priority" }] }] }],
    ] satisfies [string, JsonObject][]) {
      const outgoing = await readJsonLine(fixture.official.stdin);
      expect(outgoing.method).toBe(method);
      writeRequest(fixture.official.stdout, { id: requiredMessageId(outgoing), result });
    }
    await fixture.collector.waitFor((message) => requestId(message, 820));
    const input = { id: 821, ...request };
    writeRequest(fixture.desktopInput, input);
    const outgoing = await readJsonLine(fixture.official.stdin);
    expect({ ...outgoing, id: input.id }).toEqual(input);
    writeRequest(fixture.official.stdout, {
      id: requiredMessageId(outgoing),
      error: { code: -32602, message: "Native validation result" },
    });
    expect(await fixture.collector.waitFor((message) => requestId(message, 821))).toEqual({
      id: 821,
      error: { code: -32602, message: "Native validation result" },
    });
  } finally {
    await stopFixture(fixture);
  }
});

it("never injects the enabled Codex tier into an external Harness turn", async () => {
  const fixture = createFixture();
  try {
    await fixture.ready;
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 810,
      method: CODEX_SERVICE_TIER_SETTINGS_METHOD,
      params: { enabled: true, tier: "fast" },
    });
    for (const [method, result] of [
      ["config/read", { config: { model_provider: "custom", model: "model-a" } }],
      ["model/list", { data: [{ model: "model-a", serviceTiers: [{ id: "priority" }] }] }],
    ] satisfies [string, JsonObject][]) {
      const outgoing = await readJsonLine(fixture.official.stdin);
      expect(outgoing.method).toBe(method);
      writeRequest(fixture.official.stdout, { id: requiredMessageId(outgoing), result });
    }
    await fixture.collector.waitFor((message) => requestId(message, 810));
    await startPiTurn(fixture, threadId);
    expect(fixture.official.stdin.readableLength).toBe(0);
  } finally {
    await stopFixture(fixture);
  }
});
