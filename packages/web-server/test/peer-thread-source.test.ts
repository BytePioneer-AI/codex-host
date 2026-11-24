import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import type { HostClientUpdate } from "@codexhost/desktop-control";
import { PeerChHostClient, type PeerChTransport } from "../src/peer-ch-host-client.ts";
import { PeerThreadSource, resolvePeerHarnessIcon } from "../src/peer-thread-source.ts";
import { RpcError } from "../src/transport.ts";

function makeRow(id: string, modelProvider = "codexhost") {
  return {
    id,
    cwd: "/remote/project",
    modelProvider,
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    turns: [],
  };
}

function makeFakeTransport(
  handler: (route: "rpc" | "snapshot" | "respond", body: Record<string, unknown>) => unknown,
  manifestEpoch?: string,
) {
  const listeners = new Set<(update: HostClientUpdate) => void>();
  const transport: PeerChTransport = {
    async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
      return (await handler(route, body as Record<string, unknown>)) as T;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    manifest: () =>
      manifestEpoch === undefined
        ? undefined
        : {
            version: "0.26.0",
            epoch: manifestEpoch,
            platform: "darwin",
            hostname: "peer-host",
            homeDir: "/Users/peer",
            projects: [],
          },
  };
  return {
    transport,
    emit(update: HostClientUpdate) {
      for (const listener of [...listeners]) listener(update);
    },
  };
}

it("paginates catalog/read, supplements tree ancestors, and enforces cursor progress and 100-page cap", async (t) => {
  const { transport } = makeFakeTransport((_route, body) => {
    const method = body.method;
    const params = (body.params ?? {}) as Record<string, unknown>;
    if (method === "codexhost/thread/tree/read") {
      return { parents: { child: "ancestor" } };
    }
    if (method === "codexhost/thread/catalog/read") {
      const live = (params.officialCursor as { live?: string | null } | undefined)?.live;
      if (live === undefined) {
        return {
          threads: [makeRow("child", "codexhost")],
          ownership: [{ threadId: "child", owner: "external", harnessId: "claude-code" }],
          officialCursor: { live: "cursor-2" },
          archivedThreadIds: ["old-archived"],
        };
      }
      return {
        threads: [makeRow("codex-1", "openai"), makeRow("child", "openai")],
        ownership: [
          { threadId: "codex-1", owner: "codex" },
          { threadId: "child", owner: "codex" },
        ],
        officialCursor: { live: null },
        archivedThreadIds: [],
      };
    }
    if (method === "thread/read" && params.threadId === "ancestor") {
      return { thread: makeRow("ancestor", "codexhost") };
    }
    if (method === "codexhost/thread/ownership/list") {
      return {
        threads: [{ threadId: "ancestor", owner: "external", harnessId: "claude-code" }],
      };
    }
    throw new Error(`Unexpected method: ${String(method)}`);
  });

  const source = new PeerThreadSource({
    hostId: "remote-peer:p1",
    host: new PeerChHostClient(transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  const listed = await source.listThreads();
  assert.equal(listed.ownershipAvailable, true);
  assert.deepEqual(listed.rows.map((r) => r.id).sort(), ["ancestor", "child", "codex-1"]);
  assert.equal(listed.harnessIds.get("child"), "claude-code");
  assert.equal(listed.harnessIds.get("ancestor"), "claude-code");
  assert.equal(listed.harnessIds.get("codex-1"), "codex");
  assert.deepEqual(listed.parents, { child: "ancestor" });
  assert.equal(listed.archivedIds.has("old-archived"), true);

  // Stalled cursor throws remote/read-failed.
  const stalled = new PeerThreadSource({
    hostId: "remote-peer:stalled",
    host: new PeerChHostClient(
      makeFakeTransport((_r, body) => {
        if (body.method === "codexhost/thread/tree/read") return { parents: {} };
        return {
          threads: [makeRow("t1")],
          ownership: [{ threadId: "t1", owner: "codex" }],
          officialCursor: { live: "same-cursor" },
          archivedThreadIds: [],
        };
      }).transport,
    ),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => stalled.close());
  await assert.rejects(stalled.listThreads(), { code: "remote/read-failed" });

  // Exceeding 100 pages throws remote/read-failed.
  let pageCount = 0;
  const unbounded = new PeerThreadSource({
    hostId: "remote-peer:unbounded",
    host: new PeerChHostClient(
      makeFakeTransport((_r, body) => {
        if (body.method === "codexhost/thread/tree/read") return { parents: {} };
        pageCount++;
        return {
          threads: [makeRow(`t-${pageCount}`)],
          ownership: [{ threadId: `t-${pageCount}`, owner: "codex" }],
          officialCursor: { live: `cursor-${pageCount}` },
          archivedThreadIds: [],
        };
      }).transport,
    ),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => unbounded.close());
  await assert.rejects(unbounded.listThreads(), { code: "remote/read-failed" });
  assert.equal(pageCount, 100);
});

it("falls back to thread/list on -32601 and degrades gracefully when tree/read fails", async (t) => {
  // 1. Legacy peer without catalog/read (-32601) falls back to thread/list with ownershipAvailable=false.
  const legacyTransport = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/thread/catalog/read") {
      throw new RpcError("remote/request-failed", "Method not found", { hostCode: -32601 });
    }
    if (body.method === "codexhost/thread/tree/read") {
      throw new RpcError("remote/request-failed", "Method not found", { hostCode: -32601 });
    }
    if (body.method === "thread/list") {
      const cursor = (body.params as { cursor?: string | null }).cursor;
      if (cursor === null) {
        return { data: [makeRow("legacy-1", "openai")], nextCursor: "p2" };
      }
      return { data: [makeRow("legacy-2", "codexhost")], nextCursor: null };
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  }).transport;

  const legacySource = new PeerThreadSource({
    hostId: "remote-peer:legacy",
    host: new PeerChHostClient(legacyTransport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => legacySource.close());

  const legacyResult = await legacySource.listThreads();
  assert.equal(legacyResult.ownershipAvailable, false);
  assert.deepEqual(
    legacyResult.rows.map((r) => r.id),
    ["legacy-1", "legacy-2"],
  );
  assert.deepEqual(legacyResult.parents, {});

  // 2. Peer with catalog/read but failing tree/read returns ownershipAvailable=true and parents={}.
  const noTreeTransport = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/thread/tree/read") {
      throw new RpcError("remote/request-failed", "Tree unavailable");
    }
    if (body.method === "codexhost/thread/catalog/read") {
      return {
        threads: [makeRow("t-1", "codexhost")],
        ownership: [{ threadId: "t-1", owner: "external", harnessId: "pi" }],
        officialCursor: { live: null },
        archivedThreadIds: [],
      };
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  }).transport;

  const noTreeSource = new PeerThreadSource({
    hostId: "remote-peer:notree",
    host: new PeerChHostClient(noTreeTransport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => noTreeSource.close());

  const noTreeResult = await noTreeSource.listThreads();
  assert.equal(noTreeResult.ownershipAvailable, true);
  assert.equal(noTreeResult.harnessIds.get("t-1"), "pi");
  assert.deepEqual(noTreeResult.parents, {});
});

it("caches catalog per peer, invalidates on hello, and resolves peer icons without touching local catalog", async (t) => {
  const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString(
    "base64",
  );
  let pluginListCalls = 0;
  const fake = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/harness/plugins/list") {
      pluginListCalls++;
      return {
        plugins: [
          {
            id: "remote-only-agent",
            name: "Remote Only",
            version: "1.0.0",
            icon: `data:image/svg+xml;base64,${svgBase64}`,
            iconStyle: { background: "#112233", borderRadius: 8 },
          },
        ],
      };
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  });

  const source = new PeerThreadSource({
    hostId: "remote-peer:peer-a",
    host: new PeerChHostClient(fake.transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  let state: "connected" | "offline" = "connected";
  const peers = {
    client: (hostId: string) => (hostId === "remote-peer:peer-a" ? { state } : undefined),
    source: (hostId: string) => (hostId === "remote-peer:peer-a" ? source : undefined),
  };

  // First icon + presentation requests hit plugins/list once and reuse cache.
  const icon = await resolvePeerHarnessIcon(peers, "/harness-icons/peer/peer-a/remote-only-agent");
  assert.ok(icon);
  assert.equal(icon.contentType, "image/svg+xml");
  assert.equal(icon.body.toString("utf8"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  const presentation = await resolvePeerHarnessIcon(
    peers,
    "/harness-icons/peer/peer-a/presentation.json",
  );
  assert.ok(presentation);
  assert.equal(presentation.contentType, "application/json");
  assert.deepEqual(JSON.parse(presentation.body.toString("utf8")), {
    "remote-only-agent": { background: "#112233", borderRadius: 8 },
  });
  assert.equal(pluginListCalls, 1);

  // Hello event invalidates the Peer catalog cache.
  fake.emit({
    type: "hello",
    version: 1,
    cursor: { epoch: randomUUID(), sequence: 1 },
    reset: true,
  });
  await source.catalog.list();
  assert.equal(pluginListCalls, 2);

  // Unknown peer, missing icon, codex, malformed URL, and offline peer all return undefined (404).
  assert.equal(
    await resolvePeerHarnessIcon(peers, "/harness-icons/peer/unknown/remote-only-agent"),
    undefined,
  );
  assert.equal(
    await resolvePeerHarnessIcon(peers, "/harness-icons/peer/peer-a/missing"),
    undefined,
  );
  assert.equal(await resolvePeerHarnessIcon(peers, "/harness-icons/peer/peer-a/codex"), undefined);
  assert.equal(
    await resolvePeerHarnessIcon(peers, "/harness-icons/peer/peer-a/%E0%A4%A"),
    undefined,
  );
  state = "offline";
  assert.equal(
    await resolvePeerHarnessIcon(peers, "/harness-icons/peer/peer-a/remote-only-agent"),
    undefined,
  );
  assert.equal(
    await resolvePeerHarnessIcon(peers, "/harness-icons/peer/peer-a/presentation.json"),
    undefined,
  );
});

it("preserves prewarmed catalog across initial same-epoch hello, waits for newly added plugin icons during refresh, marks stale presentation, and emits per-page onPage before tree finishes", async (t) => {
  const epoch = randomUUID();
  const newIconSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>',
  ).toString("base64");
  let pluginListCalls = 0;
  let releaseSecondPluginList: (() => void) | undefined;
  let releaseTree: (() => void) | undefined;

  const fake = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/harness/plugins/list") {
      pluginListCalls++;
      if (pluginListCalls === 1) {
        return {
          plugins: [
            {
              id: "antigravity",
              name: "Antigravity",
              version: "1.0.0",
              iconStyle: { background: "#000000", borderRadius: 6 },
            },
          ],
        };
      }
      return new Promise((resolve) => {
        releaseSecondPluginList = () =>
          resolve({
            plugins: [
              {
                id: "antigravity",
                name: "Antigravity v2",
                version: "2.0.0",
                iconStyle: { background: "#ffffff", borderRadius: 12 },
              },
              {
                id: "new-plugin-b",
                name: "New Plugin B",
                version: "1.0.0",
                icon: `data:image/svg+xml;base64,${newIconSvg}`,
              },
            ],
          });
      });
    }
    if (body.method === "codexhost/thread/catalog/read") {
      const live = (body.params as { officialCursor?: { live?: string | null } } | undefined)
        ?.officialCursor?.live;
      if (live === undefined) {
        return {
          threads: [makeRow("page-1-ext", "codexhost")],
          ownership: [{ threadId: "page-1-ext", owner: "external", harnessId: "antigravity" }],
          officialCursor: { live: "cursor-2" },
          archivedThreadIds: [],
        };
      }
      return {
        threads: [makeRow("page-2-codex", "openai")],
        ownership: [{ threadId: "page-2-codex", owner: "codex" }],
        officialCursor: { live: null },
        archivedThreadIds: [],
      };
    }
    if (body.method === "codexhost/thread/tree/read") {
      return new Promise((resolve) => {
        releaseTree = () => resolve({ parents: {} });
      });
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  }, epoch);

  const source = new PeerThreadSource({
    hostId: "remote-peer:peer-b",
    host: new PeerChHostClient(fake.transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  const peers = {
    client: () => ({ state: "connected" }),
    source: () => source,
  };

  // Prewarm catalog with manifest epoch, then receive initial hello for the same epoch.
  await source.catalog.list();
  assert.equal(pluginListCalls, 1);
  fake.emit({
    type: "hello",
    version: 1,
    cursor: { epoch, sequence: 1 },
    reset: true,
  });
  await source.catalog.list();
  assert.equal(pluginListCalls, 1, "initial same-epoch hello must not wipe prewarmed catalog");

  // A new epoch invalidates: presentation.json serves cached data marked stale=true immediately
  // while kicking off background refresh, whereas an uncached newly added plugin waits for refresh.
  fake.emit({
    type: "hello",
    version: 1,
    cursor: { epoch: randomUUID(), sequence: 1 },
    reset: true,
  });
  const stalePres = await resolvePeerHarnessIcon(
    peers,
    "/harness-icons/peer/peer-b/presentation.json",
  );
  assert.ok(stalePres);
  assert.equal(stalePres.stale, true);
  assert.deepEqual(JSON.parse(stalePres.body.toString("utf8")), {
    antigravity: { background: "#000000", borderRadius: 6 },
  });
  assert.equal(pluginListCalls, 2, "stale-while-revalidate must kick off background refresh");

  let newIconSettled = false;
  const newIconPromise = resolvePeerHarnessIcon(
    peers,
    "/harness-icons/peer/peer-b/new-plugin-b",
  ).then((asset) => {
    newIconSettled = true;
    return asset;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(newIconSettled, false, "uncached new plugin icon must wait for in-flight refresh");

  releaseSecondPluginList?.();
  const newIcon = await newIconPromise;
  assert.ok(newIcon);
  assert.equal(newIcon.contentType, "image/svg+xml");
  assert.equal(
    newIcon.body.toString("utf8"),
    '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>',
  );

  const freshPres = await resolvePeerHarnessIcon(
    peers,
    "/harness-icons/peer/peer-b/presentation.json",
  );
  assert.ok(freshPres);
  assert.equal(freshPres.stale, undefined);
  assert.deepEqual(JSON.parse(freshPres.body.toString("utf8")), {
    antigravity: { background: "#ffffff", borderRadius: 12 },
    "new-plugin-b": null,
  });

  // Multi-page listThreads must emit each page's own rows incrementally before tree/read finishes.
  const pageSnapshots: string[][] = [];
  const listPromise = source.listThreads({
    onPage: (partial) => {
      pageSnapshots.push(partial.rows.map((row) => row.id));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(pageSnapshots, [["page-1-ext"], ["page-2-codex"]]);
  releaseTree?.();
  const listed = await listPromise;
  assert.deepEqual(
    listed.rows.map((row) => row.id),
    ["page-1-ext", "page-2-codex"],
  );
});

it("marks awaited presentation response as stale when a new-epoch hello arrives mid-flight", async (t) => {
  let releaseFirstList: (() => void) | undefined;
  const fake = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/harness/plugins/list") {
      return new Promise((resolve) => {
        releaseFirstList = () =>
          resolve({
            plugins: [
              {
                id: "antigravity",
                name: "Antigravity Old",
                version: "1.0.0",
                iconStyle: { background: "#111111", borderRadius: 4 },
              },
            ],
          });
      });
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  });

  const source = new PeerThreadSource({
    hostId: "remote-peer:peer-c",
    host: new PeerChHostClient(fake.transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  const peers = {
    client: () => ({ state: "connected" }),
    source: () => source,
  };

  const pendingPres = resolvePeerHarnessIcon(peers, "/harness-icons/peer/peer-c/presentation.json");
  await new Promise((resolve) => setTimeout(resolve, 10));
  fake.emit({
    type: "hello",
    version: 1,
    cursor: { epoch: randomUUID(), sequence: 1 },
    reset: true,
  });
  releaseFirstList?.();
  const asset = await pendingPres;
  assert.ok(asset);
  assert.equal(asset.stale, true, "response from superseded generation must be marked stale");
});
