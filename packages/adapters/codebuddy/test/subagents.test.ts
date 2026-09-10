import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { CodeBuddySubagents } from "../src/subagents.js";
import { snapshotFromHistory } from "../src/history.js";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCodeBuddyChild } from "../src/subagent-history.js";

const parent = nativeSessionRefSchema.parse({
  harnessId: "codebuddy",
  nativeSessionId: "parent",
  formatVersion: 1,
});
const start = {
  sessionUpdate: "tool_call",
  toolCallId: "spawn-1",
  rawInput: {
    description: "Read files",
    subagent_type: "Explore",
    model: "child-model",
    prompt: "Read A",
    run_in_background: false,
  },
  _meta: { "codebuddy.ai/toolName": "Agent", "codebuddy.ai/toolArgumentsComplete": true },
};

describe("CodeBuddy native Subagent projection", () => {
  it("does not emit stale progress after cancellation while a native file read is pending", async () => {
    const events: HostEvent[] = [];
    let resolve!: (id: string) => void;
    const manager = new CodeBuddySubagents({
      parent: () => parent,
      cwd: "/work",
      environment: {},
      emit: (e) => events.push(e),
      locate: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    manager.begin(hostTurnIdSchema.parse("turn"));
    manager.update(start);
    manager.update({
      _meta: {
        "codebuddy.ai/parentToolCallId": "spawn-1",
        "codebuddy.ai/conversationRequestId": "req",
      },
    });
    await Promise.resolve();
    const pending = manager.refresh();
    manager.close();
    const count = events.length;
    resolve("agent-late");
    await pending;
    expect(events).toHaveLength(count);
  });
  it("reads a bounded native child with an in-flight tail and rejects mixed workspaces, identity and redirected paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cb-child-"));
    try {
      const cwd = path.join(root, "work"),
        other = path.join(root, "other"),
        config = path.join(root, "config");
      const project = path.join(config, "projects", "fixture"),
        children = path.join(project, "parent", "subagents");
      await Promise.all([mkdir(cwd), mkdir(other), mkdir(children, { recursive: true })]);
      const environment = { CODEBUDDY_CONFIG_DIR: config };
      await writeFile(
        path.join(project, "parent.jsonl"),
        JSON.stringify({
          id: "user",
          type: "message",
          role: "user",
          content: "delegate",
          cwd,
          sessionId: "parent",
        }),
      );
      const file = path.join(children, "agent-child.jsonl");
      const row = {
        id: "user",
        type: "message",
        role: "user",
        content: "read files",
        cwd,
        sessionId: "native-child",
      };
      await writeFile(file, JSON.stringify(row) + '\n{"inflight":');
      expect(
        (await readCodeBuddyChild(parent, "agent-child", cwd, environment, "running")).turns[0]
          ?.outcome.status,
      ).toBe("unknown");
      await expect(readCodeBuddyChild(parent, "../outside", cwd, environment)).rejects.toThrow(
        "Invalid native Subagent ID",
      );
      await writeFile(file, JSON.stringify({ ...row, cwd: other }));
      await expect(readCodeBuddyChild(parent, "agent-child", cwd, environment)).rejects.toThrow(
        "workspace differs",
      );
      await writeFile(
        file,
        [row, { ...row, id: "other", sessionId: "different" }]
          .map((r) => JSON.stringify(r))
          .join("\n"),
      );
      await expect(readCodeBuddyChild(parent, "agent-child", cwd, environment)).rejects.toThrow(
        "identity is missing or mixed",
      );
      await writeFile(file, JSON.stringify(row) + '\n{"invalid":\n');
      await expect(readCodeBuddyChild(parent, "agent-child", cwd, environment)).rejects.toThrow();
      await rm(children, { recursive: true });
      await symlink(other, children, process.platform === "win32" ? "junction" : "dir");
      await expect(readCodeBuddyChild(parent, "agent-child", cwd, environment)).rejects.toThrow(
        "Redirected CodeBuddy Subagent directory",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("creates one card, resolves native identity during execution, and emits child progress before completion", async () => {
    const events: HostEvent[] = [];
    const manager = new CodeBuddySubagents({
      parent: () => parent,
      cwd: "/work",
      environment: {},
      emit: (event) => events.push(event),
      locate: async () => "agent-child",
      read: async () => ({ turns: [] }),
    });
    manager.begin(hostTurnIdSchema.parse("turn"));
    try {
      manager.update(start);
      manager.update(start);
      expect(events.filter((e) => e.type === "item.started")).toHaveLength(1);
      expect(
        manager.update({
          sessionUpdate: "tool_call",
          title: "Read A",
          _meta: {
            "codebuddy.ai/parentToolCallId": "spawn-1",
            "codebuddy.ai/toolArgumentsComplete": true,
            "codebuddy.ai/conversationRequestId": "child-request",
          },
        }),
      ).toBe(true);
      await manager.refresh();
      await manager.refresh();
      expect(
        events.some(
          (e) =>
            e.type === "subagent.state.changed" &&
            e.nativeSubagentId === "agent-child" &&
            e.status === "running",
        ),
      ).toBe(true);
      expect(events.some((e) => e.type === "subagent.transcript.changed")).toBe(true);
      expect(events.filter((e) => e.type === "item.completed")).toHaveLength(0);
      manager.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "spawn-1",
        status: "completed",
        rawOutput: { type: "text", text: "done\n\n[Agent ID: agent-child]" },
      });
      manager.finish({ status: "succeeded" });
      expect(events.filter((e) => e.type === "item.completed")).toMatchObject([
        {
          snapshot: {
            item: {
              type: "subagentDelegation",
              subagents: [
                { nativeSubagentId: "agent-child", status: "completed", model: "child-model" },
              ],
            },
          },
        },
      ]);
    } finally {
      manager.close();
    }
  });
  it("does not promote background spawn completion or loss of observation into child success", () => {
    const events: HostEvent[] = [];
    const manager = new CodeBuddySubagents({
      parent: () => undefined,
      cwd: "/work",
      environment: {},
      emit: (e) => events.push(e),
    });
    manager.begin(hostTurnIdSchema.parse("turn"));
    manager.update({ ...start, rawInput: { ...start.rawInput, run_in_background: true } });
    manager.update({
      toolCallId: "spawn-1",
      status: "completed",
      rawOutput: { type: "text", text: "started\n\n[Agent ID: agent-child]" },
    });
    expect(manager.state("agent-child")?.status).toBe("running");
    manager.finish({ status: "succeeded" });
    expect(manager.state("agent-child")?.status).toBe("interrupted");
    manager.close();
  });
  it("retains the same native child in parent history", () => {
    const records = [
      { id: "user", type: "message", role: "user", content: "delegate" },
      {
        id: "call",
        parentId: "user",
        type: "function_call",
        callId: "spawn-1",
        name: "Agent",
        arguments: JSON.stringify(start.rawInput),
      },
      {
        id: "result",
        parentId: "call",
        type: "function_call_result",
        callId: "spawn-1",
        status: "completed",
        output: { type: "text", text: "done" },
        providerData: { toolResult: { subAgent: { sessionId: "agent-child" } } },
      },
    ];
    const snapshot = snapshotFromHistory(
      records.map((r) => JSON.stringify(r)).join("\n"),
      parent,
      "/work",
    );
    expect(snapshot.turns[0]?.items[0]?.item).toMatchObject({
      type: "subagentDelegation",
      subagents: [{ nativeSubagentId: "agent-child", status: "completed" }],
    });
  });
});
