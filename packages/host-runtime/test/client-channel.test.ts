import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  startExternalThread,
  completePiTurn,
  rollbackCapableAdapter,
  startPiTurn,
  stopFixture,
  writeRequest,
  requiredMessageId,
} from "./app-server-host-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(options: Parameters<typeof createFixture>[0] = {}) {
  const fixture = createFixture(options);
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
  it("forwards the GUI's paginated Revert with canonical identities and notifies both clients", async () => {
    const adapter = rollbackCapableAdapter();
    const { fixture, a, b, events } = await setup({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startExternalThread(fixture, "codexhost/pi-native", 1, {
      historyMode: "paginated",
    });
    const first = await completePiTurn(fixture, threadId, 2);
    const last = await completePiTurn(fixture, threadId, 3);
    await expect(a.request("thread/revert", { threadId, beforeTurnId: "stale" })).rejects.toThrow(
      "boundary",
    );
    expect(adapter.sessions).toHaveLength(1);
    await expect(
      a.request("thread/revert", { threadId, beforeTurnId: last }),
    ).resolves.toMatchObject({ thread: { id: threadId, turns: [] } });
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "changed" && event.method === "thread/reverted"),
      ).toBe(true),
    );
    expect((await b.snapshot(threadId)).turnsPage.data.map((turn) => turn.id)).toEqual([first]);
    expect(adapter.sessions).toHaveLength(2);
  });

  it("shares confirmed display order across Desktop, Web and Console without Harness execution", async () => {
    const { fixture, a, b, events } = await setup();
    const get = "codexhost/harness/display-settings/get";
    const set = "codexhost/harness/display-settings/set";
    expect(await a.request("codexhost/harness/display-settings/capabilities", {})).toEqual({
      events: true,
    });
    const first = [{ agent: "pi", section: "more" }];
    writeRequest(fixture.desktopInput, { id: 710, method: set, params: { entries: first } });
    await fixture.collector.waitFor((message) => message.id === 710);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "display-settings-changed")).toBe(true),
    );
    expect(await a.request(get, {})).toEqual({ entries: first });
    expect(await fixture.host.handleConsoleRequest(get, {})).toEqual({
      result: { entries: first },
    });
    const second = [{ agent: "grok", section: "main" }];
    await b.request(set, { entries: second });
    expect(
      await fixture.collector.waitFor(
        (message) => message.method === "codexhost/harness/display-settings/changed",
      ),
    ).toMatchObject({ params: {} });
    expect(await fixture.host.handleConsoleRequest(get, {})).toEqual({
      result: { entries: second },
    });
    await fixture.host.handleConsoleRequest(set, { entries: [] });
    expect(await a.request(get, {})).toEqual({ entries: [] });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "display-settings-changed")).toHaveLength(3),
    );
    const before = events.filter((event) => event.type === "display-settings-changed").length;
    await expect(a.request(set, { entries: [{ agent: "", section: "main" }] })).rejects.toThrow();
    expect(events.filter((event) => event.type === "display-settings-changed")).toHaveLength(
      before,
    );
    expect(await b.request(get, {})).toEqual({ entries: [] });
    expect(
      JSON.parse(
        readFileSync(
          path.join(fixture.mappingStoreDirectory, "harness-display-settings-v1.json"),
          "utf8",
        ),
      ),
    ).toEqual([]);
    expect(fixture.adapter.sessions).toHaveLength(0);
  });
  it("shares durable preferences between Desktop and Web without creating Harness sessions", async () => {
    const { fixture, a, b, events } = await setup();
    const patchMethod = "codexhost/harness/preferences/patch";
    const getMethod = "codexhost/harness/preferences/get";
    writeRequest(fixture.desktopInput, {
      id: 700,
      method: patchMethod,
      params: {
        scope: "external",
        operations: [
          { kind: "idleRelease", value: { enabled: true, timeoutMinutes: 20 } },
          {
            kind: "newThread",
            lastHarness: "pi",
            harnessId: "pi",
            configuration: { model: { id: "native" } },
          },
        ],
      },
    });
    await fixture.collector.waitFor((message) => message.id === 700);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "preferences-changed")).toBe(true),
    );
    expect(await a.request(getMethod, {})).toMatchObject({
      values: {
        idleRelease: { enabled: true, timeoutMinutes: 20 },
        newThread: { lastHarness: "pi" },
      },
    });
    await b.request(patchMethod, {
      operations: [{ kind: "favorite", harnessId: "pi", modelId: "native", enabled: true }],
    });
    writeRequest(fixture.desktopInput, { id: 701, method: getMethod, params: {} });
    expect(await fixture.collector.waitFor((message) => message.id === 701)).toMatchObject({
      result: { values: { favorites: { pi: ["native"] } } },
    });
    expect(
      JSON.parse(
        readFileSync(
          path.join(fixture.mappingStoreDirectory, "harness-preferences-v1.json"),
          "utf8",
        ),
      ).scopes.external.favorites.pi,
    ).toEqual(["native"]);
    await expect(
      a.request(patchMethod, {
        operations: [
          { kind: "newThread", harnessId: "codex", configuration: { model: { id: "gpt" } } },
        ],
      }),
    ).rejects.toThrow();
    expect(fixture.adapter.sessions).toHaveLength(0);
  });
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
  it("serves unchanged completed Turns as placeholders and full tool output on demand over HTTP", async () => {
    const { fixture, a } = await setup();
    const id = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, id);
    const command = current(fixture).startCommandExecution("cat big");
    const output = "line of output\n".repeat(8_000);
    current(fixture).appendCommandOutput(command, output);
    current(fixture).completeItem(command, { status: "succeeded" });
    current(fixture).succeedTurn();
    await fixture.collector.waitFor((value) => value.method === "turn/completed");

    const plain = await a.snapshot(id);
    expect(plain.turnsPage.data[0]?.fingerprint).toBeUndefined();
    expect(
      plain.turnsPage.data
        .find((turn) => turn.id === turnId)
        ?.items.find((item) => item.type === "commandExecution")?.aggregatedOutput,
    ).toBe(output);

    const first = await a.snapshot(id, { knownTurns: [], truncateToolOutput: true });
    const served = first.turnsPage.data.find((turn) => turn.id === turnId);
    expect(served?.fingerprint).toEqual(expect.any(String));
    const shortened = served?.items.find((item) => item.type === "commandExecution");
    expect((shortened?.aggregatedOutput as string).length).toBeLessThan(output.length);
    expect(shortened?.codexhostTruncated).toEqual({
      fields: [{ path: ["aggregatedOutput"], originalLength: output.length }],
    });

    const second = await a.snapshot(id, {
      knownTurns: [{ id: turnId, fingerprint: served?.fingerprint ?? "" }],
      truncateToolOutput: true,
    });
    expect(second.turnsPage.data.find((turn) => turn.id === turnId)).toMatchObject({
      unchanged: true,
      items: [],
    });
    // Without truncation the served form differs, so the same fingerprint cannot match.
    const untruncated = await a.snapshot(id, {
      knownTurns: [{ id: turnId, fingerprint: served?.fingerprint ?? "" }],
    });
    expect(
      untruncated.turnsPage.data.find((turn) => turn.id === turnId)?.unchanged,
    ).toBeUndefined();

    const full = await a.request<{
      data: Array<{ item: { id: string; aggregatedOutput?: string } }>;
    }>("thread/items/list", { threadId: id, turnId });
    expect(full.data.find((entry) => entry.item.id === shortened?.id)?.item.aggregatedOutput).toBe(
      output,
    );
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
  it("publishes GUI queue deletion and removes it from both client snapshots", async () => {
    const { fixture, a, b, events } = await setup();
    const id = await startPiThread(fixture);
    await startPiTurn(fixture, id);
    writeRequest(fixture.desktopInput, {
      id: 801,
      method: "thread/queue/add",
      params: {
        threadId: id,
        clientUserMessageId: "gui-queued-message",
        input: [{ type: "text", text: "delete before execution" }],
      },
    });
    await fixture.collector.waitFor((value) => value.id === 801);
    const before = await a.snapshot(id);
    const queued = before.queue?.items[0];
    expect(queued).toBeDefined();
    if (!queued) throw new Error("GUI message did not enter the shared queue");
    expect((await b.snapshot(id)).queue?.items).toEqual(before.queue?.items);
    writeRequest(fixture.desktopInput, {
      id: 802,
      method: "thread/queue/delete",
      params: { threadId: id, queuedSubmissionId: queued.id },
    });
    expect(await fixture.collector.waitFor((value) => value.id === 802)).toMatchObject({
      result: { deleted: true },
    });
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === "changed" &&
            event.threadId === id &&
            event.method === "codexhost/thread/queue/updated" &&
            event.cursor.sequence > before.cursor.sequence,
        ),
      ).toBe(true),
    );
    expect((await a.snapshot(id)).queue?.items).toEqual([]);
    expect((await b.snapshot(id)).queue?.items).toEqual([]);
    current(fixture).succeedTurn();
  });
  it("broadcasts Web dequeue and requeue to the GUI without executing the removed text", async () => {
    const { fixture, a, b } = await setup();
    const id = await startPiThread(fixture);
    await startPiTurn(fixture, id);
    writeRequest(fixture.desktopInput, {
      id: 811,
      method: "thread/queue/add",
      params: { threadId: id, input: [{ type: "text", text: "old queued text" }] },
    });
    await fixture.collector.waitFor((value) => value.id === 811);
    const item = (await a.snapshot(id)).queue?.items[0];
    if (!item) throw new Error("Missing queued message");
    const before = fixture.collector.messages.length;
    expect(
      await a.request("thread/queue/delete", { threadId: id, queuedSubmissionId: item.id }),
    ).toEqual({ deleted: true });
    await vi.waitFor(() =>
      expect(
        fixture.collector.messages
          .slice(before)
          .some((value) => value.method === "thread/queue/changed"),
      ).toBe(true),
    );
    writeRequest(fixture.desktopInput, {
      id: 812,
      method: "thread/queue/list",
      params: { threadId: id },
    });
    expect(await fixture.collector.waitFor((value) => value.id === 812)).toMatchObject({
      result: { data: [] },
    });
    expect((await b.snapshot(id)).queue?.items).toEqual([]);
    await a.request("turn/start", {
      threadId: id,
      delivery: "queue",
      clientUserMessageId: "edited-submission",
      input: [{ type: "text", text: "new queued text" }],
    });
    writeRequest(fixture.desktopInput, {
      id: 813,
      method: "thread/queue/list",
      params: { threadId: id },
    });
    const reply = await fixture.collector.waitFor((value) => value.id === 813);
    expect(reply).toMatchObject({
      result: {
        data: [
          expect.objectContaining({
            clientUserMessageId: "edited-submission",
            input: [{ type: "text", text: "new queued text", text_elements: [] }],
          }),
        ],
      },
    });
    const items = (await b.snapshot(id)).queue?.items;
    expect(items).toHaveLength(1);
    expect(items?.[0]?.id).not.toBe(item.id);
    const execute = vi.spyOn(current(fixture), "execute");
    current(fixture).succeedTurn();
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "turn.start",
          input: [{ type: "text", text: "new queued text" }],
        }),
      ),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    current(fixture).succeedTurn();
  });
  it("projects native queue text arrays without discarding annotations or image inputs", async () => {
    const { fixture, a } = await setup();
    const threadId = await startPiThread(fixture);
    const annotation = { byteRange: { start: 0, end: 4 }, placeholder: "native-context" };
    const input = [
      { type: "text", text: "plain" },
      { type: "text", text: "test", text_elements: [annotation] },
      { type: "localImage", path: "/synthetic/image.png" },
    ];
    const result = await a.request<{ queuedSubmission: { id: string; input: unknown[] } }>(
      "thread/queue/add",
      { threadId, input },
    );
    const expected = [{ type: "text", text: "plain", text_elements: [] }, input[1], input[2]];
    expect(result.queuedSubmission.input).toEqual(expected);
    writeRequest(fixture.desktopInput, {
      id: 814,
      method: "thread/queue/list",
      params: { threadId },
    });
    expect(await fixture.collector.waitFor((value) => value.id === 814)).toMatchObject({
      result: { data: [{ input: expected }] },
    });
    await a.request("thread/queue/delete", {
      threadId,
      queuedSubmissionId: result.queuedSubmission.id,
    });
  });
  it("queues a busy Web follow-up and starts it after the active Turn", async () => {
    const { fixture, a } = await setup();
    const id = await startPiThread(fixture);
    await startPiTurn(fixture, id);
    await expect(
      a.request("turn/start", {
        threadId: id,
        delivery: "queue",
        clientUserMessageId: "queued-web-message",
        input: [{ type: "text", text: "next from Web" }],
      }),
    ).resolves.toMatchObject({ queued: true });
    expect((await a.snapshot(id)).queue?.items).toEqual([
      expect.objectContaining({ clientUserMessageId: "queued-web-message" }),
    ]);
    current(fixture).succeedTurn();
    await fixture.collector.waitFor(
      (value) =>
        value.method === "turn/started" && JSON.stringify(value).includes("queued-web-message"),
    );
    expect((await a.snapshot(id)).queue?.items).toEqual([]);
    current(fixture).succeedTurn();
  });
  it("keeps a late Web Steer as a queued follow-up after the busy window closes", async () => {
    const { fixture, a } = await setup();
    const id = await startPiThread(fixture);
    const completedTurnId = await startPiTurn(fixture, id);
    current(fixture).succeedTurn();
    await fixture.collector.waitFor(
      (value) =>
        value.method === "turn/completed" && JSON.stringify(value).includes(completedTurnId),
    );
    await expect(
      a.request("turn/steer", {
        threadId: id,
        expectedTurnId: completedTurnId,
        clientUserMessageId: "late-web-steer",
        input: [{ type: "text", text: "preserve this follow-up" }],
      }),
    ).resolves.toHaveProperty("turn");
    await fixture.collector.waitFor(
      (value) =>
        value.method === "turn/started" && JSON.stringify(value).includes("late-web-steer"),
    );
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
  it("shares multi-select questions with Web and settles them through the shared owner", async () => {
    const { fixture, a, b } = await setup();
    const id = await startPiThread(fixture);
    current(fixture).askQuestionOnNextTurn({
      type: "choice",
      id: "choice",
      prompt: "Choose several",
      options: [
        { value: "native-a", label: "A" },
        { value: "native-b", label: "B" },
      ],
      multiple: true,
      allowOther: false,
      optional: false,
    });
    await startPiTurn(fixture, id);
    await vi.waitFor(async () => expect((await a.snapshot(id)).interactions).toHaveLength(1));
    const snapshot = await a.snapshot(id);
    const request = snapshot.interactions[0];
    if (!request) throw new Error("Missing multi-select question");
    expect(
      fixture.collector.messages.some((message) => message.method === "item/tool/requestUserInput"),
    ).toBe(false);
    await a.respond({
      epoch: snapshot.cursor.epoch,
      threadId: id,
      requestId: request.requestId,
      result: { answers: { choice: { answers: ["A", "B"] } } },
    });
    expect(current(fixture).interactionResponses).toHaveLength(1);
    expect(current(fixture).interactionResponses[0]).toMatchObject({
      response: { type: "question", answers: { choice: ["native-a", "native-b"] } },
    });
    expect((await b.snapshot(id)).interactions).toHaveLength(0);
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
