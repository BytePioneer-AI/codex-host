import type { JsonObject } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { mapOmpSnapshot, type OmpSessionHistory } from "../src/omp-history.js";

describe("OMP History snapshot mapping", () => {
  it("extracts subagent yield tool execution as an assistant agentMessage", () => {
    const history: OmpSessionHistory = {
      entries: [
        {
          id: "msg-user-1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Complete assignment thoroughly:\n# Target\nEcho confirmation",
              },
            ],
          },
        } as unknown as JsonObject,
        {
          id: "msg-assistant-1",
          parentId: "msg-user-1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_yield_1",
                name: "yield",
                arguments: {
                  result: {
                    data: {
                      message: "Test sub-agent execution confirmed.",
                    },
                  },
                },
              },
            ],
          },
        } as unknown as JsonObject,
        {
          id: "msg-tool-1",
          parentId: "msg-assistant-1",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call_yield_1",
            toolName: "yield",
            content: [{ type: "text", text: "Result submitted." }],
            details: {
              data: { message: "Test sub-agent execution confirmed." },
              status: "success",
            },
          },
        } as unknown as JsonObject,
      ],
      leafId: "msg-tool-1",
    };

    const snapshot = mapOmpSnapshot(history, {
      sessionId: "subagent-session-1",
      model: null,
    });

    expect(snapshot.turns).toHaveLength(1);
    const turn = snapshot.turns[0];
    expect(turn).toBeDefined();
    if (!turn) return;
    expect(turn.input).toEqual([
      { type: "text", text: "Complete assignment thoroughly:\n# Target\nEcho confirmation" },
    ]);

    const agentMessageItem = turn.items.find((item) => item.item.type === "agentMessage");
    expect(agentMessageItem).toBeDefined();
    expect(agentMessageItem?.item).toMatchObject({
      type: "agentMessage",
      text: "Test sub-agent execution confirmed.",
    });
  });

  it("extracts a yield summary field as the Agent Message", () => {
    const history: OmpSessionHistory = {
      entries: [
        {
          id: "msg-user-1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Inspect package.json" }],
          },
        } as unknown as JsonObject,
        {
          id: "msg-assistant-1",
          parentId: "msg-user-1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_yield_1",
                name: "yield",
                arguments: {
                  result: {
                    data: {
                      summary: "The package name is @hermes/find-clients.",
                    },
                  },
                },
              },
            ],
          },
        } as unknown as JsonObject,
        {
          id: "msg-tool-1",
          parentId: "msg-assistant-1",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call_yield_1",
            toolName: "yield",
            content: [{ type: "text", text: "Result submitted." }],
            details: {
              data: { summary: "The package name is @hermes/find-clients." },
              status: "success",
            },
          },
        } as unknown as JsonObject,
      ],
      leafId: "msg-tool-1",
    };

    const snapshot = mapOmpSnapshot(history, {
      sessionId: "subagent-session-2",
      model: null,
    });
    expect(
      snapshot.turns[0]?.items.find((item) => item.item.type === "agentMessage")?.item,
    ).toMatchObject({
      type: "agentMessage",
      text: "The package name is @hermes/find-clients.",
    });
  });

  it("keeps a steered User message inside the original Turn", () => {
    const history: OmpSessionHistory = {
      entries: [
        {
          id: "msg-user-1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "count to 200" }],
          },
        } as unknown as JsonObject,
        {
          id: "msg-assistant-1",
          parentId: "msg-user-1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "one two three" }],
            stopReason: "aborted",
            errorMessage: "Request was aborted",
          },
        } as unknown as JsonObject,
        {
          id: "msg-user-steer",
          parentId: "msg-assistant-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "say only HELLO" }],
            steering: true,
          },
        } as unknown as JsonObject,
        {
          id: "msg-assistant-2",
          parentId: "msg-user-steer",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "HELLO" }],
            stopReason: "stop",
          },
        } as unknown as JsonObject,
      ],
      leafId: "msg-assistant-2",
    };

    const snapshot = mapOmpSnapshot(history, {
      sessionId: "steer-session-1",
      model: null,
    });

    expect(snapshot.turns).toHaveLength(1);
    const turn = snapshot.turns[0];
    expect(turn).toBeDefined();
    if (!turn) return;
    expect(turn.nativeTurnRef.nativeTurnKey).toBe("msg-user-1");
    expect(turn.input).toEqual([{ type: "text", text: "count to 200" }]);
    expect(turn.outcome).toEqual({ status: "succeeded" });
    expect(
      turn.items
        .filter((item) => item.item.type === "agentMessage")
        .map((item) => item.item.type === "agentMessage" && item.item.text),
    ).toEqual(["one two three", "HELLO"]);
  });

  it("extracts turn and tool execution timestamps and duration from history entries", () => {
    const history: OmpSessionHistory = {
      entries: [
        {
          id: "msg-user-1",
          parentId: null,
          type: "message",
          timestamp: "2026-09-01T12:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Read file" }],
          },
        } as unknown as JsonObject,
        {
          id: "tool-start-1",
          parentId: "msg-user-1",
          type: "custom",
          customType: "tool_execution_start",
          timestamp: "2026-09-01T12:00:01.000Z",
          data: {
            toolCallId: "call_read_1",
            toolName: "read",
            startedAt: "2026-09-01T12:00:01.000Z",
          },
        } as unknown as JsonObject,
        {
          id: "msg-assistant-1",
          parentId: "tool-start-1",
          type: "message",
          timestamp: "2026-09-01T12:00:01.050Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_read_1",
                name: "read",
                arguments: { path: "hello.txt" },
              },
            ],
          },
        } as unknown as JsonObject,
        {
          id: "msg-tool-1",
          parentId: "msg-assistant-1",
          type: "message",
          timestamp: "2026-09-01T12:00:01.500Z",
          message: {
            role: "toolResult",
            toolCallId: "call_read_1",
            toolName: "read",
            content: [{ type: "text", text: "Hello world" }],
          },
        } as unknown as JsonObject,
        {
          id: "msg-assistant-2",
          parentId: "msg-tool-1",
          type: "message",
          timestamp: "2026-09-01T12:00:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done reading file." }],
            stopReason: "stop",
          },
        } as unknown as JsonObject,
      ],
      leafId: "msg-assistant-2",
    };

    const snapshot = mapOmpSnapshot(history, {
      sessionId: "session-1",
      model: null,
    });

    expect(snapshot.turns).toHaveLength(1);
    const turn = snapshot.turns[0];
    expect(turn).toBeDefined();
    if (!turn) return;
    expect(turn.startedAt).toBe(Date.parse("2026-09-01T12:00:00.000Z"));
    expect(turn.completedAt).toBe(Date.parse("2026-09-01T12:00:05.000Z"));
    expect(turn.durationMs).toBe(5000);

    const toolItem = turn.items.find((item) => item.item.type === "toolExecution");
    expect(toolItem).toBeDefined();
    expect(toolItem?.item).toMatchObject({
      type: "toolExecution",
      toolName: "read",
      durationMs: 500,
    });
  });

  it("projects historical subagent delegations and background process command executions", () => {
    const history: OmpSessionHistory = {
      entries: [
        {
          id: "entry-u1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "delegate and start process" }],
          },
        },
        {
          id: "entry-a1",
          parentId: "entry-u1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-task-1",
                name: "task",
                arguments: {
                  tasks: [{ task: "Scan repository", name: "scout-1" }],
                },
              },
              {
                type: "toolCall",
                id: "call-bash-bg",
                name: "bash",
                arguments: {
                  command: "npm run dev",
                  async: true,
                },
              },
            ],
          },
        },
        {
          id: "entry-r1",
          parentId: "entry-a1",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-task-1",
            toolName: "task",
            content: [{ type: "text", text: "Scouting complete" }],
            isError: false,
          },
        },
        {
          id: "entry-r2",
          parentId: "entry-r1",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-bash-bg",
            toolName: "bash",
            details: { jobId: "dev-server", pid: 9912 },
            content: [{ type: "text", text: "Started background process" }],
            isError: false,
          },
        },
      ],
      leafId: "entry-r2",
    };

    const snapshot = mapOmpSnapshot(history, {
      sessionId: "session-hist-1",
      model: null,
    });

    expect(snapshot.turns).toHaveLength(1);
    const turn = snapshot.turns[0];
    expect(turn).toBeDefined();
    if (!turn) return;

    const subagentItem = turn.items.find((item) => item.item.type === "subagentDelegation");
    expect(subagentItem).toBeDefined();
    expect(subagentItem?.item).toMatchObject({
      type: "subagentDelegation",
      operation: "spawn",
      subagents: [
        {
          nativeSubagentId: "scout-1",
          status: "completed",
        },
      ],
    });

    const processItem = turn.items.find((item) => item.item.type === "commandExecution");
    expect(processItem).toBeDefined();
    expect(processItem?.item).toMatchObject({
      type: "commandExecution",
      command: "npm run dev",
      processId: "dev-server",
    });
  });

  it("projects history with bash_<hex> async job as commandExecution and not subagent", () => {
    const history: OmpSessionHistory = {
      entries: [
        {
          id: "entry-u1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "run bun test in background" }],
          },
        },
        {
          id: "entry-a1",
          parentId: "entry-u1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-bash-1",
                name: "bash",
                arguments: {
                  command: "bun test",
                  async: true,
                },
              },
            ],
          },
        },
        {
          id: "entry-r1",
          parentId: "entry-a1",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-bash-1",
            toolName: "bash",
            details: { jobId: "bash_fcf988" },
            content: [{ type: "text", text: "Started job bash_fcf988" }],
            isError: false,
          },
        },
      ],
      leafId: "entry-r1",
    };

    const snapshot = mapOmpSnapshot(history, {
      sessionId: "session-hist-2",
      model: null,
    });

    expect(snapshot.turns).toHaveLength(1);
    const turn = snapshot.turns[0];
    expect(turn).toBeDefined();
    if (!turn) return;

    const subagents = turn.items.filter((item) => item.item.type === "subagentDelegation");
    expect(subagents).toHaveLength(0);

    const processItem = turn.items.find((item) => item.item.type === "commandExecution");
    expect(processItem).toBeDefined();
    expect(processItem?.item).toMatchObject({
      type: "commandExecution",
      command: "bun test",
      processId: "bash_fcf988",
    });
  });

  it("projects hyphenated hub terminal history as a process, not a Subagent", () => {
    const history: OmpSessionHistory = {
      entries: [
        {
          id: "entry-u1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "start term-1" }],
          },
        },
        {
          id: "entry-a1",
          parentId: "entry-u1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-hub-1",
                name: "bash",
                arguments: {
                  command: "hub start term-1 -- bash --norc --noprofile",
                },
              },
            ],
          },
        },
        {
          id: "entry-r1",
          parentId: "entry-a1",
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-hub-1",
            toolName: "bash",
            content: [
              { type: "text", text: "Started term-1: running pid=1416880 uptime=11ms restarts=0" },
            ],
            isError: false,
          },
        },
      ],
      leafId: "entry-r1",
    };

    const snapshot = mapOmpSnapshot(history, {
      sessionId: "session-hist-term",
      model: null,
    });
    const turn = snapshot.turns[0];
    expect(turn).toBeDefined();
    if (!turn) return;
    expect(turn.items.filter((item) => item.item.type === "subagentDelegation")).toHaveLength(0);
    expect(turn.items.find((item) => item.item.type === "commandExecution")?.item).toMatchObject({
      type: "commandExecution",
      processId: "term-1",
      command: "hub start term-1 -- bash --norc --noprofile",
      osPid: 1416880,
    });
  });
});
