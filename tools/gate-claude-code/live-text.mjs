import { randomUUID } from "node:crypto";

import { scenarioResult, scenarioStatus } from "./contracts.mjs";
import {
  allSessionsMatch,
  collectQuery,
  collectTurn,
  nativeIds,
  PushableInput,
  sdkUserMessage,
  writeRawScenario,
} from "./live-helpers.mjs";
import { claudeOptions, closeQuery } from "./runtime.mjs";
import { createProbeWorkspace, removeSyntheticProject } from "./workspace.mjs";

function historyUserIds(messages) {
  return messages.flatMap((message) =>
    message.type === "user" && typeof message.uuid === "string" ? [message.uuid] : [],
  );
}

function successful(summary) {
  return summary.resultCount === 1 && summary.terminal.outcome === "succeeded";
}

export async function runTextHistoryScenarios({ repositoryRoot, executable }) {
  const workspace = createProbeWorkspace(repositoryRoot, "live", "text-history-fork");
  const { forkSession, getSessionMessages, query } = await import("@anthropic-ai/claude-agent-sdk");
  const sessionId = randomUUID();
  const callerUserIds = [randomUUID(), randomUUID()];
  const input = new PushableInput();
  const activeQuery = query({
    prompt: input,
    options: claudeOptions({ cwd: workspace.cwd, executable, sessionId }),
  });

  let first;
  let second;
  let historyAfterTurns;
  try {
    await activeQuery.initializationResult();
    input.push(sdkUserMessage(sessionId, "Reply with exactly FIRST.", callerUserIds[0]));
    first = await collectTurn(activeQuery);
    input.push(sdkUserMessage(sessionId, "Reply with exactly SECOND.", callerUserIds[1]));
    second = await collectTurn(activeQuery);
    historyAfterTurns = await getSessionMessages(sessionId, {
      dir: workspace.cwd,
      includeSystemMessages: true,
    });
  } finally {
    input.end();
    await closeQuery(activeQuery);
  }

  const observedUserIds = historyUserIds(historyAfterTurns);
  const textChecks = {
    firstSucceeded: successful(first.summary),
    secondSucceeded: successful(second.summary),
    firstSessionMatched: allSessionsMatch(first.messages, sessionId),
    secondSessionMatched: allSessionsMatch(second.messages, sessionId),
    callerUserIdsPreserved: callerUserIds.every((id) => observedUserIds.includes(id)),
    callerUserOrderPreserved:
      observedUserIds.indexOf(callerUserIds[0]) >= 0 &&
      observedUserIds.indexOf(callerUserIds[0]) < observedUserIds.indexOf(callerUserIds[1]),
  };
  const textResult = scenarioResult({
    id: "live-text-multiturn",
    profile: "live",
    required: true,
    status: scenarioStatus(textChecks),
    checks: textChecks,
    facts: {
      firstEventCount: first.messages.length,
      secondEventCount: second.messages.length,
      nativeHistoryCount: historyAfterTurns.length,
      unknownEventKinds: Object.keys({
        ...first.summary.unknownTypeCounts,
        ...second.summary.unknownTypeCounts,
      }).sort(),
    },
  });

  const idsBeforeResume = nativeIds(historyAfterTurns);
  const resumed = query({
    prompt: "Reply with exactly RESUMED. Do not use tools.",
    options: {
      ...claudeOptions({ cwd: workspace.cwd, executable, sessionId }),
      sessionId: undefined,
      resume: sessionId,
    },
  });
  const resumedRun = await collectQuery(resumed);
  const historyAfterResume = await getSessionMessages(sessionId, {
    dir: workspace.cwd,
    includeSystemMessages: true,
  });
  const idsAfterResume = nativeIds(historyAfterResume);
  const resumeChecks = {
    resumedTurnSucceeded: successful(resumedRun.summary),
    resumedSessionMatched: allSessionsMatch(resumedRun.messages, sessionId),
    priorMessageIdsPreserved: idsBeforeResume.every((id) => idsAfterResume.includes(id)),
    historyAppended: historyAfterResume.length > historyAfterTurns.length,
    callerUserIdsStillPresent: callerUserIds.every((id) =>
      historyUserIds(historyAfterResume).includes(id),
    ),
  };
  const resumeResult = scenarioResult({
    id: "live-resume",
    profile: "live",
    required: true,
    status: scenarioStatus(resumeChecks),
    checks: resumeChecks,
    facts: {
      historyBeforeCount: historyAfterTurns.length,
      historyAfterCount: historyAfterResume.length,
    },
  });

  const secondUserIndex = historyAfterResume.findIndex(
    (message) => message.type === "user" && message.uuid === callerUserIds[1],
  );
  const checkpoint = historyAfterResume
    .slice(0, secondUserIndex)
    .findLast((message) => message.type === "assistant" && typeof message.uuid === "string")?.uuid;
  if (!checkpoint) throw new Error("Claude Probe could not identify the first-Turn checkpoint");

  const sourceCountBeforeFork = historyAfterResume.length;
  const fork = await forkSession(sessionId, {
    dir: workspace.cwd,
    upToMessageId: checkpoint,
    title: "codexhost-claude-probe-fork",
  });
  const [forkHistory, sourceAfterFork] = await Promise.all([
    getSessionMessages(fork.sessionId, { dir: workspace.cwd, includeSystemMessages: true }),
    getSessionMessages(sessionId, { dir: workspace.cwd, includeSystemMessages: true }),
  ]);
  const sourceIds = new Set(nativeIds(historyAfterResume));
  const forkIds = nativeIds(forkHistory);
  const forkChecks = {
    newSessionCreated: fork.sessionId !== sessionId,
    sourceUnchanged: sourceAfterFork.length === sourceCountBeforeFork,
    contextStopsBeforeSecondTurn: historyUserIds(forkHistory).length === 1,
    derivedIdsRemapped: forkIds.length > 0 && forkIds.every((id) => !sourceIds.has(id)),
    sourceCheckpointNotReused: !forkIds.includes(checkpoint),
  };
  const forkResult = scenarioResult({
    id: "live-fork",
    profile: "live",
    required: true,
    status: scenarioStatus(forkChecks),
    checks: forkChecks,
    facts: {
      sourceHistoryCount: historyAfterResume.length,
      forkHistoryCount: forkHistory.length,
      forkUserCount: historyUserIds(forkHistory).length,
    },
  });

  writeRawScenario(repositoryRoot, workspace, "text-history-fork", {
    sessionId,
    callerUserIds,
    first: first.messages,
    second: second.messages,
    historyAfterTurns,
    resumed: resumedRun.messages,
    historyAfterResume,
    fork,
    forkHistory,
    results: [textResult, resumeResult, forkResult],
  });
  removeSyntheticProject(workspace);
  return [textResult, resumeResult, forkResult];
}
