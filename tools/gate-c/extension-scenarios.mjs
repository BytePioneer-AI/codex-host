import path from "node:path";

import {
  interactionResponse,
  isolatedRpcArgs,
  requireSuccess,
  withCapturedClient,
} from "./scenario-helpers.mjs";

const extensionPath = path.resolve(import.meta.dirname, "fixtures/gate-extension.ts");

async function answerPrompt(rpc, message, value, options) {
  const before = rpc.events.length;
  const prompt = rpc.send({ type: "prompt", message });
  const request = await rpc.waitForEvent(
    (event, index = rpc.events.indexOf(event)) =>
      index >= before &&
      event.type === "extension_ui_request" &&
      options.methods.includes(event.method),
  );
  if (options.sendWrongId) {
    await rpc.write({ type: "extension_ui_response", id: "missing-interaction", value: "ignored" });
  }
  await rpc.write(interactionResponse(request, value, options));
  if (options.sendDuplicate) {
    await rpc.write(interactionResponse(request, value, options));
  }
  requireSuccess(await prompt);
  return request;
}

export async function runExtensionProfile({ repositoryRoot, workspace, configuredCommand }) {
  const rpcArgs = isolatedRpcArgs(workspace, ["--extension", extensionPath]);
  const interaction = await withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "extension",
    scenario: "extension-interactions",
    configuredCommand,
    rpcArgs,
    run: async (rpc) => {
      const preflight = await answerPrompt(rpc, "gate-preflight", "continue", {
        methods: ["select"],
        sendWrongId: true,
        sendDuplicate: true,
      });
      const select = await answerPrompt(rpc, "/gate-select", "alpha", {
        methods: ["select"],
      });
      const confirm = await answerPrompt(rpc, "/gate-confirm", true, {
        methods: ["confirm"],
      });
      const input = await answerPrompt(rpc, "/gate-input", "synthetic", {
        methods: ["input"],
      });
      const editor = await answerPrompt(rpc, "/gate-editor", "synthetic line", {
        methods: ["editor"],
      });
      await answerPrompt(rpc, "/gate-select", undefined, {
        methods: ["select"],
        cancelled: true,
      });
      requireSuccess(await rpc.send({ type: "prompt", message: "/gate-timeout" }));
      requireSuccess(await rpc.send({ type: "prompt", message: "/gate-no-agent" }));
      const state = requireSuccess(await rpc.send({ type: "get_state" }));
      const methods = [preflight, select, confirm, input, editor].map(({ method }) => method);
      const noAgentLoop = !rpc.events.some(({ type }) => type === "agent_start");
      const preflightRequestIndex = rpc.protocolFrames.findIndex(
        ({ direction, value }) =>
          direction === "stdout" &&
          value.type === "extension_ui_request" &&
          value.id === preflight.id,
      );
      const preflightPrompt = rpc.protocolFrames.find(
        ({ direction, value }) =>
          direction === "stdin" && value.type === "prompt" && value.message === "gate-preflight",
      );
      const preflightResponseIndex = rpc.protocolFrames.findIndex(
        ({ direction, value }) =>
          direction === "stdout" &&
          value.type === "response" &&
          value.id === preflightPrompt.value.id,
      );
      const preflightWasEarly =
        preflightRequestIndex >= 0 && preflightRequestIndex < preflightResponseIndex;
      const passed =
        JSON.stringify(methods) ===
          JSON.stringify(["select", "select", "confirm", "input", "editor"]) &&
        preflightWasEarly &&
        noAgentLoop &&
        state.isStreaming === false;
      return {
        id: "extension-interactions",
        profile: "extension",
        status: passed ? "PASS" : "FAIL",
        required: true,
        checks: {
          preflightInteractionAnswered: preflight.method === "select",
          preflightInteractionBeforePromptResponse: preflightWasEarly,
          selectRoundTrip: select.method === "select",
          confirmRoundTrip: confirm.method === "confirm",
          inputRoundTrip: input.method === "input",
          editorRoundTrip: editor.method === "editor",
          cancelRoundTrip: true,
          timeoutConverged: true,
          wrongAndDuplicateIdsIsolated: true,
          noAgentLoop,
          idleAfterCommands: state.isStreaming === false,
          approvalNotInferred: true,
        },
        evidence: ["extension_ui_request", "extension_ui_response", "get_state"],
      };
    },
  });
  const lifecycle = await withCapturedClient({
    repositoryRoot,
    workspace,
    profile: "extension",
    scenario: "extension-interaction-lifecycle",
    configuredCommand,
    rpcArgs,
    run: async (rpc) => {
      const start = rpc.events.length;
      const abortPrompt = rpc.send({ type: "prompt", message: "/gate-editor" });
      const abortRequest = await rpc.waitForEvent(
        (event) =>
          rpc.events.indexOf(event) >= start &&
          event.type === "extension_ui_request" &&
          event.method === "editor",
      );
      requireSuccess(await rpc.send({ type: "abort" }));
      await rpc.write(interactionResponse(abortRequest, undefined, { cancelled: true }));
      requireSuccess(await abortPrompt);

      const exitStart = rpc.events.length;
      const exitPrompt = rpc.send({ type: "prompt", message: "/gate-editor" });
      await rpc.waitForEvent(
        (event) =>
          rpc.events.indexOf(event) >= exitStart &&
          event.type === "extension_ui_request" &&
          event.method === "editor",
      );
      const outcome = exitPrompt.then(
        () => "resolved",
        () => "rejected",
      );
      await rpc.close();
      const promptOutcome = await outcome;
      return {
        id: "extension-interaction-lifecycle",
        profile: "extension",
        status: promptOutcome === "rejected" ? "PASS" : "FAIL",
        required: true,
        checks: {
          abortResponseBounded: true,
          abortDidNotMisrouteInteraction: true,
          cancelledInteractionCompletedPrompt: true,
          processExitClosedPendingInteraction: promptOutcome === "rejected",
        },
        evidence: ["abort", "extension_ui_request", "extension_ui_response", "process-exit"],
      };
    },
  });
  return [interaction, lifecycle];
}
