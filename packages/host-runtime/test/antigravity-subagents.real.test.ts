import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { AntigravityAdapter } from "@codexhost/adapter-antigravity";
import { MappingStore } from "@codexhost/mapping-store";
import { encodeAntigravityTransportModel } from "@codexhost/protocol-core";
import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AppServerHost } from "../src/app-server-host.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";

const RUN_REAL = process.env.CODEXHOST_RUN_ANTIGRAVITY_SUBAGENTS_REAL === "1";

describe.skipIf(!RUN_REAL)("Antigravity real Subagent Desktop protocol", () => {
  it("materializes live child progress, reads stable history, restores and cancels", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-subagents-"));
    await writeFile(path.join(workspace, "marker.txt"), "AGY_SUBAGENT_FILE_OK\n");
    const environment = { ...process.env, CODEXHOST_DATA_DIR: path.join(workspace, "data") };
    const evidence: unknown[] = [];
    let stage = "start";
    function runtime() {
      const adapter = new AntigravityAdapter({ environment, printTimeout: "2m" });
      const input = new PassThrough();
      const output = new PassThrough();
      const diagnostics = new PassThrough();
      diagnostics.setEncoding("utf8").on("data", (text) => evidence.push({ diagnostic: text }));
      const messages: JsonObject[] = [];
      readline.createInterface({ input: output }).on("line", (line) => {
        const message = JSON.parse(line) as JsonObject;
        messages.push(message);
        evidence.push(message);
      });
      let closeOfficial!: (value: OfficialAppServerExit) => void;
      const closed = new Promise<OfficialAppServerExit>((resolve) => {
        closeOfficial = resolve;
      });
      const officialOutput = new PassThrough();
      const host = new AppServerHost({
        stockCodexPath: "/unused",
        arguments: ["app-server"],
        defaultAgent: "codex",
        desktopInput: input,
        desktopOutput: output,
        diagnosticOutput: diagnostics,
        environment,
        mappingStore: new MappingStore({ directory: path.join(workspace, "mapping") }),
        externalAdapters: new Map([["antigravity", adapter]]),
        createOfficialConnection: () => ({
          stdin: new PassThrough(),
          stdout: officialOutput,
          stderr: new PassThrough(),
          closed,
          close: () => {
            officialOutput.end();
            closeOfficial({ code: 0, signal: null });
          },
        }),
      });
      const running = host.run();
      const wait = async (predicate: (message: JsonObject) => boolean) => {
        const until = Date.now() + 120_000;
        while (Date.now() < until) {
          const found = messages.find(predicate);
          if (found) return found;
          await delay(25);
        }
        throw new Error(`Timed out at ${stage}`);
      };
      let sequence = 0;
      const request = async (method: string, params: JsonObject): Promise<JsonObject> => {
        const id = ++sequence;
        input.write(JSON.stringify({ id, method, params }) + "\n");
        const response = await wait((message) => message.id === id);
        if (response.error) throw new Error(JSON.stringify(response.error));
        return response.result as JsonObject;
      };
      return {
        messages,
        request,
        wait,
        close: async () => {
          host.close();
          input.end();
          await running;
        },
      };
    }
    let host = runtime();
    const params = (message: JsonObject) => (message.params ?? {}) as JsonObject;
    const historyItems = (history: JsonObject): JsonObject[] =>
      (history.data as JsonObject[]).flatMap((turn) => turn.items as JsonObject[]);
    try {
      const created = await host.request("thread/start", {
        cwd: workspace,
        model: encodeAntigravityTransportModel(
          harnessModelRefSchema.parse({ id: "gemini-3.8-flash" }),
          harnessPermissionModeIdSchema.parse("dangerously-skip-permissions"),
          harnessThinkingOptionIdSchema.parse("high"),
        ),
      });
      const parentId = (created.thread as JsonObject).id as string;
      stage = "spawn";
      const started = await host.request("turn/start", {
        threadId: parentId,
        input: [
          {
            type: "text",
            text: `Synthetic integration test. Invoke exactly ONE research subagent, role "Subagent Protocol Probe", in the inherited workspace. Its task: use view_file to read ${path.join(workspace, "marker.txt")} and reply AGY_CHILD_VERIFIED plus the file contents. No other tools, no file writes, no worktrees, no additional agents. Wait for its native completion notification, then reply AGY_PARENT_VERIFIED.`,
          },
        ],
      });
      const turnId = (started.turn as JsonObject).id as string;
      const childStarted = await host.wait(
        (message) =>
          message.method === "thread/started" &&
          (params(message).thread as JsonObject | undefined)?.parentThreadId === parentId,
      );
      const childThread = params(childStarted).thread as JsonObject;
      const childId = childThread.id as string;
      expect(childThread.canAcceptDirectInput).toBe(false);
      const card = await host.wait(
        (message) =>
          message.method === "item/completed" &&
          params(message).threadId === parentId &&
          (params(message).item as JsonObject | undefined)?.type === "collabAgentToolCall",
      );
      expect((params(card).item as JsonObject).receiverThreadIds).toEqual([childId]);
      stage = "open child";
      // Materialize the child while it runs so progress notifications are exercised.
      await host.request("thread/turns/list", { threadId: childId, limit: 20, itemsView: "full" });
      await host.wait(
        (message) =>
          message.method === "turn/completed" &&
          params(message).threadId === parentId &&
          (params(message).turn as JsonObject | undefined)?.id === turnId,
      );
      stage = "read history";
      const childHistory = await host.request("thread/turns/list", {
        threadId: childId,
        limit: 20,
        itemsView: "full",
      });
      const childItems = historyItems(childHistory);
      expect(childItems.filter((item) => item.type === "userMessage")).toHaveLength(1);
      expect(
        childItems.some(
          (item) =>
            item.type === "agentMessage" && String(item.text).includes("AGY_CHILD_VERIFIED"),
        ),
      ).toBe(true);
      expect(
        childItems.some(
          (item) => item.type === "dynamicToolCall" || item.type === "commandExecution",
        ),
      ).toBe(true);
      expect(new Set(childItems.map((item) => item.id)).size).toBe(childItems.length);
      expect(
        host.messages.some(
          (message) => message.method === "item/completed" && params(message).threadId === childId,
        ),
      ).toBe(true);
      const parentHistory = await host.request("thread/turns/list", {
        threadId: parentId,
        limit: 20,
        itemsView: "full",
      });
      expect(
        historyItems(parentHistory).filter((item) => item.type === "userMessage"),
      ).toHaveLength(1);

      stage = "restart";
      await host.close();
      host = runtime();
      const restored = await host.request("thread/turns/list", {
        threadId: childId,
        limit: 20,
        itemsView: "full",
      });
      expect(historyItems(restored)).toEqual(childItems);
      await host.request("thread/resume", { threadId: parentId });
      stage = "followup";
      const followup = await host.request("turn/start", {
        threadId: parentId,
        input: [
          {
            type: "text",
            text: "Contact the EXISTING Subagent Protocol Probe using send_message, not invoke_subagent. Ask it to read marker.txt again and reply AGY_CHILD_FOLLOWUP. No new agents or writes. Wait for its native reply, then say AGY_PARENT_FOLLOWUP.",
          },
        ],
      });
      const followupTurnId = (followup.turn as JsonObject).id as string;
      await host.wait(
        (message) =>
          message.method === "thread/status/changed" &&
          params(message).threadId === childId &&
          (params(message).status as JsonObject | undefined)?.type === "active",
      );
      await host.wait(
        (message) =>
          message.method === "turn/completed" &&
          params(message).threadId === parentId &&
          (params(message).turn as JsonObject | undefined)?.id === followupTurnId,
      );
      const followupHistory = await host.request("thread/turns/list", {
        threadId: childId,
        limit: 20,
        itemsView: "full",
      });
      expect(
        historyItems(followupHistory).some(
          (item) =>
            item.type === "agentMessage" && String(item.text).includes("AGY_CHILD_FOLLOWUP"),
        ),
      ).toBe(true);
      stage = "cancel";
      const next = await host.request("turn/start", {
        threadId: parentId,
        input: [
          {
            type: "text",
            text: "Synthetic cancellation test. Launch exactly one NEW research subagent with role Cancellation Probe. Ask it to inspect the current directory with list_dir and then give a detailed description of each entry. No writes, no worktrees, no additional agents. Wait for its native result.",
          },
        ],
      });
      const cancelTurnId = (next.turn as JsonObject).id as string;
      const second = await host.wait(
        (message) =>
          message.method === "thread/started" &&
          (params(message).thread as JsonObject | undefined)?.parentThreadId === parentId &&
          (params(message).thread as JsonObject | undefined)?.id !== childId,
      );
      const cancelledChildId = (params(second).thread as JsonObject).id as string;
      await host.request("turn/interrupt", { threadId: parentId, turnId: cancelTurnId });
      const cancelled = await host.wait(
        (message) =>
          message.method === "turn/completed" &&
          params(message).threadId === parentId &&
          (params(message).turn as JsonObject | undefined)?.id === cancelTurnId,
      );
      expect((params(cancelled).turn as JsonObject).status).toBe("interrupted");
      await host.wait(
        (message) =>
          message.method === "thread/status/changed" &&
          params(message).threadId === cancelledChildId &&
          (params(message).status as JsonObject | undefined)?.type === "idle",
      );
      stage = "passed";
    } finally {
      await host.close();
      const directory = process.env.CODEXHOST_ANTIGRAVITY_SUBAGENTS_EVIDENCE_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, `${Date.now()}-${stage}.json`),
          JSON.stringify({ stage, evidence }, null, 2),
        );
      }
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 360_000);
});
