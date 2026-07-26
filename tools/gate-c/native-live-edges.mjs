import { liveEnvironment, liveRpcArgs, terminalChecks } from "./live-helpers.mjs";
import { requireSuccess, withCapturedClient } from "./scenario-helpers.mjs";

function newEvent(rpc, startIndex, predicate, timeoutMs = 120_000) {
  return rpc.waitForEvent((event) => rpc.events.indexOf(event) >= startIndex && predicate(event), {
    timeoutMs,
  });
}

export async function runRuntimeEdgeScenario({ repositoryRoot, workspace, configuredCommand }) {
  return withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "native-live",
    scenario: "native-live-runtime-edges",
    configuredCommand,
    env: liveEnvironment(workspace),
    rpcArgs: liveRpcArgs(workspace),
    run: async (rpc) => {
      const start = rpc.events.length;
      const settled = newEvent(rpc, start, ({ type }) => type === "agent_settled");
      const prompt = rpc.send({
        type: "prompt",
        message: "Write a numbered list of 20 one-word colors, one per line. Do not use tools.",
      });
      await newEvent(rpc, start, ({ type }) => type === "agent_start");
      const steer = await rpc.send({
        type: "steer",
        message: "Use uppercase words for the remaining response.",
      });
      const followUp = await rpc.send({
        type: "follow_up",
        message: "Then reply with exactly GATE_FOLLOW_UP_OK.",
      });
      requireSuccess(await prompt);
      requireSuccess(steer);
      requireSuccess(followUp);
      await settled;
      const state = requireSuccess(await rpc.send({ type: "get_state" }));
      const runEvents = rpc.events.slice(start);
      const compactStart = rpc.events.length;
      const compactResponse = await rpc.send({
        type: "compact",
        customInstructions: "Preserve only the synthetic Gate C facts.",
      });
      const compactEvents = rpc.events.slice(compactStart);
      const entries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const queueUpdates = runEvents.filter(({ type }) => type === "queue_update");
      const compactionSucceeded = compactResponse.success === true;
      const compactionEntry = entries.entries.some(({ type }) => type === "compaction");
      return {
        id: "native-live-runtime-edges",
        profile: "native-live",
        status: "BLOCKED",
        required: false,
        checks: {
          steerAccepted: steer.success === true,
          followUpAccepted: followUp.success === true,
          queueUpdatesObserved: queueUpdates.length > 0,
          queuedRunSettledOnce: terminalChecks(runEvents, state).singleSettled,
          manualCompactionCompleted: compactionSucceeded,
          compactionEventsObserved: compactEvents.some(({ type }) => type === "compaction_end"),
          compactionEntryPersisted: compactionEntry,
          automaticRetryObserved: false,
        },
        evidence: ["steer", "follow_up", "queue_update", "compact", "get_entries"],
        blocker:
          "Automatic provider retry and overflow compaction cannot be triggered deterministically without changing the user's Native Mode environment.",
      };
    },
  });
}
