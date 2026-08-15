import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { differentialResultSchema } from "../../tools/gate-a/contracts.mjs";

const MAX_PROTOCOL_ERROR_COUNT = 10;
const MAX_PROTOCOL_ERROR_PREVIEW = 160;

const INITIALIZE_PARAMS = {
  clientInfo: {
    name: "codex_app_server_daemon",
    title: "codexhost Gate A differential",
    version: "0.0.0",
  },
  capabilities: {
    experimentalApi: true,
    mcpServerOpenaiFormElicitation: true,
  },
};

function cleanEnvironment(codexHome) {
  const environment = { ...process.env, CODEX_HOME: codexHome };
  for (const key of [
    "CODEX_CLI_PATH",
    "CODEXHOST_STOCK_CODEX_PATH",
    "CODEXHOST_PROBE_OUTPUT",
    "CODEXHOST_DESKTOP_VERSION",
    "CODEXHOST_INSTALL_ROOT",
  ]) {
    delete environment[key];
  }
  return environment;
}

function normalize(value, roots) {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["createdAt", "updatedAt", "timestamp", "recencyAt"].includes(key))
        .map(([key, entry]) => [key, normalize(entry, roots)]),
    );
  }
  if (typeof value !== "string") return value;
  let normalized = value;
  for (const [root, replacement] of roots) {
    normalized = normalized
      .replaceAll(root, replacement)
      .replaceAll(root.replaceAll("\\", "\\\\"), replacement)
      .replaceAll(root.replaceAll("\\", "/"), replacement);
  }
  return normalized.replace(
    /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-<THREAD_ID>\.jsonl/gu,
    "rollout-<TIMESTAMP>-<THREAD_ID>.jsonl",
  );
}

function commandSpec(executable, shim, codexHome, prefixArguments = []) {
  if (!shim) {
    return {
      label: "direct",
      executable,
      prefixArguments,
      environment: cleanEnvironment(codexHome),
    };
  }
  return {
    label: "shim",
    executable: shim,
    prefixArguments,
    environment: {
      ...cleanEnvironment(codexHome),
      CODEXHOST_STOCK_CODEX_PATH: executable,
    },
  };
}

function captureCommand(spec, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, [...spec.prefixArguments, ...argumentsList], {
      env: spec.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function version(spec) {
  return captureCommand(spec, ["--version"]);
}

export function parseProtocolLine(line, lineNumber) {
  try {
    return { message: JSON.parse(line) };
  } catch {
    return {
      error: {
        lineNumber,
        characterLength: line.length,
        preview: line.slice(0, MAX_PROTOCOL_ERROR_PREVIEW),
        truncated: line.length > MAX_PROTOCOL_ERROR_PREVIEW,
      },
    };
  }
}

export function assertNoProtocolErrors(label, protocolErrors, protocolErrorCount) {
  if (protocolErrorCount === 0) return;
  const omitted = protocolErrorCount - protocolErrors.length;
  throw new Error(
    `${label} app-server stdout contained ${protocolErrorCount} non-JSON line(s): ` +
      `${JSON.stringify(protocolErrors)}${omitted > 0 ? `; ${omitted} omitted` : ""}`,
  );
}

function summarizeTurn(startResponse, events, expectedMarkers, expectedStatus = "completed") {
  const methods = new Set(events.map((event) => event.method));
  const serialized = events.map((event) => JSON.stringify(event.params)).join("\n");
  const observableOutput = events
    .filter(
      (event) =>
        event.method.includes("agentMessage") ||
        JSON.stringify(event.params).includes('"type":"agentMessage"') ||
        JSON.stringify(event.params).includes('"type":"commandExecution"'),
    )
    .map((event) => JSON.stringify(event.params))
    .join("\n");
  const completed = events.find((event) => event.method === "turn/completed");
  const status = completed?.params?.turn?.status ?? "missing";
  const markerMatches = expectedMarkers.map((marker) => observableOutput.includes(marker));
  const summary = {
    turnStartAccepted: !startResponse.error,
    status,
    hasTurnStarted: methods.has("turn/started"),
    hasAgentMessageDelta: methods.has("item/agentMessage/delta"),
    hasCommandExecution: serialized.includes('"type":"commandExecution"'),
    markerMatches,
  };
  return {
    ...summary,
    passed:
      summary.turnStartAccepted &&
      summary.status === expectedStatus &&
      summary.hasTurnStarted &&
      (expectedStatus !== "completed" || summary.hasAgentMessageDelta) &&
      markerMatches.every(Boolean),
  };
}

async function appServerSession(spec, { live = false } = {}) {
  const child = spawn(
    spec.executable,
    [...spec.prefixArguments, "-c", "features.plugins=false", "app-server", "--listen", "stdio://"],
    {
      env: spec.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = new Set();
  const protocolErrors = [];
  let protocolErrorCount = 0;
  let lineNumber = 0;
  lines.on("line", (line) => {
    lineNumber += 1;
    const parsed = parseProtocolLine(line, lineNumber);
    if (parsed.error) {
      protocolErrorCount += 1;
      if (protocolErrors.length < MAX_PROTOCOL_ERROR_COUNT) protocolErrors.push(parsed.error);
      return;
    }
    const { message } = parsed;
    if (typeof message.id === "number" && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      notifications.push(message);
      for (const waiter of notificationWaiters) {
        if (waiter.predicate(message)) {
          notificationWaiters.delete(waiter);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
      }
    }
  });
  let nextId = 1;
  const request = (method, params, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out; stderr=${stderr.slice(-2000)}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const waitForNotification = (predicate, startIndex, timeoutMs = 120_000) => {
    const existing = notifications.slice(startIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timeout: undefined };
      waiter.timeout = setTimeout(() => {
        notificationWaiters.delete(waiter);
        reject(new Error(`notification timed out; stderr=${stderr.slice(-2000)}`));
      }, timeoutMs);
      notificationWaiters.add(waiter);
    });
  };

  try {
    const initialize = await request("initialize", INITIALIZE_PARAMS);
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const modelList = await request("model/list", {});
    const threadList = await request("thread/list", { limit: 1 });
    const model = modelList.result?.data?.find((entry) => entry.isDefault)?.model;
    if (typeof model !== "string") throw new Error("model/list did not expose a default model");
    const threadStart = await request("thread/start", {
      model,
      cwd: path.dirname(spec.environment.CODEX_HOME),
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    const threadId = threadStart.result?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start did not return a thread id");
    const threadRead = await request("thread/read", { threadId, includeTurns: true });
    const threadResume = await request("thread/resume", { threadId });
    const unknownMethod = await request("codexhost/unknown-method", {});
    const responses = {
      initialize,
      modelList,
      threadList,
      threadStart,
      threadRead,
      threadResume,
      unknownMethod,
    };

    if (live) {
      const runTurn = async (text, expectedMarkers) => {
        const startIndex = notifications.length;
        const start = await request(
          "turn/start",
          {
            threadId,
            input: [{ type: "text", text }],
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          },
          120_000,
        );
        const turnId = start.result?.turn?.id;
        if (typeof turnId !== "string") throw new Error("turn/start did not return a turn id");
        await waitForNotification(
          (message) => message.method === "turn/completed" && message.params?.turn?.id === turnId,
          startIndex,
        );
        return summarizeTurn(start, notifications.slice(startIndex), expectedMarkers);
      };

      console.error(`[gate:a] ${spec.label} live stream turn`);
      responses.liveStream = await runTurn("Reply exactly GATE_A_STREAM_OK.", ["GATE_A_STREAM_OK"]);
      console.error(`[gate:a] ${spec.label} live tool/continuation turn`);
      responses.liveToolContinuation = await runTurn(
        "Use the shell tool to run echo GATE_A_TOOL_OK, then reply exactly GATE_A_TOOL_COMPLETE.",
        ["GATE_A_TOOL_OK", "GATE_A_TOOL_COMPLETE"],
      );
      responses.liveToolContinuation.passed =
        responses.liveToolContinuation.passed && responses.liveToolContinuation.hasCommandExecution;

      console.error(`[gate:a] ${spec.label} live cancellation turn`);
      const cancelStartIndex = notifications.length;
      const cancelStart = await request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: "Write the integers from 1 to 100000, one per line." }],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        },
        120_000,
      );
      const cancelTurnId = cancelStart.result?.turn?.id;
      if (typeof cancelTurnId !== "string") {
        throw new Error("cancellation turn/start did not return a turn id");
      }
      await waitForNotification(
        (message) => message.method === "turn/started" && message.params?.turn?.id === cancelTurnId,
        cancelStartIndex,
      );
      const interrupt = await request("turn/interrupt", { threadId, turnId: cancelTurnId }, 30_000);
      await waitForNotification(
        (message) =>
          message.method === "turn/completed" && message.params?.turn?.id === cancelTurnId,
        cancelStartIndex,
      );
      const cancelEvents = notifications.slice(cancelStartIndex);
      const cancelSummary = summarizeTurn(cancelStart, cancelEvents, [], "interrupted");
      responses.liveCancel = {
        ...cancelSummary,
        interruptAccepted: !interrupt.error,
        passed:
          !interrupt.error &&
          ["interrupted", "cancelled"].includes(cancelSummary.status) &&
          cancelSummary.hasTurnStarted,
      };
    }

    assertNoProtocolErrors(spec.label, protocolErrors, protocolErrorCount);
    return { responses, threadId };
  } finally {
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    lines.close();
  }
}

function copyCodexProfile(sourceHome, codexHomes) {
  const authPath = path.join(sourceHome, "auth.json");
  if (!fs.existsSync(authPath)) throw new Error(`Codex auth file is unavailable: ${authPath}`);
  const profileFiles = [authPath, path.join(sourceHome, "config.toml")].filter((file) =>
    fs.existsSync(file),
  );
  for (const codexHome of codexHomes) {
    for (const source of profileFiles) {
      const destination = path.join(codexHome, path.basename(source));
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o600);
    }
  }
}

export async function runDifferential({
  stockCodexPath,
  stockCodexPrefixArguments = [],
  shimPath,
  shimPrefixArguments = [],
  outputPath,
  temporaryParent = os.tmpdir(),
  live = false,
}) {
  fs.mkdirSync(temporaryParent, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "codexhost-gate-a-"));
  const directCodexHome = path.join(temporaryRoot, "direct-codex-home");
  const shimCodexHome = path.join(temporaryRoot, "shim-codex-home");
  fs.mkdirSync(directCodexHome, { recursive: true });
  fs.mkdirSync(shimCodexHome, { recursive: true });
  if (live) {
    copyCodexProfile(path.join(os.homedir(), ".codex"), [directCodexHome, shimCodexHome]);
  }
  const direct = commandSpec(stockCodexPath, null, directCodexHome, stockCodexPrefixArguments);
  const shim = commandSpec(stockCodexPath, shimPath, shimCodexHome, shimPrefixArguments);
  try {
    const directVersion = await version(direct);
    const shimVersion = await version(shim);
    const directProtocol = await appServerSession(direct, { live });
    const shimProtocol = await appServerSession(shim, { live });
    const directRoots = [
      [directCodexHome, "<CODEX_HOME>"],
      [temporaryRoot, "<TEMP>"],
      [directProtocol.threadId, "<THREAD_ID>"],
    ];
    const shimRoots = [
      [shimCodexHome, "<CODEX_HOME>"],
      [temporaryRoot, "<TEMP>"],
      [shimProtocol.threadId, "<THREAD_ID>"],
    ];
    const scenarios = Object.keys(directProtocol.responses).map((name) => {
      const directValue = normalize(directProtocol.responses[name], directRoots);
      const shimValue = normalize(shimProtocol.responses[name], shimRoots);
      const successful =
        !name.startsWith("live") || (directValue.passed === true && shimValue.passed === true);
      return {
        name,
        equal: successful && JSON.stringify(directValue) === JSON.stringify(shimValue),
        direct: directValue,
        shim: shimValue,
      };
    });
    const directVersionStderr = normalize(directVersion.stderr, directRoots);
    const shimVersionStderr = normalize(shimVersion.stderr, shimRoots);
    const byteLayerEqual =
      directVersion.status === shimVersion.status &&
      directVersion.stdout === shimVersion.stdout &&
      directVersionStderr === shimVersionStderr;
    if (!byteLayerEqual) {
      console.error(
        `version byte comparison failed: ${JSON.stringify({
          direct: { ...directVersion, stderr: directVersionStderr },
          shim: { ...shimVersion, stderr: shimVersionStderr },
        })}`,
      );
    }
    const result = differentialResultSchema.parse({
      schemaVersion: 1,
      directVersion: directVersion.stdout.trim(),
      shimVersion: shimVersion.stdout.trim(),
      byteLayerEqual,
      protocolScenarios: scenarios,
      unknownDifferences: scenarios
        .filter((scenario) => !scenario.equal)
        .map((scenario) => scenario.name),
    });
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    return result;
  } finally {
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 60,
      retryDelay: 500,
    });
  }
}

const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (executedFile === fileURLToPath(import.meta.url)) {
  const [stockCodexPath, shimPath, outputPath] = process.argv.slice(2);
  if (!stockCodexPath || !shimPath) {
    throw new Error(
      "usage: node tests/differential/codex-transparent-proxy.mjs <stock-codex> <shim> [output]",
    );
  }
  const result = await runDifferential({
    stockCodexPath: path.resolve(stockCodexPath),
    shimPath: path.resolve(shimPath),
    outputPath: outputPath ? path.resolve(outputPath) : undefined,
    live: process.env.CODEXHOST_GATE_A_LIVE === "1",
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.byteLayerEqual || result.unknownDifferences.length > 0) process.exitCode = 1;
}
