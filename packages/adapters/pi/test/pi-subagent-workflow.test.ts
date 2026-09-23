import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  piWorkflowSummary,
  piWorkflowSubagentId,
  parsePiWorkflowSubagentId,
} from "../src/pi-subagent-workflow.js";
import { readPiWorkflowChild } from "../src/pi-workflow-child-history.js";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { PiSubagents } from "../src/pi-subagents.js";
import { mapPiSnapshot, type PiSessionHistory } from "../src/pi-history.js";

// Minimized shape of the reported four-worker async:false workflow. Not asyncId/asyncDir.
export function workflowResult(state = "completed") {
  return {
    details: {
      mode: "workflow",
      runId: "parent-call",
      workflowChildren: {
        version: 1,
        parentToolCallId: "parent-call",
        workflowRunId: "parent-call",
        inventoryComplete: true,
        workflowState: state,
        children: ["t1", "t2", "t3", "t4"].map((childId) => ({
          childId,
          runId: `child-${childId}`,
          agent: "delegate",
          state,
          sessionName: `Delegate ${childId}`,
          model: "provider/model",
        })),
      },
      results: ["t1", "t2", "t3", "t4"].map((workflowKey) => ({
        index: 0,
        workflowKey,
        agent: "delegate",
        exitCode: 0,
        outputState: "present",
        finalOutput: `${workflowKey} OK`,
      })),
    },
  };
}
export function workflowHistory(): PiSessionHistory {
  return {
    leafId: "result",
    entries: [
      {
        id: "user",
        parentId: null,
        type: "message",
        message: { role: "user", content: "test four children" },
      },
      {
        id: "assistant",
        parentId: "user",
        type: "message",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "parent-call",
              name: "subagent",
              arguments: { async: false, workflowScript: "await runs.all(...)" },
            },
          ],
        },
      },
      {
        id: "result",
        parentId: "assistant",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "parent-call",
          toolName: "subagent",
          isError: false,
          content: [],
          ...workflowResult(),
        },
      },
    ],
  };
}

describe("Pi synchronous workflow subagents", () => {
  it("rejects unknown protocols, mismatched calls and duplicate child identities", () => {
    const result = workflowResult();
    expect(
      piWorkflowSummary({
        details: {
          ...result.details,
          workflowChildren: { ...result.details.workflowChildren, version: 2 },
        },
      }),
    ).toBeNull();
    expect(piWorkflowSummary({ details: { ...result.details, runId: "wrong" } })).toBeNull();
    expect(
      piWorkflowSummary({
        details: {
          ...result.details,
          workflowChildren: {
            ...result.details.workflowChildren,
            children: [
              result.details.workflowChildren.children[0],
              result.details.workflowChildren.children[0],
            ],
          },
        },
      }),
    ).toBeNull();
    expect(
      new PiSubagents(() => undefined).project(
        "subagent",
        result,
        hostItemIdSchema.parse("item"),
        "another-call",
      ),
    ).toBeNull();
    const address = { workflowRunId: "parent-call", childId: "review/path" };
    expect(parsePiWorkflowSubagentId(piWorkflowSubagentId(address))).toEqual(address);
    expect(() => parsePiWorkflowSubagentId(piWorkflowSubagentId(address) + "=")).toThrow();
  });

  it("does not lose child failures just because the enclosing tool is an error", () => {
    const history = workflowHistory();
    const last = history.entries.at(-1);
    if (!last) throw new Error("Missing fixture entry");
    last.message = {
      role: "toolResult",
      toolCallId: "parent-call",
      toolName: "subagent",
      isError: true,
      content: [],
      ...workflowResult("failed"),
    };
    const snapshot = mapPiSnapshot(history, { sessionId: "parent", model: null });
    const delegation = snapshot.turns[0]?.items.find(
      ({ item }) => item.type === "subagentDelegation",
    );
    expect(delegation?.item).toMatchObject({
      subagents: [
        { status: "failed" },
        { status: "failed" },
        { status: "failed" },
        { status: "failed" },
      ],
    });
  });

  it("reads only the child referenced by native parent history, then falls back to its saved result after pruning", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-child-"));
    try {
      const sessionFile = path.join(dir, "child.jsonl");
      await writeFile(
        sessionFile,
        [
          { type: "session", version: 3, id: "child-session", cwd: dir },
          {
            type: "message",
            id: "child-user",
            parentId: null,
            message: { role: "user", content: "task" },
          },
          {
            type: "message",
            id: "child-answer",
            parentId: "child-user",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "native child answer" }],
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const history = workflowHistory();
      const result = workflowResult();
      const last = history.entries.at(-1);
      if (!last) throw new Error("Missing fixture entry");
      last.message = {
        role: "toolResult",
        toolCallId: "parent-call",
        toolName: "subagent",
        isError: false,
        content: [],
        details: {
          ...result.details,
          results: result.details.results.map((child) => ({
            ...child,
            ...(child.workflowKey === "t1" ? { sessionFile } : {}),
          })),
        },
      };
      const address = { workflowRunId: "parent-call", childId: "t1" };
      const read = await readPiWorkflowChild(history, "parent-session", address);
      expect(read).toMatchObject({
        ok: true,
        value: {
          turns: [
            {
              nativeTurnRef: { nativeSessionId: "parent-session" },
              items: [{ item: { text: "native child answer" } }],
            },
          ],
        },
      });
      if (read.ok) expect(read.value.turns[0]?.checkpoint).toBeUndefined();
      await rm(sessionFile);
      const fallback = await readPiWorkflowChild(history, "parent-session", address);
      expect(fallback).toMatchObject({ ok: true });
      expect(JSON.stringify(fallback)).toContain("saved native result");
      expect(JSON.stringify(fallback)).toContain("t1 OK");
      expect(
        await readPiWorkflowChild(history, "parent-session", {
          ...address,
          childId: "foreign-child",
        }),
      ).toMatchObject({ ok: false });
      expect(
        await readPiWorkflowChild({ entries: [], leafId: null }, "parent-session", address),
      ).toMatchObject({ ok: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores all four real children without an async widget or async receipt", () => {
    const snapshot = mapPiSnapshot(
      workflowHistory(),
      { sessionId: "parent-session", model: null },
      new PiSubagents(() => undefined),
    );
    const children = snapshot.turns
      .flatMap((turn) => turn.items)
      .flatMap(({ item }) => (item.type === "subagentDelegation" ? item.subagents : []));
    expect(children).toHaveLength(4);
    expect(new Set(children.map((child) => child.nativeSubagentId)).size).toBe(4);
    expect(children.every((child) => child.status === "completed")).toBe(true);
  });

  it("updates one live card across partial and terminal workflow summaries", () => {
    const events: HostEvent[] = [];
    const observer = new PiSubagents((event) => events.push(event));
    const turn = hostTurnIdSchema.parse("turn");
    observer.start(turn, "subagent", workflowResult("running"), hostItemIdSchema.parse("first"));
    observer.start(turn, "subagent", workflowResult(), hostItemIdSchema.parse("second"));
    observer.finish(turn);
    expect(events.filter((event) => event.type === "item.started")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "item.updated", itemId: "first" }),
    );
    const terminal = events.find((event) => event.type === "item.completed");
    expect(terminal).toMatchObject({
      snapshot: {
        item: {
          itemId: "first",
          subagents: [
            { status: "completed" },
            { status: "completed" },
            { status: "completed" },
            { status: "completed" },
          ],
        },
      },
    });
  });
});
