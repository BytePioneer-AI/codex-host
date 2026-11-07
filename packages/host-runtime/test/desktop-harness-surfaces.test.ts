import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { DelegationControlApi } from "../src/delegation-types.js";
import {
  encodeHarnessPluginRoute,
  harnessPluginIdSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFixture,
  JsonLineCollector,
  requiredMessageId,
  writeRequest,
} from "./app-server-host-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fakeModule = pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href;

interface SurfaceAdapters {
  [id: string]: { sessions: Array<{ appendText(text: string): void; succeedTurn(): void }> };
}

function surfaceFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexhost-surfaces-"));
  roots.push(root);
  writeFileSync(
    join(root, "enabled.json"),
    JSON.stringify({ version: 1, enabled: ["web-only", "desktop-agent"] }),
  );
  for (const [id, manifest] of [
    ["web-only", { surfaces: ["web"] }],
    ["desktop-agent", {}],
  ] as const) {
    mkdirSync(join(root, id));
    writeFileSync(
      join(root, id, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id,
        name: `Plugin ${id}`,
        version: "1.0.0",
        adapterApiVersion: 1,
        entry: "index.mjs",
        ...manifest,
      }),
    );
    writeFileSync(
      join(root, id, "index.mjs"),
      `
      import { FakeHarnessAdapter } from ${JSON.stringify(fakeModule)};
      const adapter = new FakeHarnessAdapter(${JSON.stringify(id)});
      globalThis.__codexhostSurfaceAdapters = { ...globalThis.__codexhostSurfaceAdapters,
        ${JSON.stringify(id)}: adapter };
      export function createHarnessAdapter() { return adapter; }
    `,
    );
  }
  let delegationApi: DelegationControlApi | undefined;
  const fixture = createFixture({
    pluginDirectory: root,
    onDelegationApi: (api) => {
      delegationApi = api;
      return undefined;
    },
  });
  return { fixture, delegation: () => delegationApi };
}

/** An official backend that answers list and Thread cwd reads without native Codex. */
function answerOfficial(fixture: ReturnType<typeof createFixture>) {
  const official = new JsonLineCollector(fixture.official.stdin);
  fixture.official.stdin.on("data", () => {
    for (const request of official.messages.splice(0)) {
      const id = requiredMessageId(request);
      writeRequest(
        fixture.official.stdout,
        request.method === "thread/list"
          ? {
              id,
              result: { data: [], nextCursor: null, backwardsCursor: null },
            }
          : { id, result: { thread: { id: "parent-thread", cwd: "/synthetic" } } },
      );
    }
  });
}

function route(harnessId: string): string {
  return encodeHarnessPluginRoute({ harnessId: harnessPluginIdSchema.parse(harnessId) });
}

async function callClient(
  fixture: ReturnType<typeof createFixture>,
  method: string,
  params: JsonObject,
): Promise<JsonObject> {
  const reply = await fixture.host.handleClientRequest(method, params);
  if ("error" in reply) throw new Error(reply.error.message);
  return reply.result as JsonObject;
}

function threadIds(page: JsonObject): string[] {
  return ((page.data as JsonObject[] | undefined) ?? []).map((thread) => String(thread.id));
}

describe("Harness presentation surfaces", () => {
  it("hides a Web-only plugin and its Threads from Desktop while the client channel keeps them", async () => {
    const { fixture } = surfaceFixture();
    try {
      await fixture.ready;
      answerOfficial(fixture);

      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/harness/plugins/list",
        params: {},
      });
      const desktopPlugins = await fixture.collector.waitFor((message) => message.id === 1);
      const desktopIds = ((desktopPlugins.result as JsonObject).plugins as JsonObject[]).map(
        (plugin) => plugin.id,
      );
      expect(desktopIds).toContain("desktop-agent");
      expect(desktopIds).not.toContain("web-only");
      expect(
        (
          (await callClient(fixture, "codexhost/harness/plugins/list", {})).plugins as JsonObject[]
        ).map((plugin) => plugin.id),
      ).toContain("web-only");

      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/start",
        params: { model: route("web-only"), cwd: "/synthetic" },
      });
      expect(await fixture.collector.waitFor((message) => message.id === 2)).toMatchObject({
        error: { code: -32070, message: expect.stringContaining("web-only") },
      });

      const created = await callClient(fixture, "thread/start", {
        model: route("web-only"),
        cwd: "/synthetic",
      });
      const thread = created.thread as JsonObject;
      const threadId = String(thread.id);

      writeRequest(fixture.desktopInput, { id: 3, method: "thread/list", params: {} });
      const desktopList = await fixture.collector.waitFor((message) => message.id === 3);
      expect(threadIds(desktopList.result as JsonObject)).not.toContain(threadId);
      expect(threadIds(await callClient(fixture, "thread/list", {}))).toContain(threadId);

      // A Thread the Desktop must not see never receives its events there either.
      expect(
        fixture.collector.messages.some((message) => JSON.stringify(message).includes(threadId)),
      ).toBe(false);

      const adapters = (globalThis as { __codexhostSurfaceAdapters?: SurfaceAdapters })
        .__codexhostSurfaceAdapters;
      const session = adapters?.["web-only"]?.sessions[0];
      if (!session) throw new Error("Web-only Session was not opened");
      const turn = await callClient(fixture, "turn/start", {
        threadId,
        input: [{ type: "text", text: "hello" }],
      });
      const turnId = String((turn.turn as JsonObject).id);
      session.appendText("answer");
      session.succeedTurn();
      const page = await callClient(fixture, "thread/turns/list", { threadId });
      expect((page.data as JsonObject[]).map((entry) => entry.id)).toContain(turnId);
      expect(
        fixture.collector.messages.some((message) => JSON.stringify(message).includes(threadId)),
      ).toBe(false);

      // A restored Desktop tab or link naming the Thread is answered as a missing Thread.
      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "thread/read",
        params: { threadId, includeTurns: false },
      });
      expect(await fixture.collector.waitFor((message) => message.id === 4)).toMatchObject({
        error: { message: `thread not found: ${threadId}` },
      });
      expect(
        (
          (await callClient(fixture, "thread/read", { threadId, includeTurns: false }))
            .thread as JsonObject
        ).id,
      ).toBe(threadId);
    } finally {
      await fixture.desktopInput.end();
      await fixture.running;
      delete (globalThis as { __codexhostSurfaceAdapters?: SurfaceAdapters })
        .__codexhostSurfaceAdapters;
    }
  });

  it("excludes a Web-only Harness from official delegation but allows an external parent", async () => {
    const { fixture, delegation } = surfaceFixture();
    try {
      await fixture.ready;
      answerOfficial(fixture);
      if (!delegation()) throw new Error("Delegation API was not registered");
      const api = delegation() as DelegationControlApi;

      expect(await api.listHarnesses({ parentThreadId: "parent-thread" })).toEqual({
        harnesses: ["codex", "pi", "desktop-agent"],
      });
      expect(await api.listHarnesses()).toEqual({
        harnesses: ["codex", "pi", "desktop-agent", "web-only"],
      });

      await expect(
        api.inspect({ harnessId: "web-only", parentThreadId: "parent-thread" }),
      ).rejects.toMatchObject({ code: "HARNESS_NOT_FOUND" });
      expect(await api.inspect({ harnessId: "web-only" })).toMatchObject({
        harnessId: "web-only",
      });

      await expect(
        api.start({ harnessId: "web-only", task: "child", parentThreadId: "parent-thread" }),
      ).rejects.toMatchObject({ code: "HARNESS_NOT_FOUND" });

      const parent = await callClient(fixture, "thread/start", {
        model: route("desktop-agent"),
        cwd: "/synthetic",
      });
      const parentId = String((parent.thread as JsonObject).id);
      expect(
        await api.start({ harnessId: "web-only", task: "child", parentThreadId: parentId }),
      ).toMatchObject({ harnessId: "web-only", parentThreadId: parentId });
    } finally {
      await fixture.desktopInput.end();
      await fixture.running;
      delete (globalThis as { __codexhostSurfaceAdapters?: SurfaceAdapters })
        .__codexhostSurfaceAdapters;
    }
  });
});
