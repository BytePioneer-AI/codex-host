import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";
import { CodeBuddyAdapter } from "../../packages/adapters/codebuddy/src/codebuddy-adapter.js";
import { fixture as nativeFixture } from "../../packages/adapters/codebuddy/test/fixtures.js";
import {
  createFixture,
  messageParams,
  method,
  requestId,
  startExternalThread,
  stopFixture,
  turnEvent,
  writeRequest,
} from "../../packages/host-runtime/test/app-server-host-fixture.js";

type Native = ReturnType<typeof nativeFixture>;
type Client = Native["clients"][number];

const codeBuddyModel = encodeHarnessPluginRoute(
  harnessPluginRouteSchema.parse({ harnessId: "codebuddy" }),
);
const text = (value: string) => [{ type: "text", text: value }];

function announce(client: Client, requestIdValue = "live") {
  client.update({
    sessionUpdate: "session_info_update",
    _meta: {
      "codebuddy.ai/unsolicitedTurn": { requestId: requestIdValue, reason: "background_drain" },
      "codebuddy.ai/requestId": requestIdValue,
    },
  });
}

function reply(client: Client, message: string, requestIdValue = "live") {
  client.update({
    sessionUpdate: "agent_message_chunk",
    messageId: `${message}-answer`,
    content: { type: "text", text: message },
    _meta: { "codebuddy.ai/requestId": requestIdValue },
  });
}

function end(client: Client, requestIdValue = "live") {
  client.update({
    sessionUpdate: "session_end",
    stopReason: "end_turn",
    _meta: { "codebuddy.ai/requestId": requestIdValue },
  });
}

async function setup(readHistory?: Native["readHistory"]) {
  const native = nativeFixture();
  const adapter = new CodeBuddyAdapter({
    ...native,
    ...(readHistory ? { readHistory } : {}),
  });
  const host = createFixture({
    additionalAdapters: new Map([["codebuddy", adapter]]),
  });
  const threadId = await startExternalThread(host, codeBuddyModel, 1, { cwd: process.cwd() });
  const client = native.clients[0];
  if (!client) throw new Error("Missing CodeBuddy fixture client");
  let nextId = 10;
  const request = async (methodName: string, params: JsonObject) => {
    const id = nextId++;
    writeRequest(host.desktopInput, { id, method: methodName, params });
    return host.collector.waitFor((message) => requestId(message, id));
  };
  return { native, adapter, host, threadId, client, request };
}

describe("CodeBuddy autonomous Turns through AppServerHost", () => {
  it("projects an idle autonomous Turn without persisting turn identity or disrupting later turns", async () => {
    const { host, threadId, client, request } = await setup();
    try {
      announce(client);
      reply(client, "live answer");
      end(client);

      const completed = await host.collector.waitFor((message) =>
        method(message, "turn/completed"),
      );
      const turn = messageParams(completed).turn as JsonObject;
      expect(turn).toMatchObject({ status: "completed" });
      expect(
        host.collector.messages.some(
          (message) =>
            method(message, "item/completed") &&
            (messageParams(message).item as JsonObject)?.text === "live answer",
        ),
      ).toBe(true);
      expect(
        (await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId)))?.turnMappings,
      ).toEqual([]);

      const started = await request("turn/start", {
        threadId,
        input: text("follow-up"),
      });
      expect(started).not.toHaveProperty("error");
      const foregroundId = ((started.result as JsonObject).turn as JsonObject).id as string;
      await expect(
        host.collector.waitFor((message) => turnEvent(message, "turn/completed", foregroundId)),
      ).resolves.toMatchObject({
        params: { turn: { id: foregroundId, status: "completed" } },
      });
      expect(
        (await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId)))?.turnMappings,
      ).toHaveLength(1);
      expect(host.diagnosticOutput.read()?.toString() ?? "").toBe("");
    } finally {
      await stopFixture(host);
    }
  });

  it.each(["open", "already-ended"] as const)(
    "defers queued foreground advancement across a back-to-back %s autonomous drain and delivers the head once",
    async (drainState) => {
      const native = nativeFixture();
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let reads = 0;
      const adapter = new CodeBuddyAdapter({
        ...native,
        readHistory: async () => {
          const contents = await native.readHistory();
          if (++reads === 2) {
            entered.resolve(undefined);
            await release.promise;
          }
          return contents;
        },
      });
      const host = createFixture({
        additionalAdapters: new Map([["codebuddy", adapter]]),
      });
      try {
        const threadId = await startExternalThread(host, codeBuddyModel, 1, { cwd: process.cwd() });
        const client = native.clients[0];
        if (!client) throw new Error("Missing CodeBuddy fixture client");
        const promptSpy = vi.spyOn(client, "prompt");

        writeRequest(host.desktopInput, {
          id: 2,
          method: "turn/start",
          params: { threadId, input: text("hold") },
        });
        const firstResponse = await host.collector.waitFor((message) => requestId(message, 2));
        const firstTurnId = ((firstResponse.result as JsonObject).turn as JsonObject).id as string;
        await host.collector.waitFor((message) => turnEvent(message, "turn/started", firstTurnId));

        writeRequest(host.desktopInput, {
          id: 3,
          method: "thread/queue/add",
          params: { threadId, input: text("queued follow-up"), clientUserMessageId: "queued-1" },
        });
        const added = await host.collector.waitFor((message) => requestId(message, 3));
        expect(added).not.toHaveProperty("error");

        // Finish the foreground prompt, then announce a drain before the terminal snapshot resolves
        // so the Adapter emits turn.completed and turn.autonomous.started back-to-back.
        client.finishPending();
        await entered.promise;
        announce(client, "drain-1");
        reply(client, "drain answer", "drain-1");
        if (drainState === "already-ended") end(client, "drain-1");
        release.resolve(undefined);

        await expect(
          host.collector.waitFor((message) => turnEvent(message, "turn/completed", firstTurnId)),
        ).resolves.toMatchObject({
          params: { turn: { id: firstTurnId, status: "completed" } },
        });

        const autonomousStarted = await host.collector.waitFor(
          (message) =>
            method(message, "turn/started") &&
            ((messageParams(message).turn as JsonObject).id as string) !== firstTurnId,
        );
        const autonomousTurnId = (messageParams(autonomousStarted).turn as JsonObject).id as string;
        await host.collector.waitFor(
          (message) =>
            method(message, "item/agentMessage/delta") &&
            messageParams(message).turnId === autonomousTurnId,
        );

        if (drainState === "open") {
          // Give any deferred queue start microtasks a turn while the drain is still active.
          await new Promise((resolve) => setTimeout(resolve, 40));
          expect((await host.host.clientSnapshot(threadId)).queue).toMatchObject({
            pausedReason: null,
            items: [{ clientUserMessageId: "queued-1" }],
          });
          expect(
            promptSpy.mock.calls.filter(([, input]) => input === "queued follow-up"),
          ).toHaveLength(0);
          end(client, "drain-1");
        }

        await expect(
          host.collector.waitFor((message) =>
            turnEvent(message, "turn/completed", autonomousTurnId),
          ),
        ).resolves.toMatchObject({
          params: { turn: { id: autonomousTurnId, status: "completed" } },
        });

        const queuedStarted = await host.collector.waitFor(
          (message) =>
            method(message, "turn/started") &&
            ![firstTurnId, autonomousTurnId].includes(
              (messageParams(message).turn as JsonObject).id as string,
            ),
        );
        const queuedTurnId = (messageParams(queuedStarted).turn as JsonObject).id as string;
        await expect(
          host.collector.waitFor((message) => turnEvent(message, "turn/completed", queuedTurnId)),
        ).resolves.toMatchObject({
          params: { turn: { id: queuedTurnId, status: "completed" } },
        });

        expect(
          promptSpy.mock.calls.filter(([, input]) => input === "queued follow-up"),
        ).toHaveLength(1);
        await vi.waitFor(async () =>
          expect((await host.host.clientSnapshot(threadId)).queue).toMatchObject({
            items: [],
            pausedReason: null,
          }),
        );
        expect(
          (await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId)))?.turnMappings,
        ).toHaveLength(2);
        expect(host.diagnosticOutput.read()?.toString() ?? "").toBe("");
      } finally {
        release.resolve(undefined);
        await stopFixture(host);
      }
    },
  );

  it("pauses the queued foreground Turn when an intervening autonomous drain is cancelled", async () => {
    const native = nativeFixture();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let reads = 0;
    const adapter = new CodeBuddyAdapter({
      ...native,
      readHistory: async () => {
        const contents = await native.readHistory();
        if (++reads === 2) {
          entered.resolve(undefined);
          await release.promise;
        }
        return contents;
      },
    });
    const host = createFixture({
      additionalAdapters: new Map([["codebuddy", adapter]]),
    });
    try {
      const threadId = await startExternalThread(host, codeBuddyModel, 1, { cwd: process.cwd() });
      const client = native.clients[0];
      if (!client) throw new Error("Missing CodeBuddy fixture client");
      const promptSpy = vi.spyOn(client, "prompt");

      writeRequest(host.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: text("hold") },
      });
      const firstResponse = await host.collector.waitFor((message) => requestId(message, 2));
      const firstTurnId = ((firstResponse.result as JsonObject).turn as JsonObject).id as string;
      await host.collector.waitFor((message) => turnEvent(message, "turn/started", firstTurnId));

      writeRequest(host.desktopInput, {
        id: 3,
        method: "thread/queue/add",
        params: { threadId, input: text("wait after cancel"), clientUserMessageId: "queued-stop" },
      });
      await host.collector.waitFor((message) => requestId(message, 3));

      client.finishPending();
      await entered.promise;
      announce(client, "drain-cancel");
      release.resolve(undefined);

      await host.collector.waitFor((message) => turnEvent(message, "turn/completed", firstTurnId));
      const autonomousStarted = await host.collector.waitFor(
        (message) =>
          method(message, "turn/started") &&
          ((messageParams(message).turn as JsonObject).id as string) !== firstTurnId,
      );
      const autonomousTurnId = (messageParams(autonomousStarted).turn as JsonObject).id as string;

      writeRequest(host.desktopInput, {
        id: 4,
        method: "turn/interrupt",
        params: { threadId, turnId: autonomousTurnId },
      });
      await expect(
        host.collector.waitFor((message) => requestId(message, 4)),
      ).resolves.not.toHaveProperty("error");

      end(client, "drain-cancel");
      await expect(
        host.collector.waitFor((message) => turnEvent(message, "turn/completed", autonomousTurnId)),
      ).resolves.toMatchObject({
        params: { turn: { id: autonomousTurnId, status: "interrupted" } },
      });

      await vi.waitFor(async () =>
        expect((await host.host.clientSnapshot(threadId)).queue).toMatchObject({
          pausedReason: "interrupted",
          items: [{ clientUserMessageId: "queued-stop" }],
        }),
      );
      expect(
        promptSpy.mock.calls.filter(([, input]) => input === "wait after cancel"),
      ).toHaveLength(0);
    } finally {
      release.resolve(undefined);
      await stopFixture(host);
    }
  });

  it("drains an autonomous Turn that finishes during admission snapshot read without corrupting foreground state", async () => {
    const native = nativeFixture();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let reads = 0;
    const adapter = new CodeBuddyAdapter({
      ...native,
      readHistory: async () => {
        if (++reads === 1) {
          entered.resolve(undefined);
          await release.promise;
        }
        return native.readHistory();
      },
    });
    const host = createFixture({
      additionalAdapters: new Map([["codebuddy", adapter]]),
    });
    try {
      const threadId = await startExternalThread(host, codeBuddyModel, 1, { cwd: process.cwd() });
      const client = native.clients[0];
      if (!client) throw new Error("Missing CodeBuddy fixture client");

      // Direct turn/start enters admission snapshot read; an autonomous drain starts and completes
      // inside that await window. Host must reject with sessionBusy rather than promoting fg over
      // unconsumed autonomous events, then accept the subsequent turn cleanly.
      writeRequest(host.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: text("hold") },
      });
      await entered.promise;
      announce(client, "snapshot-drain");
      reply(client, "drain during snapshot", "snapshot-drain");
      end(client, "snapshot-drain");
      release.resolve(undefined);

      await expect(
        host.collector.waitFor((message) => requestId(message, 2)),
      ).resolves.toMatchObject({ error: { code: -32073 } });

      const autonomousCompleted = await host.collector.waitFor((message) =>
        method(message, "turn/completed"),
      );
      const autonomousTurnId = (messageParams(autonomousCompleted).turn as JsonObject).id as string;
      expect(messageParams(autonomousCompleted).turn).toMatchObject({ status: "completed" });

      writeRequest(host.desktopInput, {
        id: 3,
        method: "turn/start",
        params: { threadId, input: text("hold") },
      });
      const fgResponse = await host.collector.waitFor((message) => requestId(message, 3));
      expect(fgResponse).not.toHaveProperty("error");
      const fgTurnId = ((fgResponse.result as JsonObject).turn as JsonObject).id as string;
      expect(fgTurnId).not.toBe(autonomousTurnId);
      await host.collector.waitFor((message) => turnEvent(message, "turn/started", fgTurnId));

      // Verify Host still tracks fgTurnId as active and turn/interrupt succeeds (no -32074).
      writeRequest(host.desktopInput, {
        id: 4,
        method: "turn/interrupt",
        params: { threadId, turnId: fgTurnId },
      });
      await expect(
        host.collector.waitFor((message) => requestId(message, 4)),
      ).resolves.not.toHaveProperty("error");
      await expect(
        host.collector.waitFor((message) => turnEvent(message, "turn/completed", fgTurnId)),
      ).resolves.toMatchObject({
        params: { turn: { id: fgTurnId, status: "interrupted" } },
      });
      expect(host.diagnosticOutput.read()?.toString() ?? "").toBe("");
    } finally {
      release.resolve(undefined);
      await stopFixture(host);
    }
  });

  it("drains an autonomous Turn that completes during post-cancel reconnection without crashing the foreground Turn", async () => {
    const native = nativeFixture();
    const adapter = new CodeBuddyAdapter({
      ...native,
      clientFactory: (options) => {
        const client = native.clientFactory(options);
        if (native.clients.length === 2) {
          const open = client.open.bind(client);
          client.open = async (cwd, sessionId) => {
            const result = await open(cwd, sessionId);
            announce(client, "resume-drain");
            reply(client, "drain during resume", "resume-drain");
            end(client, "resume-drain");
            return result;
          };
        }
        return client;
      },
    });
    const host = createFixture({
      additionalAdapters: new Map([["codebuddy", adapter]]),
    });
    try {
      const threadId = await startExternalThread(host, codeBuddyModel, 1, { cwd: process.cwd() });
      const firstClient = native.clients[0];
      if (!firstClient) throw new Error("Missing first CodeBuddy fixture client");

      // Cancel a foreground Turn so the next admission triggers #resumeClient().
      writeRequest(host.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: text("hold") },
      });
      const firstResponse = await host.collector.waitFor((message) => requestId(message, 2));
      const firstTurnId = ((firstResponse.result as JsonObject).turn as JsonObject).id as string;
      await host.collector.waitFor((message) => turnEvent(message, "turn/started", firstTurnId));

      writeRequest(host.desktopInput, {
        id: 3,
        method: "turn/interrupt",
        params: { threadId, turnId: firstTurnId },
      });
      await host.collector.waitFor((message) => requestId(message, 3));
      await host.collector.waitFor((message) => turnEvent(message, "turn/completed", firstTurnId));

      // Next admission reconnects and observes a completed drain during #resumeClient().
      writeRequest(host.desktopInput, {
        id: 4,
        method: "turn/start",
        params: { threadId, input: text("after cancel") },
      });
      await expect(
        host.collector.waitFor((message) => requestId(message, 4)),
      ).resolves.toMatchObject({ error: { code: -32073 } });

      const autonomousCompleted = await host.collector.waitFor(
        (message) =>
          method(message, "turn/completed") &&
          ((messageParams(message).turn as JsonObject).id as string) !== firstTurnId,
      );
      expect(messageParams(autonomousCompleted).turn).toMatchObject({ status: "completed" });

      // Follow-up foreground Turn succeeds cleanly on the resumed session.
      writeRequest(host.desktopInput, {
        id: 5,
        method: "turn/start",
        params: { threadId, input: text("after drain") },
      });
      const retryResponse = await host.collector.waitFor((message) => requestId(message, 5));
      expect(retryResponse).not.toHaveProperty("error");
      const retryTurnId = ((retryResponse.result as JsonObject).turn as JsonObject).id as string;
      await expect(
        host.collector.waitFor((message) => turnEvent(message, "turn/completed", retryTurnId)),
      ).resolves.toMatchObject({
        params: { turn: { id: retryTurnId, status: "completed" } },
      });
      expect(host.diagnosticOutput.read()?.toString() ?? "").toBe("");
    } finally {
      await stopFixture(host);
    }
  });
});
