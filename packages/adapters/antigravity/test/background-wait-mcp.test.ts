import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME,
  ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME,
  createAntigravityBackgroundMcpServer,
  isAntigravityBackgroundWaitTool,
  serveBackgroundWaitMcp,
  waitForBackgroundTask,
} from "../src/background-wait-mcp.js";
import { nativeBrainDirPath, nativeConversationSummariesDbPath } from "../src/fork.js";

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-bg-wait-"));
  homes.push(dir);
  return dir;
}

async function setupSummariesDb(
  home: string,
  childId: string,
  parentId: string,
  status: "CASCADE_RUN_STATUS_RUNNING" | "CASCADE_RUN_STATUS_IDLE",
): Promise<string> {
  const summaryDbPath = nativeConversationSummariesDbPath(home);
  await mkdir(path.dirname(summaryDbPath), { recursive: true });
  const db = new DatabaseSync(summaryDbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, status TEXT);",
  );
  db.prepare("INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?)").run(
    childId,
    parentId,
    status,
  );
  db.close();
  return summaryDbPath;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Antigravity background task wait MCP", () => {
  it("resolves immediately when a background command message is already written", async () => {
    const home = await tempHome();
    const convId = randomUUID();
    const messagesDir = path.join(
      nativeBrainDirPath(convId, home),
      ".system_generated",
      "messages",
    );
    await mkdir(messagesDir, { recursive: true });
    await writeFile(
      path.join(messagesDir, `${randomUUID()}.json`),
      JSON.stringify({
        id: randomUUID(),
        recipient: convId,
        sender: `${convId}/task-12`,
        content: "Task finished",
      }),
    );

    const result = await waitForBackgroundTask({
      home,
      taskId: `${convId}/task-12`,
      timeoutMs: 500,
    });
    expect(result.isError).toBeUndefined();
    expect(result.message).toContain(`${convId}/task-12`);
  });

  it("blocks until the matching background task writes its completion message", async () => {
    const home = await tempHome();
    const convId = randomUUID();
    const messagesDir = path.join(
      nativeBrainDirPath(convId, home),
      ".system_generated",
      "messages",
    );

    const waiting = waitForBackgroundTask({
      home,
      taskId: "task-42",
      conversationId: convId,
      timeoutMs: 5_000,
      recheckIntervalMs: 40,
    });

    setTimeout(async () => {
      await mkdir(messagesDir, { recursive: true });
      await writeFile(
        path.join(messagesDir, "unrelated.json"),
        JSON.stringify({ id: "u1", sender: `${convId}/task-99` }),
      );
      await writeFile(
        path.join(messagesDir, "done.json"),
        JSON.stringify({ id: "u2", sender: `${convId}/task-42` }),
      );
    }, 60);

    const result = await waiting;
    expect(result.isError).toBeUndefined();
    expect(result.message).toContain(`${convId}/task-42`);
  });

  it("ignores stale unread replies and stale IDLE on reused subagents until the latest dispatch settles", async () => {
    const home = await tempHome();
    const parentId = randomUUID();
    const childId = randomUUID();
    const parentMsgDir = path.join(
      nativeBrainDirPath(parentId, home),
      ".system_generated",
      "messages",
    );
    const childMsgDir = path.join(
      nativeBrainDirPath(childId, home),
      ".system_generated",
      "messages",
    );
    await mkdir(parentMsgDir, { recursive: true });
    await mkdir(childMsgDir, { recursive: true });

    // Subagent is still IDLE from turn 1 and has an older unread reply before turn 2's dispatch.
    await setupSummariesDb(home, childId, parentId, "CASCADE_RUN_STATUS_IDLE");
    await writeFile(path.join(parentMsgDir, "read.json"), JSON.stringify({}));
    await writeFile(
      path.join(parentMsgDir, "turn1Reply.json"),
      JSON.stringify({
        id: "turn1Reply",
        sender: childId,
        timestamp: "2026-11-15T10:00:00.000Z",
        content: "stale reply",
      }),
    );
    await writeFile(
      path.join(childMsgDir, "turn2Dispatch.json"),
      JSON.stringify({
        id: "turn2Dispatch",
        sender: parentId,
        timestamp: "2026-11-15T10:01:00.000Z",
        content: "new instruction",
      }),
    );

    let settledEarly = false;
    const waiting = waitForBackgroundTask({
      home,
      taskId: childId,
      boundSessionId: parentId,
      timeoutMs: 5_000,
      recheckIntervalMs: 30,
    }).then((res) => {
      settledEarly = true;
      return res;
    });

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(settledEarly).toBe(false);

    // Child consumes turn2Dispatch while RUNNING, emits a delayed reply while still RUNNING,
    // and must only settle once summary status returns to IDLE.
    await setupSummariesDb(home, childId, parentId, "CASCADE_RUN_STATUS_RUNNING");
    await writeFile(path.join(childMsgDir, "read.json"), JSON.stringify({ turn2Dispatch: true }));
    await writeFile(
      path.join(parentMsgDir, "delayedTurn1OrMidTurnReply.json"),
      JSON.stringify({
        id: "delayedTurn1OrMidTurnReply",
        sender: childId,
        content: "reply while still running",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(settledEarly).toBe(false);

    await setupSummariesDb(home, childId, parentId, "CASCADE_RUN_STATUS_IDLE");
    const result = await waiting;
    expect(result.isError).toBeUndefined();
    expect(result.message).toContain(childId);
  });

  it("does not fail open when read.json or a new dispatch JSON is mid-write", async () => {
    const home = await tempHome();
    const parentId = randomUUID();
    const childId = randomUUID();
    const childMsgDir = path.join(
      nativeBrainDirPath(childId, home),
      ".system_generated",
      "messages",
    );
    await mkdir(childMsgDir, { recursive: true });
    await setupSummariesDb(home, childId, parentId, "CASCADE_RUN_STATUS_IDLE");

    // Turn 1 dispatch was already consumed, and a turn 2 dispatch JSON is currently half-written
    // while child summary is still IDLE: wait must NOT treat turn 1's consumed dispatch + IDLE as done.
    await writeFile(
      path.join(childMsgDir, "turn1Dispatch.json"),
      JSON.stringify({ id: "turn1Dispatch", sender: parentId }),
    );
    await writeFile(path.join(childMsgDir, "read.json"), JSON.stringify({ turn1Dispatch: true }));
    await writeFile(path.join(childMsgDir, "turn2Dispatch.json"), "{");

    let done = false;
    const waiting = waitForBackgroundTask({
      home,
      taskId: childId,
      boundSessionId: parentId,
      timeoutMs: 5_000,
      recheckIntervalMs: 30,
    }).then((res) => {
      done = true;
      return res;
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(done).toBe(false);

    // Finish writing turn2Dispatch.json, then corrupt read.json mid-write while IDLE: still pending.
    await writeFile(
      path.join(childMsgDir, "turn2Dispatch.json"),
      JSON.stringify({ id: "turn2Dispatch", sender: parentId }),
    );
    await writeFile(path.join(childMsgDir, "read.json"), "{");

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(done).toBe(false);

    // Child consumes turn2Dispatch and returns to IDLE -> settles cleanly.
    await writeFile(
      path.join(childMsgDir, "read.json"),
      JSON.stringify({ turn1Dispatch: true, turn2Dispatch: true }),
    );

    const result = await waiting;
    expect(result.isError).toBeUndefined();
  });

  it("rejects traversal, mismatched boundSessionId, and foreign subagent ownership", async () => {
    const home = await tempHome();
    const realParent = randomUUID();
    const otherParent = randomUUID();
    const childId = randomUUID();
    await setupSummariesDb(home, childId, realParent, "CASCADE_RUN_STATUS_IDLE");

    expect(
      (await waitForBackgroundTask({ home, taskId: "../outside/task-1", timeoutMs: 100 })).isError,
    ).toBe(true);
    expect(
      (
        await waitForBackgroundTask({
          home,
          taskId: `${otherParent}/task-1`,
          boundSessionId: realParent,
          timeoutMs: 100,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await waitForBackgroundTask({
          home,
          taskId: childId,
          conversationId: otherParent,
          timeoutMs: 100,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await waitForBackgroundTask({
          home,
          taskId: childId,
          boundSessionId: otherParent,
          timeoutMs: 100,
        })
      ).isError,
    ).toBe(true);
  });

  it("cancels cleanly even during initial evaluation and distinguishes timeout from completion", async () => {
    const home = await tempHome();
    const convId = randomUUID();
    const controller = new AbortController();
    const pending = waitForBackgroundTask({
      home,
      taskId: `${convId}/task-5`,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    const cancelled = await pending;
    expect(cancelled).toEqual({ isError: true, message: "Wait cancelled." });

    const timedOut = await waitForBackgroundTask({
      home,
      taskId: `${convId}/task-6`,
      timeoutMs: 60,
    });
    expect(timedOut.message).toContain("still running");
    expect(timedOut.message).toContain(ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME);
  });

  it("only matches trusted codexhost_background tool qualifiers", () => {
    expect(isAntigravityBackgroundWaitTool("codexhost_background_wait_for_background_task")).toBe(
      true,
    );
    expect(
      isAntigravityBackgroundWaitTool("mcp__codexhost_background__wait_for_background_task"),
    ).toBe(true);
    expect(isAntigravityBackgroundWaitTool("wait_for_background_task")).toBe(false);
    expect(isAntigravityBackgroundWaitTool("untrusted_server_wait_for_background_task")).toBe(
      false,
    );
  });

  it("serves MCP discovery fallback, tools/list, tools/call and notifications/cancelled", async () => {
    const home = await tempHome();
    const convId = randomUUID();
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: Array<Record<string, unknown>> = [];
    let buffer = "";
    output.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line) as Record<string, unknown>);
      }
    });

    const server = serveBackgroundWaitMcp({
      home,
      boundSessionId: convId,
      input,
      output,
      recheckIntervalMs: 30,
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} })}\n`,
      );
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`,
      );
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })}\n`,
      );
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME,
            arguments: { taskId: `${convId}/task-9` },
          },
        })}\n`,
      );
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 4 },
        })}\n`,
      );

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(responses).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found: server/discover" },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME, version: "1.0.0" },
          },
        },
        expect.objectContaining({
          jsonrpc: "2.0",
          id: 3,
          result: {
            tools: [expect.objectContaining({ name: ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME })],
          },
        }),
      ]);
    } finally {
      server.close();
    }

    expect(createAntigravityBackgroundMcpServer(home, convId)).toMatchObject({
      name: ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME,
      command: process.execPath,
      env: [],
    });
  });
});
