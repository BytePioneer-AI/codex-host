import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { OpenCodeAdapter } from "../../packages/adapters/opencode/dist/index.js";
import { describe, it } from "vitest";
const command = process.env.CODEXHOST_OPENCODE_REAL_COMMAND;
describe.runIf(Boolean(command))("OpenCode cancellation with a local model", () => {
  it("closes the old request before continuation and preserves warm and cold history", async () => {
    const root = await mkdtemp("/private/tmp/opencode-controlled-");
    const model = "adjust-model",
      provider = "codexhost-adjust-test";
    let firstClosed = false,
      agentRequests = 0,
      overlappingRequests = false,
      activeResponses = new Set();
    const requests = [];
    const server = http.createServer((req, res) => {
      void (async () => {
        let text = "";
        for await (const c of req) text += c;
        const body = JSON.parse(text);
        requests.push(body.messages);
        const isTitle = body.messages?.some(
          (m) =>
            m.role === "system" &&
            typeof m.content === "string" &&
            m.content.includes("You are a title generator"),
        );
        const index = isTitle ? 0 : ++agentRequests;
        if (index > 1 && !firstClosed) overlappingRequests = true;

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        activeResponses.add(res);
        res.on("close", () => {
          activeResponses.delete(res);
          if (index === 1) firstClosed = true;
        });
        const chunk = (content, finish_reason = null) =>
          res.write(
            "data: " +
              JSON.stringify({
                id: "chatcmpl-adjust",
                object: "chat.completion.chunk",
                created: 0,
                model,
                choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason }],
              }) +
              "\n\n",
          );
        chunk(index === 1 ? "FIRST_BEGIN" : isTitle ? "Adjustment test" : "OPENCODE_CANCEL_OK");
        if (index !== 1) {
          chunk("", "stop");
          res.end("data: [DONE]\n\n");
        }
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const config = {
      enabled_providers: [provider],
      model: provider + "/" + model,
      small_model: provider + "/" + model,
      provider: {
        [provider]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local adjustment test",
          options: {
            apiKey: "test-only",
            baseURL: "http://127.0.0.1:" + server.address().port + "/v1",
          },
          models: {
            [model]: { name: model, tool_call: true, limit: { context: 32000, output: 4000 } },
          },
        },
      },
    };
    const environment = {
      ...process.env,
      CODEWIZ_AUTO_UPDATE: "0",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_TEST_HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    };
    const adapter = new OpenCodeAdapter({ command, environment, startupTimeoutMs: 30000 });
    const events = [];
    let session, consumed;
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("Timed out " + label);
    };
    const start = (turnId, text) =>
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] });
    try {
      const opened = await adapter.open({ kind: "create", cwd: root, executionPolicy: "default" });
      if (!opened.ok) throw Error("Open " + opened.error.code + ": " + opened.error.message);
      session = opened.value;
      consumed = (async () => {
        for await (const o of session.outputs) {
          if (o.kind === "event") {
            events.push(o.event);
          }
        }
      })();
      assert.equal((await start("before", "FIRST_INPUT")).ok, true);
      await waitFor(() => agentRequests === 1, "first request");
      const ack = await session.execute({ type: "turn.cancel", turnId: "before" });
      assert.equal(ack.ok, true);
      const before = await waitFor(
        () => events.find((e) => e.type === "turn.completed" && e.turnId === "before"),
        "cancel terminal",
      );
      assert.equal(before.outcome.status, "cancelled");
      assert.equal((await start("after", "SECOND_INPUT")).ok, true);
      const after = await waitFor(
        () => events.find((e) => e.type === "turn.completed" && e.turnId === "after"),
        "next terminal",
      );
      assert.equal(after.outcome.status, "succeeded");
      const snap = await session.readSnapshot();
      assert.equal(snap.ok, true);
      assert.equal(snap.value.turns.length, 2);
      assert.ok(JSON.stringify(snap.value.turns.at(-1)).includes("OPENCODE_CANCEL_OK"));
      assert.equal(agentRequests, 2);
      assert.equal(overlappingRequests, false);
      assert.equal(firstClosed, true);
      const nativeRef = session.initialState.nativeRef;
      await session.close();
      await consumed;
      const resumed = await adapter.open({ kind: "resume", nativeRef, cwd: root });
      assert.equal(resumed.ok, true);
      const cold = await resumed.value.readSnapshot();
      assert.equal(cold.ok, true);
      assert.equal(cold.value.turns.length, 2);
      assert.ok(JSON.stringify(cold.value.turns.at(-1)).includes("OPENCODE_CANCEL_OK"));
    } finally {
      await adapter.close();
      if (consumed) await consumed;
      for (const r of activeResponses) r.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
});
