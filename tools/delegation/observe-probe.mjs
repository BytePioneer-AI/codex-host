#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { startIsolatedDelegationRuntime } from "../../packages/host-runtime/dist/isolated-delegation-runtime.js";

const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 2 && args[0] === "--duration-ms"),
  "usage: observe-probe.mjs [--duration-ms N]",
);
const durationMs = Number(args[1] ?? 66000);
assert(
  Number.isSafeInteger(durationMs) && durationMs >= 3000 && durationMs <= 120000,
  "duration must be 3000..120000 ms",
);
const main = path.resolve(import.meta.dirname, "../../packages/host-runtime/dist/main.js");
const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-observe-probe-"));
const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
const processes = new Set();
const timers = [];
let runtime;

function launch(environment, targetsFile) {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      main,
      "--codexhost-delegation-cli",
      "thread",
      "observe",
      "--targets-file",
      targetsFile,
      "--timeout-ms",
      String(durationMs + 5000),
    ],
    {
      cwd: directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processes.add(child);
  let stdout = "";
  let stderr = "";
  let firstOutputMs = null;
  child.stdout.on("data", (chunk) => {
    firstOutputMs ??= Math.round(performance.now() - started);
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      processes.delete(child);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        firstOutputMs,
        elapsedMs: Math.round(performance.now() - started),
      });
    });
  });
  const guard = setTimeout(() => child.kill("SIGKILL"), durationMs + 15000);
  void done.finally(() => clearTimeout(guard));
  return { child, done };
}

try {
  runtime = await startIsolatedDelegationRuntime({
    dataDirectory: path.join(directory, "runtime"),
    cliPath: main,
    mode: "hermetic",
    externalAdapters: new Map([["grok", adapter]]),
  });
  const environment = runtime.childEnvironment();
  const call = async (route, body) => {
    const response = await fetch(`${runtime.endpoint}/v1/${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.CODEXHOST_RUNTIME_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert(response.ok, `Runtime returned ${response.status}`);
    return response.json();
  };
  const start = (task) => call("delegate/start", { harnessId: "grok", task, cwd: directory });
  const one = await start("CONTROLLED_FIXTURE_ONE");
  const two = await start("CONTROLLED_FIXTURE_TWO");
  const targetsFile = path.join(directory, "targets.json");
  await writeFile(
    targetsFile,
    JSON.stringify(
      [one, two].map((child) => ({ threadId: child.threadId, expectedTurnId: child.turnId })),
    ),
  );
  const first = launch(environment, targetsFile);
  // Give the observer's initial process/snapshot enough time, then cross one real 60s request without output.
  timers.push(
    setTimeout(
      () => adapter.sessions[0].appendText("ordinary fixture progress"),
      durationMs - 1500,
    ),
  );
  timers.push(setTimeout(() => adapter.sessions[0].succeedTurn(), durationMs));
  const observed = await first.done;
  assert.equal(observed.code, 0, observed.stderr);
  const result = JSON.parse(observed.stdout);
  assert.equal(result.reason, "attention");
  assert.deepEqual(result.events, [{ threadId: one.threadId, reason: "terminal" }]);
  assert(result.suppressedChanges >= 1, "ordinary progress was not observed and suppressed");
  assert(
    result.requests >= (durationMs > 62000 ? 4 : 3),
    "internal continuation was not exercised",
  );
  assert(
    observed.firstOutputMs >= durationMs - 500,
    "observer emitted output before the terminal event",
  );
  assert.equal(result.inputVisibilityUnavailable.length, 0);
  assert.equal((await call("thread/status", { threadId: two.threadId })).status, "running");

  await writeFile(
    targetsFile,
    JSON.stringify([{ threadId: two.threadId, expectedTurnId: two.turnId }]),
  );
  const second = launch(environment, targetsFile);
  await delay(750);
  second.child.kill("SIGTERM");
  const stopped = await second.done;
  assert.equal(stopped.code, 143, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).reason, "cancelled");
  const surviving = await call("thread/status", { threadId: two.threadId });
  assert.equal(surviving.status, "running");
  adapter.sessions[1].succeedTurn();
  const cleanup = await runtime.close();
  runtime = undefined;
  assert.deepEqual(cleanup.cleanupErrors, []);
  process.stdout.write(
    `${JSON.stringify(
      {
        evidenceLayer: "controlled Harness fixture / real Runtime HTTP / real CLI process",
        fixtureModelCalls: 0,
        requestedDurationMs: durationMs,
        observerElapsedMs: result.elapsedMs,
        processElapsedMs: observed.elapsedMs,
        firstOutputMs: observed.firstOutputMs,
        internalRequests: result.requests,
        suppressedChanges: result.suppressedChanges,
        terminalEvents: result.events.length,
        crossedReal60SecondWait: durationMs > 62000,
        cancellationExit: stopped.code,
        childAfterObserverCancellation: surviving.status,
        cleanupErrors: cleanup.cleanupErrors,
        outerToolWakeups: "must be checked by the actual caller; not inferred from this process",
        result: "PASS",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  for (const child of processes) child.kill("SIGKILL");
  if (runtime) await runtime.close();
  await rm(directory, { recursive: true, force: true });
}
