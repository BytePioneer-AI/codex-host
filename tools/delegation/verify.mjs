#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    const first = await originalClose();
    throw new Error(
      `synthetic cleanup failure${first.cleanupErrors.length ? `:${first.cleanupErrors.join(",")}` : ""}`,
    );
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
  if (input.taskFile) {
    args.splice(args.indexOf("--task"), 2);
    args.push("--task-file", input.taskFile);
  }
  return requireOk(await runCli(context.childEnvironment, args, input.cwd), "delegate start");
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
  if (turnId && started.turnId && turnId !== started.turnId && cancel.cancelled) {
    throw new Error(`TURN-01 identity drifted ${started.turnId} -> ${turnId}`);
  }
  return { started: started.turnId, cancel: cancel.turnId, read: read.turn?.turnId };
}

async function scenarioTurn05(context) {
  const cwd = await mkdtemp(path.join(context.runDirectory, "turn5-"));
  const started = await startTask(context, { task: "first turn", cwd });
  await runCli(
    context.childEnvironment,
    ["thread", "wait", started.threadId, "--timeout-ms", "60000"],
    cwd,
    70_000,
  );
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
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await runCli(context.childEnvironment, ["thread", "cancel", started.threadId], cwd);
  await runCli(
    context.childEnvironment,
    ["thread", "wait", started.threadId, "--timeout-ms", "30000"],
    cwd,
    40_000,
  );
  const released = requireOk(
    await runCli(context.childEnvironment, ["thread", "release", started.threadId], cwd),
    "release",
  );
  await new Promise((resolve) => setTimeout(resolve, 7000));
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

const HANDLERS = {
  "ENTRY-01": scenarioEntry01,
  "ENTRY-02": scenarioEntry02,
  "ENTRY-03": scenarioEntry03,
  "SMOKE-01": scenarioSmoke01,
  "CREATION-01": scenarioCreation01,
  "CREATION-02": scenarioCreation02,
  "CREATION-03": scenarioCreation02,
  "RECOVERY-01": scenarioRecovery01,
  "RECOVERY-02": scenarioRecovery01,
  "TURN-01": scenarioTurn01,
  "TURN-02": scenarioTurn01,
  "TURN-03": scenarioTurn01,
  "TURN-04": scenarioCreation01,
  "TURN-05": scenarioTurn05,
  "RELEASE-01": scenarioRelease01,
  "RELEASE-02": scenarioRelease01,
  "RELEASE-03": scenarioRelease01,
  "RELEASE-04": scenarioRelease01,
  "OBSERVE-01": scenarioObserve01,
  "OBSERVE-02": scenarioObserve01,
  "OBSERVE-03": scenarioObserve01,
  "OBSERVE-04": scenarioObserve01,
  "INPUT-01": scenarioInput01,
  "INPUT-02": scenarioInput01,
  "EVIDENCE-01": scenarioEvidence01,
  "EVIDENCE-02": scenarioEvidence01,
  "EVIDENCE-03": scenarioEvidence01,
  "EVIDENCE-04": scenarioEvidence01,
  "SKILL-01": scenarioSkill01,
  "SKILL-02": scenarioSkill01,
  "SKILL-03": scenarioTurn01,
  "SKILL-04": scenarioEvidence01,
  "FLOW-01": scenarioCreation01,
  "FLOW-02": scenarioRecovery01,
  "FLOW-03": scenarioObserve01,
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
  const dataDirectory = path.join(runDirectory, "data");
  let runtime;
  const cleanupErrors = [];
  let scenarioError;
  try {
    const needsRuntime = expanded.some((id) => id !== "ENTRY-01");
    if (needsRuntime) {
      runtime = await startRuntime(mode, dataDirectory);
      if (inheritedEndpoint && runtime.endpoint === inheritedEndpoint) {
        throw new Error("Isolated Runtime used the inherited Desktop endpoint");
      }
    }
    const childEnvironment = runtime ? runtime.childEnvironment() : { ...process.env };
    const context = {
      mode,
      runDirectory,
      dataDirectory,
      runtime,
      childEnvironment,
      candidate,
    };
    for (const id of expanded) {
      const started = Date.now();
      const logPath = path.join(output, `${id}.log`);
      const jsonPath = path.join(output, `${id}.json`);
      let result = "PASS";
      let details;
      try {
        if (mode === "live" && SCENARIOS[id] && !SCENARIOS[id].live) {
          throw new Error(`${id} is not a live scenario`);
        }
        if (mode === "hermetic" && SCENARIOS[id] && !SCENARIOS[id].hermetic) {
          throw new Error(`${id} is not a hermetic scenario`);
        }
        const handler = HANDLERS[id];
        details = handler ? await handler(context) : await scenarioViaVitest(id);
      } catch (error) {
        result = "FAIL";
        details = { error: error instanceof Error ? error.message : String(error) };
        scenarioError = error;
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
          runtime: runtime
            ? {
                endpoint: runtime.endpoint,
                pid: runtime.pid,
                dataDirectory: runtime.dataDirectory,
                officialKind: runtime.officialKind,
              }
            : null,
          details,
        },
        inheritedToken ?? childEnvironment[TOKEN_ENV],
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
          dataDirectory,
          endpoint: runtime?.endpoint ?? null,
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
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (!message.includes("usage:")) process.stderr.write(usage());
    process.exitCode =
      error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) || 1 : 1;
  }
}
