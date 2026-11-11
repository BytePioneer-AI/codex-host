import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import {
  DelegationControlError,
  type DelegationThreadSnapshot,
  type DelegationThreadStatus,
} from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";
import { ClientEventLog, type NewClientEvent } from "../src/external-client-events.js";
import { externalClientEventStream, externalClientRouter } from "../src/external-client-routes.js";
import {
  externalClientDescriptorPath,
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import { ExternalClientRegistry } from "../src/external-clients.js";

const DAY = 24 * 60 * 60_000;

function need<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

function event(threadId: string): NewClientEvent {
  return { type: "watch", threadId, outcome: "completed", deepLink: `codex://threads/${threadId}` };
}

describe("client event log", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-events-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("appends events with increasing ids and reads them by cursor", async () => {
    const log = new ClientEventLog({ directory, retentionDays: 7 });
    const [first, second] = await log.append("bot", [event("a"), event("b")]);
    expect(need(second).id).toBeGreaterThan(need(first).id);
    expect(await log.read("bot", 0)).toEqual({ events: [first, second], cursor: need(second).id });
    expect(await log.read("bot", need(first).id)).toEqual({
      events: [second],
      cursor: need(second).id,
    });
    expect(await log.read("bot", need(second).id)).toEqual({ events: [], cursor: need(second).id });
    // Each client sees only its own log.
    expect((await log.read("other", 0)).events).toEqual([]);
  });

  it("continues above earlier ids after a restart, even with a slower clock", async () => {
    const before = new ClientEventLog({ directory, retentionDays: 7, now: () => 2_000_000 });
    const [last] = await before.append("bot", [event("a")]);
    const after = new ClientEventLog({ directory, retentionDays: 7, now: () => 1_000_000 });
    const [next] = await after.append("bot", [event("b")]);
    expect(need(next).id).toBeGreaterThan(need(last).id);
  });

  it("records stalled alerts in the client log and keeps observing until the final stop", async () => {
    vi.useFakeTimers();
    let status: DelegationThreadStatus = "running";
    const send = vi.fn();
    // Fake timers cannot wait for real file writes, so polling appends to memory and
    // the real log stores the recorded events once real timers are back.
    const appended: NewClientEvent[] = [];
    const append = vi.fn(async (_client: string, events: readonly NewClientEvent[]) => {
      appended.push(...events);
    });
    const service = new DelegationWatchService(
      {
        read: vi.fn(
          async ({ threadId }: { threadId: string }): Promise<DelegationThreadSnapshot> => ({
            threadId,
            harnessId: "codex",
            status,
            turn: { turnId: "turn-1", status },
            progress: [],
            result: { availability: "pending" },
            nextCursor: null,
          }),
        ),
        send,
      },
      { pollIntervalMs: 1_000, clientEvents: { append } },
    );
    try {
      await service.watch({
        threadId: "child",
        notifyThreadId: "client:bot",
        timeoutMs: 60_000,
        stallAfterMs: 3_000,
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(appended).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(appended).toEqual([
        {
          type: "watch",
          threadId: "child",
          outcome: "stalled",
          turnId: "turn-1",
          harnessId: "codex",
          deepLink: "codex://threads/child",
          note: expect.stringContaining(
            "still running, but no Harness event had been observed for at least 3 s",
          ),
        },
      ]);
      expect(appended[0]?.note).toContain("The watch continues");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(appended).toHaveLength(1);
      service.noteActivity(["child"]);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(appended).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(appended).toHaveLength(2);
      expect((await service.watches()).watches).toEqual([
        expect.objectContaining({ state: "watching", stallAfterMs: 3_000 }),
      ]);
      status = "completed";
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appended.map((event) => event.outcome)).toEqual(["stalled", "stalled", "completed"]);
      expect((await service.watches()).watches).toEqual([]);
      expect(append.mock.calls.map(([client]) => client)).toEqual(["bot", "bot", "bot"]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      service.close();
      vi.useRealTimers();
    }
    // The stalled outcome and its explanation survive the real log and reopening it.
    await new ClientEventLog({ directory, retentionDays: 7 }).append("bot", appended);
    const reopened = new ClientEventLog({ directory, retentionDays: 7 });
    expect((await reopened.read("bot", 0)).events).toEqual(
      appended.map((event) => ({ ...event, id: expect.any(Number), time: expect.any(String) })),
    );
  });

  it("removes whole days past retention and reports an expired cursor", async () => {
    let now = Date.parse("2026-11-01T12:00:00Z");
    const log = new ClientEventLog({ directory, retentionDays: 7, now: () => now });
    const [old] = await log.append("bot", [event("old")]);
    now += 10 * DAY;
    const [fresh] = await log.append("bot", [event("fresh")]);
    expect(await readdir(path.join(directory, "bot"))).not.toContain("2026-11-01.jsonl");
    await expect(log.read("bot", need(old).id - 1)).rejects.toMatchObject({
      code: "CURSOR_EXPIRED",
      details: { oldestEventId: need(fresh).id },
    });
    // Reading from the start, or from the last removed event, is still fine.
    await expect(log.read("bot", 0)).resolves.toMatchObject({ events: [fresh] });
    await expect(log.read("bot", need(old).id)).resolves.toMatchObject({ events: [fresh] });
  });

  it("skips a line cut short by a crash", async () => {
    const log = new ClientEventLog({ directory, retentionDays: 7 });
    const [first] = await log.append("bot", [event("a")]);
    const file = path.join(directory, "bot", (await readdir(path.join(directory, "bot")))[0] ?? "");
    await writeFile(file, '{"id": 9', { flag: "a" });
    const [second] = await log.append("bot", [event("b")]);
    expect((await log.read("bot", 0)).events).toEqual([first, second]);
  });

  it("wakes a waiter on append and refuses names that could leave the directory", async () => {
    const log = new ClientEventLog({ directory, retentionDays: 7 });
    const waiting = log.waitForEvent("bot", 10_000);
    await log.append("bot", [event("a")]);
    await expect(waiting).resolves.toBeUndefined();
    await expect(log.append("../escape", [event("a")])).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("watches that notify an external client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function runtime(status: { child: DelegationThreadStatus }) {
    return {
      read: vi.fn(async ({ threadId }: { threadId: string }) => {
        if (threadId !== "child") throw new DelegationControlError("THREAD_NOT_FOUND", "missing");
        return {
          threadId,
          harnessId: "pi",
          status: status.child,
          turn: { turnId: "turn-1", status: status.child },
          progress: [],
          result: { availability: "pending" },
          nextCursor: null,
          refs: ["https://github.com/o/r/issues/12"],
        } as DelegationThreadSnapshot;
      }),
      send: vi.fn(),
    };
  }

  it("writes an event instead of starting a Turn", async () => {
    const status = { child: "running" as DelegationThreadStatus };
    const fake = runtime(status);
    const append = vi.fn(async () => []);
    const service = new DelegationWatchService(fake, {
      pollIntervalMs: 1_000,
      clientEvents: { append },
    });
    await expect(
      service.watch({ threadId: "child", notifyThreadId: "client:grok-bot", timeoutMs: 60_000 }),
    ).resolves.toMatchObject({ state: "watching" });
    // The client is not a Thread, so it is never read.
    expect(fake.read).toHaveBeenCalledTimes(1);

    status.child = "completed";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.send).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledExactlyOnceWith("grok-bot", [
      {
        type: "watch",
        threadId: "child",
        outcome: "completed",
        turnId: "turn-1",
        harnessId: "pi",
        deepLink: "codex://threads/child",
        refs: ["https://github.com/o/r/issues/12"],
      },
    ]);
    await expect(service.watches()).resolves.toEqual({ watches: [] });
  });

  it("retries a failed append and rejects invalid clients", async () => {
    const status = { child: "running" as DelegationThreadStatus };
    const append = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue([]);
    const service = new DelegationWatchService(runtime(status), {
      pollIntervalMs: 1_000,
      clientEvents: { append },
    });
    await service.watch({ threadId: "child", notifyThreadId: "client:bot", timeoutMs: 60_000 });
    status.child = "failed";
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(service.watches()).resolves.toMatchObject({
      watches: [{ state: "pendingDelivery", outcome: "failed" }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(append).toHaveBeenCalledTimes(2);
    await expect(service.watches()).resolves.toEqual({ watches: [] });

    await expect(
      service.watch({ threadId: "child", notifyThreadId: "client:../x", timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const withoutLog = new DelegationWatchService(runtime(status));
    await expect(
      withoutLog.watch({ threadId: "child", notifyThreadId: "client:bot", timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("event routes", () => {
  let directory: string;
  const servers: ExternalClientServer[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-event-routes-"));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await rm(directory, { recursive: true, force: true });
  });

  it("defaults a client's watch to itself and refuses another client", async () => {
    const watch = vi.fn(async (input: Record<string, unknown>) => input);
    const route = externalClientRouter({
      api: {} as never,
      watchApi: { watch, watches: vi.fn() } as never,
    });
    const call = { client: "bot" } as Parameters<typeof route>[0];
    await route(call, "/v1/thread/watch", { threadId: "child", timeoutMs: 1 });
    expect(watch).toHaveBeenCalledWith(expect.objectContaining({ notifyThreadId: "client:bot" }));
    await expect(
      route(call, "/v1/thread/watch", {
        threadId: "c",
        notifyThreadId: "client:other",
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("long-polls until an event arrives or the timeout ends", async () => {
    const events = new ClientEventLog({ directory, retentionDays: 7 });
    const route = externalClientRouter({ api: {} as never, events });
    const call = { client: "bot" } as Parameters<typeof route>[0];
    await expect(route(call, "/v1/events/poll", { after: 0, timeoutMs: 20 })).resolves.toEqual({
      events: [],
      cursor: 0,
    });
    const pending = route(call, "/v1/events/poll", { after: 0, timeoutMs: 10_000 });
    const [written] = await events.append("bot", [event("a")]);
    await expect(pending).resolves.toEqual({ events: [written], cursor: need(written).id });
    await expect(
      route(call, "/v1/events/poll", { after: 0, timeoutMs: 120_000 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("streams events over SSE, resumes from Last-Event-ID, and ends for a removed client", async () => {
    const clients = new ExternalClientRegistry(path.join(directory, "clients.json"));
    const { token } = await clients.add("bot");
    const events = new ClientEventLog({
      directory: path.join(directory, "events"),
      retentionDays: 7,
    });
    const [first] = await events.append("bot", [event("a")]);
    const server = await startExternalClientServer({
      port: 0,
      clients,
      route: externalClientRouter({ api: {} as never, events }),
      streams: { "/v1/events": externalClientEventStream(events, clients) },
      descriptorPath: externalClientDescriptorPath({ CODEXHOST_DATA_DIR: directory }),
    });
    if (!server) throw new Error("listener did not start");
    servers.push(server);

    const response = await fetch(new URL("/v1/events", server.endpoint), {
      headers: { authorization: `Bearer ${token}`, "last-event-id": String(need(first).id) },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = need(response.body).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const [second] = await events.append("bot", [event("b")]);
    while (!text.includes(`id: ${need(second).id}`)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    // The event before Last-Event-ID is not replayed; the new one is pushed.
    expect(text).not.toContain(`id: ${need(first).id}\n`);
    expect(text).toContain(`event: watch\ndata: ${JSON.stringify(second)}`);
    await reader.cancel();
  });

  it("prints a page of events for an external client from the CLI", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"events":[{"id":5}],"cursor":5}', { status: 200 }),
    ) as unknown as typeof fetch;
    const output = new PassThrough();
    await expect(
      runDelegationCli({
        arguments: ["events", "--after", "4"],
        environment: { CODEXHOST_DATA_DIR: directory, CODEXHOST_CLIENT_TOKEN: "chc_x" },
        output,
        fetchImpl,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(String(output.read()))).toEqual({ events: [{ id: 5 }], cursor: 5 });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ after: 4, limit: 100, timeoutMs: 0 });

    const diagnosticOutput = new PassThrough();
    await expect(
      runDelegationCli({
        arguments: ["events"],
        environment: { CODEXHOST_RUNTIME_ENDPOINT: "http://x", CODEXHOST_RUNTIME_TOKEN: "t" },
        diagnosticOutput,
      }),
    ).resolves.toBe(1);
    expect(String(diagnosticOutput.read())).toContain("external clients");
  });
});
