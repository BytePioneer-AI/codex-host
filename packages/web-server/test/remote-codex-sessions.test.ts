import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { it } from "node:test";
import type { HostClientUpdate } from "@codexhost/desktop-control";
import type { WebCodexRequest } from "@codexhost/shared-contracts";
import type { ChHostClient } from "../src/ch-host-client.ts";
import { RemoteCodexSessions } from "../src/remote-codex-sessions.ts";
import { EventHub } from "../src/transport.ts";

class ObservedEvents extends EventHub {
  readonly emitted: Array<{ kind: string; args: unknown[] }> = [];
  override emit(kind: string, ...args: unknown[]): void {
    this.emitted.push({ kind, args });
  }
}
async function until(test: () => boolean) {
  const end = Date.now() + 2000;
  while (!test()) {
    assert.ok(Date.now() < end, "Remote reconciliation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function fixture() {
  let epoch = randomUUID();
  const scope = `web-codex:${"a".repeat(64)}`;
  let subscriber: ((event: HostClientUpdate) => void) | undefined;
  let rows: Array<{ sessionId: string }> = [];
  let requestHook: ((request: WebCodexRequest) => Promise<unknown>) | undefined;
  const requests: WebCodexRequest[] = [];
  const host: ChHostClient = {
    request: async () => {
      throw new Error("External methods unused");
    },
    projects: async () => ({ projects: [], assignments: {}, projectless: [] }),
    pins: async () => [],
    close() {},
    realtime: {
      subscribe(listener) {
        subscriber = listener;
        return () => {
          subscriber = undefined;
        };
      },
      request: async () => {
        throw new Error("External methods unused");
      },
      snapshot: async () => {
        throw new Error("External snapshot unused");
      },
      respond: async () => ({ resolved: false }),
    },
    webCodex: {
      get epoch() {
        return epoch;
      },
      configure: async () => ({
        version: 1,
        scope,
        cursor: { epoch, sequence: 0 },
        sessionIds: rows.map((row) => row.sessionId),
        notificationCursor: 0,
      }),
      async request<T>(request: WebCodexRequest): Promise<T> {
        requests.push(request);
        if (requestHook) return (await requestHook(request)) as T;
        if (request.operation === "list") return { items: rows } as T;
        if (request.operation === "interactions") return [] as T;
        if (request.operation === "notifications") return { cursor: 0, items: [] } as T;
        return null as T;
      },
      stream: async () => {},
    },
  };
  const events = new ObservedEvents("/test");
  const connect = () =>
    RemoteCodexSessions.connect(host, events, {
      home: "/not-launched",
      command: "/not-launched",
      pluginRoots: [resolve("packages/adapters")],
    });
  return {
    host,
    events,
    requests,
    connect,
    setRows(value: Array<{ sessionId: string }>) {
      rows = value;
    },
    setHook(value: typeof requestHook) {
      requestHook = value;
    },
    changed() {
      subscriber?.({ type: "web-codex-changed", scope, cursor: { epoch, sequence: 1 } });
    },
    reconnect() {
      subscriber?.({ type: "hello", version: 1, cursor: { epoch, sequence: 2 }, reset: true });
    },
    restart() {
      epoch = randomUUID();
      subscriber?.({ type: "hello", version: 1, cursor: { epoch, sequence: 0 }, reset: true });
    },
  };
}

it("drains invalidations and rejects stale epoch list results without publishing old rows", async () => {
  const f = fixture(),
    remote = await f.connect();
  const delayed = Promise.withResolvers<unknown>();
  let waiting = false;
  f.setHook(async (request) => {
    if (request.operation === "list" && !waiting) {
      waiting = true;
      return delayed.promise;
    }
    if (request.operation === "list") return { items: [{ sessionId: "new-owner-session" }] };
    if (request.operation === "interactions") return [];
    if (request.operation === "notifications") return { cursor: 0, items: [] };
    return null;
  });
  f.changed();
  await until(() => waiting);
  f.restart();
  delayed.resolve({ items: [{ sessionId: "obsolete-owner-session" }] });
  await until(() => remote.owns("new-owner-session"));
  assert.equal(remote.owns("obsolete-owner-session"), false);
  assert.equal(JSON.stringify(f.events.emitted).includes("obsolete-owner-session"), false);
  await remote.close();
});

it("close during a pending read cannot create later interaction waterfalls or events", async () => {
  const f = fixture(),
    remote = await f.connect();
  const delayed = Promise.withResolvers<unknown>();
  let pending = false;
  f.setHook(async (request) => {
    if (request.operation === "list") return { items: [] };
    if (request.operation === "interactions") {
      pending = true;
      return delayed.promise;
    }
    return { cursor: 0, items: [] };
  });
  f.changed();
  await until(() => pending);
  await remote.close();
  const before = f.events.emitted.length;
  delayed.resolve([
    {
      requestId: "late",
      sessionId: "late-session",
      interaction: {
        type: "approval",
        title: "Late",
        actions: [{ id: "yes", label: "Yes", effect: "allowOnce" }],
      },
    },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.events.emitted.length, before);
  assert.equal(f.requests.filter((request) => request.operation === "notifications").length, 1);
});

it("keeps the notification cursor across same-owner reconnects while the gateway is alive", async () => {
  const f = fixture(),
    remote = await f.connect();
  let delivered = 0;
  remote.notifier = () => {
    delivered++;
  };
  f.setHook(async (request) => {
    if (request.operation === "list") return { items: [] };
    if (request.operation === "interactions") return [];
    if (request.operation === "notifications")
      return {
        cursor: 1,
        items:
          Number(request.input.after) < 1
            ? [
                {
                  notification: {
                    kind: "turn",
                    sessionId: "done",
                    title: "Done",
                    body: "Finished",
                  },
                },
              ]
            : [],
      };
    return null;
  });
  f.changed();
  await until(() => delivered === 1);
  f.reconnect();
  await until(
    () => f.requests.filter((request) => request.operation === "notifications").length >= 3,
  );
  assert.equal(delivered, 1);
  assert.equal(
    f.requests.filter((request) => request.operation === "notifications").at(-1)?.input.after,
    1,
  );
  await remote.close();
});

it("drains a reconnect invalidation even when the previous generation rejects its pending read", async () => {
  const f = fixture(),
    remote = await f.connect();
  const delayed = Promise.withResolvers<unknown>();
  let waiting = false;
  f.setHook(async (request) => {
    if (request.operation === "list" && !waiting) {
      waiting = true;
      return delayed.promise;
    }
    if (request.operation === "list") return { items: [{ sessionId: "replacement-session" }] };
    if (request.operation === "interactions") return [];
    if (request.operation === "notifications") return { cursor: 0, items: [] };
    return null;
  });
  f.changed();
  await until(() => waiting);
  f.restart();
  delayed.reject(Object.assign(new Error("Obsolete Host reply"), { code: -32094 }));
  await until(() => remote.owns("replacement-session"));
  await remote.close();
});
