import type {
  AssistantMessage,
  Session,
  SnapshotFileDiff,
  TextPart,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import { nativeCheckpointRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  projectOpenCodeHistory,
  reliableOpenCodeFileChanges,
  resolveOpenCodeForkBoundary,
  resolveOpenCodeLastTurnBoundary,
  type OpenCodeMessageWithParts,
} from "../src/history.js";
import { OpenCodeMessageIdGenerator } from "../src/message-grouping.js";

function session(revert?: Session["revert"]): Session {
  return {
    id: "session-1",
    slug: "session-1",
    projectID: "project-1",
    directory: "/synthetic",
    title: "Synthetic",
    version: "1.18.25",
    time: { created: 1, updated: 2 },
    ...(revert ? { revert } : {}),
  };
}

function user(id: string, text: string): OpenCodeMessageWithParts {
  const info: UserMessage = {
    id,
    sessionID: "session-1",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  };
  const part: TextPart = {
    id: `part-${id}`,
    sessionID: "session-1",
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [part] };
}

function assistant(id: string, parentID: string, text: string): OpenCodeMessageWithParts {
  const info: AssistantMessage = {
    id,
    sessionID: "session-1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID,
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/synthetic", root: "/synthetic" },
    cost: 0.1,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  };
  const part: TextPart = {
    id: `part-${id}`,
    sessionID: "session-1",
    messageID: id,
    type: "text",
    text,
    time: { start: 1, end: 2 },
  };
  return { info, parts: [part] };
}

const messages = [
  user("user-1", "first"),
  assistant("assistant-1", "user-1", "one"),
  user("user-2", "second"),
  assistant("assistant-2", "user-2", "two"),
];

describe("OpenCode history projection", () => {
  it("hides transcript entries at and after the persisted revert boundary", () => {
    const snapshot = projectOpenCodeHistory({
      session: session({ messageID: "user-2" }),
      messages,
      toolOutputLimit: 1_000,
    });

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.input).toEqual([{ type: "text", text: "first" }]);
    expect(resolveOpenCodeLastTurnBoundary(session(), messages)).toEqual({
      lastUserMessageID: "user-2",
      sourceTurnCount: 2,
    });
  });

  it("forks at the exclusive message boundary following an exact Assistant checkpoint", () => {
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "opencode",
      nativeSessionId: "session-1",
      checkpointId: "assistant-1",
      formatVersion: 1,
    });

    expect(resolveOpenCodeForkBoundary(session(), messages, checkpoint)).toEqual({
      messageID: "user-2",
      sourceTurnCount: 1,
    });
  });

  it("projects steered native messages as one logical Turn and preserves history boundaries", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const firstGroup = generator.createGroup("host-turn-1");
    const root = generator.next(firstGroup, 1_000);
    const steer = generator.next(firstGroup, 1_001);
    const secondGroup = generator.createGroup("host-turn-2");
    const nextRoot = generator.next(secondGroup, 1_002);
    const groupedMessages = [
      user(root, "initial"),
      assistant("assistant-initial", root, "draft"),
      user(steer, "focus on tests"),
      assistant("assistant-steer", steer, "revised"),
      user(nextRoot, "follow up"),
      assistant("assistant-follow-up", nextRoot, "done"),
    ];
    const diffs = new Map<string, SnapshotFileDiff[]>([
      [
        root,
        [
          {
            file: "src/root.ts",
            patch: "@@ root @@",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
      ],
      [
        steer,
        [
          {
            file: "src/steer.ts",
            patch: "@@ steer @@",
            status: "added",
            additions: 1,
            deletions: 0,
          },
        ],
      ],
    ]);

    const snapshot = projectOpenCodeHistory({
      session: session(),
      messages: groupedMessages,
      diffsByUserMessageId: diffs,
      toolOutputLimit: 1_000,
    });
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: root },
      checkpoint: { checkpointId: "assistant-steer" },
      input: [
        { type: "text", text: "initial" },
        { type: "text", text: "focus on tests" },
      ],
      items: [
        { item: { type: "agentMessage", text: "draft" } },
        { item: { type: "agentMessage", text: "revised" } },
        { item: { type: "fileChange", changes: [{ path: "src/root.ts" }] } },
        { item: { type: "fileChange", changes: [{ path: "src/steer.ts" }] } },
      ],
    });
    expect(
      resolveOpenCodeForkBoundary(
        session(),
        groupedMessages,
        nativeCheckpointRefSchema.parse({
          harnessId: "opencode",
          nativeSessionId: "session-1",
          checkpointId: "assistant-initial",
          formatVersion: 1,
        }),
      ),
    ).toBeNull();
    expect(
      resolveOpenCodeForkBoundary(
        session(),
        groupedMessages,
        nativeCheckpointRefSchema.parse({
          harnessId: "opencode",
          nativeSessionId: "session-1",
          checkpointId: "assistant-steer",
          formatVersion: 1,
        }),
      ),
    ).toEqual({ messageID: nextRoot, sourceTurnCount: 1 });
    expect(resolveOpenCodeLastTurnBoundary(session(), groupedMessages)).toEqual({
      lastUserMessageID: nextRoot,
      sourceTurnCount: 2,
    });
  });

  it("does not reuse an earlier Assistant as the terminal of an incomplete steering segment", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const group = generator.createGroup("incomplete-steer");
    const root = generator.next(group, 1_000);
    const steer = generator.next(group, 1_001);

    const snapshot = projectOpenCodeHistory({
      session: session(),
      messages: [
        user(root, "initial"),
        assistant("assistant-root", root, "draft"),
        user(steer, "adjust"),
      ],
      toolOutputLimit: 1_000,
    });

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: root },
      input: [
        { type: "text", text: "initial" },
        { type: "text", text: "adjust" },
      ],
      outcome: { status: "unknown" },
    });
    expect(snapshot.turns[0]?.checkpoint).toBeUndefined();
    expect(
      resolveOpenCodeForkBoundary(
        session(),
        [user(root, "initial"), assistant("assistant-root", root, "draft"), user(steer, "adjust")],
        nativeCheckpointRefSchema.parse({
          harnessId: "opencode",
          nativeSessionId: "session-1",
          checkpointId: "assistant-root",
          formatVersion: 1,
        }),
      ),
    ).toBeNull();
  });

  it("does not hide a recovery-shaped message outside its namespaced group", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const group = generator.createGroup("orphan-recovery");
    generator.next(group, 1_000);
    const orphanRecovery = generator.nextRecovery(group, 1_001);

    const snapshot = projectOpenCodeHistory({
      session: session(),
      messages: [
        user(orphanRecovery, "standalone recovery text"),
        assistant("assistant-orphan-recovery", orphanRecovery, "done"),
      ],
      toolOutputLimit: 1_000,
    });

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.input).toEqual([{ type: "text", text: "standalone recovery text" }]);
  });

  it("keeps an interrupted recovery segment as a visible standalone Turn", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const group = generator.createGroup("interrupted-recovery");
    const root = generator.next(group, 1_000);
    const recovery = generator.nextRecovery(group, 1_001);
    const transcript = [
      user(root, "initial"),
      assistant("assistant-root", root, "draft"),
      user("external-user", "external interruption"),
      assistant("assistant-external", "external-user", "external response"),
      user(recovery, "recovery after interruption"),
      assistant("assistant-recovery", recovery, "recovered"),
    ];

    const snapshot = projectOpenCodeHistory({
      session: session(),
      messages: transcript,
      toolOutputLimit: 1_000,
    });

    expect(snapshot.turns.map(({ input }) => input)).toEqual([
      [{ type: "text", text: "initial" }],
      [{ type: "text", text: "external interruption" }],
      [{ type: "text", text: "recovery after interruption" }],
    ]);
    expect(resolveOpenCodeLastTurnBoundary(session(), transcript)).toEqual({
      lastUserMessageID: recovery,
      sourceTurnCount: 3,
    });
  });

  it("rolls back a final steered group from its root boundary", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const group = generator.createGroup("last-steered-turn");
    const root = generator.next(group, 1_000);
    const steer = generator.next(group, 1_001);
    const recovery = generator.nextRecovery(group, 1_002);
    const transcript = [
      user("prefix-user", "prefix"),
      assistant("prefix-assistant", "prefix-user", "done"),
      user(root, "initial"),
      assistant("assistant-root", root, "draft"),
      user(steer, "adjust"),
      user(recovery, "recover"),
      assistant("assistant-recovery", recovery, "final"),
    ];

    expect(resolveOpenCodeLastTurnBoundary(session(), transcript)).toEqual({
      lastUserMessageID: root,
      sourceTurnCount: 2,
    });
  });

  it("projects only complete native Diffs", () => {
    expect(
      reliableOpenCodeFileChanges([
        { file: "a.ts", patch: "@@ -1 +1 @@", status: "modified", additions: 1, deletions: 1 },
        { file: "missing.patch", status: "added", additions: 1, deletions: 0 },
        { patch: "@@", status: "deleted", additions: 0, deletions: 1 },
        {
          file: "unknown-status.ts",
          patch: "@@",
          status: "renamed",
          additions: 1,
          deletions: 1,
        } as unknown as SnapshotFileDiff,
        {
          file: "invalid-count.ts",
          patch: "@@",
          status: "modified",
          additions: -1,
          deletions: 1,
        },
        {
          file: 17,
          patch: "@@",
          status: "modified",
          additions: 1,
          deletions: 1,
        } as unknown as SnapshotFileDiff,
      ]),
    ).toEqual([{ path: "a.ts", kind: "update", unifiedDiff: "@@ -1 +1 @@" }]);
  });

  it("fails closed when a persisted revert boundary is absent", () => {
    expect(() =>
      projectOpenCodeHistory({
        session: session({ messageID: "missing" }),
        messages,
        toolOutputLimit: 1_000,
      }),
    ).toThrow("revert boundary is absent");
  });
});
