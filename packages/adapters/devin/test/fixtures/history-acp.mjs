import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

// Synthetic native schema assumptions, NOT a recording of a successful Devin mutation.
const scenario = process.env.DEVIN_HISTORY_SCENARIO ?? "normal";
const sourceKeys = scenario === "single" ? ["u1"] : scenario === "empty" ? [] : ["u1", "u2", "u3"];
const historyFlags = {
  "cognition.ai/revert": true,
  "cognition.ai/revertHistoryRewound": true,
  "cognition.ai/revertByUserMessageId": true,
};
const model = {
  id: "model",
  category: "model",
  name: "Model",
  type: "select",
  currentValue: "a",
  options: ["a", "b"].map((value) => ({ value, name: value })),
};
const thought = {
  id: "effort",
  category: "thought_level",
  name: "Effort",
  type: "select",
  currentValue: "low",
  options: ["low", "high"].map((value) => ({ value, name: value })),
};
const mode = {
  id: "mode",
  name: "Mode",
  type: "select",
  currentValue: "ask",
  options: ["ask", "plan"].map((value) => ({ value, name: value })),
};
const configOptions = [model, thought, mode];
const info = () => ({
  modes: {
    currentModeId: mode.currentValue,
    availableModes: mode.options.map(({ value, name }) => ({ id: value, name })),
  },
  configOptions,
});
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
let cwd;
let sessionId;
let promptCount = 0;
const addedKeys = [];
let heldListStepsId;
const keys = () =>
  sessionId === "source"
    ? sourceKeys
    : sessionId === "empty-child"
      ? []
      : scenario === "wrong-prefix"
        ? ["u3"]
        : sourceKeys.slice(0, Number(sessionId?.split("-")[1]));
const makeSteps = (list) =>
  list.map((key, index) => ({
    stepId: `step-${key}`,
    stepNumber: index + 1,
    kind: "prompt",
    userMessageId: key,
    toolCallId: null,
    questionNodeId: null,
    revertTargetNodeId: `before-${key}`,
    forkTargetNodeId: `after-${key}`,
    summary: key,
  }));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (process.env.DEVIN_TEST_LOG)
    appendFileSync(
      process.env.DEVIN_TEST_LOG,
      `${JSON.stringify({ pid: process.pid, ...message })}\n`,
    );
  let result = {};
  switch (message.method) {
    case "initialize":
      if (message.params.clientCapabilities?._meta?.["cognition.ai/revert"] !== true)
        throw new Error("Missing revert negotiation");
      result = {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
          _meta: scenario === "old" ? {} : historyFlags,
        },
      };
      break;
    case "session/new":
      sessionId = "empty-child";
      cwd = message.params.cwd;
      result = { sessionId, ...info() };
      break;
    case "session/load":
      sessionId = message.params.sessionId;
      cwd = message.params.cwd;
      for (const key of [...keys(), ...addedKeys]) {
        for (const update of [
          {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: key },
            _meta: { "cognition.ai/clientMessageId": key },
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `answer ${key}` },
          },
        ])
          send({ method: "session/update", params: { sessionId, update } });
      }
      result = {
        ...info(),
        ...(scenario === "wrong-id" && sessionId !== "source" ? { sessionId: "wrong-child" } : {}),
      };
      break;
    case "session/list":
      result = {
        sessions: [
          {
            sessionId: sessionId ?? "source",
            cwd: scenario === "wrong-cwd" ? "/different" : (cwd ?? process.env.DEVIN_SOURCE_CWD),
          },
        ],
      };
      break;
    case "_cognition.ai/revert/listSteps":
      if (scenario === "pre-prompt-hang") continue;
      if (scenario === "pre-prompt-timeout" && promptCount === 0) continue;
      if (
        scenario === "late-pre-prompt-response" &&
        promptCount === 0 &&
        heldListStepsId === undefined
      ) {
        heldListStepsId = message.id;
        continue;
      }
      if (scenario === "compacted-post-prompt-timeout" && promptCount === 1) continue;
      if (promptCount > 0) {
        if (scenario === "checkpoint-exit") process.exit(7);
        if (scenario === "checkpoint-timeout") continue;
        if (scenario === "checkpoint-error") {
          send({
            id: message.id,
            error: { code: -32602, message: "Synthetic protocol error: process exited" },
          });
          continue;
        }
        if (scenario === "checkpoint-schema") {
          send({ id: message.id, result: { steps: null } });
          continue;
        }
      }
      result = { steps: makeSteps([...keys(), ...addedKeys]) };
      break;
    case "_cognition.ai/revert/forkFromStep": {
      if (scenario === "fork-error") {
        send({
          id: message.id,
          error: { code: -32602, message: "Synthetic native fork rejected" },
        });
        continue;
      }
      const index = sourceKeys.findIndex((key) => `step-${key}` === message.params.stepId);
      if (message.params.sessionId !== "source" || index < 0) throw new Error("Invalid target");
      result = { forkedSessionId: scenario === "source-id" ? "source" : `fork-${index + 1}` };
      break;
    }
    case "session/set_config_option":
      configOptions.find((option) => option.id === message.params.configId).currentValue =
        message.params.value;
      result = { configOptions };
      break;
    case "session/prompt":
      promptCount += 1;
      send({
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "answer next" },
          },
        },
      });
      if (scenario === "pre-prompt-hang") {
        result = { stopReason: "end_turn" };
      } else if (scenario === "late-pre-prompt-response") {
        if (promptCount === 1) {
          addedKeys.push("t1");
          result = { stopReason: "end_turn", _meta: { "cognition.ai/userMessageId": "t1" } };
        } else if (promptCount === 2) {
          if (heldListStepsId !== undefined) {
            send({ id: heldListStepsId, result: { steps: makeSteps(keys()) } });
            heldListStepsId = undefined;
          }
          result = { stopReason: "end_turn" };
        } else {
          addedKeys.push("t3");
          result = { stopReason: "end_turn" };
        }
      } else if (scenario === "compacted-post-prompt-timeout") {
        if (promptCount === 1) {
          addedKeys.push("compacted");
          result = { stopReason: "end_turn" };
        } else {
          addedKeys.push("after-timeout");
          result = {
            stopReason: "end_turn",
            _meta: { "cognition.ai/userMessageId": "after-timeout" },
          };
        }
      } else {
        if (!addedKeys.includes("next")) addedKeys.push("next");
        result = { stopReason: "end_turn", _meta: { "cognition.ai/userMessageId": "next" } };
      }
      break;
    default:
      throw new Error(`Forbidden or unexpected synthetic RPC ${message.method}`);
  }
  if (message.id !== undefined) send({ id: message.id, result });
}
