import { describe, expect, it } from "vitest";

import {
  isOmpKillTool,
  isOmpProcessId,
  isOmpProcessPayload,
  isOmpProcessRole,
  isOmpProcessTool,
  isOmpWaitTool,
  normalizeOmpEffort,
  ompNativeSubagentId,
  ompNativeSubagentIds,
  ompProcessCommand,
  ompSubagentBackground,
  ompSubagentDescription,
  ompSubagentModel,
  ompSubagentOperation,
  ompSubagentPrompt,
  ompSubagentReasoningEffort,
  ompSubagentResultSummary,
  ompSubagentRole,
  ompSubagentSpawnSpecs,
  ompSubagentWaitSettlements,
} from "../src/omp-subagent.js";

describe("OMP Subagent helpers", () => {
  it("recognizes subagent tools and operations", () => {
    expect(ompSubagentOperation("task", {})).toBe("spawn");
    expect(ompSubagentOperation("Task", {})).toBe("spawn");
    expect(ompSubagentOperation("agent", {})).toBe("spawn");
    expect(ompSubagentOperation("subagent", {})).toBe("spawn");
    expect(ompSubagentOperation("spawn_subagent", {})).toBe("spawn");
    expect(ompSubagentOperation("delegate", {})).toBe("spawn");
    expect(ompSubagentOperation("send_subagent_message", {})).toBe("send");
    expect(ompSubagentOperation("send_message", {})).toBe("send");
    expect(ompSubagentOperation("hub", { op: "send" })).toBe("send");
    expect(ompSubagentOperation("hub", { op: "start" })).toBeNull();
    expect(ompSubagentOperation("hub", { op: "wait" })).toBeNull();
    expect(ompSubagentOperation("bash", { command: "sleep 10", async: true })).toBeNull();
    expect(isOmpProcessTool("hub", { op: "start" })).toBe(true);
    expect(isOmpProcessTool("bash", { command: "sleep 10", async: true })).toBe(true);
    expect(
      ompProcessCommand("hub", {
        op: "start",
        name: "web",
        application: "bun",
        args: ["run", "dev"],
      }),
    ).toBe("hub start web -- bun run dev");
    expect(isOmpWaitTool("hub", { op: "wait" })).toBe(true);
    expect(isOmpWaitTool("hub", { op: "jobs" })).toBe(true);
    expect(isOmpKillTool("hub", { op: "cancel" })).toBe(true);
    expect(isOmpKillTool("hub", { op: "stop" })).toBe(true);
    expect(ompSubagentOperation("bash", {})).toBeNull();
    expect(ompSubagentOperation("edit", {})).toBeNull();
    expect(ompSubagentOperation("read", {})).toBeNull();
    expect(ompSubagentOperation("wait_tasks", {})).toBeNull();
  });

  it("extracts description, prompt, role, model, effort from single-task arguments", () => {
    const args = {
      task: "Analyze the architecture of codexhost",
      agent: "task",
      model: "xai/grok-4.6",
      effort: "hi",
      background: true,
      subagent_id: "child-agent-42",
    };

    expect(ompSubagentDescription(args, "task")).toBe("Analyze the architecture of codexhost");
    expect(ompSubagentPrompt(args)).toBe("Analyze the architecture of codexhost");
    expect(ompSubagentRole(args)).toBe("task");
    expect(ompSubagentModel(args)).toBe("xai/grok-4.6");
    expect(ompSubagentReasoningEffort(args)).toBe("high");
    expect(ompSubagentBackground(args)).toBe(true);
    expect(ompNativeSubagentId(args)).toBe("child-agent-42");
  });

  it("extracts native subagent id from tasks[0].name and details", () => {
    const argsWithName = {
      tasks: [
        {
          name: "TestSubagent",
          task: "Echo confirmation",
        },
      ],
    };
    expect(ompNativeSubagentId(argsWithName)).toBe("TestSubagent");
    expect(ompSubagentDescription(argsWithName, "task")).toBe("TestSubagent");

    const resultWithAsync = {
      details: {
        async: {
          jobId: "TestSubagent",
        },
      },
    };
    expect(ompNativeSubagentId(resultWithAsync)).toBe("TestSubagent");
  });

  it("parses wait settlements from hub details and text", () => {
    const hubResult = {
      details: {
        op: "wait",
        jobs: [
          {
            id: "TestSubagent",
            type: "task",
            status: "completed",
            label: "TestSubagent",
            resultText: "Execution confirmed",
          },
        ],
      },
    };
    const settlements = ompSubagentWaitSettlements({
      name: "hub",
      rawInput: { op: "wait" },
      rawOutput: hubResult,
    });
    expect(settlements).toEqual([
      {
        id: "TestSubagent",
        status: "completed",
        resultSummary: "Execution confirmed",
      },
    ]);
    expect(
      ompSubagentWaitSettlements({
        name: "hub",
        rawInput: { op: "wait" },
        rawOutput: {
          details: {
            op: "wait",
            jobs: [
              { id: "LiveSubagent", type: "task", status: "working", output: "still working" },
            ],
          },
        },
      }),
    ).toEqual([{ id: "LiveSubagent", status: "running", resultSummary: "still working" }]);
  });

  it("normalizes reasoning effort strings", () => {
    expect(normalizeOmpEffort("lo")).toBe("low");
    expect(normalizeOmpEffort("low")).toBe("low");
    expect(normalizeOmpEffort("med")).toBe("medium");
    expect(normalizeOmpEffort("medium")).toBe("medium");
    expect(normalizeOmpEffort("hi")).toBe("high");
    expect(normalizeOmpEffort("high")).toBe("high");
    expect(normalizeOmpEffort("xhigh")).toBe("xhigh");
    expect(normalizeOmpEffort("max")).toBe("xhigh");
    expect(normalizeOmpEffort(undefined)).toBeUndefined();
  });

  it("extracts description, prompt, role from batch-task arguments", () => {
    const batchArgs = {
      context: "Shared context across all subagents",
      tasks: [
        {
          task: "Subagent 1: inspect protocol",
          agent: "sonic",
          model: "grok-4.6",
          effort: "med",
        },
        {
          task: "Subagent 2: inspect adapters",
          agent: "librarian",
        },
      ],
    };

    expect(ompSubagentDescription(batchArgs, "task")).toBe("Subagent 1: inspect protocol");
    expect(ompSubagentPrompt(batchArgs)).toContain("Subagent 1: inspect protocol");
    expect(ompSubagentPrompt(batchArgs)).toContain("Subagent 2: inspect adapters");
    expect(ompSubagentRole(batchArgs)).toBe("sonic");
    expect(ompSubagentModel(batchArgs)).toBe("grok-4.6");
    expect(ompSubagentReasoningEffort(batchArgs)).toBe("medium");
    expect(ompSubagentSpawnSpecs(batchArgs, "task")).toEqual([
      {
        description: "Subagent 1: inspect protocol",
        prompt: "Subagent 1: inspect protocol",
        role: "sonic",
        model: "grok-4.6",
        reasoningEffort: "medium",
        background: true,
      },
      {
        description: "Subagent 2: inspect adapters",
        prompt: "Subagent 2: inspect adapters",
        role: "librarian",
        background: true,
      },
    ]);
  });

  it("extracts every named Agent from a batch spawn", () => {
    const batchArgs = {
      tasks: [
        {
          name: "RepoInspector",
          agent: "scout",
          task: "Read package.json",
        },
        {
          name: "DocsInspector",
          agent: "scout",
          task: "List docs",
        },
      ],
    };
    expect(ompSubagentSpawnSpecs(batchArgs, "task")).toEqual([
      {
        description: "RepoInspector",
        prompt: "Read package.json",
        role: "scout",
        background: true,
        nativeSubagentId: "RepoInspector",
      },
      {
        description: "DocsInspector",
        prompt: "List docs",
        role: "scout",
        background: true,
        nativeSubagentId: "DocsInspector",
      },
    ]);
    expect(
      ompNativeSubagentIds({
        details: {
          progress: [
            { id: "RepoInspector", status: "pending" },
            { id: "DocsInspector", status: "pending" },
          ],
          async: { jobId: "RepoInspector" },
        },
      }),
    ).toEqual(["RepoInspector", "DocsInspector"]);
  });

  it("extracts result summaries and IDs from outputs", () => {
    expect(ompSubagentResultSummary("Completed successfully")).toBe("Completed successfully");
    expect(ompSubagentResultSummary({ result: "Finished task with 0 errors" })).toBe(
      "Finished task with 0 errors",
    );
    expect(ompNativeSubagentId({ task_id: "task-99" })).toBe("task-99");
    expect(ompNativeSubagentId("subagent_id: agent-xyz")).toBe("agent-xyz");
  });

  it("handles hub start and background process parameters", () => {
    const hubStartArgs = {
      op: "start",
      name: "test-ticker",
      application: "bun",
      args: ["run", "ticker.js"],
    };

    expect(ompSubagentOperation("hub", hubStartArgs)).toBeNull();
    expect(isOmpProcessTool("hub", hubStartArgs)).toBe(true);
    expect(ompProcessCommand("hub", hubStartArgs)).toBe(
      "hub start test-ticker -- bun run ticker.js",
    );
    expect(ompSubagentDescription(hubStartArgs, "hub")).toBe("test-ticker");
    expect(ompSubagentPrompt(hubStartArgs)).toBe("bun run ticker.js");
    expect(ompNativeSubagentId(hubStartArgs)).toBe("test-ticker");
    expect(
      isOmpProcessTool("bash", {
        command: "hub start term-1 -- bash --norc --noprofile",
      }),
    ).toBe(true);
    expect(isOmpProcessTool("hub", { command: "hub start terminal-1 -- bash" })).toBe(true);
    expect(ompNativeSubagentId({ command: "hub start terminal-1 -- bash" })).toBe("terminal-1");
    expect(
      ompNativeSubagentId("Daemon terminal-2 has unacknowledged completion notifications"),
    ).toBe("terminal-2");
    expect(isOmpProcessTool("hub", { command: ["hub", "start", "terminal-1", "--", "bash"] })).toBe(
      true,
    );
    expect(ompNativeSubagentId({ command: ["hub", "start", "terminal-1", "--", "bash"] })).toBe(
      "terminal-1",
    );
    expect(
      ompNativeSubagentId({
        command: "hub start term-2 -- bash --norc --noprofile",
      }),
    ).toBe("term-2");
    expect(ompNativeSubagentId("Started term-3: running pid=1416880 uptime=11ms restarts=0")).toBe(
      "term-3",
    );
    expect(
      isOmpProcessTool("eval", {
        language: "js",
        title: "start ticker",
        code: 'await tool.hub({ op: "start", name: "ticker", application: "bash" })',
      }),
    ).toBe(true);
    expect(
      ompNativeSubagentId({
        language: "js",
        code: 'await tool.hub({ op: "start", name: "ticker", application: "bash" })',
      }),
    ).toBe("ticker");

    expect(isOmpProcessId("bash_fcf988")).toBe(true);
    expect(isOmpProcessId("proc_1234")).toBe(true);
    expect(isOmpProcessId("term_main")).toBe(true);
    expect(isOmpProcessId("term-1")).toBe(true);
    expect(isOmpProcessId("terminal-3")).toBe(true);
    expect(isOmpProcessPayload({ id: "term-1", status: "started" })).toBe(true);
    expect(isOmpProcessPayload({ id: "terminal-3", description: "counting loop" })).toBe(true);
    expect(isOmpProcessId("task_agent_1")).toBe(false);
    expect(isOmpProcessRole("process")).toBe(true);
    expect(isOmpProcessRole("terminal")).toBe(true);
    expect(isOmpProcessRole("bash")).toBe(true);
    expect(isOmpProcessRole("scout")).toBe(false);
    expect(
      isOmpProcessPayload({ id: "bash_fcf988", description: "Run `bun test` in background" }),
    ).toBe(true);
    expect(isOmpProcessPayload({ id: "agent-1", role: "process" })).toBe(true);
    expect(isOmpProcessPayload({ id: "agent-1", role: "scout" })).toBe(false);

    const killSettlements = ompSubagentWaitSettlements({
      name: "hub",
      rawInput: { op: "stop", name: "test-ticker" },
      rawOutput: { ok: true },
    });
    expect(killSettlements).toEqual([{ id: "test-ticker", status: "interrupted" }]);
  });
});
