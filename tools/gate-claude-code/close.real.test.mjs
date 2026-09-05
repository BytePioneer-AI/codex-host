import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ClaudeSdkTransport } from "../../packages/adapters/claude-code/dist/sdk-transport.js";
const command = process.env.CODEXHOST_CLAUDE_REAL_COMMAND;
describe.runIf(Boolean(command) && process.env.CODEXHOST_CLAUDE_REAL_LIVE !== "1")(
  "Claude native background task fence",
  () => {
    it("stops a running native Bash task before close resolves", async () => {
      const root = await fs.mkdtemp("/private/tmp/claude-history-native-");
      const cwd = path.join(root, "workspace");
      const config = path.join(root, "config");
      await fs.mkdir(cwd);
      await fs.mkdir(config);

      const requests = [];
      const server = http.createServer(async (req, res) => {
        let data = "";
        for await (const b of req) data += b;
        const body = JSON.parse(data || "{}");
        if (req.url.includes("/count_tokens")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"input_tokens":10}');
          return;
        }
        if (!req.url.includes("/messages")) {
          res.writeHead(404);
          res.end("{}");
          return;
        }
        requests.push(body.messages);
        const msg = {
          id: "msg_" + randomUUID(),
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "PROBE_OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
        if (requests.length === 1) {
          msg.content = [
            {
              type: "tool_use",
              id: "tool_background_probe",
              name: "Bash",
              input: {
                command: `touch ${cwd}/started; sleep 4; printf 'late' > ${cwd}/late.txt`,
                run_in_background: true,
                description: "Temporary close fence probe",
              },
            },
          ];
          msg.stop_reason = "tool_use";
        }
        res.writeHead(200, {
          "content-type": body.stream ? "text/event-stream" : "application/json",
        });
        if (!body.stream) {
          res.end(JSON.stringify(msg));
          return;
        }
        for (const [event, value] of [
          [
            "message_start",
            { type: "message_start", message: { ...msg, content: [], stop_reason: null } },
          ],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block:
                msg.content[0].type === "tool_use"
                  ? { ...msg.content[0], input: {} }
                  : { type: "text", text: "" },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta:
                msg.content[0].type === "tool_use"
                  ? { type: "input_json_delta", partial_json: JSON.stringify(msg.content[0].input) }
                  : { type: "text_delta", text: "PROBE_OK" },
            },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: msg.stop_reason, stop_sequence: null },
              usage: { output_tokens: 5 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ])
          res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
        res.end();
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const env = {
        ...process.env,
        ANTHROPIC_API_KEY: "local-probe",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      };
      for (const key of Object.keys(env)) {
        if (
          (key.startsWith("ANTHROPIC_") &&
            !["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"].includes(key)) ||
          key.startsWith("CLAUDE_CODE_USE_") ||
          key === "AWS_BEARER_TOKEN_BEDROCK"
        )
          delete env[key];
      }

      const transport = new ClaudeSdkTransport({
        command,
        environment: env,
        cwd,
        sessionId: randomUUID(),
        openMode: "create",
        model: "claude-sonnet-4-6",
        thinkingOptionId: "off",
        permissionMode: "bypassPermissions",
        closeTimeoutMs: 7000,
        onFault: () => {},
        onPermissionModeChanged: () => {},
        onPlanLimit: () => {},
      });
      try {
        await transport.start();
        assert.equal(
          (
            await transport.runTurn(
              "Run the temporary background close probe, then reply OK.",
              randomUUID(),
              () => {},
            )
          ).status,
          "succeeded",
        );
        const exists = async (name) =>
          fs.stat(path.join(cwd, name)).then(
            () => true,
            () => false,
          );
        const deadline = Date.now() + 10000;
        while (!(await exists("started")) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(await exists("started"), true);
        assert.equal(await exists("late.txt"), false);
        await transport.close();
        await new Promise((resolve) => setTimeout(resolve, 4500));
        assert.equal(await exists("late.txt"), false, "native background Bash wrote after close");
      } finally {
        await transport.close().catch(() => undefined);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(root, { force: true, recursive: true });
      }
    }, 30000);
  },
);
