import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { encodePiModelRef } from "../../packages/adapters/pi/dist/pi-model-catalog.js";
import { DeepSeekHarnessAdapter } from "../../packages/adapters/deepseek-harness/dist/index.js";

async function waitFor(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

for (const [id, variable, Adapter] of [
  ["deepseek-harness", "CODEXHOST_DSH_REAL_COMMAND", DeepSeekHarnessAdapter],
]) {
  const command = process.env[variable];
  describe.runIf(Boolean(command))(`${id} native lifecycle`, () => {
    it("streams, cancels without overlap, edits and resumes empty and retained history", async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-lifecycle-")));
      const responses = new Set();
      let overlapping = false;
      let heldClosed = false;
      let heldStarted = false;
      const modelRequests = [];
      const server = http.createServer((request, response) => {
        if (request.method === "GET") {
          response.writeHead(404).end();
          return;
        }
        void (async () => {
          let input = "";
          for await (const chunk of request) input += chunk;
          const body = JSON.parse(input);
          const user = [...(body.messages ?? [])]
            .reverse()
            .find((message) => message.role === "user");
          const text = JSON.stringify(user?.content ?? "");
          const held = text.includes("HOLD_INPUT");
          const main = /(?:FIRST|HOLD|THIRD)_INPUT/u.test(text);
          modelRequests.push({ held, main, input: text.match(/(?:FIRST|HOLD|THIRD)_INPUT/u)?.[0] });
          if (main && responses.size > 0) overlapping = true;
          if (main) responses.add(response);
          if (held) heldStarted = true;
          response.on("close", () => {
            responses.delete(response);
            if (held) heldClosed = true;
          });
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          const chunk = (content, finish_reason = null) =>
            response.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-fixture",
                object: "chat.completion.chunk",
                created: 1,
                model: body.model,
                choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason }],
              })}\n\n`,
            );
          chunk(held ? "HOLD_BEGIN" : "FIRST_CHUNK");
          if (!held) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            chunk(" SECOND_CHUNK");
            chunk("", "stop");
            response.end("data: [DONE]\n\n");
          }
        })().catch(() => {
          response.destroy();
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
      const agentDirectory = path.join(root, "pi-agent");
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(
        path.join(agentDirectory, "models.json"),
        JSON.stringify({
          providers: {
            "lifecycle-test": {
              baseUrl: baseURL,
              api: "openai-completions",
              apiKey: "test-only",
              models: [
                {
                  id: "test-model",
                  name: "Lifecycle test",
                  reasoning: false,
                  contextWindow: 32000,
                  maxTokens: 4000,
                },
              ],
            },
          },
        }),
      );
      const environment = {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_CODING_AGENT_SESSION_DIR: path.join(root, "pi-sessions"),
        DSH_HOME: path.join(root, "dsh"),
        DEEPSEEK_API_KEY: "test-only",
        DEEPSEEK_BASE_URL: baseURL,
      };
      const createAdapter = () =>
        new Adapter({
          command,
          environment,
          endpoint: `${new URL(baseURL).origin}/`,
          startupTimeoutMs: 30000,
        });
      let adapter = createAdapter();
      let session;
      let events = [];
      const consumers = [];
      const attach = (next) => {
        session = next;
        events = [];
        const observed = events;
        consumers.push(
          (async () => {
            for await (const output of next.outputs)
              if (output.kind === "event") observed.push(output.event);
          })(),
        );
      };
      const opened = (result) => {
        assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result.error));
        return result.value;
      };
      const snapshot = async () => opened(await session.readSnapshot());
      const start = async (turnId, text) => {
        opened(
          await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] }),
        );
      };
      const terminal = (turnId) =>
        waitFor(() => {
          const fault = events.find((event) => event.type === "session.faulted");
          assert.equal(fault, undefined, JSON.stringify(fault));
          return events.find((event) => event.type === "turn.completed" && event.turnId === turnId);
        }, `terminal ${turnId}`).catch((error) => {
          throw new Error(`${error.message}: ${JSON.stringify({ events, modelRequests })}`);
        });
      const state = () =>
        [...events].reverse().find((event) => event.type === "session.state.changed")?.state ??
        session.initialState;
      try {
        const inspection = await adapter.inspect({ cwd: root });
        assert.equal(inspection.status, "ready", JSON.stringify(inspection));
        const model =
          id === "pi"
            ? inspection.catalog.models.find(
                (model) =>
                  model.ref.id ===
                  encodePiModelRef({ provider: "lifecycle-test", id: "test-model" }).id,
              )?.ref
            : inspection.catalog.defaultModel;
        assert.ok(model, "test Model missing");
        attach(opened(await adapter.open({ kind: "create", cwd: root, model, environment })));
        await start("first", "FIRST_INPUT");
        const first = await terminal("first");
        assert.equal(first.outcome.status, "succeeded", JSON.stringify(first.outcome));
        assert.equal((await snapshot()).turns.length, 1);
        const originalThinking = state().effectiveThinkingOptionId;
        const originalPermission = state().effectivePermissionModeId;
        const originalRef = state().nativeRef;
        assert.ok(originalRef);
        const replacement = opened(
          await adapter.open({
            kind: "rollbackLastTurn",
            cwd: root,
            sourceRef: originalRef,
            environment,
          }),
        );
        assert.equal(opened(await replacement.readSnapshot()).turns.length, 0);
        assert.deepEqual(
          replacement.initialState.effectiveModel,
          model,
          "empty edit changed Model",
        );
        assert.equal(replacement.initialState.effectiveThinkingOptionId, originalThinking);
        assert.equal(replacement.initialState.effectivePermissionModeId, originalPermission);
        const emptyRef = replacement.initialState.nativeRef;
        assert.ok(emptyRef);
        assert.notEqual(emptyRef.nativeSessionId, originalRef.nativeSessionId);
        assert.equal((await snapshot()).turns.length, 1, "source history changed");
        await adapter.close();
        adapter = createAdapter();
        attach(
          opened(
            await adapter.open({ kind: "resume", cwd: root, nativeRef: emptyRef, environment }),
          ),
        );
        assert.equal((await snapshot()).turns.length, 0);
        assert.deepEqual(state().effectiveModel, model, "cold empty edit changed Model");
        assert.equal(state().effectiveThinkingOptionId, originalThinking);
        assert.equal(state().effectivePermissionModeId, originalPermission);
        await start("kept", "FIRST_INPUT");
        const kept = await terminal("kept");
        assert.equal(kept.outcome.status, "succeeded", JSON.stringify(kept.outcome));
        await start("held", "HOLD_INPUT");
        await waitFor(
          () =>
            events.some(
              (event) =>
                event.type === "item.updated" &&
                event.update.type === "text.append" &&
                event.update.text.includes("HOLD_BEGIN"),
            ),
          "incremental output before completion",
        );
        assert.equal(heldStarted, true);
        opened(await session.execute({ type: "turn.cancel", turnId: "held" }));
        assert.equal((await terminal("held")).outcome.status, "cancelled");
        await waitFor(() => heldClosed, "cancelled HTTP request closed");
        assert.equal((await snapshot()).turns.length, 2);
        const retained = opened(
          await adapter.open({
            kind: "rollbackLastTurn",
            cwd: root,
            sourceRef: state().nativeRef,
            environment,
          }),
        );
        assert.equal(opened(await retained.readSnapshot()).turns.length, 1);
        const retainedRef = retained.initialState.nativeRef;
        await adapter.close();
        adapter = createAdapter();
        attach(
          opened(
            await adapter.open({ kind: "resume", cwd: root, nativeRef: retainedRef, environment }),
          ),
        );
        assert.equal((await snapshot()).turns.length, 1);
        await start("continued", "THIRD_INPUT");
        assert.equal((await terminal("continued")).outcome.status, "succeeded");
        assert.equal((await snapshot()).turns.length, 2);
        heldClosed = false;
        await start("close-active", "HOLD_INPUT");
        await waitFor(
          () =>
            events.some(
              (event) =>
                event.type === "item.updated" &&
                event.turnId === "close-active" &&
                event.update.type === "text.append" &&
                event.update.text.includes("HOLD_BEGIN"),
            ),
          "output before active close",
        );
        await session.close();
        await waitFor(() => heldClosed, "active Session close stops native request");
        assert.equal(overlapping, false);
      } finally {
        await adapter.close();
        await Promise.all(consumers);
        for (const response of responses) response.destroy();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
      }
    }, 180000);
  });
}
