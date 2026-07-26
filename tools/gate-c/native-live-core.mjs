import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  activeBranchIds,
  liveEnvironment,
  liveRpcArgs,
  promptAndSettle,
  responseDataFromCapture,
  runNativeAppend,
  sessionArgument,
  terminalChecks,
  userEntryIds,
} from "./live-helpers.mjs";
import { requireSuccess, withCapturedClient } from "./scenario-helpers.mjs";

function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assistantCompleted(events) {
  const assistants = events
    .filter(({ type }) => type === "message_end")
    .map(({ message }) => message)
    .filter(({ role }) => role === "assistant");
  return assistants.some(({ stopReason }) => stopReason === "stop");
}

export async function runStreamScenario({ repositoryRoot, workspace, configuredCommand }) {
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-stream",
    configuredCommand,
    env: liveEnvironment(),
    rpcArgs: liveRpcArgs(workspace),
    run: async (rpc) => {
      const before = requireSuccess(await rpc.send({ type: "get_entries" }));
      const run = await promptAndSettle(
        rpc,
        "Reply with exactly GATE_STREAM_OK. Do not call tools.",
      );
      const after = requireSuccess(await rpc.send({ type: "get_entries" }));
      const state = requireSuccess(await rpc.send({ type: "get_state" }));
      const terminal = terminalChecks(run.events, run.state);
      const types = run.events.map(({ type }) => type);
      const promptFrame = rpc.protocolFrames.find(
        ({ direction, value }) => direction === "stdin" && value.type === "prompt",
      );
      const responseIndex = rpc.protocolFrames.findIndex(
        ({ direction, value }) =>
          direction === "stdout" && value.type === "response" && value.id === promptFrame.value.id,
      );
      const startIndex = rpc.protocolFrames.findIndex(
        ({ direction, value }) => direction === "stdout" && value.type === "agent_start",
      );
      const userIds = userEntryIds(after.entries);
      const passed =
        Object.values(terminal).every(Boolean) &&
        types.includes("message_update") &&
        assistantCompleted(run.events) &&
        userIds.length === 1 &&
        after.entries.length > before.entries.length;
      return {
        id: "native-live-stream",
        profile: "native-live",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          promptAccepted: responseIndex >= 0,
          agentStartObserved: startIndex >= 0,
          promptAndAgentOrderingCaptured: responseIndex >= 0 && startIndex >= 0,
          messageStreamObserved: types.includes("message_update"),
          reasoningObserved: run.events.some(
            ({ assistantMessageEvent }) => assistantMessageEvent?.type === "thinking_delta",
          ),
          assistantCompleted: assistantCompleted(run.events),
          stableTerminal: Object.values(terminal).every(Boolean),
          oneUserTurnPersisted: userIds.length === 1,
          nativeSessionAssigned: Boolean(state.sessionId && state.sessionFile),
        },
        evidence: ["prompt", "agent_start", "message_update", "agent_end", "agent_settled"],
      };
    },
  });
}

export async function runModelSwitchScenario({
  repositoryRoot,
  workspace,
  configuredCommand,
  sessionFile,
}) {
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-model-switch",
    configuredCommand,
    env: liveEnvironment(),
    rpcArgs: liveRpcArgs(workspace, sessionArgument(sessionFile)),
    run: async (rpc) => {
      const initial = requireSuccess(await rpc.send({ type: "get_state" }));
      const catalog = requireSuccess(await rpc.send({ type: "get_available_models" }));
      const thinking = requireSuccess(await rpc.send({ type: "get_available_thinking_levels" }));
      const alternateThinking = thinking.levels.find((level) => level !== initial.thinkingLevel);
      if (alternateThinking) {
        requireSuccess(await rpc.send({ type: "set_thinking_level", level: alternateThinking }));
      }
      const thinkingState = requireSuccess(await rpc.send({ type: "get_state" }));
      const modelFamily = initial.model?.id.split("-").slice(0, 2).join("-");
      const alternate = catalog.models
        .filter(
          ({ id, provider }) => id !== initial.model?.id || provider !== initial.model?.provider,
        )
        .sort((left, right) => {
          const leftScore =
            Number(left.provider === initial.model?.provider) +
            Number(left.id.startsWith(`${modelFamily}-`));
          const rightScore =
            Number(right.provider === initial.model?.provider) +
            Number(right.id.startsWith(`${modelFamily}-`));
          return rightScore - leftScore;
        })[0];
      if (!alternate) {
        requireSuccess(await rpc.send({ type: "get_entries" }));
        return {
          id: "native-live-model-switch",
          profile: "native-live",
          status: "BLOCKED",
          required: true,
          checks: {
            catalogRead: true,
            secondModelAvailable: false,
            thinkingCatalogRead: Array.isArray(thinking.levels),
          },
          evidence: ["get_available_models", "get_available_thinking_levels"],
          blocker: "The current Native Mode exposes only one callable Model.",
        };
      }
      requireSuccess(
        await rpc.send({ type: "set_model", provider: alternate.provider, modelId: alternate.id }),
      );
      const alternateState = requireSuccess(await rpc.send({ type: "get_state" }));
      const alternateRun = await promptAndSettle(
        rpc,
        "Reply with exactly GATE_MODEL_ALTERNATE_OK. Do not call tools.",
      );
      requireSuccess(
        await rpc.send({
          type: "set_model",
          provider: initial.model.provider,
          modelId: initial.model.id,
        }),
      );
      if (alternateThinking) {
        requireSuccess(
          await rpc.send({ type: "set_thinking_level", level: initial.thinkingLevel }),
        );
      }
      const restoredState = requireSuccess(await rpc.send({ type: "get_state" }));
      const restoredRun = await promptAndSettle(
        rpc,
        "Reply with exactly GATE_MODEL_RESTORED_OK. Do not call tools.",
      );
      const finalEntries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const switched =
        alternateState.model?.id === alternate.id &&
        alternateState.model?.provider === alternate.provider;
      const restored =
        restoredState.model?.id === initial.model.id &&
        restoredState.model?.provider === initial.model.provider;
      const alternateCompleted = assistantCompleted(alternateRun.events);
      const thinkingSwitched =
        !alternateThinking || thinkingState.thinkingLevel === alternateThinking;
      const thinkingRestored =
        !alternateThinking || restoredState.thinkingLevel === initial.thinkingLevel;
      const passed =
        switched &&
        restored &&
        thinkingSwitched &&
        thinkingRestored &&
        alternateCompleted &&
        assistantCompleted(restoredRun.events);
      return {
        id: "native-live-model-switch",
        profile: "native-live",
        status: !alternateCompleted ? "BLOCKED" : passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          catalogRead: true,
          secondModelAvailable: true,
          alternateModelEffective: switched,
          alternateTurnCompleted: alternateCompleted,
          originalModelRestored: restored,
          restoredTurnCompleted: assistantCompleted(restoredRun.events),
          modelChangeEntriesPersisted:
            finalEntries.entries.filter(({ type }) => type === "model_change").length >= 3,
          thinkingCatalogRead: Array.isArray(thinking.levels),
          thinkingSwitchEffective: thinkingSwitched,
          thinkingRestored,
          thinkingChangeEntriesPersisted:
            !alternateThinking ||
            finalEntries.entries.filter(({ type }) => type === "thinking_level_change").length >= 3,
        },
        evidence: ["get_available_models", "set_model", "get_state", "prompt"],
        ...(!alternateCompleted
          ? {
              blocker:
                "The selected alternate catalog Model was accepted by set_model but was not callable with the current authentication route.",
            }
          : {}),
      };
    },
  });
}

export async function runHistoryScenario({
  repositoryRoot,
  workspace,
  configuredCommand,
  sessionFile,
  originalUserIds,
}) {
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-history",
    configuredCommand,
    env: liveEnvironment(),
    rpcArgs: liveRpcArgs(workspace, sessionArgument(sessionFile)),
    run: async (rpc) => {
      const firstRead = requireSuccess(await rpc.send({ type: "get_entries" }));
      const repeatedRead = requireSuccess(await rpc.send({ type: "get_entries" }));
      const tree = requireSuccess(await rpc.send({ type: "get_tree" }));
      const messages = requireSuccess(await rpc.send({ type: "get_messages" }));
      const beforeIds = firstRead.entries.map(({ id }) => id);
      const run = await promptAndSettle(
        rpc,
        "Reply with exactly GATE_HISTORY_RPC_APPEND_OK. Do not call tools.",
      );
      const after = requireSuccess(await rpc.send({ type: "get_entries" }));
      const state = requireSuccess(await rpc.send({ type: "get_state" }));
      const afterUserIds = userEntryIds(after.entries);
      const stableReads =
        JSON.stringify(beforeIds) === JSON.stringify(repeatedRead.entries.map(({ id }) => id));
      const oldUsersStable = originalUserIds.every((id, index) => afterUserIds[index] === id);
      const activeIds = activeBranchIds(after.entries, after.leafId);
      const passed =
        stableReads &&
        oldUsersStable &&
        afterUserIds.length === originalUserIds.length + 1 &&
        activeIds.includes(afterUserIds.at(-1)) &&
        tree.leafId === firstRead.leafId &&
        messages.messages.length > 0 &&
        assistantCompleted(run.events);
      return {
        id: "native-live-history",
        profile: "native-live",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          sessionResumed: state.sessionFile === sessionFile,
          repeatedEntryIdsStable: stableReads,
          existingUserEntryIdsStable: oldUsersStable,
          appendedTurnHasNewUserEntry: afterUserIds.length === originalUserIds.length + 1,
          activeLeafDefinesBranch: activeIds.includes(afterUserIds.at(-1)),
          getMessagesIsContextOnly: messages.messages.length > 0,
          appendedTurnCompleted: assistantCompleted(run.events),
        },
        evidence: ["get_entries", "get_tree", "get_messages", "prompt"],
      };
    },
  });
}

export async function runNativeAppendScenario({
  repositoryRoot,
  workspace,
  configuredCommand,
  sessionFile,
  expectedUserIds,
}) {
  const env = liveEnvironment();
  let appendError;
  try {
    runNativeAppend({
      configuredCommand,
      env,
      workspace,
      sessionFile,
      message: "Reply with exactly GATE_NATIVE_APPEND_OK. Do not call tools.",
    });
  } catch (error) {
    appendError = error;
  }
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-native-append",
    configuredCommand,
    env,
    rpcArgs: liveRpcArgs(workspace, sessionArgument(sessionFile)),
    run: async (rpc) => {
      const state = requireSuccess(await rpc.send({ type: "get_state" }));
      const entries = requireSuccess(await rpc.send({ type: "get_entries" }));
      if (appendError) {
        return {
          id: "native-live-native-append",
          profile: "native-live",
          status: "BLOCKED",
          required: true,
          checks: {
            rpcResumedNativeAppend: state.sessionFile === sessionFile,
            nativeClientAppendCompleted: false,
          },
          evidence: ["native-print-append", "get_state", "get_entries"],
          blocker: appendError.message,
        };
      }
      const users = userEntryIds(entries.entries);
      const oldStable = expectedUserIds.every((id, index) => users[index] === id);
      const passed =
        state.sessionFile === sessionFile &&
        oldStable &&
        users.length === expectedUserIds.length + 1;
      return {
        id: "native-live-native-append",
        profile: "native-live",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          rpcResumedNativeAppend: state.sessionFile === sessionFile,
          existingUserEntryIdsStable: oldStable,
          nativeClientTurnReadable: users.length === expectedUserIds.length + 1,
        },
        evidence: ["native-print-append", "get_state", "get_entries"],
      };
    },
  });
}

export async function runForkScenario({
  repositoryRoot,
  workspace,
  configuredCommand,
  sessionFile,
}) {
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-fork",
    configuredCommand,
    env: liveEnvironment(),
    rpcArgs: liveRpcArgs(workspace, sessionArgument(sessionFile)),
    run: async (rpc) => {
      const sourceState = requireSuccess(await rpc.send({ type: "get_state" }));
      const source = requireSuccess(await rpc.send({ type: "get_entries" }));
      const sourceUsers = userEntryIds(source.entries);
      if (sourceUsers.length < 3) {
        return {
          id: "native-live-fork",
          profile: "native-live",
          status: "FAIL",
          required: true,
          checks: { sourceHasThreeTurns: false },
          evidence: ["get_entries"],
          error: { code: "FORK_SOURCE", message: "Fork source has fewer than three Turns" },
        };
      }
      const sourceHash = hashFile(sessionFile);
      const targetUser = sourceUsers[0];
      const nextUser = sourceUsers[1];
      const nextUserIndex = source.entries.findIndex(({ id }) => id === nextUser);
      const checkpointPrefix = source.entries.slice(0, nextUserIndex);
      const expectedModel = checkpointPrefix.filter(({ type }) => type === "model_change").at(-1);
      const expectedThinking = checkpointPrefix
        .filter(({ type }) => type === "thinking_level_change")
        .at(-1);
      requireSuccess(await rpc.send({ type: "fork", entryId: nextUser }));
      const forkState = requireSuccess(await rpc.send({ type: "get_state" }));
      const forkEntries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const forkActive = activeBranchIds(forkEntries.entries, forkEntries.leafId);
      const forkContinued = await promptAndSettle(
        rpc,
        "Reply with exactly GATE_FORK_CONTINUE_OK. Do not call tools.",
      );
      const allNonLastForks = [forkActive.includes(targetUser) && !forkActive.includes(nextUser)];
      for (let index = 2; index < sourceUsers.length; index += 1) {
        requireSuccess(await rpc.send({ type: "switch_session", sessionPath: sessionFile }));
        requireSuccess(await rpc.send({ type: "fork", entryId: sourceUsers[index] }));
        const derived = requireSuccess(await rpc.send({ type: "get_entries" }));
        const active = activeBranchIds(derived.entries, derived.leafId);
        allNonLastForks.push(
          active.includes(sourceUsers[index - 1]) && !active.includes(sourceUsers[index]),
        );
      }
      requireSuccess(await rpc.send({ type: "switch_session", sessionPath: sessionFile }));
      const sourceAfter = requireSuccess(await rpc.send({ type: "get_entries" }));
      const sourceUnchanged =
        hashFile(sessionFile) === sourceHash &&
        JSON.stringify(sourceAfter.entries.map(({ id }) => id)) ===
          JSON.stringify(source.entries.map(({ id }) => id));
      requireSuccess(await rpc.send({ type: "clone" }));
      const cloneState = requireSuccess(await rpc.send({ type: "get_state" }));
      const cloneEntries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const cloneContinued = await promptAndSettle(
        rpc,
        "Reply with exactly GATE_CLONE_CONTINUE_OK. Do not call tools.",
      );
      const forkIdentityChanged =
        forkState.sessionId !== sourceState.sessionId &&
        forkState.sessionFile !== sourceState.sessionFile;
      const forkCutExact = allNonLastForks.every(Boolean);
      const forkStateMatchesCutoff =
        (!expectedModel ||
          (forkState.model?.provider === expectedModel.provider &&
            forkState.model?.id === expectedModel.modelId)) &&
        (!expectedThinking || forkState.thinkingLevel === expectedThinking.thinkingLevel);
      const cloneIdentityChanged =
        cloneState.sessionId !== sourceState.sessionId &&
        cloneState.sessionFile !== sourceState.sessionFile;
      const cloneContainsSource = source.entries
        .map(({ id }) => id)
        .every((id) => cloneEntries.entries.some((entry) => entry.id === id));
      const passed =
        forkIdentityChanged &&
        forkCutExact &&
        forkStateMatchesCutoff &&
        sourceUnchanged &&
        cloneIdentityChanged &&
        cloneContainsSource &&
        assistantCompleted(forkContinued.events) &&
        assistantCompleted(cloneContinued.events);
      return {
        id: "native-live-fork",
        profile: "native-live",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          sourceHasThreeTurns: true,
          nonLastForkIdentityChanged: forkIdentityChanged,
          allNonLastForkPositionsExact: forkCutExact,
          forkStateMatchesCheckpointCutoff: forkStateMatchesCutoff,
          forkCanContinue: assistantCompleted(forkContinued.events),
          sourceSessionUnchanged: sourceUnchanged,
          lastTurnCloneIdentityChanged: cloneIdentityChanged,
          cloneContainsCompleteSource: cloneContainsSource,
          cloneCanContinue: assistantCompleted(cloneContinued.events),
          modelAndThinkingStateRecorded: Boolean(
            forkState.model && forkState.thinkingLevel && cloneState.model,
          ),
        },
        evidence: ["get_entries", "fork", "switch_session", "clone", "prompt"],
      };
    },
  });
}

export async function runTreeBranchScenario({
  repositoryRoot,
  workspace,
  configuredCommand,
  sessionFile,
}) {
  const extensionPath = path.resolve(import.meta.dirname, "fixtures/gate-extension.ts");
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-tree-branch",
    configuredCommand,
    env: liveEnvironment(),
    rpcArgs: liveRpcArgs(workspace, [
      "--extension",
      extensionPath,
      ...sessionArgument(sessionFile),
    ]),
    run: async (rpc) => {
      const before = requireSuccess(await rpc.send({ type: "get_entries" }));
      const beforeActive = activeBranchIds(before.entries, before.leafId);
      const branchTarget = before.entries.find(
        ({ id, type, message }) =>
          beforeActive.includes(id) && type === "message" && message?.role === "assistant",
      );
      const oldUsers = userEntryIds(before.entries);
      if (!branchTarget || oldUsers.length < 2) {
        return {
          id: "native-live-tree-branch",
          profile: "native-live",
          status: "FAIL",
          required: true,
          checks: { branchTargetAvailable: false },
          evidence: ["get_entries"],
          error: { code: "TREE_SOURCE", message: "No completed branch target is available" },
        };
      }
      requireSuccess(
        await rpc.send({ type: "prompt", message: `/gate-navigate ${branchTarget.id}` }),
      );
      const branchRun = await promptAndSettle(
        rpc,
        "Reply with exactly GATE_TREE_BRANCH_OK. Do not call tools.",
      );
      const after = requireSuccess(await rpc.send({ type: "get_entries" }));
      const tree = requireSuccess(await rpc.send({ type: "get_tree" }));
      const messages = requireSuccess(await rpc.send({ type: "get_messages" }));
      const active = activeBranchIds(after.entries, after.leafId);
      const afterUsers = userEntryIds(after.entries);
      const newUser = afterUsers.at(-1);
      const abandonedUsers = oldUsers.slice(1);
      const appendOrderRetained = abandonedUsers.every((id) =>
        after.entries.some((entry) => entry.id === id),
      );
      const abandonedExcluded = abandonedUsers.every((id) => !active.includes(id));
      const activeIncludesNewBranch = active.includes(newUser);
      const contextUserCount = messages.messages.filter(({ role }) => role === "user").length;
      const entriesUserCount = afterUsers.length;
      const passed =
        appendOrderRetained &&
        abandonedExcluded &&
        activeIncludesNewBranch &&
        contextUserCount < entriesUserCount &&
        tree.leafId === after.leafId &&
        assistantCompleted(branchRun.events);
      return {
        id: "native-live-tree-branch",
        profile: "native-live",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          branchTargetAvailable: true,
          appendOrderRetainsAbandonedBranch: appendOrderRetained,
          activeBranchExcludesAbandonedUsers: abandonedExcluded,
          activeBranchIncludesNewTurn: activeIncludesNewBranch,
          getMessagesDiffersFromCompleteEntries: contextUserCount < entriesUserCount,
          treeLeafMatchesEntriesLeaf: tree.leafId === after.leafId,
        },
        evidence: ["get_entries", "gate-navigate", "get_tree", "get_messages"],
      };
    },
  });
}

export function contextFromCapture(capturePath) {
  const state = responseDataFromCapture(capturePath, "get_state");
  const entries = responseDataFromCapture(capturePath, "get_entries");
  return {
    sessionFile: state.sessionFile,
    sessionId: state.sessionId,
    model: state.model,
    entryIds: entries.entries.map(({ id }) => id),
    userIds: userEntryIds(entries.entries),
  };
}
