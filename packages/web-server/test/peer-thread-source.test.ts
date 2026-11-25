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

it("isolates tree cache by epoch, discards stale pages/responses, preserves supplemented ancestors on transient failure, and omits parents from pending onPage", async (t) => {
  let epoch = randomUUID();
  let failTree = false;
  let treeReadCalls = 0;
  let includeParentInCatalog = false;
  let currentParents: Record<string, string> = { child: "parent" };
  let holdTree: PromiseWithResolvers<{ parents: Record<string, string> }> | undefined;
  let holdCatalog: PromiseWithResolvers<unknown> | undefined;
  const fake = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/thread/tree/read") {
      treeReadCalls++;
      if (holdTree) return holdTree.promise;
      if (failTree) {
        throw new RpcError("remote/request-failed", "Temporary timeout");
      }
      return { parents: { ...currentParents } };
    }
    if (body.method === "codexhost/thread/catalog/read") {
      if (holdCatalog) return holdCatalog.promise;
      const rows = includeParentInCatalog
        ? [makeRow("parent", "codexhost"), makeRow("child", "codexhost")]
        : [makeRow("child", "codexhost")];
      return {
        threads: rows,
        ownership: rows.map((row) => ({
          threadId: row.id,
          owner: "external",
          harnessId: "claude-code",
        })),
        officialCursor: { live: null },
        archivedThreadIds: [],
      };
    }
    if (
      body.method === "thread/read" &&
      (body.params as { threadId?: string }).threadId === "parent"
    ) {
      return { thread: makeRow("parent", "codexhost") };
    }
    if (body.method === "codexhost/thread/ownership/list") {
      return {
        threads: [{ threadId: "parent", owner: "external", harnessId: "claude-code" }],
      };
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  }, epoch);

  const source = new PeerThreadSource({
    hostId: "remote-peer:peer-tree-resilient",
    host: new PeerChHostClient(fake.transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  fake.emit({ type: "connection", online: true });
  fake.emit({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });

  // First refresh supplements the unlisted parent ancestor.
  const first = await source.listThreads();
  assert.deepEqual(first.rows.map((row) => row.id).sort(), ["child", "parent"]);
  assert.equal(first.harnessIds.get("parent"), "claude-code");
  assert.deepEqual(first.parents, { child: "parent" });
  assert.equal(first.treeStale, undefined);
  assert.equal(treeReadCalls, 1);

  // P1-2 & P2-1: Same-epoch transient tree/read failure retains BOTH the confirmed parent link
  // AND the supplemented ancestor row, while onPage omits parents and marks treeStale=true.
  failTree = true;
  const sameEpochPageParents: Array<Readonly<Record<string, string>>> = [];
  const second = await source.listThreads({
    onPage: (partial) => {
      sameEpochPageParents.push(partial.parents);
    },
  });
  assert.equal(treeReadCalls, 2);
  assert.deepEqual(sameEpochPageParents, [{}]);
  assert.deepEqual(
    second.rows.map((row) => row.id).sort(),
    ["child", "parent"],
    "transient tree/read failure must preserve previously supplemented ancestor rows",
  );
  assert.equal(second.harnessIds.get("parent"), "claude-code");
  assert.deepEqual(second.parents, { child: "parent" });
  assert.equal(second.treeStale, true);

  // P2-1: When unparenting with a slow tree/read, onPage must NOT publish the previous refresh's
  // stale parent before the current tree/read resolves.
  failTree = false;
  currentParents = {};
  holdTree = Promise.withResolvers();
  const unparentPageParents: Array<Readonly<Record<string, string>>> = [];
  const unparentPromise = source.listThreads({
    onPage: (partial) => {
      unparentPageParents.push(partial.parents);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(unparentPageParents, [{}]);
  holdTree.resolve({ parents: {} });
  holdTree = undefined;
  const unparented = await unparentPromise;
  assert.deepEqual(unparented.parents, {});
  assert.deepEqual(
    unparented.rows.map((row) => row.id),
    ["child"],
    "confirmed unparenting drops the previously supplemented ancestor row",
  );

  // Re-establish parent before testing epoch roll.
  includeParentInCatalog = true;
  currentParents = { child: "parent" };
  const reparented = await source.listThreads();
  assert.deepEqual(reparented.parents, { child: "parent" });

  // P1-1: An in-flight catalog page from an old epoch must never invoke onPage or commit after
  // a new-epoch hello arrives.
  holdCatalog = Promise.withResolvers();
  const stalePageCalls: string[][] = [];
  const staleCatalogPromise = source.listThreads({
    onPage: (partial) => {
      stalePageCalls.push(partial.rows.map((row) => row.id));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  epoch = randomUUID();
  fake.emit({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true });
  holdCatalog.resolve({
    threads: [makeRow("stale-old-row", "codexhost")],
    ownership: [{ threadId: "stale-old-row", owner: "external", harnessId: "claude-code" }],
    officialCursor: { live: null },
    archivedThreadIds: [],
  });
  holdCatalog = undefined;
  const staleCatalogResult = await staleCatalogPromise;
  assert.deepEqual(stalePageCalls, []);
  assert.equal(staleCatalogResult.stale, true);
  assert.deepEqual(staleCatalogResult.rows, []);
  assert.deepEqual(staleCatalogResult.parents, {});

  // A late tree/read from the old epoch must also be discarded once a new epoch hello arrives.
  holdTree = Promise.withResolvers();
  const lateListPromise = source.listThreads();
  await new Promise((resolve) => setTimeout(resolve, 10));
  epoch = randomUUID();
  fake.emit({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: true });
  holdTree.resolve({ parents: { child: "stale-old-epoch-parent" } });
  holdTree = undefined;
  const lateResult = await lateListPromise;
  assert.equal(lateResult.stale, true);
  assert.deepEqual(lateResult.parents, {});
  assert.equal(lateResult.treeStale, true);

  // On the new epoch, a failing first tree/read must NOT reuse the old epoch's parents in onPage or final output.
  failTree = true;
  const newEpochPageParents: Array<Readonly<Record<string, string>>> = [];
  const afterRoll = await source.listThreads({
    onPage: (partial) => {
      newEpochPageParents.push(partial.parents);
    },
  });
  assert.deepEqual(newEpochPageParents, [{}]);
  assert.deepEqual(afterRoll.parents, {});
  assert.equal(afterRoll.treeStale, true);

  // P1-1: Same-epoch full reset must also invalidate in-flight tree/read responses so a late
  // pre-reset tree response cannot pollute the cache for a subsequent failing read.
  failTree = false;
  holdTree = Promise.withResolvers();
  const preResetList = source.listThreads();
  await new Promise((resolve) => setTimeout(resolve, 10));
  fake.emit({ type: "hello", version: 1, cursor: { epoch, sequence: 2 }, reset: true });
  holdTree.resolve({ parents: { child: "stale-pre-reset-parent" } });
  holdTree = undefined;
  const preResetResult = await preResetList;
  assert.equal(preResetResult.stale, true);
  assert.deepEqual(preResetResult.parents, {});

  failTree = true;
  const afterFullResetFailure = await source.listThreads();
  assert.deepEqual(
    afterFullResetFailure.parents,
    {},
    "late pre-reset tree/read must not pollute cache after same-epoch full reset",
  );
  assert.equal(afterFullResetFailure.treeStale, true);
});

it("preserves realtime thread/archived received while an older active catalog page is in flight", async (t) => {
  const epoch = randomUUID();
  let holdCatalog: PromiseWithResolvers<unknown> | undefined;
  let parentArchived = false;
  const fake = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/thread/catalog/read") {
      if (holdCatalog) {
        const gate = holdCatalog;
        holdCatalog = undefined;
        return gate.promise;
      }
      const rows = parentArchived
        ? [makeRow("child", "codexhost")]
        : [makeRow("parent", "openai"), makeRow("child", "codexhost")];
      return {
        threads: rows,
        ownership: rows.map((row) =>
          row.id === "parent"
            ? { threadId: row.id, owner: "codex" }
            : { threadId: row.id, owner: "external", harnessId: "claude-code" },
        ),
        officialCursor: { live: null },
        archivedThreadIds: [],
      };
    }
    if (body.method === "codexhost/thread/tree/read") {
      return { parents: { child: "parent" } };
    }
    if (
      body.method === "thread/read" &&
      (body.params as { threadId?: string }).threadId === "parent"
    ) {
      // Simulate thread/read omitting the optional `archived` boolean.
      return { thread: makeRow("parent", "openai") };
    }
    if (body.method === "codexhost/thread/ownership/list") {
      return { threads: [{ threadId: "parent", owner: "codex" }] };
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  }, epoch);

  const source = new PeerThreadSource({
    hostId: "remote-peer:peer-archive-race",
    host: new PeerChHostClient(fake.transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  fake.emit({ type: "connection", online: true });
  fake.emit({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });

  // 1. Start a catalog list whose active page still contains `parent`, and hold it in flight.
  const catalogGate = Promise.withResolvers<unknown>();
  holdCatalog = catalogGate;
  const pageArchivedStates: boolean[] = [];
  const inFlightList = source.listThreads({
    onPage: (partial) => {
      pageArchivedStates.push(partial.archivedIds.has("parent"));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // 2. While that older active page is still in flight, receive a realtime `thread/archived` event.
  parentArchived = true;
  fake.emit({
    type: "changed",
    cursor: { epoch, sequence: 2 },
    method: "thread/archived",
    threadId: "parent",
  });

  // 3. Release the older active catalog page (which lists `parent` as active, archivedThreadIds: []).
  catalogGate.resolve({
    threads: [makeRow("parent", "openai"), makeRow("child", "codexhost")],
    ownership: [
      { threadId: "parent", owner: "codex" },
      { threadId: "child", owner: "external", harnessId: "claude-code" },
    ],
    officialCursor: { live: null },
    archivedThreadIds: [],
  });
  const firstResult = await inFlightList;
  assert.deepEqual(
    pageArchivedStates,
    [true],
    "in-flight older active onPage must not override a newer realtime thread/archived event",
  );
  assert.equal(
    firstResult.archivedIds.has("parent"),
    true,
    "older active catalog page must keep parent archived when thread/archived arrived mid-flight",
  );

  // 4. Subsequent refresh supplements `parent` by ID (thread/read omits `archived`): must remain archived.
  const nextResult = await source.listThreads();
  assert.equal(
    nextResult.archivedIds.has("parent"),
    true,
    "supplementing parent after mid-flight thread/archived must keep it archived",
  );
});

it("removes a child-only archivedThreadId when thread/unarchived arrives during ancestor supplement", async (t) => {
  const epoch = randomUUID();
  let holdAncestorRead: PromiseWithResolvers<unknown> | undefined;
  const fake = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/thread/catalog/read") {
      // Only active sibling is in rows; `unarchived-child` is only in archivedThreadIds (not in rows).
      return {
        threads: [makeRow("sibling", "codexhost")],
        ownership: [{ threadId: "sibling", owner: "external", harnessId: "claude-code" }],
        officialCursor: { live: null },
        archivedThreadIds: ["unarchived-child"],
      };
    }
    if (body.method === "codexhost/thread/tree/read") {
      return { parents: { sibling: "ancestor", "unarchived-child": "ancestor" } };
    }
    if (
      body.method === "thread/read" &&
      (body.params as { threadId?: string }).threadId === "ancestor"
    ) {
      if (holdAncestorRead) {
        const gate = holdAncestorRead;
        holdAncestorRead = undefined;
        return gate.promise;
      }
      return { thread: makeRow("ancestor", "openai") };
    }
    if (body.method === "codexhost/thread/ownership/list") {
      return { threads: [{ threadId: "ancestor", owner: "codex" }] };
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  }, epoch);

  const source = new PeerThreadSource({
    hostId: "remote-peer:peer-unarchive-mid-supplement",
    host: new PeerChHostClient(fake.transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  fake.emit({ type: "connection", online: true });
  fake.emit({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });

  const ancestorGate = Promise.withResolvers<unknown>();
  holdAncestorRead = ancestorGate;
  const listing = source.listThreads();
  await new Promise((resolve) => setTimeout(resolve, 10));

  // While supplementing `ancestor`, `unarchived-child` (present only in archivedThreadIds) is restored.
  fake.emit({
    type: "changed",
    cursor: { epoch, sequence: 2 },
    method: "thread/unarchived",
    threadId: "unarchived-child",
  });

  ancestorGate.resolve({ thread: makeRow("ancestor", "openai") });
  const listed = await listing;
  assert.equal(
    listed.archivedIds.has("unarchived-child"),
    false,
    "thread/unarchived arriving during supplement must clear non-row ID from archivedIds",
  );
  assert.equal(listed.unarchivedIds?.has("unarchived-child"), true);
});

it("keeps a previously unarchived supplemented ancestor unarchived across consecutive refreshes when thread/read omits archived", async (t) => {
  const epoch = randomUUID();
  const fake = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/thread/catalog/read") {
      return {
        threads: [makeRow("child", "codexhost")],
        ownership: [{ threadId: "child", owner: "external", harnessId: "claude-code" }],
        officialCursor: { live: null },
        archivedThreadIds: [],
      };
    }
    if (body.method === "codexhost/thread/tree/read") {
      return { parents: { child: "parent" } };
    }
    if (
      body.method === "thread/read" &&
      (body.params as { threadId?: string }).threadId === "parent"
    ) {
      // Omit `archived` field to verify knownArchived===false is not treated as unknown.
      return { thread: makeRow("parent", "openai") };
    }
    if (body.method === "codexhost/thread/ownership/list") {
      return { threads: [{ threadId: "parent", owner: "codex" }] };
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  }, epoch);

  const source = new PeerThreadSource({
    hostId: "remote-peer:peer-unarchived-supplement",
    host: new PeerChHostClient(fake.transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  fake.emit({ type: "connection", online: true });
  fake.emit({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });

  // Deliver thread/unarchived BEFORE refresh starts (so seq === listStartArchiveSeq).
  fake.emit({
    type: "changed",
    cursor: { epoch, sequence: 2 },
    method: "thread/unarchived",
    threadId: "parent",
  });

  // Two consecutive refreshes supplementing `parent` without `archived` must keep it explicitly unarchived.
  for (let i = 0; i < 2; i++) {
    const res = await source.listThreads();
    assert.equal(res.archivedIds.has("parent"), false);
    assert.equal(
      res.retainedAncestorIds?.has("parent") ?? false,
      false,
      "knownArchived===false ancestor must not be placed in retainedAncestorIds",
    );
    assert.equal(res.unarchivedIds?.has("parent"), true);
  }
});

it("clears archivedIds when ancestor supplement thread/read explicitly returns archived: false despite catalog archivedThreadIds", async (t) => {
  const epoch = randomUUID();
  const fake = makeFakeTransport((_r, body) => {
    if (body.method === "codexhost/thread/catalog/read") {
      return {
        threads: [makeRow("child", "codexhost")],
        ownership: [{ threadId: "child", owner: "external", harnessId: "claude-code" }],
        officialCursor: { live: null },
        archivedThreadIds: ["parent"],
      };
    }
    if (body.method === "codexhost/thread/tree/read") {
      return { parents: { child: "parent" } };
    }
    if (
      body.method === "thread/read" &&
      (body.params as { threadId?: string }).threadId === "parent"
    ) {
      return { thread: { ...makeRow("parent", "openai"), archived: false } };
    }
    if (body.method === "codexhost/thread/ownership/list") {
      return { threads: [{ threadId: "parent", owner: "codex" }] };
    }
    throw new Error(`Unexpected method: ${String(body.method)}`);
  }, epoch);

  const source = new PeerThreadSource({
    hostId: "remote-peer:peer-supplement-explicit-unarchived",
    host: new PeerChHostClient(fake.transport),
    onCatalogChanged: () => {},
    onThreadChanged: () => {},
    onConnection: () => {},
  });
  t.after(() => source.close());

  fake.emit({ type: "connection", online: true });
  fake.emit({ type: "hello", version: 1, cursor: { epoch, sequence: 1 }, reset: false });

  const listed = await source.listThreads();
  assert.equal(
    listed.archivedIds.has("parent"),
    false,
    "explicit archived: false on supplement must remove parent from archivedIds",
  );
  assert.equal(listed.unarchivedIds?.has("parent"), true);
  assert.equal(listed.retainedAncestorIds?.has("parent") ?? false, false);
});
