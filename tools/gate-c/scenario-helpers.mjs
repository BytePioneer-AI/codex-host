import os from "node:os";
import path from "node:path";

import { createCaptureRecorder, writeRawCapture } from "./capture.mjs";
import { scenarioResultSchema } from "./contracts.mjs";
import { asGateCError, GateCError } from "./errors.mjs";
import { PiRpcClient } from "./rpc-client.mjs";

export function requireSuccess(response) {
  if (!response?.success) {
    throw new GateCError("RPC_COMMAND", response?.error ?? "Pi RPC command failed", {
      command: response?.command,
    });
  }
  return response.data;
}

export function nativeEnvironment(overrides = {}) {
  return {
    ...process.env,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...overrides,
  };
}

export function isolatedRpcArgs(workspace, extra = []) {
  return [
    "--session-dir",
    workspace.sessions,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    ...extra,
  ];
}

export async function withCapturedClient({
  repositoryRoot,
  workspace,
  profile,
  scenario,
  configuredCommand,
  rpcArgs,
  env = nativeEnvironment(),
  run,
}) {
  const recorder = createCaptureRecorder();
  const startedAt = new Date().toISOString();
  const rpc = new PiRpcClient({
    configuredCommand,
    env,
    cwd: workspace.cwd,
    rpcArgs,
    commandTimeoutMs: 30_000,
    pendingCloseMs: 250,
    closeGraceMs: 2_000,
    forceGraceMs: 3_000,
    onProtocolFrame: (frame) => recorder.record(frame),
  });
  let result;
  try {
    await rpc.start();
    result = scenarioResultSchema.parse(await run(rpc));
  } catch (caught) {
    const error = asGateCError(caught);
    result = scenarioResultSchema.parse({
      id: scenario,
      profile,
      status: ["PROCESS_START", "PROCESS_START_TIMEOUT"].includes(error.code) ? "BLOCKED" : "FAIL",
      required: true,
      checks: { boundedCompletion: true },
      evidence: [],
      ...(error.code === "PROCESS_START" ? { blocker: error.message } : {}),
      error: { code: error.code, message: error.message },
    });
  } finally {
    await rpc.close().catch((error) => {
      if (!result || result.status === "PASS") {
        const gateError = asGateCError(error, "PROCESS_CLEANUP");
        result = scenarioResultSchema.parse({
          id: scenario,
          profile,
          status: "FAIL",
          required: true,
          checks: { boundedCompletion: false },
          evidence: [],
          error: { code: gateError.code, message: gateError.message },
        });
      }
    });
  }
  const outputPath = path.join(workspace.raw, `${scenario}.capture.json`);
  writeRawCapture(repositoryRoot, outputPath, {
    profile,
    scenario,
    commandSource: rpc.commandSource,
    platform: process.platform,
    architecture: os.arch(),
    startedAt,
    completedAt: new Date().toISOString(),
    frames: recorder.frames,
    result,
  });
  return { result, outputPath, commandSource: rpc.commandSource };
}

export function interactionResponse(request, value, { cancelled = false } = {}) {
  if (cancelled) return { type: "extension_ui_response", id: request.id, cancelled: true };
  if (request.method === "confirm") {
    return { type: "extension_ui_response", id: request.id, confirmed: Boolean(value) };
  }
  return { type: "extension_ui_response", id: request.id, value: String(value) };
}
