import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { ClientEventLog, type NewClientEvent } from "../src/external-client-events.js";
import {
  WebhookDispatcher,
  WebhookStore,
  grokBotWebhookAdapter,
} from "../src/external-client-webhooks.js";
import { ExternalClientRegistry, defaultExternalClientsPath } from "../src/external-clients.js";

const URL_ = "https://api2.cursor.sh/automations/webhook/00000000-0000-4000-8000-000000000001";
const KEY = "crsr_secret_key";

function event(threadId: string, refs?: string[]): NewClientEvent {
  return {
    type: "watch",
    threadId,
    outcome: "completed",
    deepLink: `codex://threads/${threadId}`,
    ...(refs ? { refs } : {}),
  };
}

describe("Grok Bot webhook adapter", () => {
  it("sends a small JSON body with the Bearer key and an idempotency key", () => {
    const request = grokBotWebhookAdapter.request(
      "grok-bot",
      { id: 42, time: "t", ...event("t1") },
      { adapter: "grok-bot", url: URL_, key: KEY },
    );
    expect(request.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "idempotency-key": "grok-bot:42",
    });
    expect(JSON.parse(request.body)).toMatchObject({
      id: 42,
      threadId: "t1",
      outcome: "completed",
    });

    const many = Array.from(
      { length: 16 },
      (_, index) => `https://e.com/${"x".repeat(400)}/${index}`,
    );
    const large = grokBotWebhookAdapter.request(
      "grok-bot",
      { id: 1, time: "t", ...event("t1", many) },
      { adapter: "grok-bot", url: URL_, key: KEY },
    );
    expect(Buffer.byteLength(large.body)).toBeLessThanOrEqual(4_096);
    expect(JSON.parse(large.body)).toMatchObject({ refsOmitted: true });

    const noisy = grokBotWebhookAdapter.request(
      "grok-bot",
      {
        id: 7,
        time: "t",
        ...event("t1", many),
        note: "n".repeat(5_000),
        extra: "not part of the payload",
      } as unknown as Parameters<typeof grokBotWebhookAdapter.request>[1],
      { adapter: "grok-bot", url: URL_, key: KEY },
    );
    expect(Buffer.byteLength(noisy.body)).toBeLessThanOrEqual(4_096);
    const parsed = JSON.parse(noisy.body) as Record<string, unknown>;
    expect(parsed).toMatchObject({ id: 7, refsOmitted: true, noteOmitted: true });
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed.deepLink).toBe("codex://threads/t1");
  });

  it("classifies answers and validates its configuration", () => {
    expect(
      [200, 202, 400, 401, 403, 404, 429, 500, 503].map((status) =>
        grokBotWebhookAdapter.classify(status),
      ),
    ).toEqual([
      "delivered",
      "delivered",
      "drop",
      "drop",
      "drop",
      "drop",
      "retry",
      "retry",
      "retry",
    ]);
    expect(() =>
      grokBotWebhookAdapter.validate({ adapter: "grok-bot", url: "http://x", key: KEY }),
    ).toThrow(/https/u);
    expect(() =>
      grokBotWebhookAdapter.validate({ adapter: "grok-bot", url: URL_, key: " " }),
    ).toThrow(/key/u);
  });
});

describe("webhook dispatcher", () => {
  let directory: string;
  let events: ClientEventLog;
  let store: WebhookStore;
  let now: number;
  let statuses: Array<number | Error>;
  let fetchImpl: ReturnType<typeof vi.fn>;

  function dispatcher(): WebhookDispatcher {
    return new WebhookDispatcher({
      store,
      events,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
  }

  const pushedIds = () =>
    fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)).id as number,
    );

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-webhooks-"));
    now = Date.parse("2026-11-04T00:00:00Z");
    events = new ClientEventLog({
      directory: path.join(directory, "events"),
      retentionDays: 7,
      now: () => now,
    });
    store = new WebhookStore(path.join(directory, "hooks"));
    statuses = [];
    fetchImpl = vi.fn(async () => {
      const next = statuses.shift() ?? 200;
      if (next instanceof Error) throw next;
      return new Response(null, { status: next });
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("starts from zero only when no delivery state exists, and reports a damaged one", async () => {
    await expect(store.state("bot")).resolves.toEqual({ delivered: 0 });
    await store.saveState("bot", { delivered: 3 });
    await expect(store.state("bot")).resolves.toEqual({ delivered: 3 });
    const { writeFile } = await import("node:fs/promises");
    const statePath = path.join(directory, "hooks", "bot.state.json");
    await writeFile(statePath, "{not json");
    await expect(store.state("bot")).rejects.toThrow();
    await writeFile(statePath, JSON.stringify({ delivered: -1 }));
    await expect(store.state("bot")).rejects.toThrow(/invalid/u);
  });

  it("starts after the latest event, then pushes new ones in order", async () => {
    await events.append("bot", [event("old")]);
    await store.set(
      "bot",
      { adapter: "grok-bot", url: URL_, key: KEY },
      await events.lastEventId("bot"),
    );
    const [a, b] = await events.append("bot", [event("a"), event("b")]);
    await dispatcher().tick();
    expect(pushedIds()).toEqual([a?.id, b?.id]);
    await expect(store.state("bot")).resolves.toMatchObject({
      delivered: b?.id,
      lastSuccessAt: expect.any(String),
    });
    await dispatcher().tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off on failures, keeps later events waiting, and resumes after a restart", async () => {
    await store.set("bot", { adapter: "grok-bot", url: URL_, key: KEY }, 0);
    const [a, b] = await events.append("bot", [event("a"), event("b")]);
    statuses.push(503, new Error("connect ECONNREFUSED"));
    await dispatcher().tick();
    expect(pushedIds()).toEqual([a?.id]);
    const first = await store.state("bot");
    expect(first).toMatchObject({ delivered: 0, attempts: 1, nextAttemptAt: now + 5_000 });

    await dispatcher().tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 5_000;
    await dispatcher().tick();
    await expect(store.state("bot")).resolves.toMatchObject({
      attempts: 2,
      nextAttemptAt: now + 10_000,
    });

    // A new Runtime picks up where the last one stopped.
    now += 10_000;
    await dispatcher().tick();
    expect(pushedIds()).toEqual([a?.id, a?.id, a?.id, b?.id]);
    await expect(store.state("bot")).resolves.toMatchObject({ delivered: b?.id });
  });

  it("stops at once on a configuration error and gives up after 24 hours", async () => {
    await store.set("bot", { adapter: "grok-bot", url: URL_, key: KEY }, 0);
    const [a, b] = await events.append("bot", [event("a"), event("b")]);
    statuses.push(401);
    await dispatcher().tick();
    expect(pushedIds()).toEqual([a?.id, b?.id]);
    await expect(store.state("bot")).resolves.toMatchObject({
      delivered: b?.id,
      lastFailure: { eventId: a?.id, reason: "HTTP 401", final: true },
    });

    const [c] = await events.append("bot", [event("c")]);
    statuses.push(500);
    await dispatcher().tick();
    now += 24 * 60 * 60_000;
    statuses.push(500);
    await dispatcher().tick();
    await expect(store.state("bot")).resolves.toMatchObject({
      delivered: c?.id,
      lastFailure: { eventId: c?.id, final: true },
    });
  });

  it("configures webhooks from the CLI without exposing the key", async () => {
    const environment = { CODEXHOST_DATA_DIR: directory, CODEXHOST_WEBHOOK_KEY: KEY };
    await new ExternalClientRegistry(defaultExternalClientsPath(environment)).add("bot");
    const run = async (arguments_: string[]) => {
      const output = new PassThrough();
      const diagnosticOutput = new PassThrough();
      const code = await runDelegationCli({
        arguments: arguments_,
        environment,
        output,
        diagnosticOutput,
      });
      return { code, text: String((code === 0 ? output : diagnosticOutput).read()) };
    };
    const set = await run(["client", "webhook", "bot", "--adapter", "grok-bot", "--url", URL_]);
    expect(set.code).toBe(0);
    expect(set.text).not.toContain(KEY);
    expect(JSON.parse(set.text)).toMatchObject({
      webhook: { adapter: "grok-bot", url: URL_, keyConfigured: true },
      state: { delivered: 0 },
    });
    const stored = await readFile(path.join(directory, "client-webhooks", "bot.json"), "utf8");
    expect(stored).toContain(KEY);

    expect(
      (await run(["client", "webhook", "bot", "--adapter", "slack", "--url", URL_])).text,
    ).toContain("Unknown webhook adapter");
    expect(
      (await run(["client", "webhook", "ghost", "--adapter", "grok-bot", "--url", URL_])).code,
    ).toBe(1);
    expect(JSON.parse((await run(["client", "webhook", "bot", "--clear", "true"])).text)).toEqual({
      name: "bot",
      webhook: null,
    });
  });
});
