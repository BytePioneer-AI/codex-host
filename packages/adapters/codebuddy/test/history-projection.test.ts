import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CODEBUDDY_ID, CODEBUDDY_RUNTIME_PROFILE } from "../src/common.js";
import { configuration, modelRef, nativeModel } from "../src/configuration.js";
import { historyUsage, nativeHistoryRows, snapshotFromHistory } from "../src/history.js";
import { CodeBuddyTurnOutput } from "../src/projection.js";
import { configOptions } from "./fixtures.js";

const ref = { harnessId: CODEBUDDY_ID, nativeSessionId: "session", formatVersion: 1 as const };
const nativeCommandProfile = { ...CODEBUDDY_RUNTIME_PROFILE, nativeCommands: true };
const commandsDisabledProfile = { ...CODEBUDDY_RUNTIME_PROFILE, nativeCommands: false };
const user = {
  type: "message",
  role: "user",
  id: "user",
  content: [{ type: "input_text", text: "hi" }],
};
const assistant = {
  type: "message",
  role: "assistant",
  id: "answer",
  parentId: "user",
  status: "completed",
  content: [{ type: "output_text", text: "ok" }],
};
const preMessageCompaction = {
  type: "message",
  role: "user",
  id: "cmp",
  logicalParentId: "answer",
  providerData: {
    agent: "cli",
    compactType: "pre-message-auto",
    compactionId: "cmp",
    isCompactInternal: true,
    isCompacted: true,
    compactionKind: "auto",
    compactionTrigger: "cache_expired",
  },
  content: [{ type: "input_text", text: "<cb_summary>old conversation</cb_summary>" }],
};
const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

describe("CodeBuddy native history and output projection", () => {
  it("honors a runtime profile that disables native command projection", () => {
    const snapshot = snapshotFromHistory(
      lines([
        user,
        {
          ...user,
          id: "compact",
          parentId: "user",
          providerData: { agent: "compact" },
          content: "native internal prompt",
        },
        { ...assistant, parentId: "compact" },
      ]),
      ref,
      process.cwd(),
      commandsDisabledProfile,
    );
    expect(snapshot.turns).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain("contextCompaction");

    const events: HostEvent[] = [];
    const output = new CodeBuddyTurnOutput(
      hostTurnIdSchema.parse("codebuddy-compact-marker"),
      process.cwd(),
      (event) => events.push(event),
      commandsDisabledProfile,
    );
    output.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "summary",
      content: { type: "text", text: "summary" },
      _meta: { "codebuddy.ai/isCompactInternal": true },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ item: expect.objectContaining({ type: "agentMessage" }) }),
    );
  });

  it("keeps WorkBuddy context-injection user rows inside the active turn (#616)", () => {
    const snapshot = snapshotFromHistory(
      lines([
        {
          ...user,
          id: "q1",
          providerData: {
            conversationRequestId: "q-1",
            startsNewUserRequest: true,
          },
          content: [{ type: "input_text", text: "<user_query>hi</user_query>" }],
        },
        {
          ...user,
          id: "ctx-1",
          parentId: "q1",
          providerData: {
            conversationRequestId: "q-1",
            startsNewUserRequest: false,
          },
          content: [
            {
              type: "input_text",
              text: '<system-reminder data-role="user-context">injected</system-reminder>',
            },
          ],
        },
        {
          ...user,
          id: "ctx-2",
          parentId: "ctx-1",
          providerData: {
            conversationRequestId: "q-1",
            startsNewUserRequest: false,
            isMeta: true,
          },
          content: [
            {
              type: "input_text",
              text: '<system-reminder data-role="user-context">also meta</system-reminder>',
            },
          ],
        },
        { ...assistant, id: "a1", parentId: "ctx-2" },
        {
          ...user,
          id: "q2",
          parentId: "a1",
          providerData: {
            conversationRequestId: "q-2",
            startsNewUserRequest: true,
          },
          content: [{ type: "input_text", text: "<user_query>next</user_query>" }],
        },
        { ...assistant, id: "a2", parentId: "q2" },
      ]),
      ref,
      process.cwd(),
    );
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]?.input).toEqual([
      { type: "text", text: "<user_query>hi</user_query>" },
    ]);
    expect(snapshot.turns[1]?.input).toEqual([
      { type: "text", text: "<user_query>next</user_query>" },
    ]);
  });

  it.each([
    "Do not delete files; only review.",
    "<user_query>Only review.</user_query>",
    '<system-reminder data-role="user-context">context</system-reminder>\nOnly review.',
    '<system-reminder data-role="user-context">context</system-reminder>\n<user_query>Only review.</user_query>',
  ])("preserves same-turn user input without changing native identity: %s", (content) => {
    const snapshot = snapshotFromHistory(
      lines([
        user,
        {
          type: "function_call",
          id: "call",
          parentId: "user",
          callId: "call-1",
          name: "Bash",
          arguments: { command: "pwd" },
        },
        {
          ...user,
          id: "steer",
          parentId: "call",
          providerData: { startsNewUserRequest: false },
          content,
        },
        {
          type: "function_call_result",
          id: "result",
          parentId: "steer",
          callId: "call-1",
          status: "completed",
          output: "workspace",
        },
        { ...assistant, parentId: "result" },
        { ...user, id: "next", parentId: "answer", content: "next request" },
        { ...assistant, id: "next-answer", parentId: "next" },
      ]),
      ref,
      process.cwd(),
    );
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "user" },
      checkpoint: { checkpointId: "user" },
      input: [
        { type: "text", text: "hi" },
        { type: "text", text: content },
      ],
      items: [
        {
          item: { type: "commandExecution", output: "workspace" },
          outcome: { status: "succeeded" },
        },
        { item: { type: "agentMessage", text: "ok" } },
      ],
      outcome: { status: "succeeded" },
    });
    expect(snapshot.turns[1]?.input).toEqual([{ type: "text", text: "next request" }]);
  });

  it.each([
    '<system-reminder data-role="user-context">body.includes("<user_query>")</system-reminder>',
    "  <system-reminder data-role='user-context'>quoted <user_query>text</user_query></system-reminder>\n",
    '<system-reminder data-role="user-context">first</system-reminder>\n<system-reminder data-role="user-context">second <user_query></system-reminder>',
  ])("hides context-only wrappers even when they quote user-query tags: %s", (content) => {
    const snapshot = snapshotFromHistory(
      lines([
        user,
        {
          ...user,
          id: "context",
          parentId: "user",
          providerData: { startsNewUserRequest: false },
          content,
        },
        { ...assistant, parentId: "context" },
      ]),
      ref,
      process.cwd(),
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "user" },
      checkpoint: { checkpointId: "user" },
      input: [{ type: "text", text: "hi" }],
      items: [{ item: { type: "agentMessage", text: "ok" } }],
      outcome: { status: "succeeded" },
    });
  });

  it.each([false, true])(
    "honors startsNewUserRequest=%s for meta rows containing user-query tags",
    (startsNewUserRequest) => {
      const snapshot = snapshotFromHistory(
        lines([
          user,
          {
            ...user,
            id: "meta",
            parentId: "user",
            providerData: { startsNewUserRequest, isMeta: true },
            content: "<user_query>quoted prompt</user_query>",
          },
          { ...assistant, parentId: "meta" },
        ]),
        ref,
        process.cwd(),
      );
      expect(snapshot.turns).toHaveLength(startsNewUserRequest ? 2 : 1);
      expect(snapshot.turns.at(-1)).toMatchObject({
        nativeTurnRef: { nativeTurnKey: startsNewUserRequest ? "meta" : "user" },
        input: [
          {
            type: "text",
            text: startsNewUserRequest ? "<user_query>quoted prompt</user_query>" : "hi",
          },
        ],
        items: [{ item: { type: "agentMessage", text: "ok" } }],
        outcome: { status: "succeeded" },
      });
    },
  );

  it("groups native local command records and hides compaction prompts and summaries", () => {
    const snapshot = snapshotFromHistory(
      lines([
        {
          ...user,
          id: "caveat",
          providerData: { skipRun: true },
          content:
            '<system-reminder data-role="command-caveat">local command notice</system-reminder>',
        },
        {
          ...user,
          id: "cost",
          parentId: "caveat",
          providerData: { skipRun: true, startsNewUserRequest: false, isMeta: true },
          content: "<command-name>/cost</command-name>",
        },
        {
          ...user,
          id: "cost-result",
          parentId: "cost",
          providerData: { skipRun: true },
          content: "<local-command-stdout>Cost: 1 credit</local-command-stdout>",
        },
        {
          ...user,
          id: "compact",
          parentId: "cost-result",
          providerData: { agent: "compact", startsNewUserRequest: false, isMeta: true },
          content: "Internal summary instructions",
        },
        {
          type: "reasoning",
          id: "thinking",
          parentId: "compact",
          providerData: { agent: "compact" },
          content: "Internal analysis",
        },
        {
          ...assistant,
          parentId: "thinking",
          providerData: {
            agent: "compact",
            isCompactInternal: true,
            isCompacted: true,
            compactType: "user-command",
          },
          content: "Internal summary",
        },
      ]),
      ref,
      process.cwd(),
      nativeCommandProfile,
    );
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      input: [{ text: "/cost" }],
      items: [{ item: { type: "agentMessage", text: "Cost: 1 credit" } }],
      outcome: { status: "succeeded" },
    });
    expect(snapshot.turns[1]).toMatchObject({
      input: [{ text: "/compact" }],
      items: [{ item: { type: "contextCompaction" } }],
      outcome: { status: "succeeded" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("Internal");
  });

  it("keeps emergency auto-compaction within the original user Turn", () => {
    const snapshot = snapshotFromHistory(
      lines([
        user,
        {
          ...user,
          id: "auto",
          parentId: "user",
          providerData: { agent: "compact" },
          content: "Internal compaction prompt",
        },
        {
          ...assistant,
          id: "auto-summary",
          parentId: "auto",
          providerData: {
            agent: "compact",
            isCompactInternal: true,
            isCompacted: true,
            compactType: "emergency-auto",
          },
        },
        { ...assistant, parentId: "auto-summary" },
      ]),
      ref,
      process.cwd(),
      nativeCommandProfile,
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      input: [{ text: "hi" }],
      items: [
        { item: { type: "contextCompaction" } },
        { item: { type: "agentMessage", text: "ok" } },
      ],
    });
  });

  it("reads the pre-compaction history of a cache-expired auto-compaction", () => {
    const after = {
      ...assistant,
      id: "after",
      parentId: "cmp",
      content: [{ type: "output_text", text: "resumed" }],
    };
    const rows = [user, assistant, preMessageCompaction, after];
    // Administrative readers keep the physical chain, so existing derived-session
    // provenance is unchanged.
    expect(nativeHistoryRows(lines(rows)).map((row) => row.id)).toEqual(["cmp", "after"]);
    const snapshot = snapshotFromHistory(lines(rows), ref, process.cwd(), nativeCommandProfile);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "user" },
      input: [{ text: "hi" }],
      items: [
        { item: { type: "agentMessage", text: "ok" } },
        { item: { type: "contextCompaction" }, outcome: { status: "succeeded" } },
        { item: { type: "agentMessage", text: "resumed" } },
      ],
      outcome: { status: "succeeded" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("cb_summary");
    expect(
      snapshotFromHistory(lines(rows), ref, process.cwd(), nativeCommandProfile, {
        includeCompactionHistory: false,
      }).turns[0]?.nativeTurnRef.nativeTurnKey,
    ).toBe("cmp");
  });

  it("preserves compaction evidence and physical boundaries on meta continuation rows", () => {
    const rows = lines([
      user,
      assistant,
      {
        ...preMessageCompaction,
        providerData: {
          ...preMessageCompaction.providerData,
          startsNewUserRequest: false,
          isMeta: true,
        },
      },
      { ...assistant, id: "after", parentId: "cmp" },
    ]);
    const snapshot = snapshotFromHistory(rows, ref, process.cwd(), nativeCommandProfile);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items[1]).toMatchObject({
      item: { type: "contextCompaction" },
      outcome: { status: "succeeded" },
    });
    expect(
      snapshotFromHistory(rows, ref, process.cwd(), nativeCommandProfile, {
        includeCompactionHistory: false,
      }).turns[0]?.nativeTurnRef.nativeTurnKey,
    ).toBe("cmp");
  });

  it("follows consecutive cache-expired auto-compactions", () => {
    const afterFirst = {
      ...assistant,
      id: "after-first",
      parentId: "cmp",
      content: [{ type: "output_text", text: "resumed" }],
    };
    const second = {
      ...preMessageCompaction,
      id: "cmp-2",
      logicalParentId: "after-first",
      providerData: { ...preMessageCompaction.providerData, compactionId: "cmp-2" },
    };
    const afterSecond = {
      ...assistant,
      id: "after-second",
      parentId: "cmp-2",
      content: [{ type: "output_text", text: "done" }],
    };
    const snapshot = snapshotFromHistory(
      lines([user, assistant, preMessageCompaction, afterFirst, second, afterSecond]),
      ref,
      process.cwd(),
      nativeCommandProfile,
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items.map((item) => item.item.type)).toEqual([
      "agentMessage",
      "contextCompaction",
      "agentMessage",
      "contextCompaction",
      "agentMessage",
    ]);
  });

  it("keeps the next prompt after a cache-expired auto-compaction as a new Turn", () => {
    const nextUser = {
      ...user,
      id: "next-user",
      parentId: "cmp",
      content: [{ type: "input_text", text: "continue" }],
    };
    const nextAnswer = {
      ...assistant,
      id: "next-answer",
      parentId: "next-user",
      content: [{ type: "output_text", text: "done" }],
    };
    const snapshot = snapshotFromHistory(
      lines([user, assistant, preMessageCompaction, nextUser, nextAnswer]),
      ref,
      process.cwd(),
      nativeCommandProfile,
    );
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      items: [
        { item: { type: "agentMessage", text: "ok" } },
        { item: { type: "contextCompaction" }, outcome: { status: "succeeded" } },
      ],
    });
    expect(snapshot.turns[1]).toMatchObject({
      input: [{ text: "continue" }],
      items: [{ item: { type: "agentMessage", text: "done" } }],
    });
  });

  it("reports a failed cache-expired auto-compaction without opening a user Turn", () => {
    const failed = {
      ...preMessageCompaction,
      providerData: { ...preMessageCompaction.providerData, isCompacted: false },
    };
    const snapshot = snapshotFromHistory(
      lines([user, assistant, failed]),
      ref,
      process.cwd(),
      nativeCommandProfile,
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items[1]).toMatchObject({
      item: { type: "contextCompaction" },
      outcome: {
        status: "failed",
        error: { message: "CodeBuddy: Native compaction did not complete" },
      },
    });
  });

  it("does not follow logicalParentId outside a compaction summary", () => {
    const detached = {
      ...user,
      id: "detached",
      logicalParentId: "answer",
      content: [{ type: "input_text", text: "detached" }],
    };
    expect(nativeHistoryRows(lines([user, assistant, detached])).map((row) => row.id)).toEqual([
      "detached",
    ]);
  });

  it.each(["failed", "cancelled", "succeeded"] as const)(
    "does not confirm compaction from a start marker alone (%s)",
    (status) => {
      const events: HostEvent[] = [];
      const output = new CodeBuddyTurnOutput(
        hostTurnIdSchema.parse("compact-status"),
        process.cwd(),
        (event) => events.push(event),
        nativeCommandProfile,
      );
      output.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "partial summary" },
        _meta: { "codebuddy.ai/isCompactInternal": true },
      });
      output.finish(status);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({
            item: expect.objectContaining({ type: "contextCompaction" }),
            outcome: expect.objectContaining({
              status: status === "succeeded" ? "failed" : status,
            }),
          }),
        }),
      );
      expect(JSON.stringify(events)).not.toContain("partial summary");
    },
  );

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "retains confirmed compaction after a %s Turn",
    (status) => {
      const events: HostEvent[] = [];
      const output = new CodeBuddyTurnOutput(
        hostTurnIdSchema.parse("compact-confirmed"),
        process.cwd(),
        (event) => events.push(event),
      );
      output.compact();
      output.confirmCompaction([
        {
          item: { type: "contextCompaction", itemId: hostItemIdSchema.parse("native-summary") },
          outcome: { status: "succeeded" },
        },
      ]);
      output.finish(status);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({ outcome: { status: "succeeded" } }),
        }),
      );
    },
  );

  it.each(["cancelled", "interrupted", "failed", "completed"])(
    "preserves manual compaction terminal status %s in history",
    (status) => {
      const snapshot = snapshotFromHistory(
        lines([
          { ...user, providerData: { agent: "compact" } },
          {
            ...assistant,
            status,
            providerData: {
              agent: "compact",
              isCompactInternal: true,
              isCompacted: false,
              compactType: "user-command",
            },
          },
        ]),
        ref,
        process.cwd(),
        nativeCommandProfile,
      );
      const expected = ["cancelled", "interrupted"].includes(status) ? "cancelled" : "failed";
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]).toMatchObject({
        input: [{ text: "/compact" }],
        items: [{ item: { type: "contextCompaction" }, outcome: { status: expected } }],
        outcome: { status: expected },
      });
    },
  );

  it("retains every valid diff in one terminal tool result without duplicate items", () => {
    const events: HostEvent[] = [];
    const output = new CodeBuddyTurnOutput(
      hostTurnIdSchema.parse("multi-diff"),
      process.cwd(),
      (event) => events.push(event),
    );
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "multi",
      status: "completed",
      content: [
        { type: "diff", path: "a.txt", oldText: null, newText: "new A" },
        { type: "diff", path: "b.txt", oldText: "old B", newText: "new B" },
        { type: "diff", path: "invalid", oldText: "old" },
      ],
    };
    output.update(update);
    output.update(update);
    output.finish("succeeded");
    const changes = events.flatMap((e) =>
      e.type === "item.completed" && e.snapshot.item.type === "fileChange" ? [e.snapshot.item] : [],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changes.map((c) => [c.path, c.kind])).toEqual([
      ["a.txt", "add"],
      ["b.txt", "update"],
    ]);
  });
  it("encodes native model IDs opaquely and derives configuration from the native catalog", () => {
    expect(nativeModel(modelRef("provider/model:variant"))).toBe("provider/model:variant");
    expect(configuration(configOptions()).catalog.defaultModel).toEqual(modelRef("native/model"));
    expect(() => configuration([])).toThrow();
  });
  it("follows the current branch, preserves stable IDs, and refuses damaged history", () => {
    const old = { ...assistant, id: "discarded", content: [{ type: "output_text", text: "old" }] };
    const snapshot = snapshotFromHistory(lines([user, old, assistant]), ref, process.cwd());
    expect(snapshot.turns[0]?.items).toMatchObject([{ item: { text: "ok" } }]);
    expect(snapshot.turns[0]?.nativeTurnRef.nativeTurnKey).toBe("user");
    expect(() =>
      snapshotFromHistory(lines([user, { ...assistant, parentId: "missing" }]), ref, process.cwd()),
    ).toThrow("parent is missing");
    expect(() => snapshotFromHistory('{"incomplete":', ref, process.cwd())).toThrow(
      "invalid record",
    );
    expect(snapshotFromHistory(lines([user]), ref, process.cwd()).turns[0]?.outcome.status).toBe(
      "unknown",
    );
  });
  it("replays a Tool result that precedes its call and drops one without any call", () => {
    const call = {
      type: "function_call",
      id: "call",
      parentId: "result",
      callId: "call-1",
      name: "Bash",
      arguments: JSON.stringify({ command: "tasklist" }),
    };
    const result = {
      type: "function_call_result",
      id: "result",
      parentId: "answer",
      callId: "call-1",
      status: "completed",
      output: { type: "text", text: "Command rejected: tasklist" },
    };
    const snapshot = snapshotFromHistory(lines([user, assistant, result, call]), ref, "/work");
    expect(snapshot.turns[0]?.items).toMatchObject([
      { item: { type: "agentMessage", text: "ok" } },
      {
        item: {
          type: "commandExecution",
          command: "tasklist",
          cwd: "/work",
          output: "Command rejected: tasklist",
        },
        outcome: { status: "succeeded" },
      },
    ]);
    expect(snapshot.turns[0]?.items).toHaveLength(2);
    const orphan = snapshotFromHistory(lines([user, assistant, result]), ref, "/work");
    expect(orphan.turns[0]?.items).toMatchObject([{ item: { type: "agentMessage" } }]);
  });
  it("deduplicates model-request Usage and reports credits rather than USD", () => {
    const data = {
      messageId: "model-request",
      rawUsage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, credit: 0.12 },
    };
    const tool = { type: "function_call", id: "tool", parentId: "user", providerData: data };
    const history = lines([user, tool, { ...assistant, parentId: "tool", providerData: data }]);
    expect(historyUsage(history)).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      totalCredits: 0.12,
    });
  });
  it("does not expose partial arguments as output, deduplicates tool_call, and retains a failed tool", () => {
    const events: HostEvent[] = [];
    const output = new CodeBuddyTurnOutput(hostTurnIdSchema.parse("turn"), process.cwd(), (event) =>
      events.push(event),
    );
    output.update({
      sessionUpdate: "tool_call",
      toolCallId: "call",
      title: "PowerShell",
      status: "in_progress",
      rawInput: {},
    });
    output.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call",
      rawInput: { command: "wr" },
      content: [{ type: "content", content: { type: "text", text: "wr" } }],
    });
    expect(events).toEqual([]);
    output.update({
      sessionUpdate: "tool_call",
      toolCallId: "call",
      rawInput: { command: "write-output fixture" },
      _meta: { "codebuddy.ai/toolName": "PowerShell", "codebuddy.ai/toolArgumentsComplete": true },
    });
    output.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call",
      status: "failed",
      rawOutput: { type: "text", text: "execution failed" },
    });
    output.update({ sessionUpdate: "tool_call_update", toolCallId: "call", status: "failed" });
    output.finish("succeeded");
    expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "item.completed")).toMatchObject([
      {
        snapshot: {
          item: { command: "write-output fixture", output: "execution failed" },
          outcome: { status: "failed" },
        },
      },
    ]);
  });
  it("emits immutable text starts and never mixes Team member text into the parent", () => {
    const events: HostEvent[] = [];
    const output = new CodeBuddyTurnOutput(hostTurnIdSchema.parse("turn"), "/work", (event) =>
      events.push(event),
    );
    output.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "message",
      content: { type: "text", text: "parent" },
    });
    output.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "child" },
      _meta: { "codebuddy.ai/memberEvent": "worker" },
    });
    output.finish("succeeded");
    expect(events[0]).toMatchObject({ item: { text: "" } });
    expect(events.at(-1)).toMatchObject({ snapshot: { item: { text: "parent" } } });
  });
});
