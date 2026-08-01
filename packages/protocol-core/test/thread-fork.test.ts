import { describe, expect, it } from "vitest";

import {
  decodeThreadForkRequest,
  decodeThreadRollbackRequest,
  mapExternalThreadHarnessError,
  threadForkResult,
  threadRollbackResult,
} from "../src/index.js";

describe("Codex thread/fork protocol boundary", () => {
  it("decodes current inclusive, exclusive, and tail request fields", () => {
    expect(
      decodeThreadForkRequest({
        id: 1,
        method: "thread/fork",
        params: {
          threadId: "thread-1",
          lastTurnId: "turn-1",
          path: "",
          model: "pi-native",
          modelProvider: "codexhost",
          cwd: "/workspace",
          excludeTurns: true,
          runtimeWorkspaceRoots: ["/workspace"],
          approvalPolicy: "never",
          sandbox: "workspace-write",
        },
      }),
    ).toEqual({
      threadId: "thread-1",
      lastTurnId: "turn-1",
      model: "pi-native",
      modelProvider: "codexhost",
      cwd: "/workspace",
      excludeTurns: true,
      runtimeWorkspaceRoots: ["/workspace"],
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    expect(
      decodeThreadForkRequest({
        id: 2,
        method: "thread/fork",
        params: { threadId: "thread-1", beforeTurnId: "turn-2" },
      }),
    ).toMatchObject({ beforeTurnId: "turn-2", excludeTurns: false });
    expect(decodeThreadForkRequest({ id: 3, method: "thread/read", params: {} })).toBeNull();
  });

  it("rejects conflicting or malformed external Fork boundaries", () => {
    expect(() =>
      decodeThreadForkRequest({
        id: 1,
        method: "thread/fork",
        params: { threadId: "thread-1", lastTurnId: "one", beforeTurnId: "two" },
      }),
    ).toThrow("cannot combine");
    expect(() =>
      decodeThreadForkRequest({
        id: 2,
        method: "thread/fork",
        params: { threadId: "thread-1", excludeTurns: "yes" },
      }),
    ).toThrow("excludeTurns must be boolean");
  });

  it("decodes the current bounded thread/rollback request", () => {
    expect(
      decodeThreadRollbackRequest({
        id: 4,
        method: "thread/rollback",
        params: { threadId: "derived-thread", numTurns: 2 },
      }),
    ).toEqual({ threadId: "derived-thread", numTurns: 2 });
    expect(decodeThreadRollbackRequest({ id: 5, method: "thread/read", params: {} })).toBeNull();
    for (const numTurns of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
      expect(() =>
        decodeThreadRollbackRequest({
          id: 6,
          method: "thread/rollback",
          params: { threadId: "derived-thread", numTurns },
        }),
      ).toThrow("positive safe integer");
    }
  });

  it("maps Harness failures to bounded external errors", () => {
    expect(
      mapExternalThreadHarnessError(
        {
          code: "sessionNotFound",
          message: "D:/private/session.jsonl is missing",
          retryable: false,
        },
        "resume",
      ),
    ).toEqual({ code: -32079, message: "External Native Session is unavailable" });
    expect(
      mapExternalThreadHarnessError(
        { code: "checkpointNotFound", message: "native entry secret", retryable: false },
        "fork",
      ),
    ).toEqual({ code: -32080, message: "External Fork Checkpoint is unavailable" });
  });

  it("builds the current ThreadRollbackResponse envelope", () => {
    expect(threadRollbackResult({ id: "derived", turns: [{}] })).toEqual({
      thread: { id: "derived", turns: [{}] },
    });
  });

  it("builds the current ThreadForkResponse envelope", () => {
    expect(
      threadForkResult(
        { id: "derived", turns: [] },
        {
          model: "pi-native",
          cwd: "/workspace",
          runtimeWorkspaceRoots: ["/workspace"],
          approvalPolicy: "never",
          sandbox: { type: "workspaceWrite" },
        },
      ),
    ).toMatchObject({
      thread: { id: "derived", turns: [] },
      model: "pi-native",
      modelProvider: "codexhost",
      cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace"],
      instructionSources: [],
      approvalsReviewer: "user",
      multiAgentMode: "explicitRequestOnly",
    });
  });
});
