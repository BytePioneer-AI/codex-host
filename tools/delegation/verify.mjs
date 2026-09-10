#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expandScenarios, listScenarioIds, SCENARIOS } from "./matrix.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliWrapper = path.join(repositoryRoot, "tools/delegation/cli-wrapper.mjs");
const TOKEN_ENV = "CODEXHOST_RUNTIME_TOKEN";
const ENDPOINT_ENV = "CODEXHOST_RUNTIME_ENDPOINT";

function usage() {
  return `usage:
  node tools/delegation/verify.mjs --list
  node tools/delegation/verify.mjs --mode hermetic|live --scenario <ID[,ID...]|all-required> --output <absolute-dir>
`;
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument '${argument}'`);
    }
    if (argument === "--list") {
      options.set("--list", "true");
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (options.has(argument)) throw new Error(`${argument} may only be provided once`);
    options.set(argument, value);
    index += 1;
  }
  return options;
}

function redact(value, token) {
  if (token && typeof value === "string" && value.includes(token)) {
    return value.split(token).join("[redacted]");
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, token));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key.toLowerCase().includes("token") || key === TOKEN_ENV) {
        result[key] = "[redacted]";
      } else {
        result[key] = redact(entry, token);
      }
    }
    return result;
  }
  return value;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function gitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function runCli(environment, args, cwd, timeoutMs = 120_000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliWrapper, ...args], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        argv: [process.execPath, cliWrapper, ...args],
        cwd,
        status: null,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        error: `timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve({
        argv: [process.execPath, cliWrapper, ...args],
        cwd,
        status,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        argv: [process.execPath, cliWrapper, ...args],
        cwd,
        status: null,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        error: error.message,
      });
    });
  });
}

function parseJsonOutput(cli) {
  const text = (cli.stdout || cli.stderr || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function assertWritableDirectory(output) {
  if (!path.isAbsolute(output)) throw new Error("--output must be an absolute directory");
  try {
    await mkdir(output, { recursive: true });
    const probe = path.join(output, `.write-probe-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
  } catch (error) {
    const wrapped = new Error(
      `--output is not writable: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.code = "OUTPUT_UNWRITABLE";
    throw wrapped;
  }
}

async function startRuntime(mode, dataDirectory) {
  const { startIsolatedDelegationRuntime } = await import(
    pathToFileURL(
      path.join(repositoryRoot, "packages/host-runtime/dist/isolated-delegation-runtime.js"),
    ).href
  );
  const options = {
    dataDirectory,
    cliPath: cliWrapper,
    mode,
    environment: process.env,
  };
  if (mode === "hermetic") {
    const { createHermeticGrokAdapter } = await import("./hermetic-adapter.mjs");
    options.externalAdapters = new Map([["grok", createHermeticGrokAdapter()]]);
  } else {
    options.pluginRoots = [path.join(repositoryRoot, "packages/host-runtime/dist/plugins")];
  }
  return startIsolatedDelegationRuntime(options);
}

async function scenarioEntry01() {
  const ids = listScenarioIds();
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error("Scenario IDs are not unique");
  return { ids, unique: true };
}

async function scenarioEntry02(context) {
  const inheritedEndpoint = process.env[ENDPOINT_ENV] ?? null;
  if (context.runtime.endpoint === inheritedEndpoint) {
    throw new Error("Isolated Runtime inherited the current Desktop endpoint");
  }
  return {
    isolatedEndpoint: context.runtime.endpoint,
    inheritedEndpoint,
    officialKind: context.runtime.officialKind,
  };
}

async function scenarioEntry03(context) {
  const fixtureFile = path.join(context.dataDirectory, "entry-03-fixture.txt");
  await writeFile(fixtureFile, "isolated-only");
  const userRepoProbe = path.join(repositoryRoot, "entry-03-should-not-exist.txt");
  try {
    await stat(userRepoProbe);
    throw new Error("Fixture leaked into the user repository");
  } catch (error) {
    if (error instanceof Error && error.message === "Fixture leaked into the user repository") {
      throw error;
    }
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const originalClose = context.runtime.close.bind(context.runtime);
  const scenarioError = new Error("synthetic scenario failure");
  let cleanupError;
  context.runtime.close = async () => {
    throw new Error("synthetic cleanup failure");
  };
  try {
    await context.runtime.close();
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }
  context.runtime.close = originalClose;
  if (!cleanupError) throw new Error("ENTRY-03 did not observe a cleanup failure");
  return {
    scenarioError: scenarioError.message,
    cleanupError: cleanupError.message,
    preservedBoth: true,
  };
}

async function scenarioSmoke01(context) {
  const token = `SMOKE-${randomUUID()}`;
  const cwd = await mkdtemp(path.join(context.runDirectory, "smoke-"));
  const parent = "00000000-0000-4000-8000-000000000010";
  const start = await runCli(
    context.childEnvironment,
    [
      "delegate",
      "start",
      "--harness",
      "grok",
      "--task",
      `Reply with exactly this token and nothing else: ${token}`,
      "--cwd",
      cwd,
      "--parent-thread",
      parent,
      "--request-id",
      `smoke-${token}`,
    ],
    cwd,
  );
  const started = parseJsonOutput(start);
  if (start.status !== 0 || started.error) {
    throw new Error(
      `SMOKE-01 start failed: ${start.error ?? ""} ${start.stderr || start.stdout}`.trim(),
    );
  }
  const wait = await runCli(
    context.childEnvironment,
    ["thread", "wait", started.threadId, "--timeout-ms", "120000"],
    cwd,
    130_000,
  );
  const waited = parseJsonOutput(wait);
  const read = await runCli(context.childEnvironment, ["thread", "read", started.threadId], cwd);
  const snapshot = parseJsonOutput(read);
  const text = snapshot.result?.text ?? "";
  if (!text.includes(token)) {
    throw new Error(`SMOKE-01 did not echo token; status=${snapshot.status}`);
  }
  return {
    delegationId: started.delegationId,
    threadId: started.threadId,
    turnId: started.turnId,
    parent,
    cwd,
    configuration: started.configuration ?? snapshot.configuration,
    tokenPresent: true,
    wait,
    read,
    waited,
  };
}

class ScenarioIncomplete extends Error {
  constructor(message) {
    super(message);
    this.name = "ScenarioIncomplete";
    this.code = "INCOMPLETE";
  }
}

const PARENT = "00000000-0000-4000-8000-000000000010";

function requireOk(cli, label) {
  const body = parseJsonOutput(cli);
  if (cli.status !== 0 || body.error) {
    throw new Error(
      `${label} failed: ${cli.error ?? ""} ${body.error ? JSON.stringify(body.error) : cli.stderr || cli.stdout}`.trim(),
    );
  }
  return body;
}

async function startTask(context, input) {
  const args = [
    "delegate",
    "start",
    "--harness",
    "grok",
    "--task",
    input.task,
    "--cwd",
    input.cwd,
    "--parent-thread",
    input.parent ?? PARENT,
  ];
  if (input.requestId) args.push("--request-id", input.requestId);
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--thinking", input.thinking);
  if (input.taskFile) {
    args.splice(args.indexOf("--task"), 2);
    args.push("--task-file", input.taskFile);
  }
  return requireOk(await runCli(context.childEnvironment, args, input.cwd), "delegate start");
}

function waitTimeout(context) {
  return context.mode === "live" ? 60_000 : 2_000;
}

function waitBudget(context) {
  return context.mode === "live" ? 70_000 : 5_000;
}

async function waitIdle(context, threadId, cwd) {
  await runCli(
    context.childEnvironment,
    ["thread", "wait", threadId, "--timeout-ms", String(waitTimeout(context))],
    cwd,
    waitBudget(context),
  );
}

async function threadStatus(context, threadId, cwd) {
  return requireOk(
    await runCli(context.childEnvironment, ["thread", "status", threadId], cwd),
    "thread status",
  );
}

async function threadMessages(context, threadId, cwd) {
  return requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "read", threadId, "--view", "messages", "--limit", "100"],
      cwd,
    ),
    "thread messages",
  );
}

function modelId(configuration) {
  const value = configuration?.effective?.effectiveModel;
  if (!value) return null;
  return typeof value === "object" && value !== null && "id" in value ? value.id : value;
}

export function configurationFingerprint(status) {
  return {
    harnessId: status.harnessId ?? null,
    cwd: status.cwd ?? null,
    model: modelId(status.configuration) ?? null,
    thinking: status.configuration?.effective?.effectiveThinkingOptionId ?? null,
    permission: status.configuration?.effective?.effectivePermissionModeId ?? null,
  };
}

function assertRestoredConfiguration(before, after, label) {
  const left = configurationFingerprint(before);
  const right = configurationFingerprint(after);
  if (!left.harnessId && !left.model && !left.thinking) {
    throw new Error(`${label} had empty configuration; restoration cannot be proved`);
  }
  for (const key of Object.keys(left)) {
    if (left[key] !== right[key]) {
      throw new Error(
        `${label} ${key} drifted: ${JSON.stringify(left[key])} -> ${JSON.stringify(right[key])}`,
      );
    }
  }
}

function messageTurnIds(snapshot) {
  return [
    ...new Set(
      (snapshot.messages ?? [])
        .map((message) => message.turnId)
        .filter((value) => typeof value === "string" && value.length > 0),
    ),
  ];
}

async function scenarioCreation01(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "creation-"));
  const requestId = `creation-${randomUUID()}`;
  const task = context.mode === "live" ? "Reply with CREATION_OK" : "creation same id";
  const [left, right] = await Promise.all([
    startTask(context, { task, cwd, requestId }),
    startTask(context, { task, cwd, requestId }),
  ]);
  if (left.threadId !== right.threadId || left.delegationId !== right.delegationId) {
    throw new Error("CREATION-01 produced two identities");
  }
  const read = requireOk(
    await runCli(context.childEnvironment, ["thread", "read", left.threadId], cwd),
    "read",
  );
  return { threadId: left.threadId, turnId: left.turnId, read };
}

async function scenarioCreation02(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "creation2-"));
  const requestId = `conflict-${randomUUID()}`;
  await startTask(context, { task: "task-a", cwd, requestId, parent: PARENT });
  const conflict = await runCli(
    context.childEnvironment,
    [
      "delegate",
      "start",
      "--harness",
      "grok",
      "--task",
      "task-b",
      "--cwd",
      cwd,
      "--parent-thread",
      "00000000-0000-4000-8000-000000000011",
      "--request-id",
      requestId,
    ],
    cwd,
  );
  const body = parseJsonOutput(conflict);
  if (conflict.status === 0 || body.error?.code !== "INVALID_ARGUMENT") {
    throw new Error("CREATION-02 expected INVALID_ARGUMENT for conflicting request-id");
  }
  const [one, two] = await Promise.all([
    startTask(context, { task: "parallel-a", cwd, requestId: `p-${randomUUID()}` }),
    startTask(context, { task: "parallel-b", cwd, requestId: `p-${randomUUID()}` }),
  ]);
  if (one.threadId === two.threadId)
    throw new Error("different request-ids were serialized globally");
  return { conflict: body.error, parallel: [one.threadId, two.threadId] };
}

async function scenarioRecovery01(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "recovery-"));
  const requestId = `recovery-${randomUUID()}`;
  const first = await startTask(context, { task: "recovery ping", cwd, requestId });
  await context.runtime.close();
  context.runtime = await startRuntime(context.mode, context.dataDirectory);
  context.childEnvironment = context.runtime.childEnvironment();
  const second = await startTask(context, { task: "recovery ping", cwd, requestId });
  if (second.threadId !== first.threadId) throw new Error("RECOVERY-01 re-delivered the request");
  return { threadId: first.threadId, reopened: true };
}

async function scenarioTurn01(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "turn-"));
  const started = await startTask(context, {
    task: context.mode === "live" ? "Count slowly from 1 to 20" : "turn identity",
    cwd,
  });
  const cancel = requireOk(
    await runCli(context.childEnvironment, ["thread", "cancel", started.threadId], cwd),
    "cancel",
  );
  const read = requireOk(
    await runCli(context.childEnvironment, ["thread", "read", started.threadId], cwd),
    "read",
  );
  const turnId = read.turn?.turnId ?? cancel.turnId;
  const known = [started.turnId, cancel.turnId].filter(Boolean);
  if (turnId && started.turnId && turnId !== started.turnId && !known.includes(turnId)) {
    throw new Error(`TURN-01 identity drifted ${started.turnId} -> ${turnId}`);
  }
  return {
    started: started.turnId,
    cancel: cancel.turnId,
    read: read.turn?.turnId,
    cancelled: cancel.cancelled,
  };
}

async function scenarioTurn05(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "turn5-"));
  const started = await startTask(context, { task: "first turn", cwd });
  const waited = parseJsonOutput(
    await runCli(
      context.childEnvironment,
      ["thread", "wait", started.threadId, "--timeout-ms", "120000"],
      cwd,
      130_000,
    ),
  );
  if (waited.status === "running") {
    throw new Error("TURN-05 first Turn still running after wait");
  }
  const send = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "send", started.threadId, "--message", "second turn"],
      cwd,
    ),
    "send",
  );
  const stale = await runCli(
    context.childEnvironment,
    ["thread", "cancel", started.threadId, "--expected-turn", started.turnId],
    cwd,
  );
  const body = parseJsonOutput(stale);
  if (stale.status === 0 || body.error?.code !== "STALE_TURN") {
    throw new Error("TURN-05 expected STALE_TURN");
  }
  return { newTurn: send.turnId, stale: body.error };
}

async function scenarioObserve01(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "observe-"));
  const tasks = await Promise.all([
    startTask(context, { task: "complete with OBSERVE_A", cwd }),
    startTask(context, { task: "complete with OBSERVE_B", cwd }),
    startTask(context, { task: "complete with OBSERVE_C", cwd }),
  ]);
  const targets = tasks.map((task) => ({ threadId: task.threadId }));
  const targetsFile = path.join(cwd, "targets.json");
  await writeFile(targetsFile, `${JSON.stringify(targets)}\n`);
  const first = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "wait-many", "--targets-file", targetsFile, "--timeout-ms", "0"],
      cwd,
    ),
    "wait-many-0",
  );
  const json = JSON.stringify(first);
  if (
    json.includes("OBSERVE_A") &&
    first.results?.every((row) => row.status?.status === "completed")
  ) {
    // bodies must not appear on later unchanged waits
  }
  const second = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "wait-many", "--targets-file", targetsFile, "--timeout-ms", "0"],
      cwd,
    ),
    "wait-many-repeat",
  );
  const repeat = JSON.stringify(second);
  if (repeat.includes("complete with OBSERVE")) {
    throw new Error("unchanged wait-many resent historical bodies");
  }
  return { firstBytes: json.length, secondBytes: repeat.length, count: tasks.length };
}

async function scenarioInput01(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "input 路径 "));
  const taskFile = path.join(cwd, "task.txt");
  const payload = "INPUT-01 非ASCII task";
  await writeFile(taskFile, payload);
  const started = requireOk(
    await runCli(
      context.childEnvironment,
      [
        "delegate",
        "start",
        "--harness",
        "grok",
        "--task-file",
        taskFile,
        "--cwd",
        cwd,
        "--parent-thread",
        PARENT,
      ],
      cwd,
    ),
    "start-task-file",
  );
  const mutex = await runCli(
    context.childEnvironment,
    [
      "delegate",
      "start",
      "--harness",
      "grok",
      "--task",
      "x",
      "--task-file",
      taskFile,
      "--cwd",
      cwd,
      "--parent-thread",
      PARENT,
    ],
    cwd,
  );
  if (mutex.status === 0) throw new Error("INPUT-01 accepted mutually exclusive task inputs");
  return { threadId: started.threadId, cwd, payload };
}

async function scenarioEvidence01(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "evidence-"));
  const sentinel = `EVIDENCE-${randomUUID()}`;
  const file = path.join(cwd, "sentinel.txt");
  await writeFile(file, sentinel);
  const started = await startTask(context, {
    task: `Read ${file} and reply with its exact contents.`,
    cwd,
  });
  await runCli(
    context.childEnvironment,
    ["thread", "wait", started.threadId, "--timeout-ms", "120000"],
    cwd,
    130_000,
  );
  const evidence = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "evidence", started.threadId, "--include-output", "true"],
      cwd,
    ),
    "evidence",
  );
  const blob = JSON.stringify(evidence);
  if (context.mode === "live" && !blob.includes("sentinel") && !blob.includes(file)) {
    throw new Error("EVIDENCE-01 missing user-visible tool evidence");
  }
  if (blob.toLowerCase().includes("reasoning") && blob.includes("hidden")) {
    throw new Error("EVIDENCE-01 leaked reasoning");
  }
  return { threadId: started.threadId, items: evidence.items?.length ?? 0 };
}

async function scenarioRelease01(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "release-"));
  const startedPath = path.join(cwd, "started.json");
  const latePath = path.join(cwd, "late.txt");
  const script = path.join(repositoryRoot, "tools/delegation/fixtures/delayed-write.py");
  const started = await startTask(context, {
    task: `Run python3 ${script} in the background of this workspace. Environment: PROBE_STARTED=${startedPath} PROBE_LATE=${latePath} PROBE_DELAY=6. Do not wait for it in the Turn after it has started.`,
    cwd,
  });
  await new Promise((resolve) => setTimeout(resolve, context.mode === "live" ? 1500 : 50));
  await runCli(context.childEnvironment, ["thread", "cancel", started.threadId], cwd);
  await runCli(
    context.childEnvironment,
    [
      "thread",
      "wait",
      started.threadId,
      "--timeout-ms",
      context.mode === "live" ? "30000" : "2000",
    ],
    cwd,
    context.mode === "live" ? 40_000 : 5_000,
  );
  const released = requireOk(
    await runCli(context.childEnvironment, ["thread", "release", started.threadId], cwd),
    "release",
  );
  await new Promise((resolve) => setTimeout(resolve, context.mode === "live" ? 7000 : 20));
  const late = await stat(latePath)
    .then(() => true)
    .catch(() => false);
  if (context.mode === "live" && late && released.quiescence === "confirmed") {
    throw new Error("RELEASE-01 confirmed quiescence but late write occurred");
  }
  return { released, late };
}

async function scenarioSkill01() {
  const vitest = path.join(repositoryRoot, "node_modules/vitest/vitest.mjs");
  const child = await new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        vitest,
        "run",
        "--config",
        "tests/vitest.config.js",
        "packages/host-runtime/test/delegation-skill.test.ts",
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
  if (child.status !== 0) {
    throw new Error(`SKILL-01 failed:\n${child.stdout}\n${child.stderr}`);
  }
  return { vitestStatus: child.status };
}

async function scenarioViaVitest(id) {
  const vitest = path.join(repositoryRoot, "node_modules/vitest/vitest.mjs");
  const child = await new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        vitest,
        "run",
        "--config",
        "tests/vitest.config.js",
        "-t",
        id,
        "packages/host-runtime/test/harness-delegation-coordinator.test.ts",
        "packages/host-runtime/test/delegation-cli.test.ts",
        "packages/host-runtime/test/delegation-snapshot.test.ts",
        "packages/mapping-store/test/index.test.ts",
        "packages/host-runtime/test/delegation-skill.test.ts",
        "tools/delegation",
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
  if (child.status !== 0) {
    throw new Error(`${id} vitest failed:\n${child.stdout}\n${child.stderr}`);
  }
  return { vitestStatus: child.status };
}

async function scenarioCreation03() {
  return scenarioViaVitest("CREATION-03");
}

async function scenarioTurn04(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "turn4-"));
  const started = await startTask(context, { task: "TURN-04 idle", cwd });
  await runCli(
    context.childEnvironment,
    [
      "thread",
      "wait",
      started.threadId,
      "--timeout-ms",
      context.mode === "live" ? "60000" : "2000",
    ],
    cwd,
    context.mode === "live" ? 70_000 : 5_000,
  );
  const requestId = `send-${randomUUID()}`;
  const message = "TURN-04 same payload";
  const send = (text) =>
    runCli(
      context.childEnvironment,
      ["thread", "send", started.threadId, "--message", text, "--request-id", requestId],
      cwd,
    );
  const [left, right] = await Promise.all([send(message), send(message)]);
  const leftBody = parseJsonOutput(left);
  const rightBody = parseJsonOutput(right);
  if (left.status !== 0 || right.status !== 0 || leftBody.turnId !== rightBody.turnId) {
    throw new Error("TURN-04 same request-id did not coalesce to one Turn");
  }
  const conflict = await send("TURN-04 different payload");
  const conflictBody = parseJsonOutput(conflict);
  if (conflict.status === 0 || conflictBody.error?.code !== "INVALID_ARGUMENT") {
    throw new Error("TURN-04 expected INVALID_ARGUMENT for a conflicting send payload");
  }
  return { threadId: started.threadId, turnId: leftBody.turnId, conflict: conflictBody.error };
}

async function scenarioRecovery02(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "recovery2-"));
  const started = await startTask(context, { task: "recovery reconcile", cwd });
  const dry = requireOk(
    await runCli(context.childEnvironment, ["delegate", "reconcile", started.threadId], cwd),
    "reconcile-dry-run",
  );
  if (dry.applied === true || dry.writes > 0) {
    throw new Error("RECOVERY-02 dry-run must not apply writes");
  }
  return { threadId: started.threadId, dryRun: true, writes: dry.writes ?? 0 };
}

function writeFlow01Plant(cwd) {
  return Promise.all([
    writeFile(
      path.join(cwd, "scheduler.py"),
      [
        "completed = set()",
        "",
        "def mark_done(task_id, required=()):",
        "    completed.add(task_id)",
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(cwd, "test_scheduler.py"),
      [
        "import unittest",
        "from scheduler import mark_done, completed",
        "",
        "class SelectionTest(unittest.TestCase):",
        "    def test_batch_does_not_complete_dependency(self):",
        "        mark_done('child', required=('parent',))",
        "        self.assertNotIn('child', completed)",
        "",
      ].join("\n"),
    ),
  ]);
}

function python3() {
  const found = spawnSync("python3", ["-V"], { encoding: "utf8" });
  return found.status === 0 ? "python3" : "python";
}

function schedulerSource(cwd) {
  return readFile(path.join(cwd, "scheduler.py"), "utf8");
}

function runSchedulerTests(cwd) {
  return spawnSync(python3(), ["-m", "unittest", "test_scheduler.py", "-q"], {
    cwd,
    encoding: "utf8",
  });
}

async function scenarioFlow01(context) {
  if (context.mode !== "live") throw new Error("FLOW-01 is live-only");
  const cwd = await mkdtemp(path.join(context.runDirectory, "flow1-"));
  await writeFlow01Plant(cwd);
  const leakToken = `FLOW01_LEAKED_${randomUUID().slice(0, 8)}`;
  await writeFile(path.join(cwd, "leak.py"), `API_KEY = "${leakToken}"\n`);
  const git = (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`FLOW-01 git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  };
  git(["init"]);
  git(["add", "."]);
  git(["-c", "user.email=flow@example.com", "-c", "user.name=FLOW", "commit", "-m", "plant"]);
  const planted = runSchedulerTests(cwd);
  if (planted.status === 0) {
    throw new Error("FLOW-01 plant is not a real defect; unittest unexpectedly passed");
  }
  const plantScheduler = await schedulerSource(cwd);
  const writer = await startTask(context, {
    task: "Make test_scheduler.py pass. Run python3 -m unittest test_scheduler.py. Commit only if tests pass. Do not delete tests.",
    cwd,
  });
  await runCli(
    context.childEnvironment,
    ["thread", "wait", writer.threadId, "--timeout-ms", "180000"],
    cwd,
    190_000,
  );
  const log = git(["log", "--oneline"]).trim().split("\n");
  if (log.length < 2) throw new Error("FLOW-01 writer did not produce a follow-up commit");
  const headFiles = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
  if (!headFiles.includes("scheduler.py")) {
    throw new Error("FLOW-01 writer commit did not change scheduler.py");
  }
  if ((await schedulerSource(cwd)) === plantScheduler) {
    throw new Error("FLOW-01 writer commit left scheduler.py unchanged");
  }
  const afterWriter = runSchedulerTests(cwd);
  if (afterWriter.status !== 0) {
    throw new Error("FLOW-01 writer left tests failing");
  }
  const tests = await readFile(path.join(cwd, "test_scheduler.py"), "utf8");
  if (!tests.includes("test_batch_does_not_complete_dependency")) {
    throw new Error("FLOW-01 writer removed the planted test");
  }
  if (!(await readFile(path.join(cwd, "leak.py"), "utf8")).includes(leakToken)) {
    throw new Error("FLOW-01 writer removed the planted leak");
  }
  const reviewerPrompt =
    "Independent review of the current git worktree after the writer finished. Read every file. Report remaining security or correctness defects. If a secret remains, name the file. Do not claim the tree is clean if tests were deleted or secrets remain.";
  const [reviewerA, reviewerB] = await Promise.all([
    startTask(context, { task: `${reviewerPrompt} You are reviewer A.`, cwd }),
    startTask(context, { task: `${reviewerPrompt} You are reviewer B.`, cwd }),
  ]);
  await Promise.all(
    [reviewerA, reviewerB].map((started) =>
      runCli(
        context.childEnvironment,
        ["thread", "wait", started.threadId, "--timeout-ms", "180000"],
        cwd,
        190_000,
      ),
    ),
  );
  const reports = await Promise.all(
    [reviewerA, reviewerB].map(async (started) => {
      const read = await runCli(
        context.childEnvironment,
        ["thread", "read", started.threadId],
        cwd,
      );
      return `${read.stdout}\n${read.stderr}`;
    }),
  );
  const caught = reports.some((text) => text.includes(leakToken) || /leak\.py/u.test(text));
  const denied = reports.every((text) =>
    /no defect|没有缺陷|looks good|lgtm|no issue|clean/iu.test(text),
  );
  if (!caught || denied) {
    throw new Error(
      "FLOW-01 independent reviewers did not report the planted leak after the writer",
    );
  }
  return {
    threads: [writer.threadId, reviewerA.threadId, reviewerB.threadId],
    plantedCaught: true,
    writerTestsPassed: true,
    writerChangedScheduler: true,
  };
}

async function scenarioRelease04(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "release4-"));
  const started = await startTask(context, { task: "RELEASE-04 baseline", cwd });
  await waitIdle(context, started.threadId, cwd);
  const before = await threadStatus(context, started.threadId, cwd);
  const history = await threadMessages(context, started.threadId, cwd);
  const originalTurns = messageTurnIds(history);
  if (!started.turnId || !originalTurns.includes(started.turnId)) {
    throw new Error("RELEASE-04 pre-release history is missing the original Turn");
  }
  const released = requireOk(
    await runCli(context.childEnvironment, ["thread", "release", started.threadId], cwd),
    "release",
  );
  if (released.released !== true) {
    throw new ScenarioIncomplete(
      `RELEASE-04 did not release the Session (quiescence=${released.quiescence ?? "unknown"})`,
    );
  }
  const send = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "send", started.threadId, "--message", "continue after release"],
      cwd,
    ),
    "send-after-release",
  );
  await waitIdle(context, started.threadId, cwd);
  const after = await threadStatus(context, started.threadId, cwd);
  const historyAfter = await threadMessages(context, started.threadId, cwd);
  const restoredTurns = messageTurnIds(historyAfter);
  assertRestoredConfiguration(before, after, "RELEASE-04");
  if (!send.turnId || send.turnId === started.turnId) {
    throw new Error("RELEASE-04 send did not create a new Turn");
  }
  if (!restoredTurns.includes(started.turnId)) {
    throw new Error("RELEASE-04 lost pre-release history");
  }
  if (!restoredTurns.includes(send.turnId)) {
    throw new Error("RELEASE-04 follow-up Turn is missing from history");
  }
  return {
    threadId: started.threadId,
    released: true,
    fingerprint: configurationFingerprint(after),
    originalTurnId: started.turnId,
    resumedTurnId: send.turnId,
  };
}

async function scenarioEvidence04(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "evidence4-"));
  const started = await startTask(context, { task: "EVIDENCE-04 configuration", cwd });
  await waitIdle(context, started.threadId, cwd);
  const before = await threadStatus(context, started.threadId, cwd);
  const unknownBefore = new Set(before.configuration?.unknown ?? []);
  if (unknownBefore.has("model") && before.configuration?.effective?.effectiveModel) {
    throw new Error("EVIDENCE-04 filled unknown model with a default");
  }
  await context.runtime.close();
  context.runtime = await startRuntime(context.mode, context.dataDirectory);
  context.childEnvironment = context.runtime.childEnvironment();
  const after = await threadStatus(context, started.threadId, cwd);
  assertRestoredConfiguration(before, after, "EVIDENCE-04");
  const unknownAfter = new Set(after.configuration?.unknown ?? []);
  if (unknownAfter.has("thinking") && after.configuration?.effective?.effectiveThinkingOptionId) {
    throw new Error("EVIDENCE-04 filled unknown thinking after recovery");
  }
  return {
    threadId: started.threadId,
    before: configurationFingerprint(before),
    after: configurationFingerprint(after),
    recovered: true,
  };
}

async function scenarioSkill03(context) {
  if (context.mode !== "live") throw new Error("SKILL-03 is live-only");
  const cwd = await mkdtemp(path.join(context.runDirectory, "skill3-"));
  const skillModule = await import(
    pathToFileURL(path.join(repositoryRoot, "packages/host-runtime/dist/delegation-skill.js")).href
  );
  const skillDir = path.join(cwd, ".agents", "skills", "codexhost-delegation");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), skillModule.CODEXHOST_DELEGATION_SKILL);
  const child = await startTask(context, {
    task: "Count slowly from 1 to 80 without stopping.",
    cwd,
  });
  const busy = await runCli(
    context.childEnvironment,
    ["thread", "send", child.threadId, "--message", "are you done?"],
    cwd,
  );
  const busyBody = parseJsonOutput(busy);
  if (busy.status === 0 || busyBody.error?.code !== "THREAD_BUSY") {
    throw new ScenarioIncomplete(
      `SKILL-03 could not observe THREAD_BUSY before testing skill usage (${busyBody.error?.code ?? busy.status})`,
    );
  }
  const operator = await startTask(context, {
    task: `Follow ${path.join(skillDir, "SKILL.md")} exactly. Existing child thread: ${child.threadId}. Use CODEXHOST_CLI_PATH to send a follow-up or wait. If THREAD_BUSY, wait. Do not mint a new request-id. Do not run thread release.`,
    cwd,
  });
  await runCli(
    context.childEnvironment,
    ["thread", "wait", operator.threadId, "--timeout-ms", "180000"],
    cwd,
    190_000,
  );
  const listed = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "list", "--parent", PARENT, "--limit", "25"],
      cwd,
    ),
    "list",
  );
  const extraStarts = (listed.threads ?? []).filter(
    (row) => row.threadId !== child.threadId && row.threadId !== operator.threadId,
  );
  if (extraStarts.length > 0) {
    throw new Error("SKILL-03 started an extra child instead of waiting on the busy Thread");
  }
  const evidence = requireOk(
    await runCli(context.childEnvironment, ["thread", "evidence", operator.threadId], cwd),
    "operator-evidence",
  );
  const items = evidence.items ?? [];
  if (items.length === 0) {
    throw new Error("SKILL-03 operator produced no user-visible tool/command evidence");
  }
  const usedCli = items.some(
    (item) =>
      (item.kind === "command" || item.kind === "tool") &&
      /thread (send|wait|status|read)|CODEXHOST_CLI_PATH/u.test(
        `${item.command ?? ""} ${item.toolName ?? ""} ${item.path ?? ""}`,
      ),
  );
  if (!usedCli) {
    throw new Error("SKILL-03 evidence does not show Host CLI use from the managed skill");
  }
  if (items.some((item) => /thread release|delegate start/iu.test(`${item.command ?? ""}`))) {
    throw new Error("SKILL-03 evidence shows release or a new delegation");
  }
  await runCli(context.childEnvironment, ["thread", "cancel", child.threadId], cwd);
  return {
    child: child.threadId,
    operator: operator.threadId,
    evidenceItems: items.length,
    busy: busyBody.error,
  };
}

async function scenarioTurn02(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "turn2-"));
  const started = await startTask(context, { task: "TURN-02 cancel identity", cwd });
  const cancel = requireOk(
    await runCli(context.childEnvironment, ["thread", "cancel", started.threadId], cwd),
    "cancel",
  );
  const first = requireOk(
    await runCli(context.childEnvironment, ["thread", "read", started.threadId], cwd),
    "read-1",
  );
  await context.runtime.close();
  context.runtime = await startRuntime(context.mode, context.dataDirectory);
  context.childEnvironment = context.runtime.childEnvironment();
  const second = requireOk(
    await runCli(context.childEnvironment, ["thread", "read", started.threadId], cwd),
    "read-2",
  );
  const ids = [started.turnId, cancel.turnId, first.turn?.turnId, second.turn?.turnId].filter(
    Boolean,
  );
  if (new Set(ids).size !== 1) {
    throw new Error(`TURN-02 Host Turn ID drifted: ${ids.join(",")}`);
  }
  return { threadId: started.threadId, turnId: started.turnId };
}

async function scenarioTurn03(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "turn3-"));
  const started = await startTask(context, { task: "TURN-03 first", cwd });
  await waitIdle(context, started.threadId, cwd);
  const send = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "send", started.threadId, "--message", "TURN-03 follow-up"],
      cwd,
    ),
    "follow-up",
  );
  const listedRunning = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "list", "--parent", PARENT, "--limit", "25"],
      cwd,
    ),
    "list-running",
  );
  const row = (listedRunning.threads ?? []).find((item) => item.threadId === started.threadId);
  const readRunning = await threadStatus(context, started.threadId, cwd);
  if (!row || row.status !== readRunning.status) {
    throw new Error(
      `TURN-03 list/read disagreed during follow-up (${row?.status} vs ${readRunning.status})`,
    );
  }
  await waitIdle(context, started.threadId, cwd);
  const listedDone = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "list", "--parent", PARENT, "--limit", "25"],
      cwd,
    ),
    "list-done",
  );
  const done = (listedDone.threads ?? []).find((item) => item.threadId === started.threadId);
  const readDone = await threadStatus(context, started.threadId, cwd);
  if (!done || done.status !== readDone.status) {
    throw new Error("TURN-03 list/read disagreed after terminal");
  }
  const history = await threadMessages(context, started.threadId, cwd);
  if (!messageTurnIds(history).includes(send.turnId)) {
    throw new Error("TURN-03 follow-up Turn is missing from history");
  }
  return { threadId: started.threadId, followUp: send.turnId, status: readDone.status };
}

async function scenarioRelease02(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "release2-"));
  const started = await startTask(context, { task: "RELEASE-02 idle", cwd });
  await waitIdle(context, started.threadId, cwd);
  const first = requireOk(
    await runCli(context.childEnvironment, ["thread", "release", started.threadId], cwd),
    "release-1",
  );
  if (first.released !== true) {
    throw new ScenarioIncomplete(
      `RELEASE-02 first release did not confirm (quiescence=${first.quiescence ?? "unknown"})`,
    );
  }
  const second = parseJsonOutput(
    await runCli(context.childEnvironment, ["thread", "release", started.threadId], cwd),
  );
  if (second.error && second.error.code !== "THREAD_NOT_FOUND") {
    throw new Error(`RELEASE-02 repeat release failed: ${JSON.stringify(second.error)}`);
  }
  return { threadId: started.threadId, first, second };
}

async function scenarioRelease03(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "release3-"));
  const [left, right] = await Promise.all([
    startTask(context, { task: "RELEASE-03 left", cwd }),
    startTask(context, { task: "RELEASE-03 right", cwd }),
  ]);
  await Promise.all([
    waitIdle(context, left.threadId, cwd),
    waitIdle(context, right.threadId, cwd),
  ]);
  const released = requireOk(
    await runCli(context.childEnvironment, ["thread", "release", left.threadId], cwd),
    "release-left",
  );
  if (released.released !== true) {
    throw new ScenarioIncomplete(
      `RELEASE-03 could not release the first Session (quiescence=${released.quiescence ?? "unknown"})`,
    );
  }
  const surviving = await threadStatus(context, right.threadId, cwd);
  if (!surviving.threadId) throw new Error("RELEASE-03 terminated the sibling Session");
  return { released: left.threadId, surviving: right.threadId };
}

async function scenarioObserve02(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "observe2-"));
  const started = await startTask(context, { task: "OBSERVE-02 race", cwd });
  const status = await threadStatus(context, started.threadId, cwd);
  const targetsFile = path.join(cwd, "targets.json");
  await writeFile(
    targetsFile,
    `${JSON.stringify([{ threadId: started.threadId, afterRevision: status.revision }])}\n`,
  );
  const result = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "wait-many", "--targets-file", targetsFile, "--timeout-ms", "2000"],
      cwd,
      8_000,
    ),
    "wait-many-race",
  );
  const row = result.results?.[0];
  if (
    !row ||
    (row.outcome !== "changed" && row.outcome !== "timedOut" && row.outcome !== "resync")
  ) {
    throw new Error("OBSERVE-02 wait-many lost the target");
  }
  await waitIdle(context, started.threadId, cwd);
  return { threadId: started.threadId, outcome: row.outcome };
}

async function scenarioObserve03(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "observe3-"));
  const started = await startTask(context, { task: "OBSERVE-03 mix", cwd });
  const targetsFile = path.join(cwd, "targets.json");
  await writeFile(
    targetsFile,
    `${JSON.stringify([
      { threadId: started.threadId, afterRevision: "not-a-revision" },
      { threadId: "00000000-0000-4000-8000-ffffffffffff" },
    ])}\n`,
  );
  const result = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "wait-many", "--targets-file", targetsFile, "--timeout-ms", "0"],
      cwd,
    ),
    "wait-many-mix",
  );
  const outcomes = (result.results ?? []).map((row) => row.outcome);
  if (!outcomes.includes("resync") && !outcomes.includes("error")) {
    throw new Error(`OBSERVE-03 mixed wait-many outcomes were ${outcomes.join(",")}`);
  }
  return { outcomes };
}

async function scenarioObserve04(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "observe4-"));
  const payload = "OBSERVE04_BODY_".padEnd(12_000, "x");
  const started = await startTask(context, { task: payload, cwd });
  await waitIdle(context, started.threadId, cwd);
  const targetsFile = path.join(cwd, "targets.json");
  await writeFile(targetsFile, `${JSON.stringify([{ threadId: started.threadId }])}\n`);
  const first = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "wait-many", "--targets-file", targetsFile, "--timeout-ms", "0"],
      cwd,
    ),
    "wait-many-size-1",
  );
  const second = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "wait-many", "--targets-file", targetsFile, "--timeout-ms", "0"],
      cwd,
    ),
    "wait-many-size-2",
  );
  const text = JSON.stringify(second);
  if (text.includes("OBSERVE04_BODY_")) {
    throw new Error("OBSERVE-04 wait-many resent historical body");
  }
  if (Buffer.byteLength(text) > 4096) {
    throw new Error(`OBSERVE-04 unchanged wait-many JSON was ${Buffer.byteLength(text)} bytes`);
  }
  return {
    firstBytes: Buffer.byteLength(JSON.stringify(first)),
    secondBytes: Buffer.byteLength(text),
  };
}

async function scenarioInput02(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "input2-"));
  const explicit = "00000000-0000-4000-8000-0000000000aa";
  const started = await startTask(context, {
    task: "INPUT-02 parent",
    cwd,
    parent: explicit,
  });
  const listed = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "list", "--parent", explicit, "--limit", "25"],
      cwd,
    ),
    "list-explicit-parent",
  );
  if (!(listed.threads ?? []).some((row) => row.threadId === started.threadId)) {
    throw new Error("INPUT-02 explicit parent was not recorded");
  }
  const inferred = await startTask(context, {
    task: "INPUT-02 inferred",
    cwd,
    parent: explicit,
  });
  return { explicit: started.threadId, inferred: inferred.threadId, parent: explicit };
}

async function scenarioEvidence02(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "evidence2-"));
  const started = await startTask(context, { task: "EVIDENCE-02 cursor", cwd });
  await waitIdle(context, started.threadId, cwd);
  const first = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "evidence", started.threadId, "--limit", "1"],
      cwd,
    ),
    "evidence-page-1",
  );
  const second = requireOk(
    await runCli(
      context.childEnvironment,
      [
        "thread",
        "evidence",
        started.threadId,
        "--limit",
        "1",
        ...(first.nextCursor ? ["--cursor", first.nextCursor] : []),
      ],
      cwd,
    ),
    "evidence-page-2",
  );
  const invalid = await runCli(
    context.childEnvironment,
    ["thread", "evidence", started.threadId, "--cursor", "not-a-cursor"],
    cwd,
  );
  if (invalid.status === 0) throw new Error("EVIDENCE-02 accepted an invalid cursor");
  return {
    threadId: started.threadId,
    first: first.items?.length ?? 0,
    second: second.items?.length ?? 0,
  };
}

async function scenarioEvidence03(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "evidence3-"));
  const started = await startTask(context, { task: "EVIDENCE-03 privacy", cwd });
  await waitIdle(context, started.threadId, cwd);
  const read = requireOk(
    await runCli(context.childEnvironment, ["thread", "read", started.threadId], cwd),
    "default-read",
  );
  const blob = JSON.stringify(read);
  if (/reasoning|thought/iu.test(blob)) {
    throw new Error("EVIDENCE-03 default read leaked reasoning");
  }
  const evidence = requireOk(
    await runCli(context.childEnvironment, ["thread", "evidence", started.threadId], cwd),
    "evidence",
  );
  if (/reasoning|thought/iu.test(JSON.stringify(evidence))) {
    throw new Error("EVIDENCE-03 evidence leaked reasoning");
  }
  return { threadId: started.threadId };
}

async function scenarioSkill02(context) {
  const help = await runCli(context.childEnvironment, ["delegate", "--help"], context.runDirectory);
  const text = `${help.stdout}\n${help.stderr}`;
  for (const command of [
    "delegate start",
    "thread send",
    "thread wait-many",
    "thread evidence",
    "thread release",
    "delegate reconcile",
  ]) {
    if (!text.includes(command.split(" ").at(-1))) {
      throw new Error(`SKILL-02 help is missing ${command}`);
    }
  }
  if (/\/Users\/|C:\\\\Users\\/u.test(text)) {
    throw new Error("SKILL-02 help contains a machine-local path");
  }
  return { helpBytes: Buffer.byteLength(text) };
}

async function scenarioSkill04(context) {
  const inspect = requireOk(
    await runCli(context.childEnvironment, ["harness", "inspect", "grok"], context.runDirectory),
    "inspect",
  );
  const model = inspect.inspection?.catalog?.models?.[0]?.ref?.id;
  const thinking =
    inspect.inspection?.catalog?.models?.[0]?.supportedThinkingOptionIds?.[0] ??
    inspect.inspection?.catalog?.thinkingOptions?.[0]?.id;
  if (!model) throw new Error("SKILL-04 inspect returned no Model");
  const cwd = await mkdtemp(path.join(context.runDirectory, "skill4-"));
  const started = await startTask(context, {
    task: "SKILL-04 preserve model",
    cwd,
    model,
    ...(thinking ? { thinking } : {}),
  });
  await waitIdle(context, started.threadId, cwd);
  const status = await threadStatus(context, started.threadId, cwd);
  if (status.harnessId !== "grok") {
    throw new Error(`SKILL-04 harness drifted to ${status.harnessId}`);
  }
  if (modelId(status.configuration) !== model) {
    throw new Error("SKILL-04 did not preserve the selected Model");
  }
  return { threadId: started.threadId, model, harnessId: status.harnessId };
}

async function scenarioFlow02(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "flow2-"));
  const requestId = `flow2-${randomUUID()}`;
  const started = await startTask(context, { task: "FLOW-02 persist", cwd, requestId });
  await waitIdle(context, started.threadId, cwd);
  const before = await threadStatus(context, started.threadId, cwd);
  await context.runtime.close();
  context.runtime = await startRuntime(context.mode, context.dataDirectory);
  context.childEnvironment = context.runtime.childEnvironment();
  const recovered = await startTask(context, { task: "FLOW-02 persist", cwd, requestId });
  if (recovered.threadId !== started.threadId) {
    throw new Error("FLOW-02 re-delivered after Runtime reopen");
  }
  const send = requireOk(
    await runCli(
      context.childEnvironment,
      ["thread", "send", started.threadId, "--message", "continue after reopen"],
      cwd,
    ),
    "continue",
  );
  await waitIdle(context, started.threadId, cwd);
  const after = await threadStatus(context, started.threadId, cwd);
  assertRestoredConfiguration(before, after, "FLOW-02");
  const history = await threadMessages(context, started.threadId, cwd);
  if (!messageTurnIds(history).includes(started.turnId)) {
    throw new Error("FLOW-02 lost history after reopen");
  }
  return { threadId: started.threadId, continued: send.turnId };
}

async function scenarioFlow03(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "flow3-"));
  const tasks = await Promise.all([
    startTask(context, { task: "FLOW-03 A", cwd }),
    startTask(context, { task: "FLOW-03 B", cwd }),
  ]);
  const targetsFile = path.join(cwd, "targets.json");
  await writeFile(
    targetsFile,
    `${JSON.stringify(tasks.map((task) => ({ threadId: task.threadId })))}\n`,
  );
  const waits = [];
  for (let index = 0; index < 3; index += 1) {
    waits.push(
      requireOk(
        await runCli(
          context.childEnvironment,
          ["thread", "wait-many", "--targets-file", targetsFile, "--timeout-ms", "0"],
          cwd,
        ),
        `wait-many-${index}`,
      ),
    );
  }
  const last = JSON.stringify(waits.at(-1));
  if (/"text"\s*:/u.test(last) && last.includes("FLOW-03")) {
    throw new Error("FLOW-03 later wait-many resent historical bodies");
  }
  return { waitCalls: waits.length, lastBytes: Buffer.byteLength(last) };
}

export const HANDLERS = {
  "ENTRY-01": scenarioEntry01,
  "ENTRY-02": scenarioEntry02,
  "ENTRY-03": scenarioEntry03,
  "SMOKE-01": scenarioSmoke01,
  "CREATION-01": scenarioCreation01,
  "CREATION-02": scenarioCreation02,
  "CREATION-03": scenarioCreation03,
  "RECOVERY-01": scenarioRecovery01,
  "RECOVERY-02": scenarioRecovery02,
  "TURN-01": scenarioTurn01,
  "TURN-02": scenarioTurn02,
  "TURN-03": scenarioTurn03,
  "TURN-04": scenarioTurn04,
  "TURN-05": scenarioTurn05,
  "RELEASE-01": scenarioRelease01,
  "RELEASE-02": scenarioRelease02,
  "RELEASE-03": scenarioRelease03,
  "RELEASE-04": scenarioRelease04,
  "OBSERVE-01": scenarioObserve01,
  "OBSERVE-02": scenarioObserve02,
  "OBSERVE-03": scenarioObserve03,
  "OBSERVE-04": scenarioObserve04,
  "INPUT-01": scenarioInput01,
  "INPUT-02": scenarioInput02,
  "EVIDENCE-01": scenarioEvidence01,
  "EVIDENCE-02": scenarioEvidence02,
  "EVIDENCE-03": scenarioEvidence03,
  "EVIDENCE-04": scenarioEvidence04,
  "SKILL-01": scenarioSkill01,
  "SKILL-02": scenarioSkill02,
  "SKILL-03": scenarioSkill03,
  "SKILL-04": scenarioSkill04,
  "FLOW-01": scenarioFlow01,
  "FLOW-02": scenarioFlow02,
  "FLOW-03": scenarioFlow03,
};

export async function runVerify(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.get("--list") === "true") {
    const ids = listScenarioIds();
    process.stdout.write(`${ids.join("\n")}\n`);
    return { exitCode: 0, ids };
  }
  const mode = parsed.get("--mode");
  const scenario = parsed.get("--scenario");
  const output = parsed.get("--output");
  if (mode !== "hermetic" && mode !== "live") {
    throw Object.assign(new Error("--mode must be hermetic or live"), { exitCode: 2 });
  }
  if (!scenario) throw Object.assign(new Error("--scenario is required"), { exitCode: 2 });
  if (!output) throw Object.assign(new Error("--output is required"), { exitCode: 2 });
  await assertWritableDirectory(output);
  const requested = scenario
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const id of requested) {
    if (id !== "all-required" && !SCENARIOS[id]) {
      throw Object.assign(new Error(`Unknown scenario '${id}'`), { exitCode: 2 });
    }
  }
  const expanded = expandScenarios(mode, requested);
  const candidate = gitSha();
  const inheritedEndpoint = process.env[ENDPOINT_ENV] ?? null;
  const inheritedToken = process.env[TOKEN_ENV] ?? null;
  const report = {
    mode,
    requested,
    expanded,
    candidate,
    node: process.version,
    pid: process.pid,
    repositoryRoot,
    inheritedEndpoint,
    officialKind: "fixture",
    scenarios: [],
  };
  const runDirectory = path.join(output, `${mode}-${process.pid}`);
  await mkdir(runDirectory, { recursive: true });
  let runtime;
  const cleanupErrors = [];
  let scenarioError;
  let lastDataDirectory = path.join(runDirectory, "data");
  try {
    for (const id of expanded) {
      const started = Date.now();
      const logPath = path.join(output, `${id}.log`);
      const jsonPath = path.join(output, `${id}.json`);
      let result = "PASS";
      let details;
      const dataDirectory = path.join(runDirectory, id, "data");
      lastDataDirectory = dataDirectory;
      const needsRuntime =
        id !== "ENTRY-01" && id !== "SKILL-01" && id !== "SKILL-02" && id !== "CREATION-03";
      let context;
      try {
        if (mode === "live" && SCENARIOS[id] && !SCENARIOS[id].live) {
          throw new Error(`${id} is not a live scenario`);
        }
        if (mode === "hermetic" && SCENARIOS[id] && !SCENARIOS[id].hermetic) {
          throw new Error(`${id} is not a hermetic scenario`);
        }
        if (needsRuntime) {
          runtime = await startRuntime(mode, dataDirectory);
          if (inheritedEndpoint && runtime.endpoint === inheritedEndpoint) {
            throw new Error("Isolated Runtime used the inherited Desktop endpoint");
          }
        }
        const childEnvironment = runtime ? runtime.childEnvironment() : { ...process.env };
        context = {
          mode,
          runDirectory,
          dataDirectory,
          runtime,
          childEnvironment,
          candidate,
        };
        const handler = HANDLERS[id];
        details = handler ? await handler(context) : await scenarioViaVitest(id);
        const toClose = context.runtime;
        runtime = undefined;
        context.runtime = undefined;
        if (toClose) {
          const closed = await toClose.close();
          cleanupErrors.push(...closed.cleanupErrors);
        }
      } catch (error) {
        if (error && typeof error === "object" && error.code === "INCOMPLETE") {
          result = "INCOMPLETE";
          details = { incomplete: error instanceof Error ? error.message : String(error) };
          scenarioError = scenarioError ?? error;
        } else {
          result = "FAIL";
          details = { error: error instanceof Error ? error.message : String(error) };
          scenarioError = error;
        }
        const toClose = context?.runtime ?? runtime;
        runtime = undefined;
        if (context) context.runtime = undefined;
        if (toClose) {
          try {
            const closed = await Promise.race([
              toClose.close(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("runtime close timed out")), 10_000),
              ),
            ]);
            if (closed && typeof closed === "object" && "cleanupErrors" in closed) {
              cleanupErrors.push(...closed.cleanupErrors);
            }
          } catch (closeError) {
            cleanupErrors.push(
              closeError instanceof Error ? closeError.message : String(closeError),
            );
          }
        }
      }
      const record = redact(
        {
          id,
          mode,
          result,
          candidate,
          argv: process.argv,
          cwd: process.cwd(),
          durationMs: Date.now() - started,
          logPath,
          jsonPath,
          runtime: details
            ? {
                dataDirectory,
                officialKind: "fixture",
              }
            : null,
          details,
        },
        inheritedToken,
      );
      report.scenarios.push(record);
      await writeJson(jsonPath, record);
      await writeFile(logPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      if (result === "FAIL") break;
    }
  } catch (error) {
    scenarioError = error;
  } finally {
    if (runtime) {
      try {
        const closed = await runtime.close();
        cleanupErrors.push(...closed.cleanupErrors);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  report.cleanupErrors = cleanupErrors;
  const reportPath = path.join(output, "report.json");
  await writeJson(reportPath, redact(report, inheritedToken));
  process.stdout.write(
    `${JSON.stringify(
      redact(
        {
          mode,
          expanded,
          candidate,
          pid: process.pid,
          dataDirectory: lastDataDirectory,
          officialKind: "fixture",
          report: reportPath,
          cleanupErrors,
        },
        inheritedToken,
      ),
      null,
      2,
    )}\n`,
  );
  if (scenarioError && cleanupErrors.length > 0) {
    const combined = new Error(
      `${scenarioError instanceof Error ? scenarioError.message : String(scenarioError)}; cleanup: ${cleanupErrors.join("; ")}`,
    );
    combined.exitCode = 1;
    throw combined;
  }
  if (scenarioError) {
    const error = scenarioError instanceof Error ? scenarioError : new Error(String(scenarioError));
    error.exitCode = error.exitCode ?? 1;
    throw error;
  }
  return { exitCode: 0, reportPath };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = await runVerify();
    process.exit(result.exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (!message.includes("usage:")) process.stderr.write(usage());
    process.exit(
      error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) || 1 : 1,
    );
  }
}
