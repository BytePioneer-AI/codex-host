import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../../../apps/web-ui/apps/web/public/sw.js", import.meta.url),
  "utf8",
);

interface SubscriptionChangeEventStub {
  oldSubscription?: { options: { applicationServerKey?: Uint8Array } };
  waitUntil(promise: Promise<void>): void;
}

function subscriptionChangeFixture(failure?: "http" | "rpc" | "config" | "subscribe") {
  const handlers = new Map<string, (event: SubscriptionChangeEventStub) => void>();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const options: Array<{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }> = [];
  const subscription = {
    endpoint: "https://push.example/new",
    keys: { p256dh: "p256dh", auth: "auth" },
  };
  runInNewContext(source, {
    URL,
    atob,
    crypto: webcrypto,
    navigator: { userAgent: "iPhone" },
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return {
        ok: failure !== "http",
        status: failure === "http" ? 401 : 200,
        json: async () => ({
          result:
            failure === "rpc" || (failure === "config" && url.endsWith("pushConfig"))
              ? { ok: false, error: { message: "Push RPC failed" } }
              : { ok: true, value: { publicKey: "-_8", subscribed: true } },
        }),
      };
    },
    self: {
      addEventListener(type: string, handler: (event: SubscriptionChangeEventStub) => void) {
        handlers.set(type, handler);
      },
      registration: {
        scope: "https://host.example/web/",
        pushManager: {
          async subscribe(value: (typeof options)[number]) {
            options.push(value);
            if (failure === "subscribe") throw new Error("Subscription failed");
            return { toJSON: () => subscription };
          },
        },
      },
    },
  });
  return {
    requests,
    options,
    subscription,
    change(oldSubscription?: SubscriptionChangeEventStub["oldSubscription"]) {
      const handler = handlers.get("pushsubscriptionchange");
      assert.ok(handler);
      let pending: Promise<void> | undefined;
      handler({
        ...(oldSubscription === undefined ? {} : { oldSubscription }),
        waitUntil: (promise) => {
          pending = promise;
        },
      });
      assert.ok(pending, "subscription recovery must extend the event lifetime");
      return pending;
    },
  };
}

for (const keySource of ["old", "missing-key", "missing-subscription"] as const) {
  it(`recovers a push subscription with ${keySource} and reports the RPC envelope`, async () => {
    const f = subscriptionChangeFixture();
    const key = new Uint8Array([1, 2, 3]);
    await f.change(
      keySource === "missing-subscription"
        ? undefined
        : { options: keySource === "old" ? { applicationServerKey: key } : {} },
    );
    assert.equal(f.options.length, 1);
    assert.equal(f.options[0]?.userVisibleOnly, true);
    if (keySource === "old") assert.equal(f.options[0]?.applicationServerKey, key);
    else assert.deepEqual(Array.from(f.options[0]?.applicationServerKey ?? []), [251, 255]);
    const methods =
      keySource === "old"
        ? ["codexhost/pushSubscribe"]
        : ["codexhost/pushConfig", "codexhost/pushSubscribe"];
    assert.equal(f.requests.length, methods.length);
    for (const [index, request] of f.requests.entries()) {
      const method = methods[index];
      assert.equal(request.url, `https://host.example/web/api/${method}`);
      assert.equal(request.init.method, "POST");
      assert.equal(request.init.credentials, "same-origin");
      assert.equal(
        (request.init.headers as Record<string, string>)["content-type"],
        "application/json",
      );
      const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
      assert.equal(typeof body.rpcId, "string");
      assert.deepEqual(body, {
        type: "client-request",
        rpcId: body.rpcId,
        method,
        payload: {
          args:
            method === "codexhost/pushSubscribe"
              ? { subscription: f.subscription, userAgent: "iPhone" }
              : {},
        },
      });
    }
  });
}

for (const failure of ["http", "rpc", "config", "subscribe"] as const) {
  it(`rejects the recovery lifetime promise on ${failure} failure`, async () => {
    const f = subscriptionChangeFixture(failure);
    await assert.rejects(
      f.change(
        failure === "config"
          ? undefined
          : { options: { applicationServerKey: new Uint8Array([1]) } },
      ),
      /HTTP 401|Push RPC failed|Subscription failed/u,
    );
    if (failure === "config") assert.equal(f.options.length, 0);
    if (failure === "subscribe") assert.equal(f.requests.length, 0);
  });
}

interface PushEventStub {
  data: { json(): unknown };
  waitUntil(promise: Promise<void>): void;
}

for (const [state, windows] of [
  ["foreground", [{ visibilityState: "visible", focused: true }]],
  ["background", [{ visibilityState: "hidden", focused: false }]],
  ["closed", []],
] as const) {
  for (const kind of ["turn", "approval", "question", "error", "test"] as const) {
    it(`shows ${kind} push notifications when the app is ${state}`, async () => {
      const handlers = new Map<string, (event: PushEventStub) => void>();
      const notifications: Array<{ title: string; options: Record<string, unknown> }> = [];
      runInNewContext(source, {
        self: {
          addEventListener(type: string, handler: (event: PushEventStub) => void) {
            handlers.set(type, handler);
          },
          clients: { matchAll: async () => windows },
          registration: {
            async showNotification(title: string, options: Record<string, unknown>) {
              notifications.push({ title, options });
            },
          },
        },
      });

      const push = handlers.get("push");
      assert.ok(push);
      let pending: Promise<void> | undefined;
      push({
        data: {
          json: () => ({ kind, title: "My task", body: "Ready", tag: "thread-1" }),
        },
        waitUntil(promise) {
          pending = promise;
        },
      });
      assert.ok(pending, "notification delivery must extend the push event lifetime");
      await pending;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.title, "My task");
      assert.equal(notifications[0]?.options.body, "Ready");
      assert.equal(notifications[0]?.options.tag, "thread-1");
      assert.equal(
        notifications[0]?.options.requireInteraction,
        kind === "approval" || kind === "question",
      );
    });
  }
}
