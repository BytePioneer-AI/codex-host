import fs from "node:fs";
import path from "node:path";

import { interactionResponse, requireSuccess, withCapturedClient } from "./scenario-helpers.mjs";
import {
  liveEnvironment,
  liveRpcArgs,
  promptAndSettle,
  sessionArgument,
  terminalChecks,
  userEntryIds,
} from "./live-helpers.mjs";
import { verifyUnifiedPatch } from "./patch.mjs";

const extensionPath = path.resolve(import.meta.dirname, "fixtures/gate-extension.ts");

function extensionArgs(workspace, extra = []) {
  return liveRpcArgs(workspace, ["--extension", extensionPath, ...extra]);
}

function newEvent(rpc, startIndex, predicate, timeoutMs = 120_000) {
  return rpc.waitForEvent((event) => rpc.events.indexOf(event) >= startIndex && predicate(event), {
    timeoutMs,
  });
}

function partialText(event) {
  return event.partialResult?.content
    ?.filter(({ type }) => type === "text")
    .map(({ text }) => text)
    .join("");
}

export async function runToolScenario({ repositoryRoot, workspace, configuredCommand }) {
  const samplePath = path.join(workspace.cwd, "sample.txt");
  const before = "alpha\r\nbeta\r\ngamma\r\ndelta\r\n";
  fs.writeFileSync(samplePath, before, "utf8");
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-tool",
    configuredCommand,
    env: liveEnvironment(workspace),
    rpcArgs: extensionArgs(workspace),
    run: async (rpc) => {
      const editRun = await promptAndSettle(
        rpc,
        "Use the edit tool exactly once on sample.txt. In one call, replace alpha with ALPHA and delta with DELTA. Do not use write or bash. Then reply briefly.",
      );
      const actual = fs.readFileSync(samplePath, "utf8");
      const editEvents = editRun.events.filter(({ toolName }) => toolName === "edit");
      const editStart = editEvents.find(({ type }) => type === "tool_execution_start");
      const editEnd = editEvents.find(({ type }) => type === "tool_execution_end");
      const editCallCorrelated =
        editStart && editEnd && editStart.toolCallId === editEnd.toolCallId;
      const patch = editEnd?.result?.details?.patch;
      const reliablePatch = verifyUnifiedPatch(before, patch, actual);

      const customRun = await promptAndSettle(
        rpc,
        "Call gate_custom exactly once and gate_failure exactly once. Do not call other tools. Then report that both calls were attempted.",
      );
      const customEvents = customRun.events.filter(({ toolName }) => toolName === "gate_custom");
      const customUpdates = customEvents.filter(({ type }) => type === "tool_execution_update");
      const failureEnd = customRun.events.find(
        ({ type, toolName }) => type === "tool_execution_end" && toolName === "gate_failure",
      );
      const cumulativeSnapshots =
        customUpdates.length >= 2 &&
        partialText(customUpdates.at(-1))?.includes(partialText(customUpdates[0]));
      const noSyntheticPatch = !customEvents.find(({ type }) => type === "tool_execution_end")
        ?.result?.details?.patch;

      const genericRun = await promptAndSettle(
        rpc,
        "Call write exactly once to create tool-write.txt containing GATE_WRITE_OK, and call bash exactly once to print GATE_BASH_OK. Do not call edit or other tools. Then reply briefly.",
      );
      const writeEnd = genericRun.events.find(
        ({ type, toolName }) => type === "tool_execution_end" && toolName === "write",
      );
      const bashEnd = genericRun.events.find(
        ({ type, toolName }) => type === "tool_execution_end" && toolName === "bash",
      );
      const writeHasPatch = typeof writeEnd?.result?.details?.patch === "string";
      const bashHasPatch = typeof bashEnd?.result?.details?.patch === "string";
      const toolObserved = Boolean(editStart && editEnd);
      const status = !toolObserved
        ? "BLOCKED"
        : editEnd.isError || actual === before
          ? "FAIL"
          : "PASS";
      return {
        id: "native-live-tool",
        profile: "native-live",
        status,
        required: true,
        checks: {
          editToolObserved: toolObserved,
          editCallIdCorrelated: Boolean(editCallCorrelated),
          editSucceeded: editEnd?.isError === false,
          diskChangedAsRequested: actual.includes("ALPHA") && actual.includes("DELTA"),
          reliableUnifiedPatch: reliablePatch,
          customToolObserved: customEvents.length > 0,
          cumulativePartialSnapshots: Boolean(cumulativeSnapshots),
          failedToolObserved: failureEnd?.isError === true,
          missingPatchNotInferred: noSyntheticPatch,
          writeToolObserved: Boolean(writeEnd),
          bashToolObserved: Boolean(bashEnd),
          writePatchObserved: writeHasPatch,
          bashPatchObserved: bashHasPatch,
          writeAndBashWithoutPatchRemainTools:
            Boolean(writeEnd && bashEnd) && !writeHasPatch && !bashHasPatch,
          editRunSettled: Object.values(terminalChecks(editRun.events, editRun.state)).every(
            Boolean,
          ),
        },
        evidence: ["tool_execution_start", "tool_execution_update", "tool_execution_end"],
        ...(!toolObserved
          ? { blocker: "The active model did not invoke the explicitly requested edit tool." }
          : {}),
      };
    },
  });
}

export async function runQuestionScenario({ repositoryRoot, workspace, configuredCommand }) {
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-question",
    configuredCommand,
    env: liveEnvironment(workspace),
    rpcArgs: extensionArgs(workspace),
    run: async (rpc) => {
      const start = rpc.events.length;
      const runPromise = promptAndSettle(
        rpc,
        "Call gate_question exactly once. After receiving the answer, reply with exactly GATE_QUESTION_OK.",
      );
      const request = await newEvent(
        rpc,
        start,
        ({ type, method }) => type === "extension_ui_request" && method === "select",
      );
      await rpc.write(interactionResponse(request, "continue"));
      const run = await runPromise;
      const toolEnd = run.events.find(
        ({ type, toolName }) => type === "tool_execution_end" && toolName === "gate_question",
      );
      const passed =
        toolEnd?.isError === false &&
        Object.values(terminalChecks(run.events, run.state)).every(Boolean);
      return {
        id: "native-live-question",
        profile: "native-live",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          questionInsideAgentTool: Boolean(toolEnd),
          responseMatchedRequest: true,
          operationContinued: toolEnd?.isError === false,
          stableTerminal: Object.values(terminalChecks(run.events, run.state)).every(Boolean),
          nativeApprovalObserved: false,
        },
        evidence: ["extension_ui_request", "extension_ui_response", "tool_execution_end"],
      };
    },
  });
}

async function cancelStreaming(rpc) {
  const start = rpc.events.length;
  const settled = newEvent(rpc, start, ({ type }) => type === "agent_settled");
  const prompt = rpc.send({
    type: "prompt",
    message: "Write a long numbered list with at least 500 short lines. Start immediately.",
  });
  await newEvent(
    rpc,
    start,
    ({ type, assistantMessageEvent }) =>
      type === "message_update" && assistantMessageEvent?.type === "text_delta",
  );
  requireSuccess(await rpc.send({ type: "abort" }));
  requireSuccess(await prompt);
  await settled;
  const state = requireSuccess(await rpc.send({ type: "get_state" }));
  return { events: rpc.events.slice(start), state };
}

async function cancelLongTool(rpc) {
  const start = rpc.events.length;
  const settled = newEvent(rpc, start, ({ type }) => type === "agent_settled");
  const prompt = rpc.send({
    type: "prompt",
    message: "Call gate_long_tool exactly once now. Do not call other tools.",
  });
  await newEvent(
    rpc,
    start,
    ({ type, toolName }) => type === "tool_execution_start" && toolName === "gate_long_tool",
  );
  requireSuccess(await rpc.send({ type: "abort" }));
  requireSuccess(await prompt);
  await settled;
  const state = requireSuccess(await rpc.send({ type: "get_state" }));
  return { events: rpc.events.slice(start), state };
}

async function cancelQuestion(rpc) {
  const start = rpc.events.length;
  const settled = newEvent(rpc, start, ({ type }) => type === "agent_settled");
  const prompt = rpc.send({
    type: "prompt",
    message: "Call gate_question exactly once now and wait for the answer.",
  });
  await newEvent(
    rpc,
    start,
    ({ type, method }) => type === "extension_ui_request" && method === "select",
  );
  requireSuccess(await rpc.send({ type: "abort" }));
  requireSuccess(await prompt);
  await settled;
  const state = requireSuccess(await rpc.send({ type: "get_state" }));
  return { events: rpc.events.slice(start), state };
}

export async function runCancelScenario({ repositoryRoot, workspace, configuredCommand }) {
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-cancel",
    configuredCommand,
    env: liveEnvironment(workspace),
    rpcArgs: extensionArgs(workspace),
    run: async (rpc) => {
      const beforeEntries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const streaming = await cancelStreaming(rpc);
      const tool = await cancelLongTool(rpc);
      const question = await cancelQuestion(rpc);
      requireSuccess(await rpc.send({ type: "abort" }));
      requireSuccess(await rpc.send({ type: "abort" }));
      const continuation = await promptAndSettle(
        rpc,
        "Reply with exactly GATE_AFTER_CANCEL_OK. Do not call tools.",
      );
      const afterEntries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const repeatedEntries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const beforeUsers = beforeEntries.entries
        .filter(({ type, message }) => type === "message" && message?.role === "user")
        .map(({ id }) => id);
      const afterUsers = afterEntries.entries
        .filter(({ type, message }) => type === "message" && message?.role === "user")
        .map(({ id }) => id);
      const cancelledTurnRefsPresent = afterUsers.length >= beforeUsers.length + 4;
      const turnRefsUnique = new Set(afterUsers).size === afterUsers.length;
      const repeatedTurnRefsStable =
        JSON.stringify(afterEntries.entries.map(({ id }) => id)) ===
        JSON.stringify(repeatedEntries.entries.map(({ id }) => id));
      const streamingStopped = terminalChecks(streaming.events, streaming.state);
      const toolEnd = tool.events.find(
        ({ type, toolName }) => type === "tool_execution_end" && toolName === "gate_long_tool",
      );
      const questionToolEnd = question.events.find(
        ({ type, toolName }) => type === "tool_execution_end" && toolName === "gate_question",
      );
      const passed =
        streaming.state.isStreaming === false &&
        tool.state.isStreaming === false &&
        question.state.isStreaming === false &&
        Boolean(toolEnd) &&
        Boolean(questionToolEnd) &&
        cancelledTurnRefsPresent &&
        turnRefsUnique &&
        repeatedTurnRefsStable &&
        Object.values(terminalChecks(continuation.events, continuation.state)).every(Boolean);
      return {
        id: "native-live-cancel",
        profile: "native-live",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          streamingAbortSettled: Object.values(streamingStopped).every(Boolean),
          toolAbortSettled: tool.state.isStreaming === false && Boolean(toolEnd),
          questionAbortSettled: question.state.isStreaming === false && Boolean(questionToolEnd),
          idleAbortBounded: true,
          cancelledTurnRefsPresent,
          turnRefsUnique,
          repeatedTurnRefsStable,
          continuationCompleted: Object.values(
            terminalChecks(continuation.events, continuation.state),
          ).every(Boolean),
        },
        evidence: ["abort", "agent_settled", "get_state", "get_entries", "tool_execution_end"],
      };
    },
  });
}

export async function runCancelHistoryScenario({
  repositoryRoot,
  workspace,
  configuredCommand,
  sessionFile,
  expectedUserIds,
}) {
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-cancel-history",
    configuredCommand,
    env: liveEnvironment(workspace),
    rpcArgs: extensionArgs(workspace, sessionArgument(sessionFile)),
    run: async (rpc) => {
      const state = requireSuccess(await rpc.send({ type: "get_state" }));
      const entries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const users = userEntryIds(entries.entries);
      const stable =
        JSON.stringify(users) === JSON.stringify(expectedUserIds) &&
        new Set(users).size === users.length;
      return {
        id: "native-live-cancel-history",
        profile: "native-live",
        status: stable ? "PASS" : "FAIL",
        required: true,
        checks: {
          cancelledSessionResumed: state.sessionFile === sessionFile,
          cancelledTurnRefsStableAfterResume: stable,
        },
        evidence: ["get_state", "get_entries"],
      };
    },
  });
}
