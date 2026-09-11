import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { DeepSeekHarnessAdapter } from "../../packages/adapters/deepseek-harness/dist/index.js";

async function waitFor(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${label}`);
}

function opened(result) {
  assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result.error));
  return result.value;
}

function delegations(events) {
  const items = new Map();
  for (const event of events) {
    const snapshotItem = event.item ?? event.snapshot?.item;
    if (snapshotItem?.type === "subagentDelegation") {
      items.set(snapshotItem.itemId, structuredClone(snapshotItem));
    } else if (event.type === "item.updated" && event.update.type === "subagents.replace") {
      const item = items.get(event.itemId);
      if (item) item.subagents = event.update.subagents;
    }
  }
  return [...items.values()];
}

function hasChildState(snapshot, handle, status) {
  return snapshot.turns.some((turn) =>
    turn.items.some(
      ({ item }) =>
        item.type === "subagentDelegation" &&
        item.subagents.some(
          (child) => child.nativeSubagentId === handle && child.status === status,
        ),
    ),
  );
}

const command = process.env.CODEXHOST_DSH_REAL_COMMAND;

describe.runIf(Boolean(command))("DSH native subagents through the public Adapter", () => {
  it.each(["background", "fork", "error", "interrupt", "active-close", "relocated-plugin"])(
    "%s preserves cards, child history and cold identity",
    async (testCase) => {
      const scenario = testCase === "relocated-plugin" ? "background" : testCase;
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "codexhost-dsh-subagents-")),
      );
      await writeFile(path.join(root, "child.txt"), "CHILD_TOOL_OUTPUT");
      const textGate = Promise.withResolvers();
      const finishGate = Promise.withResolvers();
      const responses = new Set();
      const issuedTools = new Set();
      const modelRequests = [];
      let modelError;
      let childCalls = 0;
      let nativeChildId;
      let childRequestClosed = false;
      const server = http.createServer((request, response) => {
        if (request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        responses.add(response);
        response.on("close", () => responses.delete(response));
        void (async () => {
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const body = JSON.parse(raw);
          const users = (body.messages ?? []).filter((message) => message.role === "user");
          const toolNames = (body.tools ?? []).map((tool) => tool.function?.name);
          const isChild =
            toolNames.length > 0 &&
            users.some((message) =>
              JSON.stringify(message.content).includes("CH_DSH_CHILD_REQUEST"),
            );
          modelRequests.push({ isChild, lastRole: body.messages?.at(-1)?.role, toolNames });
          if (isChild && scenario === "error") {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: {
                  message: "CHILD_PROVIDER_ERROR",
                  type: "invalid_request_error",
                  code: "invalid_request_error",
                },
              }),
            );
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          const send = (delta, finish_reason = null) =>
            response.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-subagent-gate",
                object: "chat.completion.chunk",
                created: 1,
                model: body.model,
                choices: [{ index: 0, delta, finish_reason }],
              })}\n\n`,
            );
          const toolCall = (name, args, id) => {
            assert.ok(toolNames.includes(name), `Native tool missing: ${name}`);
            send(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id,
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              "tool_calls",
            );
          };
          if (isChild) {
            if (childCalls++ === 0) {
              toolCall("read", { file_path: path.join(root, "child.txt") }, "call-child-read");
            } else if (childCalls === 2) {
              response.on("close", () => {
                childRequestClosed = true;
              });
              await textGate.promise;
              if (!response.destroyed) send({ role: "assistant", content: "CHILD_LIVE_PREFIX" });
              await finishGate.promise;
              if (!response.destroyed) send({ content: " CHILD_FINAL" }, "stop");
            } else {
              send({ role: "assistant", content: "CHILD_FOLLOWUP_FINAL" }, "stop");
            }
          } else {
            // This is DSH's actual model-facing receipt, never an opaque CH child handle.
            for (const message of body.messages ?? []) {
              if (message.role !== "tool") continue;
              nativeChildId ??= JSON.stringify(message.content).match(
                /started subagent ([0-9a-f-]{36})/iu,
              )?.[1];
            }
            const action = [...users]
              .reverse()
              .flatMap((message) =>
                ["PARENT_SPAWN", "PARENT_CONTINUE", "PARENT_INTERRUPT", "PARENT_HOLD"].filter(
                  (value) => JSON.stringify(message.content).includes(value),
                ),
              )[0];
            if (toolNames.includes("subagent") && action && !issuedTools.has(action)) {
              issuedTools.add(action);
              if (action === "PARENT_HOLD") {
                send({ role: "assistant", content: "PARENT_LIVE_PREFIX" });
                return;
              } else if (action === "PARENT_SPAWN") {
                toolCall(
                  scenario === "fork" ? "subagent_fork" : "subagent",
                  {
                    description: "子智能体原生 Gate",
                    prompt: "CH_DSH_CHILD_REQUEST",
                    ...(scenario === "fork" ? { run_in_background: false } : {}),
                  },
                  "call-parent-spawn",
                );
              } else {
                assert.ok(nativeChildId, "DSH background receipt did not expose child identity");
                toolCall(
                  action === "PARENT_CONTINUE" ? "send_message" : "interrupt_agent",
                  {
                    agent_id: nativeChildId,
                    ...(action === "PARENT_CONTINUE" ? { message: "CHILD_FOLLOWUP" } : {}),
                  },
                  `call-${action.toLowerCase()}`,
                );
              }
            } else {
              send({ role: "assistant", content: "PARENT_FINISHED" }, "stop");
            }
          }
          if (!response.destroyed) response.end("data: [DONE]\n\n");
        })().catch((error) => {
          modelError = error;
          response.destroy();
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const environment = {
        ...process.env,
        DSH_HOME: path.join(root, "dsh"),
        DEEPSEEK_API_KEY: "test-only",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
        DSH_TELEMETRY_MODE: "DISABLED",
      };
      const registries = [];
      const pluginRoot = path.join(root, "plugins");
      const createAdapter = async () => {
        if (testCase === "relocated-plugin") {
          const { loadHarnessPlugins } =
            await import("../../packages/host-runtime/dist/harness-plugin-loader.js");
          const diagnostics = [];
          const registry = await loadHarnessPlugins({
            roots: [pluginRoot],
            context: {
              environment: {
                ...environment,
                CODEXHOST_DEEPSEEK_HARNESS_COMMAND: command,
                CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT: `http://127.0.0.1:${server.address().port}/`,
              },
              platform: process.platform,
              managedRemoteHost: false,
            },
            warmup: false,
            diagnose: (diagnostic) => diagnostics.push(diagnostic),
          });
          registries.push(registry);
          assert.deepEqual(diagnostics, []);
          assert.equal(registry.list().length, 1);
          const adapter = registry.adapters.get("deepseek-harness");
          assert.ok(adapter);
          return adapter;
        }
        return new DeepSeekHarnessAdapter({
          command,
          environment,
          endpoint: `http://127.0.0.1:${server.address().port}/`,
          startupTimeoutMs: 30000,
        });
      };
      let adapter;
      let session;
      let testError;
      let events = [];
      const consumers = [];
      const attach = (next) => {
        session = next;
        events = [];
        const observed = events;
        consumers.push(
          (async () => {
            for await (const output of next.outputs) {
              if (output.kind === "event") observed.push(output.event);
            }
          })(),
        );
      };
      const until = (predicate, label) =>
        waitFor(async () => {
          assert.equal(modelError, undefined, String(modelError));
          const fault = events.find((event) => event.type === "session.faulted");
          assert.equal(fault, undefined, JSON.stringify(fault));
          return predicate();
        }, label).catch((error) => {
          const failure = new Error(
            `${error.message}: ${JSON.stringify({ events, modelRequests })}`,
          );
          console.error(`[${scenario}] ${failure.message}`);
          throw failure;
        });
      const start = (turnId, text) =>
        until(async () => {
          const result = await session.execute({
            type: "turn.start",
            turnId,
            input: [{ type: "text", text }],
          });
          if (!result.ok && result.error.code === "sessionBusy") return false;
          opened(result);
          return true;
        }, `accept ${turnId}`);
      const terminal = (turnId) =>
        until(
          () => events.find((event) => event.type === "turn.completed" && event.turnId === turnId),
          `terminal ${turnId}`,
        );
      const readChild = (parent, handle) =>
        adapter.subagents
          .readSnapshot({ parent, nativeSubagentId: handle, cwd: root })
          .then(opened);
      try {
        if (testCase === "relocated-plugin") {
          await mkdir(pluginRoot);
          await cp(
            path.resolve("packages/host-runtime/dist/plugins/deepseek-harness"),
            path.join(pluginRoot, "deepseek-harness"),
            { recursive: true },
          );
          await writeFile(
            path.join(pluginRoot, "enabled.json"),
            JSON.stringify({ version: 1, enabled: ["deepseek-harness"] }),
          );
        }
        adapter = await createAdapter();
        const inspection = await adapter.inspect({ cwd: root });
        assert.equal(inspection.status, "ready", JSON.stringify(inspection));
        assert.deepEqual(inspection.capabilities.subagents, {
          observe: true,
          readTranscript: true,
        });
        assert.ok(adapter.subagents);
        attach(
          opened(
            await adapter.open({
              kind: "create",
              cwd: root,
              model: inspection.catalog.defaultModel,
              environment,
            }),
          ),
        );
        const parent = session.initialState.nativeRef;
        assert.ok(parent);
        if (scenario === "fork") {
          await start("seed", "PARENT_SEED");
          assert.equal((await terminal("seed")).outcome.status, "succeeded");
        }
        await start("spawn", "PARENT_SPAWN");
        const spawned = await until(
          () =>
            delegations(events).find((item) => item.operation === "spawn" && item.subagents.length),
          "public subagent spawn card",
        );
        const child = spawned.subagents[0];
        const handle = child.nativeSubagentId;
        assert.ok(handle);
        assert.equal(child.background, scenario !== "fork");
        if (scenario !== "error") {
          if (scenario !== "fork") {
            assert.equal((await terminal("spawn")).outcome.status, "succeeded");
            const parentSnapshot = opened(await session.readSnapshot());
            assert.ok(
              hasChildState(parentSnapshot, handle, "running"),
              "Completed starter must retain running child status",
            );
          }
          textGate.resolve();
          const live = await until(async () => {
            const snapshot = await readChild(parent, handle);
            return JSON.stringify(snapshot).includes("CHILD_LIVE_PREFIX") ? snapshot : null;
          }, "live child transcript before completion");
          assert.ok(JSON.stringify(live).includes("CHILD_TOOL_OUTPUT"));
          assert.ok(
            live.turns.some((turn) => turn.items.some(({ item }) => item.type === "toolExecution")),
          );
          await until(
            () =>
              events.some(
                (event) =>
                  event.type === "subagent.transcript.changed" && event.nativeSubagentId === handle,
              ),
            "child transcript refresh notification",
          );
          if (scenario === "background") {
            await start("parent-hold", "PARENT_HOLD");
            await until(
              () =>
                events.some(
                  (event) =>
                    event.type === "item.updated" &&
                    event.turnId === "parent-hold" &&
                    event.update.type === "text.append" &&
                    event.update.text.includes("PARENT_LIVE_PREFIX"),
                ),
              "parent streaming turn before cancellation",
            );
            opened(await session.execute({ type: "turn.cancel", turnId: "parent-hold" }));
            assert.equal((await terminal("parent-hold")).outcome.status, "cancelled");
            assert.equal(
              childRequestClosed,
              false,
              "Parent Turn cancellation stopped independent background child",
            );
            assert.equal((await readChild(parent, handle)).turns.at(-1).outcome.status, "unknown");
          }
          if (scenario === "active-close") {
            await session.close();
            await until(() => childRequestClosed, "parent Session close stops owned child request");
            await adapter.close();
            adapter = await createAdapter();
            const requestsBeforeColdRead = modelRequests.length;
            const cold = await readChild(parent, handle);
            assert.equal(cold.turns.at(-1).outcome.status, "cancelled");
            assert.ok(JSON.stringify(cold).includes("CHILD_LIVE_PREFIX"));
            assert.equal(modelRequests.length, requestsBeforeColdRead);
            attach(
              opened(
                await adapter.open({ kind: "resume", cwd: root, nativeRef: parent, environment }),
              ),
            );
            const restored = opened(await session.readSnapshot());
            assert.ok(hasChildState(restored, handle, "interrupted"));
            return;
          }
          if (scenario === "interrupt") {
            await start("interrupt", "PARENT_INTERRUPT");
            assert.equal((await terminal("interrupt")).outcome.status, "succeeded");
            await until(() => childRequestClosed, "native interrupt closes child model request");
          }
        }
        finishGate.resolve();
        const status =
          scenario === "error" ? "failed" : scenario === "interrupt" ? "interrupted" : "completed";
        await until(
          () =>
            events.some(
              (event) =>
                event.type === "subagent.state.changed" &&
                event.nativeSubagentId === handle &&
                event.status === status,
            ),
          `child state ${status}`,
        );
        await terminal("spawn");
        let settled = await readChild(parent, handle);
        const outcome =
          scenario === "error" ? "failed" : scenario === "interrupt" ? "cancelled" : "succeeded";
        assert.equal(settled.turns.at(-1).outcome.status, outcome);
        if (outcome === "succeeded") assert.ok(JSON.stringify(settled).includes("CHILD_FINAL"));
        if (scenario === "fork") assert.ok(JSON.stringify(settled).includes("PARENT_SEED"));
        if (scenario === "background") {
          const previousTurns = settled.turns.length;
          await start("continue", "PARENT_CONTINUE");
          assert.equal((await terminal("continue")).outcome.status, "succeeded");
          settled = await until(async () => {
            const snapshot = await readChild(parent, handle);
            return snapshot.turns.length > previousTurns &&
              snapshot.turns.at(-1).outcome.status === "succeeded"
              ? snapshot
              : null;
          }, "follow-up settles in same child history");
          assert.ok(JSON.stringify(settled).includes("CHILD_FOLLOWUP_FINAL"));
          assert.ok(
            delegations(events).some(
              (item) =>
                item.operation === "send" &&
                item.subagents.some((entry) => entry.nativeSubagentId === handle),
            ),
          );
        }
        const parentBefore = opened(await session.readSnapshot());
        assert.ok(hasChildState(parentBefore, handle, status));
        if (testCase === "relocated-plugin") {
          try {
            await adapter.close();
          } catch (error) {
            try {
              await session.close();
            } catch (cause) {
              throw new Error(`Adapter close failed: ${String(error)}`, { cause });
            }
            throw error;
          }
        } else {
          await session.close();
          await adapter.close();
        }
        adapter = await createAdapter();
        const requestsBeforeColdRead = modelRequests.length;
        const cold = await readChild(parent, handle);
        assert.deepEqual(
          cold.turns,
          settled.turns,
          "Cold child read changed identity, history or outcomes",
        );
        assert.equal(
          modelRequests.length,
          requestsBeforeColdRead,
          "Cold transcript read started native model work",
        );
        attach(
          opened(await adapter.open({ kind: "resume", cwd: root, nativeRef: parent, environment })),
        );
        assert.deepEqual((await readChild(parent, handle)).turns, cold.turns);
        const parentAfter = opened(await session.readSnapshot());
        assert.ok(hasChildState(parentAfter, handle, status));
        assert.equal(
          events.some((event) => event.type === "turn.autonomous.started"),
          false,
          "Read-only cold restore must not execute a native Turn",
        );
        await start("after-cold", "PARENT_AFTER_COLD");
        assert.equal((await terminal("after-cold")).outcome.status, "succeeded");
        assert.deepEqual(session.initialState.effectiveModel, parentAfter.state.effectiveModel);
      } catch (error) {
        testError = error;
        throw error;
      } finally {
        textGate.resolve();
        finishGate.resolve();
        const cleanup = await Promise.allSettled([session?.close()]);
        cleanup.push(
          ...(await Promise.allSettled([
            adapter?.close(),
            ...registries.map((registry) => registry.close()),
          ])),
        );
        for (const response of responses) response.destroy();
        server.closeAllConnections();
        cleanup.push(
          ...(await Promise.allSettled([
            ...consumers,
            new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
            rm(root, { recursive: true, force: true }),
          ])),
        );
        const failed = cleanup.find((result) => result.status === "rejected");
        if (failed) {
          if (testError) console.error(`[${testCase}] cleanup:`, failed.reason);
          else await Promise.reject(failed.reason);
        }
      }
    },
    180000,
  );
});
