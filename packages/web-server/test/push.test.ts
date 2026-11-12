import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import webpush from "web-push";
import { PushNotifier } from "../src/push.ts";
import { DataDir } from "../src/store.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexhost-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  data.writeJson("push-subscriptions.json", [
    {
      endpoint: "https://push.example.test/device",
      keys: { p256dh: "test-key", auth: "test-auth" },
      createdAt: 1,
    },
  ]);
  return { data, push: new PushNotifier(data) };
}

it("sets a request timeout independently of the notification TTL", async (t) => {
  const { push } = fixture(t);
  const send = t.mock.method(webpush, "sendNotification", async () => {});
  assert.equal(await push.notify({ kind: "test", title: "Test", body: "Body" }), 1);
  assert.equal(send.mock.calls.length, 1);
  assert.deepEqual(send.mock.calls[0]?.arguments[2], {
    TTL: 3600,
    urgency: "high",
    timeout: 10_000,
  });
});

it("keeps subscriptions after a timeout so later notifications can succeed", async (t) => {
  const { push } = fixture(t);
  const log = t.mock.method(console, "error", () => {});
  let attempts = 0;
  t.mock.method(webpush, "sendNotification", async () => {
    if (attempts++ === 0) throw new Error("Socket timeout");
  });
  const message = { kind: "turn", title: "Test", body: "Body" } as const;
  assert.equal(await push.notify(message), 0);
  assert.equal(push.subscriptionCount, 1);
  assert.equal(log.mock.calls.length, 1);
  assert.equal(await push.notify(message), 1);
});
