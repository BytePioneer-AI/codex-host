import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, type JsonObject } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  createFixture,
  readJsonLine,
  requestId,
  requiredMessageId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

async function initialize(fixture: Fixture): Promise<void> {
  await fixture.ready;
  writeRequest(fixture.desktopInput, {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "passthrough-test", version: "1" },
      capabilities: { experimentalApi: true },
    },
  });
  const initializeRequest = await readJsonLine(fixture.official.stdin);
  writeRequest(fixture.official.stdout, {
    id: requiredMessageId(initializeRequest),
    result: { userAgent: "official" },
  });
  await fixture.collector.waitFor((message) => requestId(message, 1));
  expect(await readJsonLine(fixture.official.stdin)).toMatchObject({ method: "initialized" });
}

/** Native Codex owns any request without a codexhost marker or External Thread ID. */
async function expectForwardedUnchanged(fixture: Fixture, request: JsonObject): Promise<void> {
  writeRequest(fixture.desktopInput, request);
  const forwarded = await readJsonLine(fixture.official.stdin);
  const { id } = request;
  expect({ ...forwarded, id }).toEqual(request);
  const result = { official: true };
  writeRequest(fixture.official.stdout, { id: requiredMessageId(forwarded), result });
  expect(await fixture.collector.waitFor((message) => requestId(message, id as number))).toEqual({
    id,
    result,
  });
}

describe("official Codex passthrough", () => {
  it.each<JsonObject>([
    { method: "thread/start", params: { ephemeral: true, threadSource: "mcp_extension_host" } },
    { method: "thread/start", params: { model: null } },
    { method: "thread/start", params: { model: { id: "future-official-model" } } },
    { method: "thread/start" },
    { method: "thread/list", params: { sortKey: "future_sort_key" } },
    { method: "thread/list", params: { sourceKinds: ["futureSourceKind"] } },
    { method: "thread/list", params: { limit: "future-limit-shape" } },
    { method: "thread/archive", params: { thread: { id: "future-nested-id" } } },
    { method: "thread/unarchive" },
    {
      method: "thread/metadata/update",
      params: { threadId: "official-thread", gitInfo: { branch: { name: "future" } } },
    },
    { method: "thread/section/move", params: { threadId: "official-thread", sectionId: 7 } },
    { method: "turn/start" },
    { method: "turn/interrupt", params: "future-params-shape" },
    { method: "thread/read" },
    { method: "future/method", params: { anything: [1, "two"] } },
  ])("forwards an unrecognized native shape unchanged: $method", async (request) => {
    const fixture = createFixture();
    try {
      await initialize(fixture);
      await expectForwardedUnchanged(fixture, { id: 2, ...request });
      expect(fixture.adapter.sessions).toHaveLength(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("still rejects a malformed codexhost transport Model", async () => {
    const fixture = createFixture();
    try {
      await initialize(fixture);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/start",
        params: { model: "codexhost/pi-native@", cwd: "/synthetic" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        id: 2,
        error: { code: -32602 },
      });
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("still rejects a malformed codexhost thread/list cursor", async () => {
    const fixture = createFixture();
    try {
      await initialize(fixture);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/list",
        params: { cursor: "codexhost:thread-list:v1:not-a-cursor" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        id: 2,
        error: { code: -32602 },
      });
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("validates management parameters once an External Thread owns them", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startExternalThread(fixture, "codexhost/pi-native", 3);
      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "thread/metadata/update",
        params: { threadId, gitInfo: "invalid" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 4))).toMatchObject({
        id: 4,
        error: { code: -32602 },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects an undecodable section move anchored before an External Thread", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startExternalThread(fixture, "codexhost/pi-native", 3);
      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "thread/section/move",
        params: { threadId: "official-thread", sectionId: 7, beforeThreadId: threadId },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 4))).toMatchObject({
        id: 4,
        error: { code: -32602 },
      });
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("answers a request whose handler fails instead of leaving Desktop waiting", async () => {
    const fixture = createFixture({
      onCreateRequestRoute: () => {
        throw new Error("synthetic handler failure");
      },
    });
    try {
      await initialize(fixture);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/start",
        params: { model: "official/model" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        id: 2,
        error: { code: -32603 },
      });
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("answers a detached Host request whose work fails after the handler returned", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    Object.defineProperty(adapter, "inspectAccount", {
      get() {
        throw new Error("synthetic detached failure");
      },
    });
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/harness/accounts/sources",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        id: 2,
        error: { code: -32603 },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
