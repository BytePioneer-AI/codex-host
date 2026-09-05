import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { describe, it, vi } from "vitest";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeAdapter } from "../../packages/adapters/claude-code/dist/index.js";
import { encodeClaudeModelRef } from "../../packages/adapters/claude-code/dist/model-catalog.js";
import { AppServerHost } from "../../packages/host-runtime/dist/index.js";
import { MappingStore } from "../../packages/mapping-store/dist/index.js";
import { encodeClaudeTransportModel } from "../../packages/protocol-core/dist/index.js";

const command = process.env.CODEXHOST_CLAUDE_REAL_COMMAND;
const live = process.env.CODEXHOST_CLAUDE_REAL_LIVE === "1";
const desktopAsset = process.env.CODEXHOST_CLAUDE_REAL_DESKTOP_ASSET;

class Official extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor() {
    super();
    this.stdin.on("finish", () => {
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }
  kill() {
    return true;
  }
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out: ${label}`);
}
function startHost({ root, environment }) {
  const input = new PassThrough(),
    output = new PassThrough();
  const adapter = new ClaudeCodeAdapter({ command, environment, startupTimeoutMs: 30000 });
  const openSession = adapter.open.bind(adapter);
  adapter.open = async (input) => {
    const result = await openSession(input);

    if (result.ok) {
      const close = result.value.close.bind(result.value);
      result.value.close = async () => {
        try {
          await close();
        } catch (error) {
          console.error(
            JSON.stringify(error, (_key, value) =>
              value instanceof Error
                ? { message: value.message, errors: value.errors, code: value.code }
                : value,
            ),
          );
          throw error;
        }
      };
    }
    return result;
  };
  const store = new MappingStore({ directory: path.join(root, "mapping") });
  const host = new AppServerHost({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    defaultAgent: "codex",
    environment,
    desktopInput: input,
    desktopOutput: output,
    diagnosticOutput: new PassThrough(),
    mappingStore: store,
    externalAdapters: new Map([["claude-code", adapter]]),
    spawnOfficial: () => new Official(),
  });
  const responses = new Map(),
    notifications = [];
  let buffer = "",
    id = 0;
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"),
        message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined) responses.set(message.id, message);
      else notifications.push(message);
    }
  });
  const running = host.run();
  return {
    store,
    notifications,
    async rpc(method, params) {
      const requestId = ++id;
      input.write(JSON.stringify({ id: requestId, method, params }) + "\n");
      const response = await waitFor(() => responses.get(requestId), method);
      if (response.error) throw new Error(`${method}: ${response.error.message}`);
      return response.result;
    },
    async close() {
      input.end();
      await running;
      await adapter.close();
    },
  };
}

// Uses a real native CLI and real SDK history, with only the model response controlled locally.
// LIVE=1 uses the authenticated native CLI and its configured model. Each scenario sends short prompts; interruption
// scenarios cancel the long-response prompt immediately after its first text delta. Tool tests stay local.
describe.runIf(Boolean(command))("Claude message editing through Host", () => {
  const scenarios = [
    "completed",
    "first interrupted",
    "second interrupted",
    "retained interruption",
    "first interrupted after restart",
    ...(!live ? ["first interrupted before output", "first interrupted during tool"] : []),
  ];
  it.each(scenarios)("edits and resumes: %s", runScenario, 240000);
  async function runScenario(scenario) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-host-rollback-")));
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    const config = live
      ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
      : path.join(root, "config");
    if (!live) await mkdir(config);
    vi.stubEnv("CLAUDE_CONFIG_DIR", config);
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let data = "";
      for await (const chunk of req) data += chunk;
      const body = JSON.parse(data || "{}");
      if (req.url.includes("/count_tokens")) {
        res.end('{"input_tokens":10}');
        return;
      }
      if (!req.url.includes("/messages")) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      requests.push(body.messages);
      if (
        scenario === "first interrupted before output" &&
        JSON.stringify(body.messages?.at(-1)?.content).includes("CANCEL_PENDING")
      )
        return;
      const text = "EDIT_OK";
      const tool =
        scenario === "first interrupted during tool" &&
        JSON.stringify(body.messages?.at(-1)?.content).includes("CANCEL_PENDING");
      const block = tool
        ? {
            type: "tool_use",
            id: "pause-tool",
            name: "Bash",
            input: {
              command: `touch ${cwd}/started; sleep 30`,
              description: "Disposable pause regression",
            },
          }
        : { type: "text", text };
      const message = {
        id: "msg_" + randomUUID(),
        type: "message",
        role: "assistant",
        model: body.model,
        content: [block],
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      res.writeHead(200, {
        "content-type": body.stream ? "text/event-stream" : "application/json",
      });
      if (!body.stream) {
        res.end(JSON.stringify(message));
        return;
      }
      for (const value of [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        {
          type: "content_block_start",
          index: 0,
          content_block: tool ? { ...block, input: {} } : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: tool
            ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
            : { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ]) {
        res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
        if (
          value.type === "content_block_delta" &&
          !tool &&
          JSON.stringify(body.messages?.at(-1)?.content).includes("CANCEL_PENDING")
        )
          return;
      }
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const environment = {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    for (const key of Object.keys(environment))
      if (
        key.startsWith("ANTHROPIC_") ||
        key.startsWith("CLAUDE_CODE_USE_") ||
        key === "AWS_BEARER_TOKEN_BEDROCK"
      )
        delete environment[key];
    if (!live)
      Object.assign(environment, {
        ANTHROPIC_API_KEY: "local-test",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      });
    let host = startHost({ root, environment });
    const nativeIds = new Set();
    let threadId;
    const mapping = async () => {
      const result = await host.store.getThread(threadId);
      assert.ok(result);
      nativeIds.add(result.nativeSessionRef.nativeSessionId);
      return result;
    };
    const complete = async (turnId) => {
      const event = await waitFor(
        () =>
          host.notifications.find(
            (m) => m.method === "turn/completed" && m.params.turn.id === turnId,
          ),
        "turn completion",
      );
      assert.equal(event.params.turn.status, "completed", JSON.stringify(event.params.turn));
      return turnId;
    };
    const send = async (label, interrupt = false) => {
      const requestCount = requests.length;
      const turnId = (
        await host.rpc("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: interrupt
                ? `CANCEL_PENDING ${label}: Write a numbered list of 1000 simple English sentences. Do not use tools.`
                : `Reply with exactly ${label}. Do not use tools.`,
            },
          ],
        })
      ).turn.id;
      if (!interrupt) return complete(turnId);
      if (scenario === "first interrupted during tool") {
        await waitFor(
          () =>
            readFile(path.join(cwd, "started")).then(
              () => true,
              () => false,
            ),
          "native tool started",
        );
      } else if (scenario === "first interrupted before output") {
        await waitFor(() => requests.length > requestCount, "model request before any output");
      } else {
        await waitFor(
          () =>
            host.notifications.some(
              (m) => m.method === "item/agentMessage/delta" && m.params.turnId === turnId,
            ),
          "streaming before manual stop",
        );
      }
      await host.rpc("turn/interrupt", { threadId, turnId });
      const terminal = await waitFor(
        () =>
          host.notifications.find(
            (m) => m.method === "turn/completed" && m.params.turn.id === turnId,
          ),
        "manual stop terminal",
      );
      assert.equal(terminal.params.turn.status, "interrupted");
      return turnId;
    };
    const revert = async (turnId) => host.rpc("thread/revert", { threadId, beforeTurnId: turnId });
    const restart = async () => {
      await host.close();
      host = startHost({ root, environment });
      await host.rpc("thread/resume", { threadId });
    };
    const history = async (id) => getSessionMessages(id, { dir: cwd });
    try {
      const model = encodeClaudeModelRef(live ? "default" : "claude-sonnet-4-6");
      threadId = (
        await host.rpc("thread/start", {
          cwd,
          model: encodeClaudeTransportModel(
            model,
            scenario === "first interrupted during tool" ? "bypassPermissions" : "default",
            "off",
          ),
          historyMode: "paginated",
        })
      ).thread.id;
      let first = await send(
        "FIRST_KEPT",
        scenario.startsWith("first interrupted") || scenario === "retained interruption",
      );
      if (scenario.startsWith("first interrupted")) {
        await mapping();
        if (scenario === "first interrupted after restart") {
          // Simulate the extra mapping persisted by the old reader, then let cold recovery repair it.
          const previous = await mapping();
          const native = await waitFor(async () => {
            const h = await history(previous.nativeSessionRef.nativeSessionId);
            return JSON.stringify(h).includes("[Request interrupted by user]") ? h : null;
          }, "persisted interruption");
          const marker = native.findLast((m) => m.type === "user");
          await host.store.reconcileTurnMappings(threadId, [
            ...previous.turnMappings,
            {
              hostTurnId: randomUUID(),
              nativeTurnRef: {
                harnessId: "claude-code",
                nativeSessionId: previous.nativeSessionRef.nativeSessionId,
                nativeTurnKey: marker.uuid,
                formatVersion: 1,
              },
            },
          ]);
          await restart();
          assert.equal((await mapping()).turnMappings.length, 1);
        }
        await revert(first);
        assert.equal((await mapping()).turnMappings.length, 0);
        first = await send("FIRST_KEPT");
      }
      const second = await send("SECOND_REMOVED", scenario === "second interrupted");
      const original = (await mapping()).nativeSessionRef.nativeSessionId;
      await revert(second);
      const before = await history(original);
      assert.equal(
        before.filter((m) => m.type === "user").length,
        scenario === "second interrupted" || scenario === "retained interruption" ? 3 : 2,
      );
      if (scenario === "retained interruption") {
        const kept = await history((await mapping()).nativeSessionRef.nativeSessionId);
        assert.ok(JSON.stringify(kept).includes("[Request interrupted by user]"));
      }
      assert.equal((await mapping()).turnMappings.length, 1);
      assert.notEqual((await mapping()).nativeSessionRef.nativeSessionId, original);
      const edited = await send("EDITED_SECOND");
      assert.equal((await mapping()).turnMappings.length, 2);
      assert.deepEqual(await history(original), before);
      if (!live) assert.ok(!JSON.stringify(requests.at(-1)).includes("SECOND_REMOVED"));
      await revert(edited);
      await revert(first);
      const pending = (await mapping()).nativeSessionRef;
      assert.deepEqual(pending.locator, { pendingSession: 1 });
      assert.equal((await mapping()).turnMappings.length, 0);
      await restart();
      assert.deepEqual((await mapping()).nativeSessionRef, pending);
      assert.equal((await mapping()).turnMappings.length, 0);
      await send("EDITED_FIRST");
      assert.equal((await mapping()).nativeSessionRef.nativeSessionId, pending.nativeSessionId);
      if (!live) assert.ok(!JSON.stringify(requests.at(-1)).includes("FIRST_KEPT"));
      await restart();
      assert.equal(
        (await history(pending.nativeSessionId)).filter((m) => m.type === "user").length,
        1,
      );
      assert.equal((await mapping()).turnMappings.length, 1);
      await send("AFTER_EDITED_FIRST");
      assert.equal((await mapping()).turnMappings.length, 2);
      if (desktopAsset) {
        // Use the installed Desktop's actual edit implementation, without manually constructing its resend.
        const desktop = await readFile(desktopAsset, "utf8");
        const begin = desktop.indexOf("async function lcn("),
          end = desktop.indexOf("var ucn=", begin);
        assert.ok(begin >= 0 && end > begin);
        const edit = vm.runInNewContext("(" + desktop.slice(begin, end) + ")", {
          TS: (state, id) => state.turns.find((t) => t.turnId === id),
          wS: (state) => state.turns,
          C8t: (_old, text) => text,
          Ig: () => true,
          scn: () => {
            throw new Error("Unexpected legacy history");
          },
        });
        const state = {
          cwd,
          historyMode: "paginated",
          turns: (await mapping()).turnMappings.map((m) => ({
            turnId: m.hostTurnId,
            status: "completed",
            params: { input: [{ type: "text", text: "original" }] },
            items: [],
          })),
        };
        const manager = {
          getConversation: () => state,
          updateConversationState: (_id, update) => update(state),
          getStreamRole: () => ({ role: "owner" }),
          sendThreadFollowerRequest: async () => false,
          waitForPendingThreadSettingsUpdate: async () => {},
          requestClient: { getAppServerVersion: () => "0.0.0" },
          sendRequest: host.rpc,
          applyRevertResponseToConversation: ({ revertedTurns }) => {
            state.turns = state.turns.filter((t) => !revertedTurns.includes(t));
          },
        };
        let resent;
        await edit({
          manager,
          conversationId: threadId,
          options: {
            turnId: state.turns.at(-1).turnId,
            message: "Reply with exactly DESKTOP_EDIT. Do not use tools.",
            shouldSendPermissionOverrides: false,
          },
          startTurn: async (params) => {
            assert.ok(params.input[0].text.includes("DESKTOP_EDIT"));
            resent = (await host.rpc("turn/start", params)).turn.id;
          },
          turnMergePolicy: undefined,
          ownerWindowError: "Not owner",
        });
        await complete(resent);
        assert.equal((await mapping()).turnMappings.length, 2);
      }
      // Only delete this test's native transcript. A committed Session must not recover as empty.
      await host.close();
      host = null;
      await rm(
        path.join(
          config,
          "projects",
          cwd.replace(/[^a-zA-Z0-9]/g, "-"),
          pending.nativeSessionId + ".jsonl",
        ),
      );
      // The Desktop optional edit may have replaced the pending identity; test its recovery directly.
      const adapter = new ClaudeCodeAdapter({ command, environment });
      try {
        const opened = await adapter.open({ kind: "resume", cwd, nativeRef: pending });
        if (opened.ok) assert.equal((await opened.value.readSnapshot()).ok, false);
      } finally {
        await adapter.close();
      }
      console.log(
        JSON.stringify({
          realClaudeHostRollback: true,
          liveCompany: live,
          actualDesktopEditFunction: Boolean(desktopAsset),
          root,
        }),
      );
    } finally {
      await host?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      // All native files belong to the disposable test cwd, even in authenticated wrapper mode.
      await rm(path.join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")), {
        force: true,
        recursive: true,
      });
      for (const id of nativeIds)
        await rm(path.join(config, "codexhost", "pending-sessions", id), {
          force: true,
          recursive: true,
        });
      await rm(root, { force: true, recursive: true });
      vi.unstubAllEnvs();
    }
  }
});
