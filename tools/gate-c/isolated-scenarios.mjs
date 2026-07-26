import fs from "node:fs";
import path from "node:path";

import { isolatedRpcArgs, requireSuccess, withCapturedClient } from "./scenario-helpers.mjs";

export async function runIsolatedProfile({ repositoryRoot, workspace, configuredCommand }) {
  const controlPlane = await withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "isolated",
    scenario: "isolated-control-plane",
    configuredCommand,
    rpcArgs: isolatedRpcArgs(workspace),
    run: async (rpc) => {
      const state = requireSuccess(await rpc.send({ type: "get_state" }));
      const entries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const tree = requireSuccess(await rpc.send({ type: "get_tree" }));
      const commands = requireSuccess(await rpc.send({ type: "get_commands" }));
      const unknown = await rpc.send({ type: "codexhost_gate_unknown" });
      const wrongArguments = await rpc.send({ type: "set_model" });
      requireSuccess(
        await rpc.send({ type: "set_session_name", name: "codexhost-gate-c-isolated" }),
      );
      requireSuccess(await rpc.send({ type: "bash", command: "echo codexhost-gate-c-isolated" }));
      const finalState = requireSuccess(await rpc.send({ type: "get_state" }));
      const finalEntries = requireSuccess(await rpc.send({ type: "get_entries" }));
      const sessionInsideWorkspace = path
        .resolve(state.sessionFile)
        .startsWith(`${path.resolve(workspace.sessions)}${path.sep}`);
      const initializationOnly = entries.entries.every(
        ({ type }) => type === "model_change" || type === "thinking_level_change",
      );
      const noUserResources = commands.commands.every(
        ({ sourceInfo }) => sourceInfo?.scope === "temporary" && sourceInfo?.source === "inline",
      );
      const passed =
        state.isStreaming === false &&
        initializationOnly &&
        tree.tree.length > 0 &&
        noUserResources &&
        !unknown.success &&
        !wrongArguments.success &&
        sessionInsideWorkspace;
      return {
        id: "isolated-control-plane",
        profile: "isolated",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          rpcStarted: true,
          sessionLocatorAssigned: typeof finalState.sessionFile === "string",
          sessionPersistedWithoutAgentTurn: fs.existsSync(finalState.sessionFile),
          sessionInsideWorkspace,
          initiallyIdle: state.isStreaming === false,
          initializationEntriesObserved: initializationOnly,
          treeAndLeafAvailable: tree.tree.length > 0 && tree.leafId !== null,
          noUserOrProjectResources: noUserResources,
          unknownCommandRejected: !unknown.success,
          wrongArgumentsRejected: !wrongArguments.success,
          sessionNameEntryAppended: finalEntries.entries.some(
            ({ type }) => type === "session_info",
          ),
          bashExecutionCaptured: finalEntries.entries.some(
            ({ type, message }) => type === "message" && message?.role === "bashExecution",
          ),
        },
        evidence: ["get_state", "get_entries", "get_tree", "get_commands", "bash"],
      };
    },
  });
  return [controlPlane];
}
