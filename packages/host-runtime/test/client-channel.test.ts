import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostClientChannel,
  discoverHostClientChannel,
  type HostClientUpdate,
} from "@codexhost/desktop-control";
import type { ClientChannelEvent } from "@codexhost/shared-contracts";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { ClientCommandReceipts } from "../src/client-command-receipts.js";
import { startClientChannelServer } from "../src/client-channel-server.js";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
  requiredMessageId,
} from "./app-server-host-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const directory = mkdtempSync(path.join(tmpdir(), "client-channel-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const server = await startClientChannelServer({
    target: fixture.host,
    environment: {},
    directory,
  });
  cleanup.push(() => server.close());
  const a = new HostClientChannel(directory, server.descriptor),
    b = new HostClientChannel(directory, server.descriptor);
  cleanup.push(() => {
    a.close();
    b.close();
  });
  const events: HostClientUpdate[] = [];
  a.subscribe((event) => events.push(event));
  await Promise.all([a.start(), b.start()]);
  return { fixture, directory, server, a, b, events };
}
function current(fixture: ReturnType<typeof createFixture>) {
  const session = fixture.adapter.sessions[0];
  if (!session) throw new Error("Missing fake Session");
  return session;
}

describe("public authenticated owner channel", () => {
  it("rejects unauthenticated/browser-origin traffic and official Thread execution", async () => {
    const { server, a, fixture } = await setup();
    const url = `http://127.0.0.1:${server.descriptor.port}/v1/rpc`;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${server.descriptor.token}`,
            origin: "http://untrusted.invalid",
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    if (process.platform !== "win32")
      expect(statSync(server.descriptorPath).mode & 0o777).toBe(0o600);
    await expect(a.request("thread/start", { model: "gpt-5", cwd: "/synthetic" })).rejects.toThrow(
      "Only external",
    );
    await expect(
      a.request("thread/read", { threadId: "official", includeTurns: false }),
    ).rejects.toThrow("not owned");
    await expect(a.request("thread/resume", { threadId: "official" })).rejects.toThrow(
      "not available",
    );
    expect(fixture.adapter.sessions).toHaveLength(0);
  });
  it("streams GUI changes and supplies absolute snapshots without another Adapter", async () => {
    const { fixture, a, b, events } = await setup();
    const id = await startPiThread(fixture);
    await startPiTurn(fixture, id);
    current(fixture).appendText("shared text");
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) => event.type === "changed" && event.method === "item/agentMessage/delta",
        ),
      ).toBe(true),
    );
    const first = await a.snapshot(id),
      second = await b.snapshot(id);
    expect(JSON.stringify(first.turnsPage)).toContain("shared text");
    expect(second.turnsPage).toEqual(first.turnsPage);
    expect(JSON.stringify(first.turnsPage)).toContain("synthetic");
    expect(first.cursor.epoch).toBe(second.cursor.epoch);
    expect(fixture.adapter.sessions).toHaveLength(1);
    current(fixture).succeedTurn();
  });
  it("includes in-progress reasoning and tool output, not Desktop's partial pending-Turn shape", async () => {
    const { fixture, a } = await setup();
    const id = await startPiThread(fixture);
    await startPiTurn(fixture, id);
    current(fixture).startReasoning("thinking snapshot");
    const command = current(fixture).startCommandExecution("echo streamed");
    current(fixture).appendCommandOutput(command, "tool progress");
    await fixture.collector.waitFor(
      (value) => value.method === "item/commandExecution/outputDelta",
    );
    const snapshot = await a.snapshot(id);
    expect(JSON.stringify(snapshot.turnsPage)).toContain("thinking snapshot");
    expect(snapshot.turnsPage.data[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "commandExecution",
          aggregatedOutput: "tool progress",
          status: "inProgress",
        }),
      ]),
    );
    current(fixture).completeItem(command, { status: "succeeded" });
    await fixture.collector.waitFor(
      (value) =>
        value.method === "item/completed" &&
        (value.params as { item?: { id?: string } })?.item?.id === command,
    );
    expect((await a.snapshot(id)).turnsPage.data[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "commandExecution", status: "completed" }),
      ]),
    );
    current(fixture).succeedTurn();
  });
  it("publishes GUI model changes and native cancellation to every client", async () => {
    const { fixture, a, b, events } = await setup();
    const id = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 77,
      method: "codexhost/thread/model/select",
      params: { threadId: id, model: { id: "fake-model-v1.secondary" } },
    });
    await fixture.collector.waitFor((value) => value.id === 77);
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === "changed" && event.method === "codexhost/thread/configuration/updated",
        ),
      ).toBe(true),
    );
    expect((await a.snapshot(id)).configuration.effectiveModel?.id).toBe("fake-model-v1.secondary");
    const turnId = await startPiTurn(fixture, id);
    current(fixture).completeCancellationOnRequest();
    await b.request("turn/interrupt", { threadId: id, turnId });
    await fixture.collector.waitFor((value) => value.method === "turn/completed");
    expect((await a.snapshot(id)).turnsPage.data[0]?.status).toBe("interrupted");
  });
  it("rejects a competing turn instead of allocating a second execution owner", async () => {
    const { fixture, a, b } = await setup();
    const id = await startPiThread(fixture);
    const results = await Promise.allSettled([
      a.request("turn/start", {
        threadId: id,
        clientUserMessageId: "a",
        input: [{ type: "text", text: "A" }],
      }),
      b.request("turn/start", {
        threadId: id,
        clientUserMessageId: "b",
        input: [{ type: "text", text: "B" }],
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(fixture.adapter.sessions).toHaveLength(1);
    current(fixture).succeedTurn();
  });
  it.each(["web", "gui"])(
    "arbitrates %s approval against another client's simultaneous response",
    async (winner) => {
      const { fixture, a, b, server } = await setup();
      const id = await startPiThread(fixture);
      current(fixture).requestApprovalOnNextTurn("Allow test action?");
      await startPiTurn(fixture, id);
      const message = await fixture.collector.waitFor(
        (value) => value.method === "mcpServer/elicitation/request",
      );
      const snapshot = await a.snapshot(id);
      expect(snapshot.interactions).toHaveLength(1);
      const request = snapshot.interactions[0];
      if (!request) throw new Error("Missing approval request");
      const response = {
        epoch: server.descriptor.epoch,
        threadId: id,
        requestId: request.requestId,
        result: { action: "accept", content: {} },
      };
      await expect(a.respond({ ...response, result: { action: "invalid" } })).rejects.toThrow(
        "unsupported action",
      );
      expect((await a.snapshot(id)).interactions).toHaveLength(1);
      if (winner === "gui") {
        writeRequest(fixture.desktopInput, {
          id: requiredMessageId(message),
          result: response.result,
        });
        await fixture.collector.waitFor((value) => value.method === "serverRequest/resolved");
      }
      await Promise.all([a.respond(response), b.respond(response)]);
      writeRequest(fixture.desktopInput, {
        id: requiredMessageId(message),
        result: response.result,
      });
      await vi.waitFor(() => expect(current(fixture).interactionResponses).toHaveLength(1));
      expect((await b.snapshot(id)).interactions).toHaveLength(0);
      expect(
        await fixture.collector.waitFor((value) => value.method === "serverRequest/resolved"),
      ).toMatchObject({ params: { requestId: message.id, threadId: id } });
      current(fixture).succeedTurn();
    },
  );
  it("restores pending questions on reconnect and validates answers in the owner", async () => {
    const { fixture, a, b, directory, server } = await setup();
    const id = await startPiThread(fixture);
    current(fixture).askQuestionOnNextTurn({
      type: "choice",
      id: "choice",
      prompt: "Choose",
      options: [{ value: "native-a", label: "A" }],
      multiple: false,
      allowOther: false,
      optional: false,
    });
    await startPiTurn(fixture, id);
    await fixture.collector.waitFor((value) => value.method === "item/tool/requestUserInput");
    a.close();
    const late = new HostClientChannel(directory, server.descriptor);
    cleanup.push(() => late.close());
    await late.start();
    const snapshot = await late.snapshot(id);
    expect(snapshot.interactions).toHaveLength(1);
    const request = snapshot.interactions[0];
    if (!request) throw new Error("Missing question request");
    const response = {
      epoch: snapshot.cursor.epoch,
      threadId: id,
      requestId: request.requestId,
      result: { answers: { choice: { answers: ["A"] } } },
    };
    await Promise.all([late.respond(response), b.respond(response)]);
    await vi.waitFor(() => expect(current(fixture).interactionResponses).toHaveLength(1));
    expect(current(fixture).interactionResponses[0]).toMatchObject({
      response: { type: "question", answers: { choice: ["native-a"] } },
    });
    current(fixture).succeedTurn();
  });
  it("deduplicates client message IDs and rejects different text under the same ID", async () => {
    const { fixture, a, b } = await setup();
    const id = await startPiThread(fixture);
    const execute = vi.spyOn(current(fixture), "execute");
    const params = {
      threadId: id,
      clientUserMessageId: "same",
      input: [{ type: "text", text: "one" }],
    };
    const [first, second] = await Promise.all([
      a.request("turn/start", params),
      b.request("turn/start", params),
    ]);
    expect(second).toEqual(first);
    await expect(
      b.request("turn/start", { ...params, input: [{ type: "text", text: "different" }] }),
    ).rejects.toThrow("different input");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.start" }));
    const started = await fixture.collector.waitFor((value) => value.method === "turn/started");
    expect(started).toMatchObject({
      params: {
        turn: { items: [{ type: "userMessage", clientId: "same", content: [{ text: "one" }] }] },
      },
    });
    current(fixture).succeedTurn();
    await fixture.collector.waitFor((value) => value.method === "turn/completed");
    await a.request("thread/turns/list", {
      threadId: id,
      limit: 5,
      itemsView: "full",
      sortDirection: "desc",
    });
    expect((await b.snapshot(id)).turnsPage.data[0]?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "userMessage", clientId: "same" })]),
    );
  });
  it("rediscovers a restarted owner and emits a new epoch/reset without replaying writes", async () => {
    const { fixture, server, directory, a, events } = await setup();
    const oldEpoch = server.descriptor.epoch;
    await server.close();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "connection", online: false }));
    await expect(a.request("turn/start", { threadId: "offline" })).rejects.toThrow("disconnected");
    const nextFixture = createFixture();
    cleanup.push(() => stopFixture(nextFixture));
    await nextFixture.ready;
    const next = await startClientChannelServer({
      target: nextFixture.host,
      environment: {},
      directory,
    });
    cleanup.push(() => next.close());
    await vi.waitFor(
      () =>
        expect(
          events.some(
            (event) => event.type === "hello" && event.reset && event.cursor.epoch !== oldEpoch,
          ),
        ).toBe(true),
      { timeout: 4000 },
    );
    expect((await discoverHostClientChannel(directory))?.epoch).toBe(next.descriptor.epoch);
    expect(nextFixture.adapter.sessions).toHaveLength(0);
    expect(fixture.adapter.sessions).toHaveLength(0);
  });
});

describe("bounded invalidation recovery", () => {
  it("replays a retained cursor, resets gaps, future cursors and previous epochs", () => {
    const hub = new ClientChannelEvents(2);
    hub.changed("a", "item/started");
    const cursor = hub.cursor;
    hub.changed("a", "item/completed");
    const events: ClientChannelEvent[] = [];
    const stop = hub.subscribe((event) => events.push(event), cursor);
    expect(events.map((event) => event.type)).toEqual(["hello", "changed"]);
    expect(events[0]).toMatchObject({ reset: false });
    stop();
    hub.changed("b", "turn/started");
    hub.changed("b", "turn/completed");
    for (const after of [
      cursor,
      { ...hub.cursor, sequence: 99 },
      { ...hub.cursor, epoch: crypto.randomUUID() },
    ]) {
      const reset: ClientChannelEvent[] = [];
      hub.subscribe((event) => reset.push(event), after)();
      expect(reset).toHaveLength(1);
      expect(reset[0]).toMatchObject({ type: "hello", reset: true });
    }
  });
  it("keeps unknown command outcomes and never executes a duplicate", async () => {
    const receipts = new ClientCommandReceipts();
    const submit = vi.fn(async () => ({ error: { code: -32090, message: "outcome unknown" } }));
    expect(await receipts.run("id", { text: "one", mode: "same" }, submit)).toHaveProperty("error");
    await receipts.run("id", { mode: "same", text: "one" }, submit);
    expect(submit).toHaveBeenCalledOnce();
  });
});
