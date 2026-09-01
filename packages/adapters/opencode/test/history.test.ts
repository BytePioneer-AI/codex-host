import type { AssistantMessage, Session, TextPart, UserMessage } from "@opencode-ai/sdk/v2";
import { nativeCheckpointRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  projectOpenCodeHistory,
  reliableOpenCodeFileChanges,
  resolveOpenCodeForkBoundary,
  resolveOpenCodeLastTurnBoundary,
  type OpenCodeMessageWithParts,
} from "../src/history.js";

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

  it("projects only complete native Diffs", () => {
    expect(
      reliableOpenCodeFileChanges([
        { file: "a.ts", patch: "@@ -1 +1 @@", status: "modified", additions: 1, deletions: 1 },
        { file: "missing.patch", status: "added", additions: 1, deletions: 0 },
        { patch: "@@", status: "deleted", additions: 0, deletions: 1 },
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
