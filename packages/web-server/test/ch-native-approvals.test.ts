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

for (const [method, description, subject, expectedDetail, expectedIntent] of [
  [
    "item/commandExecution/requestApproval",
    "/bin/zsh -lc \"printf 'test\\n' > a.txt\"\n\nWorking directory: /synthetic/project",
    {
      kind: "command",
      threadId: "native",
      turnId: "internal-turn",
      itemId: "internal-item",
      startedAtMs: 1794238338226,
      reason: "Allow creating a.txt?",
      command: "/bin/zsh -lc \"printf 'test\\n' > a.txt\"",
      availableDecisions: ["accept", "cancel"],
    },
    undefined,
    {
      kind: "approval",
      toolLabel: "bash",
      command: "/bin/zsh -lc \"printf 'test\\n' > a.txt\"",
      actions: [{ label: "Allow once", effect: "allowOnce" }],
    },
  ],
  [
    "item/fileChange/requestApproval",
    "Working directory: /synthetic/project",
    { threadId: "native", itemId: "internal-item" },
    undefined,
    {
      kind: "approval",
      toolLabel: "files",
      actions: [{ label: "Allow once", effect: "allowOnce" }],
    },
  ],
  [
    "mcpServer/elicitation/request",
    "Create a.txt",
    { type: "nativeAction" },
    "Create a.txt",
    {
      kind: "approval",
      actions: [{ label: "Allow once", effect: "allowOnce" }],
    },
  ],
] as const)
  it(`shows only the approval explanation and relevant options for ${method}`, async (t) => {
    const host = new FakeChChannel();
    host.add("native", "/synthetic");
    host.pending = [
      {
        requestId: "display-approval",
        threadId: "native",
        kind: "approval",
        interaction: {
          type: "approval",
          title: "Allow creating a.txt?",
          ...(description ? { description } : {}),
          subject,
          actions: [{ id: "accept", label: "Allow once", effect: "allowOnce" }],
        },
        request: { method, params: {} },
      },
    ];
    const events = new EventHub("/synthetic");
    const frames: Array<Record<string, unknown>> = [];
    events.handler(
      {},
      {
        id: "approval-viewer",
        closed: false,
        push: (frame) => frames.push(frame as Record<string, unknown>),
        end() {},
        fail() {},
        onClose() {},
      },
    );
    const interactions = new ChInteractions(host.realtime, events, () => {});
    t.after(() => interactions.clear());
    interactions.update(await host.snapshot("native"));
    const request = frames.find((frame) => frame.type === "waterfall");
    assert.ok(request);
    const questions = (request.request as { questions: unknown[] }).questions;
    assert.deepEqual(questions, [
      {
        id: "approval",
        question: "Allow creating a.txt?",
        ...(expectedDetail ? { detail: expectedDetail } : {}),
        options: [{ label: "Allow once" }],
        multiSelect: false,
        allowOther: false,
        intent: expectedIntent,
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(questions),
      /internal-turn|internal-item|1794238338226|Working directory/,
    );
    assert.equal(host.answers.length, 0);
  });

it("extracts structured file diffs from the correlated turn item for fileChange approvals", async (t) => {
  const host = new FakeChChannel();
  host.add("native", "/synthetic");
  const thread = host.threads.get("native");
  assert.ok(thread);
  thread.turns.push({
    id: "turn-diff",
    status: "inProgress",
    items: [
      {
        id: "unrelated-item",
        type: "fileChange",
        changes: [
          { path: "/synthetic/other.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-x\n+y" },
        ],
      },
      {
        id: "target-diff-item",
        type: "fileChange",
        changes: [
          {
            path: "/synthetic/src/streak.ts",
            kind: { type: "update" },
            diff: "@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;",
          },
        ],
      },
    ],
  });
  host.pending = [
    {
      requestId: "file-diff-approval",
      threadId: "native",
      kind: "approval",
      interaction: {
        type: "approval",
        title: "Allow editing streak.ts?",
        actions: [
          { id: "accept", label: "Allow once", effect: "allowOnce" },
          { id: "acceptForSession", label: "Allow for session", effect: "allowForSession" },
          { id: "decline", label: "Decline", effect: "deny" },
        ],
      },
      request: {
        method: "item/fileChange/requestApproval",
        params: { itemId: "target-diff-item" },
      },
    },
  ];
  const events = new EventHub("/synthetic");
  const frames: Array<Record<string, unknown>> = [];
  events.handler(
    {},
    {
      id: "diff-viewer",
      closed: false,
      push: (frame) => frames.push(frame as Record<string, unknown>),
      end() {},
      fail() {},
      onClose() {},
    },
  );
  const interactions = new ChInteractions(host.realtime, events, () => {});
  t.after(() => interactions.clear());
  interactions.update(await host.snapshot("native"));
  const request = frames.find((frame) => frame.type === "waterfall");
  assert.ok(request);
  const questions = (request.request as { questions: unknown[] }).questions;
  assert.deepEqual(questions, [
    {
      id: "approval",
      question: "Allow editing streak.ts?",
      options: [{ label: "Allow once" }, { label: "Allow for session" }, { label: "Decline" }],
      multiSelect: false,
      allowOther: false,
      intent: {
        kind: "approval",
        toolLabel: "files",
        files: [
          {
            path: "/synthetic/src/streak.ts",
            kind: "update",
            diff: "@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;",
          },
        ],
        actions: [
          { label: "Allow once", effect: "allowOnce" },
          { label: "Allow for session", effect: "allowForSession" },
          { label: "Decline", effect: "deny" },
        ],
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(questions), /unrelated-item|target-diff-item|other\.ts/);
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
      request.request as {
        questions: Array<{ question: string; detail?: string; options: unknown[] }>;
      }
    ).questions;
    assert.equal(questions.length, 1);
    const question = questions[0];
    assert.ok(question);
    assert.equal(question.question, 'Allow Computer Use to use "Safari"?');
    assert.equal(question.detail, "Monitor the app for prompt injection risks.");
    assert.equal(question.options.length, 4);
    events.settle({
      clientId: String(frames[0]?.clientId),
      eventId: String(request.eventId),
      outcome: { kind: "returned", value: { answers: [{ id: "approval", selected: [label] }] } },
    });
    for (let i = 0; i < 100 && !host.answers.length; i++) await delay(10);
    assert.deepEqual(host.answers[0]?.result, expected);
  });
