import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../../../apps/web-ui/apps/web/public/sw.js", import.meta.url),
  "utf8",
);

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
