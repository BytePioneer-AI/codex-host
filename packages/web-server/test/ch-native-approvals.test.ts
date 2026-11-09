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

for (const [label, expected] of [
  ["Allow once", { action: "accept", content: {} }],
  ["Allow for session", { action: "accept", content: {}, _meta: { persist: "session" } }],
  ["Always allow", { action: "accept", content: {}, _meta: { persist: "always" } }],
  ["Decline", { action: "decline" }],
] as const)
  it(`presents native Computer Use consent and forwards ${label} without an empty question`, async (t) => {
    const host = new FakeChChannel();
    host.add("native", "/synthetic");
    host.pending = [
      {
        requestId: "native-safari-consent",
        threadId: "native",
        kind: "approval",
        interaction: {
          type: "approval",
          title: 'Allow Computer Use to use "Safari"?',
          description: "Monitor the app for prompt injection risks.",
          actions: [
            { id: "accept", label: "Allow once", effect: "allowOnce" },
            { id: "acceptForSession", label: "Allow for session", effect: "allowForSession" },
            { id: "acceptAlways", label: "Always allow", effect: "allowAlways" },
            { id: "decline", label: "Decline", effect: "deny" },
          ],
        },
        request: { method: "mcpServer/elicitation/request", params: {} },
      },
    ];
    const events = new EventHub("/synthetic");
    const interactions = new ChInteractions(host.realtime, events, () => {});
    t.after(() => interactions.clear());
    interactions.update(await host.snapshot("native"));
    assert.equal(host.answers.length, 0);
    // A late/reconnected browser must receive the same actionable request.
    const frames: Array<Record<string, unknown>> = [];
    events.handler(
      {},
      {
        id: "reconnected-client",
        closed: false,
        push: (frame) => frames.push(frame as Record<string, unknown>),
        end() {},
        fail() {},
        onClose() {},
      },
    );
    const request = frames.find((frame) => frame.type === "waterfall");
    assert.ok(request);
    const questions = (
      request.request as { questions: Array<{ question: string; options: unknown[] }> }
    ).questions;
    assert.equal(questions.length, 1);
    const question = questions[0];
    assert.ok(question);
    assert.match(question.question, /Safari/);
    assert.match(question.question, /prompt injection/);
    assert.equal(question.options.length, 4);
    events.settle({
      clientId: String(frames[0]?.clientId),
      eventId: String(request.eventId),
      outcome: { kind: "returned", value: { answers: [{ id: "approval", selected: [label] }] } },
    });
    for (let i = 0; i < 100 && !host.answers.length; i++) await delay(10);
    assert.deepEqual(host.answers[0]?.result, expected);
  });
