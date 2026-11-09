import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { ChInteractions } from "../src/ch-interactions.ts";
import { EventHub, type StreamSink } from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])
  for (const [decision, effect] of [
    ["accept", "allowOnce"],
    ["acceptForSession", "allowForSession"],
    ["cancel", "deny"],
  ] as const)
    it(`preserves the exact native ${decision} response for ${method}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "web-native-approval-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const host = new FakeChChannel();
      host.add("native", root);
      host.pending = [
        {
          requestId: "native-request",
          threadId: "native",
          kind: "approval",
          interaction: {
            type: "approval",
            title: "Native action",
            actions: [{ id: decision, label: decision, effect }],
          },
          request: { method, params: { availableDecisions: [decision] } },
        },
      ];
      const events = new EventHub(root);
      const frames: Array<Record<string, unknown>> = [];
      const sink: StreamSink = {
        id: "native-client",
        closed: false,
        push: (frame) => frames.push(frame as Record<string, unknown>),
        end() {},
        fail() {},
        onClose() {},
      };
      events.handler({}, sink);
      const interactions = new ChInteractions(host.realtime, events, () => {});
      t.after(() => interactions.clear());
      interactions.update(await host.snapshot("native"));
      const request = frames.find((frame) => frame.type === "waterfall");
      assert.ok(request);
      events.settle({
        clientId: String(frames[0]?.clientId),
        eventId: String(request.eventId),
        outcome: {
          kind: "returned",
          value: { answers: [{ id: "approval", selected: [decision] }] },
        },
      });
      for (let i = 0; i < 100 && !host.answers.length; i++) await delay(10);
      assert.deepEqual(host.answers[0]?.result, { decision });
    });
