import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { prepareSpawn, resolvePiCommand } from "./command.mjs";
import { GateCError } from "./errors.mjs";
import { requireSuccess } from "./scenario-helpers.mjs";

export function liveEnvironment(overrides = {}) {
  return {
    ...process.env,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...overrides,
  };
}

export function liveRpcArgs(workspace, extra = []) {
  return [
    "--session-dir",
    workspace.sessions,
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    ...extra,
  ];
}

export function responseDataFromCapture(capturePath, command) {
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  const frame = capture.frames
    .filter(
      ({ direction, value }) =>
        direction === "stdout" &&
        value?.type === "response" &&
        value.command === command &&
        value.success,
    )
    .at(-1);
  if (!frame) throw new GateCError("CAPTURE_MISSING", `Capture has no '${command}' response`);
  return frame.value.data;
}

export async function promptAndSettle(rpc, message, { timeoutMs = 120_000 } = {}) {
  const startIndex = rpc.events.length;
  const settled = rpc.waitForEvent(
    (event) => rpc.events.indexOf(event) >= startIndex && event.type === "agent_settled",
    { timeoutMs },
  );
  const response = await rpc.send({ type: "prompt", message }, { timeoutMs });
  requireSuccess(response);
  await settled;
  const state = requireSuccess(await rpc.send({ type: "get_state" }));
  const events = rpc.events.slice(startIndex);
  return { response, events, state };
}

export function terminalChecks(events, state) {
  const types = events.map(({ type }) => type);
  return {
    agentStarted: types.includes("agent_start"),
    agentEnded: types.includes("agent_end"),
    agentSettled: types.includes("agent_settled"),
    endedBeforeSettled: types.indexOf("agent_end") < types.lastIndexOf("agent_settled"),
    nonStreamingState: state.isStreaming === false,
    singleSettled: types.filter((type) => type === "agent_settled").length === 1,
  };
}

export function userEntryIds(entries) {
  return entries
    .filter(({ type, message }) => type === "message" && message?.role === "user")
    .map(({ id }) => id);
}

export function activeBranchIds(entries, leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ids = [];
  let current = leafId;
  while (current) {
    ids.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return ids.reverse();
}

export function runNativeAppend({ configuredCommand, env, workspace, sessionFile, message }) {
  const selected = resolvePiCommand({ configuredCommand, env });
  const invocation = {
    command: selected.command,
    args: [
      ...selected.prefixArgs,
      "--session",
      sessionFile,
      "--session-dir",
      workspace.sessions,
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "-p",
      message,
    ],
  };
  const prepared = prepareSpawn(invocation, { env });
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: workspace.cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
  if (result.error) throw new GateCError("NATIVE_APPEND", result.error.message);
  if (result.status !== 0) {
    throw new GateCError("NATIVE_APPEND", `Native Pi append failed: ${result.stderr.trim()}`);
  }
  return { commandSource: selected.source, exitCode: result.status };
}

export function sessionArgument(sessionFile) {
  return ["--session", path.resolve(sessionFile)];
}
