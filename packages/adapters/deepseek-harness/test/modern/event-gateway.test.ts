import { describe, expect, it, vi } from "vitest";

import {
  ModernEventGateway,
  ModernEventGatewayError,
  type ModernEventDelivery,
  type ModernEventRemote,
  type ModernEventSink,
} from "../../src/modern/event-gateway.js";
import { ModernRemoteConnectionError } from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

class EventFeed implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #items: IteratorResult<unknown>[] = [];
  #pending: ((item: IteratorResult<unknown>) => void) | undefined;
  #done = false;
  returnCalls = 0;

  push(value: unknown): void {
    this.#deliver({ done: false, value });
  }

  finish(): void {
    this.#done = true;
    this.#deliver({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<unknown>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve(item);
    if (this.#done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.#pending = resolve;
    });
  }

  return(): Promise<IteratorResult<unknown>> {
    this.returnCalls += 1;
    this.finish();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  #deliver(item: IteratorResult<unknown>): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) pending(item);
    else this.#items.push(item);
  }
}

class StalledOpening implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  returnCalls = 0;

  next(): Promise<IteratorResult<unknown>> {
    return new Promise(() => undefined);
  }

  return(): Promise<IteratorResult<unknown>> {
    this.returnCalls += 1;
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}

interface RemoteCall {
  readonly endpoint: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal | undefined;
}

class FakeRemote implements ModernEventRemote {
  readonly calls: RemoteCall[] = [];
  readonly opens: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal | undefined;
  }> = [];
  readonly #feeds: AsyncIterable<unknown>[];
  callHandler: (call: RemoteCall) => Promise<ModernRemoteResult<unknown>> = () =>
    Promise.resolve({ ok: true, value: undefined });

  constructor(...feeds: AsyncIterable<unknown>[]) {
    this.#feeds = feeds;
  }

  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>> {
    const call = { endpoint, args, signal };
    this.calls.push(call);
    return this.callHandler(call) as Promise<ModernRemoteResult<T>>;
  }

  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    this.opens.push({ endpoint, args, signal });
    const feed = this.#feeds.shift();
    if (!feed) throw new Error("unexpected event stream open");
    return feed as AsyncIterable<T>;
  }
}

interface SinkProbe extends ModernEventSink {
  readonly deliveries: ModernEventDelivery[];
  readonly cancelled: string[];
  readonly faults: ModernEventGatewayError[];
  readonly order: string[];
  readonly cancelNativeCalls: number;
}

function sinkProbe(): SinkProbe {
  const deliveries: ModernEventDelivery[] = [];
  const cancelled: string[] = [];
  const faults: ModernEventGatewayError[] = [];
  const order: string[] = [];
  let cancelNativeCalls = 0;
  return {
    deliveries,
    cancelled,
    faults,
    order,
    get cancelNativeCalls() {
      return cancelNativeCalls;
    },
    onDelivery(delivery) {
      deliveries.push(delivery);
      order.push(`delivery:${delivery.eventId}`);
    },
    onCancel(eventId) {
      cancelled.push(eventId);
      order.push(`cancel:${eventId}`);
    },
    cancelNative() {
      cancelNativeCalls += 1;
      order.push("native-cancel");
    },
    onFault(error) {
      faults.push(error);
      order.push("fault");
    },
  };
}

function ready(clientId: string): Record<string, unknown> {
  return { type: "ready", clientId, host: { home: String.raw`C:\Users\fixture` } };
}

function approval(
  eventId: string,
  agentId = "session-1",
  request: Readonly<Record<string, unknown>> = {
    toolName: "shell",
    callId: "call-1",
    reason: "write workspace",
  },
): Record<string, unknown> {
  return {
    type: "waterfall",
    event: "approval/request",
    eventId,
    agentId,
    request,
  };
}

function question(eventId: string, agentId = "session-1"): Record<string, unknown> {
  return {
    type: "waterfall",
    event: "user-questions/request",
    eventId,
    agentId,
    request: {
      questions: [
        {
          id: "decision",
          question: "Continue?",
          detail: "Plan body",
          header: "Review",
          options: [{ label: "Yes", description: "Continue" }, { label: "No" }],
          multiSelect: false,
          intent: { kind: "plan-review", approve: "Yes" },
        },
      ],
    },
  };
}

async function startGateway(
  remote: FakeRemote,
  feed: EventFeed,
  options: ConstructorParameters<typeof ModernEventGateway>[1] = {},
): Promise<ModernEventGateway> {
  feed.push(ready("client-1"));
  const gateway = new ModernEventGateway(remote, options);
  await gateway.start();
  return gateway;
}

function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected operation to reject");
    },
    (error: unknown) => error,
  );
}

describe("DeepSeek Harness Modern event gateway", () => {
  it("coalesces concurrent starts into one event generation", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = new ModernEventGateway(remote);

    const first = gateway.start();
    const second = gateway.start();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(remote.opens).toHaveLength(1));
    feed.push(ready("client-1"));
    await Promise.all([first, second]);
    expect(remote.opens).toHaveLength(1);
    await gateway.close();
  });

  it("bounds logical event readiness and returns a stalled iterator exactly once", async () => {
    vi.useFakeTimers();
    try {
      const opening = new StalledOpening();
      const remote = new FakeRemote(opening);
      const gateway = new ModernEventGateway(remote);
      const failure = captureRejection(gateway.start());
      for (let attempt = 0; attempt < 10 && remote.opens.length === 0; attempt += 1) {
        await Promise.resolve();
      }

      expect(remote.opens).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(failure).resolves.toMatchObject({
        code: "unavailable",
        message: "DeepSeek Harness event stream did not become ready in time",
      });
      expect(opening.returnCalls).toBe(1);
      expect(remote.opens[0]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await gateway.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the readiness timer after a normal ready frame", async () => {
    vi.useFakeTimers();
    try {
      const feed = new EventFeed();
      const remote = new FakeRemote(feed);
      const gateway = new ModernEventGateway(remote);
      const start = gateway.start();
      for (let attempt = 0; attempt < 10 && remote.opens.length === 0; attempt += 1) {
        await Promise.resolve();
      }

      expect(vi.getTimerCount()).toBe(1);
      feed.push(ready("client-1"));
      await start;
      expect(vi.getTimerCount()).toBe(0);
      await gateway.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims a typed approval and returns user rejection as a result exactly once", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push(approval("event-approval"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    expect(delivery).toMatchObject({
      type: "approval",
      eventId: "event-approval",
      sessionId: "session-1",
      request: { toolName: "shell", callId: "call-1", reason: "write workspace" },
    });
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");

    await delivery.respond("rejected");
    await delivery.respond("allowed-once");
    expect(remote.calls).toEqual([
      {
        endpoint: "$events/result",
        args: {
          clientId: "client-1",
          eventId: "event-approval",
          outcome: { kind: "result", value: "rejected" },
        },
        signal: expect.any(AbortSignal),
      },
    ]);

    feed.push({ type: "cancel", eventId: "event-approval" });
    await Promise.resolve();
    expect(sink.cancelled).toEqual([]);
    await gateway.close();
  });

  it("round-trips exact question answers and uses a stable rejection for user cancellation", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push(question("event-answer"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const answered = sink.deliveries[0];
    if (answered?.type !== "question") throw new Error("expected question delivery");
    await answered.respond({
      answers: [{ id: "decision", selected: ["Yes"], custom: "ship it" }],
    });

    feed.push(question("event-cancelled"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(2));
    const cancelled = sink.deliveries[1];
    if (cancelled?.type !== "question") throw new Error("expected question delivery");
    await cancelled.reject();

    expect(remote.calls.map(({ args }) => args)).toEqual([
      {
        clientId: "client-1",
        eventId: "event-answer",
        outcome: {
          kind: "result",
          value: {
            answers: [{ id: "decision", selected: ["Yes"], custom: "ship it" }],
          },
        },
      },
      {
        clientId: "client-1",
        eventId: "event-cancelled",
        outcome: {
          kind: "rejected",
          error: {
            name: "UserQuestionError",
            code: "ASK_CANCELLED",
            message: "The user cancelled the DeepSeek Harness question",
          },
        },
      },
    ]);
    await gateway.close();
  });

  it("validates and ignores emits while delegating unloaded and unknown waterfalls", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push({ type: "emit", event: "settings/document-updated", args: ["ui", { seq: 1 }] });
    feed.push(approval("event-unloaded", "session-missing"));
    feed.push({
      type: "waterfall",
      event: "plugin/future-request",
      eventId: "event-unknown",
      agentId: "session-1",
      request: { nested: [1, true, null] },
    });
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));

    expect(sink.deliveries).toEqual([]);
    expect(remote.calls.map(({ args }) => args)).toEqual([
      {
        clientId: "client-1",
        eventId: "event-unloaded",
        outcome: { kind: "next" },
      },
      {
        clientId: "client-1",
        eventId: "event-unknown",
        outcome: { kind: "next" },
      },
    ]);
    await gateway.close();
  });

  it("rejects a malformed owned request and faults only its Session", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = await startGateway(remote, feed);
    const broken = sinkProbe();
    const healthy = sinkProbe();
    gateway.attach("session-broken", broken);
    gateway.attach("session-healthy", healthy);

    feed.push(
      approval("event-malformed", "session-broken", {
        toolName: "shell",
        unexpected: "payload must not be echoed",
      }),
    );
    await vi.waitFor(() => expect(broken.faults).toHaveLength(1));
    expect(remote.calls[0]?.args).toEqual({
      clientId: "client-1",
      eventId: "event-malformed",
      outcome: {
        kind: "rejected",
        error: {
          name: "TypeError",
          code: "DSH_EVENT_INVALID",
          message: "DeepSeek Harness sent an invalid approval request",
        },
      },
    });
    expect(JSON.stringify(remote.calls[0])).not.toContain("payload must not be echoed");
    expect(broken.order.slice(-2)).toEqual(["native-cancel", "fault"]);

    feed.push(question("event-healthy", "session-healthy"));
    await vi.waitFor(() => expect(healthy.deliveries).toHaveLength(1));
    feed.push({
      ...question("event-empty-plan", "session-healthy"),
      request: {
        questions: [
          {
            id: "decision",
            question: "Continue?",
            detail: "",
            options: [{ label: "Yes" }, { label: "No" }],
            intent: { kind: "plan-review", approve: "Yes" },
          },
        ],
      },
    });
    await vi.waitFor(() => expect(healthy.deliveries).toHaveLength(2));
    expect(healthy.deliveries[1]).toMatchObject({
      type: "question",
      request: { questions: [{ detail: "" }] },
    });
    expect(healthy.faults).toEqual([]);
    await gateway.close();
  });

  it("rejects malformed owned question batches while delegating an unowned one", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = await startGateway(remote, feed);
    const healthy = sinkProbe();
    gateway.attach("session-healthy", healthy);
    const validQuestion = {
      id: "decision",
      question: "Continue?",
      detail: "Plan body",
      options: [{ label: "Yes" }, { label: "No" }],
      intent: { kind: "plan-review", approve: "Yes" },
    };
    const malformedRequests: Readonly<Record<string, unknown>>[] = [
      { questions: [] },
      { questions: [validQuestion, validQuestion] },
      {
        questions: [{ ...validQuestion, options: [{ label: "Yes" }, { label: "Yes" }] }],
      },
      {
        questions: [
          {
            id: "decision",
            question: "Continue?",
            options: validQuestion.options,
            intent: validQuestion.intent,
          },
        ],
      },
      {
        questions: [
          { ...validQuestion, options: [{ label: "No" }] },
          { id: "other", question: "Other?", options: [{ label: "Yes" }] },
        ],
      },
    ];
    const broken = malformedRequests.map((request, index) => {
      const sink = sinkProbe();
      const sessionId = `session-broken-${index}`;
      gateway.attach(sessionId, sink);
      feed.push({ ...question(`event-malformed-${index}`, sessionId), request });
      return sink;
    });

    await vi.waitFor(() => expect(broken.every(({ faults }) => faults.length === 1)).toBe(true));
    expect(remote.calls.slice(0, malformedRequests.length).map(({ args }) => args.outcome)).toEqual(
      malformedRequests.map(() => ({
        kind: "rejected",
        error: {
          name: "TypeError",
          code: "DSH_EVENT_INVALID",
          message: "DeepSeek Harness sent an invalid user question request",
        },
      })),
    );
    for (const sink of broken) {
      expect(sink.deliveries).toEqual([]);
      expect(sink.order).toEqual(["native-cancel", "fault"]);
      expect(sink.faults[0]).toMatchObject({ code: "protocolError" });
    }

    feed.push({
      ...question("event-unowned-malformed", "session-unowned"),
      request: { questions: [] },
    });
    await vi.waitFor(() => expect(remote.calls).toHaveLength(malformedRequests.length + 1));
    expect(remote.calls.at(-1)?.args).toEqual({
      clientId: "client-1",
      eventId: "event-unowned-malformed",
      outcome: { kind: "next" },
    });
    feed.push(question("event-healthy", "session-healthy"));
    await vi.waitFor(() => expect(healthy.deliveries).toHaveLength(1));
    expect(healthy.faults).toEqual([]);
    await gateway.close();
  });

  it("rebinds a disconnected pending response to a replay without a second interaction", async () => {
    const first = new EventFeed();
    const second = new EventFeed();
    const remote = new FakeRemote(first, second);
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    const frame = approval("event-replay");
    first.push(frame);
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    first.finish();
    await vi.waitFor(() => expect(lost).toHaveLength(1));

    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    expect(remote.calls).toEqual([]);

    second.push(ready("client-2"));
    await gateway.replace();
    second.push(frame);
    await response;
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]?.args).toMatchObject({
      clientId: "client-2",
      eventId: "event-replay",
    });
    expect(sink.deliveries).toHaveLength(1);

    second.push(frame);
    await delivery.respond("rejected");
    await Promise.resolve();
    expect(remote.calls).toHaveLength(1);
    expect(sink.deliveries).toHaveLength(1);
    await gateway.close();
  });

  it("retries a failed old-generation settlement only after the event replays on the replacement", async () => {
    const first = new EventFeed();
    const second = new EventFeed();
    const remote = new FakeRemote(first, second);
    const oldSettlement = Promise.withResolvers<ModernRemoteResult<unknown>>();
    remote.callHandler = () =>
      remote.calls.length === 1
        ? oldSettlement.promise
        : Promise.resolve({ ok: true, value: undefined });
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    const frame = approval("event-old-client");
    first.push(frame);
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    expect(remote.calls[0]?.args).toMatchObject({ clientId: "client-1" });

    oldSettlement.reject(new Error("old Client is no longer active"));
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    expect(first.returnCalls).toBe(1);
    second.push(ready("client-2"));
    await gateway.replace();
    second.push(frame);
    await response;
    expect(remote.calls).toHaveLength(2);
    expect(remote.calls[1]?.args).toMatchObject({
      clientId: "client-2",
      eventId: "event-old-client",
    });
    expect(sink.faults).toEqual([]);
    await delivery.respond("rejected");
    expect(remote.calls).toHaveLength(2);
    await gateway.close();
  });

  it("releases a detached in-flight response as next after replacement replay", async () => {
    const first = new EventFeed();
    const second = new EventFeed();
    const remote = new FakeRemote(first, second);
    const oldSettlement = Promise.withResolvers<ModernRemoteResult<unknown>>();
    remote.callHandler = () =>
      remote.calls.length === 1
        ? oldSettlement.promise
        : Promise.resolve({ ok: true, value: undefined });
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    const frame = approval("event-detached-in-flight");

    first.push(frame);
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    const detached = gateway.detach("session-1", sink);
    oldSettlement.reject(new Error("old Client became unavailable"));
    await detached;
    await response;
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    expect(sink.cancelled).toEqual(["event-detached-in-flight"]);

    second.push(ready("client-2"));
    await gateway.replace();
    second.push(frame);
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));
    expect(remote.calls.map(({ args }) => args)).toEqual([
      {
        clientId: "client-1",
        eventId: "event-detached-in-flight",
        outcome: { kind: "result", value: "allowed-once" },
      },
      {
        clientId: "client-2",
        eventId: "event-detached-in-flight",
        outcome: { kind: "next" },
      },
    ]);
    expect(sink.deliveries).toHaveLength(1);
    await delivery.respond("rejected");
    expect(remote.calls).toHaveLength(2);
    await gateway.close();
  });

  it("does not send next when a detached in-flight response succeeds", async () => {
    const first = new EventFeed();
    const second = new EventFeed();
    const remote = new FakeRemote(first, second);
    const settlement = Promise.withResolvers<ModernRemoteResult<unknown>>();
    remote.callHandler = () => settlement.promise;
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    const frame = approval("event-detached-success");

    first.push(frame);
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    const detached = gateway.detach("session-1", sink);
    settlement.resolve({ ok: true, value: undefined });
    await Promise.all([response, detached]);

    first.finish();
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    second.push(ready("client-2"));
    await gateway.replace();
    second.push(frame);
    await Promise.resolve();
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]?.args).toMatchObject({
      eventId: "event-detached-success",
      outcome: { kind: "result", value: "allowed-once" },
    });
    expect(sink.cancelled).toEqual(["event-detached-success"]);
    await gateway.close();
  });

  it("best-effort sends next before close after an in-flight response becomes unavailable", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const oldSettlement = Promise.withResolvers<ModernRemoteResult<unknown>>();
    remote.callHandler = () =>
      remote.calls.length === 1
        ? oldSettlement.promise
        : Promise.resolve({ ok: true, value: undefined });
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push(approval("event-close-in-flight"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    const closing = gateway.close();
    oldSettlement.reject(new Error("response transport failed during close"));
    await Promise.all([response, closing]);

    expect(remote.calls.map(({ args }) => args)).toEqual([
      {
        clientId: "client-1",
        eventId: "event-close-in-flight",
        outcome: { kind: "result", value: "allowed-once" },
      },
      {
        clientId: "client-1",
        eventId: "event-close-in-flight",
        outcome: { kind: "next" },
      },
    ]);
    expect(sink.cancelled).toEqual(["event-close-in-flight"]);
  });

  it("finishes close when both the in-flight response and best-effort next fail", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const oldSettlement = Promise.withResolvers<ModernRemoteResult<unknown>>();
    remote.callHandler = () =>
      remote.calls.length === 1
        ? oldSettlement.promise
        : Promise.reject(new Error("best-effort next also failed"));
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push(approval("event-close-double-failure"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    const closing = gateway.close();
    oldSettlement.reject(new Error("old response failed"));
    await Promise.all([response, closing]);

    expect(remote.calls).toHaveLength(2);
    expect(remote.calls[1]?.args).toEqual({
      clientId: "client-1",
      eventId: "event-close-double-failure",
      outcome: { kind: "next" },
    });
    expect(sink.cancelled).toEqual(["event-close-double-failure"]);
  });

  it("cleans a released pending event when close follows generation loss", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, feed, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push(approval("event-close-after-loss"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    feed.finish();
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    await gateway.close();

    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    await delivery.respond("allowed-once");
    expect(remote.calls).toEqual([]);
    expect(sink.cancelled).toEqual(["event-close-after-loss"]);
    await expect(gateway.start()).rejects.toMatchObject({ code: "closed" });
  });

  it("cancels the detached native Session when releasing next hits a protocol fault", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    remote.callHandler = () =>
      Promise.reject(
        new ModernRemoteConnectionError("protocolError", "event result wire is malformed"),
      );
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push(approval("event-detached-protocol"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    await gateway.detach("session-1", sink);

    expect(remote.calls[0]?.args).toEqual({
      clientId: "client-1",
      eventId: "event-detached-protocol",
      outcome: { kind: "next" },
    });
    expect(sink.cancelNativeCalls).toBe(1);
    expect(sink.faults).toEqual([]);
    expect(sink.cancelled).toEqual(["event-detached-protocol"]);
    await gateway.close();
  });

  it("cancels one detached native Session once when two event settlements fault", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const settlements = [
      Promise.withResolvers<ModernRemoteResult<unknown>>(),
      Promise.withResolvers<ModernRemoteResult<unknown>>(),
    ];
    remote.callHandler = () => {
      const settlement = settlements[remote.calls.length - 1];
      if (!settlement) throw new Error("unexpected event result call");
      return settlement.promise;
    };
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push(approval("event-detached-protocol-a"));
    feed.push(approval("event-detached-protocol-b"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(2));
    const responses = sink.deliveries.map((delivery) => {
      if (delivery.type !== "approval") throw new Error("expected approval delivery");
      return delivery.respond("allowed-once");
    });
    const detached = gateway.detach("session-1", sink);
    const protocolFault = new ModernRemoteConnectionError(
      "protocolError",
      "event result wire is malformed",
    );
    settlements[0]?.reject(protocolFault);
    settlements[1]?.reject(protocolFault);
    await Promise.allSettled([...responses, detached]);

    expect(sink.cancelNativeCalls).toBe(1);
    expect(sink.faults).toEqual([]);
    expect(sink.cancelled).toEqual(["event-detached-protocol-a", "event-detached-protocol-b"]);
    await gateway.close();
  });

  it("cancels a detached native Session when event-generation recovery is exhausted", async () => {
    const first = new EventFeed();
    const remote = new FakeRemote(first);
    const oldSettlement = Promise.withResolvers<ModernRemoteResult<unknown>>();
    remote.callHandler = () => oldSettlement.promise;
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    first.push(approval("event-detached-recovery-failed"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    const detached = gateway.detach("session-1", sink);
    oldSettlement.reject(new Error("old event generation is unavailable"));
    await Promise.all([response, detached]);
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    expect(sink.cancelNativeCalls).toBe(0);

    await gateway.fail(new Error("event generation recovery was exhausted"));
    expect(sink.cancelNativeCalls).toBe(1);
    expect(sink.faults).toEqual([]);
    await gateway.close();
  });

  it("waits for an already-detaching settlement before close completes", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const oldSettlement = Promise.withResolvers<ModernRemoteResult<unknown>>();
    remote.callHandler = () =>
      remote.calls.length === 1
        ? oldSettlement.promise
        : Promise.resolve({ ok: true, value: undefined });
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    feed.push(approval("event-detach-close-race"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    const detaching = gateway.detach("session-1", sink);
    let closed = false;
    const closing = gateway.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    oldSettlement.reject(new Error("old response became unavailable"));
    await Promise.all([response, detaching, closing]);
    expect(remote.calls.map(({ args }) => args)).toEqual([
      {
        clientId: "client-1",
        eventId: "event-detach-close-race",
        outcome: { kind: "result", value: "allowed-once" },
      },
      {
        clientId: "client-1",
        eventId: "event-detach-close-race",
        outcome: { kind: "next" },
      },
    ]);
    expect(sink.cancelled).toEqual(["event-detach-close-race"]);
  });

  it("delegates an unowned malformed request again when a replacement replays it", async () => {
    const first = new EventFeed();
    const second = new EventFeed();
    const remote = new FakeRemote(first, second);
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    const frame = approval("event-unowned-malformed", "session-missing", {
      unexpected: "known event payload is irrelevant when this Client does not own the Session",
    });

    first.push(frame);
    await vi.waitFor(() => expect(remote.calls).toHaveLength(1));
    first.finish();
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    second.push(ready("client-2"));
    await gateway.replace();
    second.push(frame);
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));

    expect(remote.calls.map(({ args }) => args)).toEqual([
      { clientId: "client-1", eventId: "event-unowned-malformed", outcome: { kind: "next" } },
      { clientId: "client-2", eventId: "event-unowned-malformed", outcome: { kind: "next" } },
    ]);
    expect(sink.deliveries).toEqual([]);
    expect(sink.faults).toEqual([]);
    await gateway.close();
  });

  it("faults when a replay changes a retained event", async () => {
    const first = new EventFeed();
    const second = new EventFeed();
    const remote = new FakeRemote(first, second);
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);

    first.push(approval("event-changed-replay"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    first.finish();
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    second.push(ready("client-2"));
    await gateway.replace();
    second.push(
      approval("event-changed-replay", "session-1", {
        toolName: "filesystem",
        reason: "changed request",
      }),
    );

    await vi.waitFor(() => expect(sink.faults).toHaveLength(1));
    expect(sink.faults[0]).toMatchObject({
      code: "protocolError",
      message: "DeepSeek Harness replay changed a pending event",
    });
    expect(sink.order.slice(-2)).toEqual(["native-cancel", "fault"]);
    await gateway.close();
  });

  it("drains an opening stream when close races ready", async () => {
    vi.useFakeTimers();
    try {
      const opening = new StalledOpening();
      const remote = new FakeRemote(opening);
      const gateway = new ModernEventGateway(remote);
      const start = captureRejection(gateway.start());
      for (let attempt = 0; attempt < 10 && remote.opens.length === 0; attempt += 1) {
        await Promise.resolve();
      }

      await gateway.close();
      await expect(start).resolves.toMatchObject({ code: "closed" });
      expect(opening.returnCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(gateway.start()).rejects.toMatchObject({ code: "closed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains an opening stream when a gateway fault races ready", async () => {
    vi.useFakeTimers();
    try {
      const opening = new StalledOpening();
      const remote = new FakeRemote(opening);
      const gateway = new ModernEventGateway(remote);
      const start = captureRejection(gateway.start());
      for (let attempt = 0; attempt < 10 && remote.opens.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      const failure = new ModernEventGatewayError("unavailable", "event gateway faulted");

      await gateway.fail(failure);
      await expect(start).resolves.toBe(failure);
      expect(opening.returnCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await gateway.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delegates when a local sink cannot accept a valid delivery, then faults only that sink", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = await startGateway(remote, feed);
    const broken = sinkProbe();
    const throwing: ModernEventSink = {
      ...broken,
      onDelivery() {
        throw new Error("renderer is unavailable");
      },
    };
    gateway.attach("session-1", throwing);

    feed.push(approval("event-local-failure"));
    await vi.waitFor(() => expect(broken.faults).toHaveLength(1));
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]?.args).toEqual({
      clientId: "client-1",
      eventId: "event-local-failure",
      outcome: { kind: "next" },
    });
    expect(broken.order).toEqual(["native-cancel", "fault"]);
    await gateway.close();
  });

  it("makes Host cancel, a late response, and duplicate replay idempotent", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    const frame = question("event-host-cancel");

    feed.push(frame);
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    feed.push({ type: "cancel", eventId: "event-host-cancel" });
    feed.push({ type: "cancel", eventId: "event-host-cancel" });
    await vi.waitFor(() => expect(sink.cancelled).toEqual(["event-host-cancel"]));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "question") throw new Error("expected question delivery");
    await delivery.respond({ answers: [{ id: "decision", selected: ["Yes"] }] });
    feed.push(frame);
    await Promise.resolve();

    expect(remote.calls).toEqual([]);
    expect(sink.deliveries).toHaveLength(1);
    await gateway.close();
  });

  it("sends next before detach and close retire their current deliveries", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const order: string[] = [];
    remote.callHandler = (call) => {
      order.push(`rpc:${String(call.args.eventId)}`);
      return Promise.resolve({ ok: true, value: undefined });
    };
    const gateway = await startGateway(remote, feed);
    const first = sinkProbe();
    const second = sinkProbe();
    const firstSink: ModernEventSink = {
      ...first,
      onCancel(eventId) {
        first.onCancel(eventId);
        order.push(`cancel:${eventId}`);
      },
    };
    const secondSink: ModernEventSink = {
      ...second,
      onCancel(eventId) {
        second.onCancel(eventId);
        order.push(`cancel:${eventId}`);
      },
    };
    gateway.attach("session-1", firstSink);
    gateway.attach("session-2", secondSink);
    feed.push(approval("event-detach", "session-1"));
    feed.push(question("event-close", "session-2"));
    await vi.waitFor(() => {
      expect(first.deliveries).toHaveLength(1);
      expect(second.deliveries).toHaveLength(1);
    });

    await gateway.detach("session-1", firstSink);
    await gateway.close();
    expect(remote.calls.map(({ args }) => args)).toEqual([
      { clientId: "client-1", eventId: "event-detach", outcome: { kind: "next" } },
      { clientId: "client-1", eventId: "event-close", outcome: { kind: "next" } },
    ]);
    expect(order).toEqual([
      "rpc:event-detach",
      "cancel:event-detach",
      "rpc:event-close",
      "cancel:event-close",
    ]);
  });

  it("cancels native Sessions before publishing a credential-safe unrecoverable fault", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const sink = sinkProbe();
    const globalFaults: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, feed, {
      onFault(error) {
        globalFaults.push(error);
        sink.order.push("global-fault");
      },
    });
    gateway.attach("session-1", sink);
    const token = "A".repeat(43);

    await gateway.fail(
      new Error(`failed ?token=${token} Bearer SUPER_SECRET api_key=SUPER_SECRET`, {
        cause: new Error("SUPER_SECRET"),
      }),
    );
    expect(sink.order).toEqual(["native-cancel", "fault", "global-fault"]);
    expect(globalFaults).toEqual(sink.faults);
    expect(sink.faults[0]).toBeInstanceOf(ModernEventGatewayError);
    expect(sink.faults[0]?.cause).toBeUndefined();
    expect(JSON.stringify(sink.faults[0])).not.toContain(token);
    expect(JSON.stringify(sink.faults[0])).not.toContain("SUPER_SECRET");
    await gateway.close();
  });

  it("keeps an invalidated delivery failed while native cancellation delays Session fault", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    remote.callHandler = (call) =>
      new Promise((_resolve, reject) => {
        call.signal?.addEventListener(
          "abort",
          () => reject(new ModernRemoteConnectionError("cancelled", "cancelled")),
          { once: true },
        );
      });
    const gateway = await startGateway(remote, feed);
    const probe = sinkProbe();
    const cancellation = Promise.withResolvers<undefined>();
    const sink: ModernEventSink = {
      ...probe,
      cancelNative: () => cancellation.promise,
    };
    gateway.attach("session-1", sink);
    feed.push(approval("event-invalidated"));
    await vi.waitFor(() => expect(probe.deliveries).toHaveLength(1));
    const delivery = probe.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const responding = delivery.respond("allowed-once");
    await vi.waitFor(() => expect(remote.calls).toHaveLength(1));

    const failure = new ModernEventGatewayError("protocolError", "event stream is invalid");
    const failing = gateway.fail(failure);
    await expect(responding).rejects.toBe(failure);
    await expect(delivery.respond("allowed-once")).rejects.toBe(failure);
    expect(remote.calls).toHaveLength(1);
    expect(probe.faults).toEqual([]);

    cancellation.resolve(undefined);
    await failing;
    expect(probe.faults).toEqual([failure]);
    await gateway.close();
  });

  it("rejects a non-void $events/result success as a protocol fault", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    remote.callHandler = () => Promise.resolve({ ok: true, value: { unexpected: true } });
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    feed.push(approval("event-non-void"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");

    await expect(delivery.respond("allowed-once")).rejects.toMatchObject({
      code: "protocolError",
    });
    expect(sink.faults).toHaveLength(1);
    expect(sink.faults[0]).toMatchObject({ code: "protocolError" });
    await gateway.close();
  });

  it("preserves credential-safe Remote protocol errors from result calls", async () => {
    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const secret = "RESULT_PROTOCOL_SECRET";
    const remoteError = new ModernRemoteConnectionError(
      "protocolError",
      `invalid response ?token=${secret}`,
      `native api_key=${secret}`,
    );
    Object.defineProperty(remoteError, "cause", {
      enumerable: true,
      value: new Error(secret),
    });
    Object.defineProperty(remoteError, "remoteFailure", {
      enumerable: true,
      value: { code: secret, message: secret, details: {} },
    });
    remote.callHandler = () => Promise.reject(remoteError);
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    feed.push(approval("event-remote-protocol"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");

    const failure = await captureRejection(delivery.respond("allowed-once"));
    expect(failure).toMatchObject({ code: "protocolError" });
    expect((failure as Error).cause).toBeUndefined();
    expect(Object.hasOwn(failure as object, "remoteFailure")).toBe(false);
    expect(String((failure as Error).message)).not.toContain(secret);
    expect(sink.faults).toHaveLength(1);
    expect(sink.faults[0]).toMatchObject({ code: "protocolError" });
    expect(sink.faults[0]?.cause).toBeUndefined();
    expect(sink.faults[0]?.message).not.toContain(secret);
    expect(JSON.stringify(sink.faults[0])).not.toContain(secret);
    await gateway.close();
  });

  it("does not retry an old-generation protocol fault on a replacement client", async () => {
    const first = new EventFeed();
    const second = new EventFeed();
    const remote = new FakeRemote(first, second);
    const oldSettlement = Promise.withResolvers<ModernRemoteResult<unknown>>();
    remote.callHandler = () => oldSettlement.promise;
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    const frame = approval("event-stale-protocol");

    first.push(frame);
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    const delivery = sink.deliveries[0];
    if (delivery?.type !== "approval") throw new Error("expected approval delivery");
    const response = delivery.respond("allowed-once");
    first.finish();
    await vi.waitFor(() => expect(lost).toHaveLength(1));
    second.push(ready("client-2"));
    await gateway.replace();
    second.push(frame);
    await Promise.resolve();

    oldSettlement.reject(
      new ModernRemoteConnectionError("protocolError", "old Client returned malformed wire"),
    );
    await expect(response).rejects.toMatchObject({ code: "protocolError" });
    await vi.waitFor(() => expect(sink.faults).toHaveLength(1));
    expect(remote.calls).toHaveLength(1);
    expect(sink.deliveries).toHaveLength(1);
    await gateway.close();
  });

  it("preserves Remote protocol errors while opening an event generation", async () => {
    const secret = "OPEN_PROTOCOL_SECRET";
    const createFailure = (): ModernRemoteConnectionError => {
      const error = new ModernRemoteConnectionError(
        "protocolError",
        `invalid stream Bearer ${secret}`,
        `native api_key=${secret}`,
      );
      Object.defineProperty(error, "cause", { enumerable: true, value: new Error(secret) });
      Object.defineProperty(error, "remoteFailure", {
        enumerable: true,
        value: { code: secret, message: secret, details: {} },
      });
      return error;
    };
    const assertSafe = (error: unknown): void => {
      expect(error).toMatchObject({ code: "protocolError" });
      expect((error as Error).cause).toBeUndefined();
      expect(Object.hasOwn(error as object, "remoteFailure")).toBe(false);
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    };

    const throwingRemote: ModernEventRemote = {
      call<T>() {
        return Promise.resolve({ ok: true, value: undefined as T });
      },
      openStream: () => {
        throw createFailure();
      },
    };
    assertSafe(await captureRejection(new ModernEventGateway(throwingRemote).start()));

    const rejectingRemote: ModernEventRemote = {
      call<T>() {
        return Promise.resolve({ ok: true, value: undefined as T });
      },
      openStream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(createFailure()),
          return: () => Promise.resolve({ done: true, value: undefined }),
        }),
      }),
    };
    assertSafe(await captureRejection(new ModernEventGateway(rejectingRemote).start()));
  });

  it("refuses to rebind retained interactions when replacement changes Host home", async () => {
    const first = new EventFeed();
    const second = new EventFeed();
    const remote = new FakeRemote(first, second);
    const lost: ModernEventGatewayError[] = [];
    const gateway = await startGateway(remote, first, {
      onGenerationLost: (error) => lost.push(error),
    });
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    first.push(approval("event-other-home"));
    await vi.waitFor(() => expect(sink.deliveries).toHaveLength(1));
    first.finish();
    await vi.waitFor(() => expect(lost).toHaveLength(1));

    second.push({
      type: "ready",
      clientId: "client-2",
      host: { home: String.raw`D:\OtherHome` },
    });
    await expect(gateway.replace()).rejects.toMatchObject({ code: "protocolError" });
    expect(sink.order.slice(-2)).toEqual(["native-cancel", "fault"]);
    expect(sink.faults[0]).toMatchObject({
      code: "protocolError",
      message: "DeepSeek Harness replacement changed its Host home",
    });
    await gateway.close();
  });

  it("strictly validates ready and bounded JSON collections", async () => {
    const invalidOpening = new EventFeed();
    invalidOpening.push({ ...ready("client-bad"), extra: true });
    const invalidRemote = new FakeRemote(invalidOpening);
    const invalidGateway = new ModernEventGateway(invalidRemote);
    await expect(invalidGateway.start()).rejects.toMatchObject({ code: "protocolError" });
    expect(invalidOpening.returnCalls).toBe(1);

    const feed = new EventFeed();
    const remote = new FakeRemote(feed);
    const gateway = await startGateway(remote, feed);
    const sink = sinkProbe();
    gateway.attach("session-1", sink);
    const oversized = Array.from({ length: 4_097 }, () => null);
    feed.push({ type: "emit", event: "fixture/oversized", args: oversized });
    await vi.waitFor(() => expect(sink.faults).toHaveLength(1));
    expect(sink.faults[0]).toMatchObject({ code: "resourceLimit" });
    expect(sink.order.slice(-2)).toEqual(["native-cancel", "fault"]);
    await gateway.close();
  });
});
