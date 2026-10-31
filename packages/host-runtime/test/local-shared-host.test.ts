import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { HostClientChannel } from "@codexhost/desktop-control";
import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import { AppServerHost } from "../src/app-server-host.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { connectLocalSharedHost } from "../src/local-shared-host.js";
import { startClientChannelServer } from "../src/client-channel-server.js";
import { readNativeWorkspaceSnapshot } from "../src/native-workspace-snapshot.js";
import {
  createFixture,
  JsonLineCollector,
  writeRequest,
  stopFixture,
} from "./app-server-host-fixture.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "local-shared-owner-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new MappingStore({ directory: path.join(root, "mapping-store") });
  await store.initialize();
  const owner = new SharedThreadOwner();
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const host = new AppServerHost({
    stockCodexPath: "/unused",
    arguments: [],
    externalOnly: true,
    desktopInput: owner.input,
    desktopOutput: owner.output,
    diagnosticOutput: new PassThrough(),
    mappingStore: store,
    externalAdapters: new Map([["pi", adapter]]),
  });
  const running = host.run();
  cleanup.push(async () => {
    host.close();
    owner.close();
    await running;
    owner.output.end();
  });
  const server = await startClientChannelServer({
    target: host,
    environment: { CODEXHOST_DATA_DIR: root },
    owner: "service",
    desktopSession: (streams) => owner.createSession(streams),
  });
  cleanup.push(() => server.close());
  const web = new HostClientChannel(path.join(root, "client-hosts"), server.descriptor);
  cleanup.push(() => web.close());
  await web.start();
  function gui() {
    const bridge = new SharedThreadBridge({
      connect: () =>
        connectLocalSharedHost({ launcher: "/unused", runtime: "/unused", dataDirectory: root }),
      delegateCreates: true,
      diagnose: () => undefined,
    });
    const viewer = createFixture({
      sharedThreads: bridge,
      mappingStore: store,
      closeMappingStoreOnExit: false,
      externalAdapters: new Map(),
    });
    const official = new JsonLineCollector(viewer.official.stdin);
    viewer.official.stdin.on("data", () => {
      for (const request of official.messages.splice(0))
        viewer.official.stdout.write(
          JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } }) + "\n",
        );
    });
    cleanup.push(() => stopFixture(viewer));
    return { viewer, bridge };
  }
  return { root, owner, adapter, host, server, web, store, gui };
}

it.each(["Web", "Desktop"])(
  "%s may join first; viewers share one execution and one writable store",
  async (first) => {
    const { web, store, adapter, gui, server } = await setup();
    const { viewer, bridge } = gui();
    await viewer.ready;
    await bridge.list({});
    const model = encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("pi") });
    let threadId: string;
    if (first === "Web") {
      const result = await web.request<{ thread: { id: string } }>("thread/start", {
        model,
        cwd: "/synthetic",
      });
      threadId = result.thread.id;
    } else {
      writeRequest(viewer.desktopInput, {
        id: 30,
        method: "thread/start",
        params: { model, cwd: "/synthetic" },
      });
      const reply = await viewer.collector.waitFor((message) => message.id === 30);
      expect(reply.error).toBeUndefined();
      threadId = ((reply.result as JsonObject).thread as JsonObject).id as string;
    }
    await web.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "shared input" }],
      clientUserMessageId: "one-input",
    });
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0];
    if (!session) throw new Error("Missing canonical Session");
    session.appendText("still running");
    await viewer.collector.waitFor((message) => message.method === "item/agentMessage/delta");
    expect(await viewer.mappingStore.listThreads()).toEqual(await store.listThreads());
    expect(viewer.mappingStore).toBe(store);
    await expect(web.request("codexhost/private/store", {})).rejects.toThrow("not available");
    // Closing Desktop does not close the canonical Session or terminate its Turn.
    viewer.host.close();
    await viewer.running;
    web.close();
    session.appendText(" after both viewers closed");
    session.succeedTurn();
    const reconnect = new HostClientChannel(path.dirname(server.descriptorPath), server.descriptor);
    cleanup.push(() => reconnect.close());
    await reconnect.start();
    await vi.waitFor(async () =>
      expect(JSON.stringify((await reconnect.snapshot(threadId)).turnsPage)).toContain(
        "after both viewers closed",
      ),
    );
    expect(adapter.sessions).toHaveLength(1);
    expect(await store.listThreads()).toHaveLength(1);
  },
);

it("reads projects and pins with no Desktop and never rewrites native metadata", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-snapshot-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const environment = { CODEX_HOME: root };
  expect(await readNativeWorkspaceSnapshot(environment)).toEqual({
    projects: [],
    assignments: {},
    projectless: [],
    pinned: [],
  });
  mkdirSync(root, { recursive: true });
  const file = path.join(root, ".codex-global-state.json");
  const text = JSON.stringify({
    "project-order": ["selected"],
    "local-projects": {
      a: { id: "selected", name: "Project", rootPaths: ["/real/project"] },
      b: { id: "hidden", name: "Hidden", rootPaths: ["/other"] },
    },
    "thread-project-assignments": {
      thread: { projectKind: "local", projectId: "selected" },
      remote: { projectKind: "remote", projectId: "remote" },
    },
    "projectless-thread-ids": ["unselected"],
    "pinned-thread-ids": ["thread"],
    privateData: "must not be projected",
  });
  writeFileSync(file, text);
  expect(await readNativeWorkspaceSnapshot(environment)).toEqual({
    projects: [{ id: "selected", name: "Project", rootPaths: ["/real/project"] }],
    assignments: { thread: "selected" },
    projectless: ["unselected"],
    pinned: ["thread"],
  });
  expect(readFileSync(file, "utf8")).toBe(text);
  for (const invalid of ["{bad", "[]", "null", '"wrong"', '{"project-order":[123]}']) {
    writeFileSync(file, invalid);
    await expect(readNativeWorkspaceSnapshot(environment)).rejects.toThrow();
  }
});
