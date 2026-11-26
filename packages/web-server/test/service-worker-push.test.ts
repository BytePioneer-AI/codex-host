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

const clickCases = [
  "accepted",
  "no-shell",
  "response-lost",
  "cached-decline",
  "activation-unknown",
  "launcher-unknown",
  "retry-denied",
  "unauthorized",
  "forbidden",
  "rate-limited",
  "existing-client",
  "no-subscription",
  "no-session",
] as const;

for (const scenario of clickCases) {
  it(`routes notification clicks (${scenario})`, async () => {
    interface ClickEvent {
      notification: { data: { url: string; sessionId?: string }; close(): void };
      waitUntil(promise: Promise<void>): void;
    }
    const handlers = new Map<string, (event: ClickEvent) => void>();
    const opened: string[] = [];
    const clientMessages: unknown[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const endpoint = "https://push.example/device";
    const sessionId = "thread-1";
    let clientLookups = 0;
    let focused = false;
    let notificationClosed = false;
    const rejectionStatuses: Partial<Record<(typeof clickCases)[number], number>> = {
      unauthorized: 401,
      forbidden: 403,
      "rate-limited": 429,
    };
    const retries = [
      "response-lost",
      "cached-decline",
      "activation-unknown",
      "launcher-unknown",
      "retry-denied",
    ].includes(scenario);
    const shouldUseWeb = [
      "no-shell",
      "existing-client",
      "no-subscription",
      "no-session",
      "cached-decline",
      "unauthorized",
      "forbidden",
      "rate-limited",
    ].includes(scenario);
    const client = {
      url: "https://host.example/web/",
      async focus() {
        focused = true;
      },
      postMessage(message: object) {
        clientMessages.push({ ...message });
      },
    };
    runInNewContext(source, {
      URL,
      AbortSignal,
      crypto: webcrypto,
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        if (
          (retries && scenario !== "launcher-unknown" && requests.length === 1) ||
          scenario === "activation-unknown"
        ) {
          throw new Error("Failed to receive the gateway response");
        }
        const status = rejectionStatuses[scenario] ?? (scenario === "retry-denied" ? 401 : 200);
        return {
          ok: status === 200,
          status,
          json: async () => ({
            result: {
              ok: true,
              value: {
                activated:
                  scenario === "launcher-unknown"
                    ? null
                    : ["accepted", "response-lost"].includes(scenario),
              },
            },
          }),
        };
      },
      self: {
        addEventListener(type: string, handler: (event: ClickEvent) => void) {
          handlers.set(type, handler);
        },
        registration: {
          scope: "https://host.example/web/",
          pushManager: {
            getSubscription: async () => (scenario === "no-subscription" ? null : { endpoint }),
          },
        },
        clients: {
          async matchAll() {
            clientLookups++;
            return scenario === "existing-client" ? [client] : [];
          },
          async openWindow(url: string) {
            opened.push(url);
            return null;
          },
        },
      },
    });

    const click = handlers.get("notificationclick");
    assert.ok(click);
    const relativeUrl = scenario === "no-session" ? "./" : "./?session=thread-1";
    let pending: Promise<void> | undefined;
    click({
      notification: {
        data: {
          url: relativeUrl,
          ...(scenario === "no-session" ? {} : { sessionId }),
        },
        close() {
          notificationClosed = true;
        },
      },
      waitUntil(promise) {
        pending = promise;
      },
    });
    assert.ok(pending, "notification clicks must extend the event lifetime");
    await pending;

    assert.equal(notificationClosed, true);
    assert.equal(clientLookups, shouldUseWeb ? 1 : 0);
    assert.equal(focused, scenario === "existing-client");
    assert.deepEqual(
      clientMessages,
      scenario === "existing-client" ? [{ type: "codexhost/open-session", sessionId }] : [],
    );
    const shouldOpen = shouldUseWeb && scenario !== "existing-client";
    assert.deepEqual(
      opened,
      shouldOpen ? [new URL(relativeUrl, "https://host.example/web/").href] : [],
    );
    if (scenario === "no-subscription" || scenario === "no-session") {
      assert.deepEqual(requests, []);
    } else {
      assert.equal(requests.length, retries ? 2 : 1);
      let clickId: unknown;
      for (const [index, request] of requests.entries()) {
        assert.equal(request.url, "https://host.example/web/api/codexhost/desktopSessionActivate");
        assert.equal(request.init.method, "POST");
        assert.equal(request.init.credentials, "same-origin");
        const body = JSON.parse(String(request.init.body)) as {
          rpcId: unknown;
          payload: { args: { requestId?: unknown } };
        };
        if (index === 0) clickId = body.payload.args.requestId;
        assert.equal(typeof clickId, "string");
        assert.equal(typeof body.rpcId, "string");
        assert.deepEqual(body, {
          type: "client-request",
          rpcId: body.rpcId,
          method: "codexhost/desktopSessionActivate",
          payload: {
            args: { requestId: clickId, endpoint, sessionId, ...(index !== 0 && { retry: true }) },
          },
        });
      }
    }
  });
}

it("lets API navigation requests bypass the offline fetch wrapper", async () => {
  const handlers = new Map<
    string,
    (event: { request: { mode: string; url: string }; respondWith(p: unknown): void }) => void
  >();
  runInNewContext(source, {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ status: 200 }),
    self: {
      addEventListener(
        type: string,
        handler: (event: {
          request: { mode: string; url: string };
          respondWith(p: unknown): void;
        }) => void,
      ) {
        handlers.set(type, handler);
      },
      registration: { scope: "https://host.example/web/" },
    },
  });
  const onFetch = handlers.get("fetch");
  assert.ok(onFetch);

  let downloadIntercepted = false;
  onFetch({
    request: {
      mode: "navigate",
      url: "https://host.example/web/api/workspace-file/download?sessionId=s&path=a.mp3",
    },
    respondWith() {
      downloadIntercepted = true;
    },
  });
  assert.equal(downloadIntercepted, false);

  let pageResponse: PromiseLike<{ status: number }> | undefined;
  onFetch({
    request: { mode: "navigate", url: "https://host.example/web/?session=s" },
    respondWith(promise) {
      pageResponse = promise as PromiseLike<{ status: number }>;
    },
  });
  assert.equal(typeof pageResponse?.then, "function");
  assert.deepEqual(await pageResponse, { status: 200 });
});

it("redacts credentials from the offline address while probing the original URL", async () => {
  const offline = runInNewContext(`${source}\nofflineResponse();`, {
    Response,
    navigator: { language: "en" },
    self: { addEventListener() {} },
  }) as Response;
  const script = (await offline.text()).match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);

  for (const [fragment, displayFragment] of [
    ["#token=shared-secret&view=chat", "#view=chat"],
    ["#connect-devices", "#connect-devices"],
  ]) {
    const href = `https://host.example/web/?token=local-secret&session=thread-1${fragment}`;
    const address = { textContent: "" };
    const probes: string[] = [];
    const location = { href };
    runInNewContext(script, {
      URL,
      URLSearchParams,
      AbortController,
      fetch(url: string) {
        probes.push(url);
        return Promise.resolve({ status: 503 });
      },
      setTimeout() {},
      clearTimeout() {},
      location,
      window: { addEventListener() {} },
      navigator: { onLine: true, serviceWorker: { addEventListener() {} } },
      document: {
        getElementById(id: string) {
          return id === "address" ? address : { addEventListener() {} };
        },
        addEventListener() {},
      },
    });
    assert.equal(
      address.textContent,
      `https://host.example/web/?session=thread-1${displayFragment}`,
    );
    assert.deepEqual(probes, [href]);
    assert.equal(location.href, href);
  }
});
