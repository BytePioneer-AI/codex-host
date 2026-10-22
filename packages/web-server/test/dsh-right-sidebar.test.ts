import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import WebSocket from "ws";

import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";

interface Envelope {
  result: {
    ok: boolean;
    value?: Record<string, unknown>;
    error?: { code: string };
  };
}

it("serves the right Sidebar file tree from a local Thread's Host directory", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "codexhost-right-sidebar-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "README.md"), "line one\nline two\n");

  const host = new FakeChHost();
  host.add("local-thread", workspace);
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());

  const url = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--adapters",
        "test/fake-harness",
      ],
      { authenticated: true },
    ),
  );
  const token = url.searchParams.get("token");
  assert.ok(token);
  const call = async (
    method: string,
    args: Record<string, unknown>,
    authenticated = true,
  ): Promise<{ status: number; envelope?: Envelope }> => {
    const response = await fetch(new URL(`/api/${method}`, url), {
      method: "POST",
      headers: {
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        origin: url.origin,
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "right-sidebar",
        method,
        payload: { args },
      }),
    });
    const text = await response.text();
    return {
      status: response.status,
      ...(text.startsWith("{") ? { envelope: JSON.parse(text) as Envelope } : {}),
    };
  };

  // The catalog is the only source of Thread identities; list it before the panel asks.
  assert.equal((await call("session/list", {})).status, 200);

  const listing = await call("workspaceFiles/list", {
    workspaceFileScopeId: "local-thread",
    path: workspace,
  });
  assert.equal(listing.status, 200);
  assert.equal(listing.envelope?.result.ok, true);
  assert.deepEqual(listing.envelope?.result.value?.entries, [
    { name: "README.md", type: "file", size: 18 },
    { name: "src", type: "directory" },
  ]);

  const page = await call("workspaceFiles/read", {
    workspaceFileScopeId: "local-thread",
    path: "README.md",
    range: {},
  });
  assert.equal(page.envelope?.result.ok, true);
  assert.equal(page.envelope?.result.value?.text, "line one\nline two");

  // Binary reads keep DSH Connection's multipart attachment response through the forward.
  const binary = await fetch(new URL("/api/workspaceFiles/readBytes", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: url.origin,
    },
    body: JSON.stringify({
      type: "client-request",
      rpcId: "right-sidebar-binary",
      method: "workspaceFiles/readBytes",
      payload: { args: { workspaceFileScopeId: "local-thread", path: "README.md", options: {} } },
    }),
  });
  assert.equal(binary.status, 200);
  assert.match(binary.headers.get("content-type") ?? "", /^multipart\/form-data/u);
  assert.match(await binary.text(), /line one/u);

  // A draft has a browser-side cwd but no Host-confirmed Thread. An unknown
  // identity follows the same path; neither case creates a Session.
  const draft = await call("session/create", { cwd: workspace });
  assert.equal(draft.envelope?.result.ok, true);
  const draftId = String(draft.envelope?.result.value?.sessionId);
  for (const sessionId of [draftId, "unknown-thread"]) {
    const missing = await call("workspaceFiles/list", {
      workspaceFileScopeId: sessionId,
      path: workspace,
    });
    assert.equal(missing.envelope?.result.ok, false);
    assert.equal(missing.envelope?.result.error?.code, "gateway/lookup-not-found");
  }

  // The DSH stream reaches the mux only after the same authentication gate.
  assert.equal(
    (
      await call(
        "workspaceFiles/list",
        { workspaceFileScopeId: "local-thread", path: workspace },
        false,
      )
    ).status,
    401,
  );
  const rejectedSocket = new WebSocket(new URL("/api/remote.mux", url));
  const [, rejected] = (await once(rejectedSocket, "unexpected-response")) as [
    unknown,
    { statusCode?: number },
  ];
  assert.equal(rejected.statusCode, 401);

  const socket = new WebSocket(new URL("/api/remote.mux", url), {
    headers: { authorization: `Bearer ${token}` },
  });
  t.after(() => socket.close());
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "open",
      streamId: "right-sidebar-stream",
      endpoint: "workspaceFiles/changes",
      payload: { args: { workspaceFileScopeId: "local-thread", path: workspace } },
    }),
  );
  const [frame] = (await once(socket, "message")) as [WebSocket.RawData];
  assert.deepEqual(JSON.parse(String(frame)), {
    type: "item",
    streamId: "right-sidebar-stream",
    value: { kind: "ready" },
  });
});
