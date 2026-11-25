import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runBuildProcess } from "./build-process.mjs";

const builds = [];

afterEach(() => {
  vi.useRealTimers();
  for (const child of builds.splice(0)) {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
      }
    } else {
      child.kill();
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
});

function launch(script, signalSource = new EventEmitter(), onStdout = () => {}) {
  let output = "";
  const result = runBuildProcess(
    { command: process.execPath, arguments: ["-e", script] },
    {
      root: process.cwd(),
      environment: process.env,
      signalSource,
      onStdout,
      onStderr: (chunk) => {
        output += chunk;
      },
      spawnImplementation: (...args) => {
        const child = spawn(...args);
        builds.push(child);
        return child;
      },
    },
  );
  return { result, signalSource, output: () => output };
}

it("forwards entry SIGTERM and waits for the actual build to exit", async () => {
  const ready = Promise.withResolvers();
  const build = launch(
    "console.log('ready'); setInterval(() => {}, 1000);",
    new EventEmitter(),
    () => ready.resolve(),
  );
  await ready.promise;
  build.signalSource.emit("SIGTERM");
  expect(await build.result).toEqual({ code: null, signal: "SIGTERM" });
  expect(builds[0].exitCode !== null || builds[0].signalCode !== null).toBe(true);
  expect(build.signalSource.listenerCount("SIGTERM")).toBe(0);
  expect(build.signalSource.listenerCount("SIGINT")).toBe(0);
});

const descendantScript = `
  process.on('SIGTERM', () => {});
  console.log('descendant ready:' + process.pid);
  process.send?.('ready');
  setInterval(() => {}, 1000);
`;

async function expectDescendantStopped(output) {
  const pid = /descendant ready:(\d+)/u.exec(output)?.[1];
  expect(pid).toBeDefined();
  await expect
    .poll(
      () => {
        const state = spawnSync("ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" });
        return state.status === 1 || /^Z/u.test(state.stdout.trim());
      },
      { timeout: 2000 },
    )
    .toBe(true);
}

it.skipIf(process.platform === "win32")(
  "bounds output draining after root failure and kills a descendant that ignores SIGTERM",
  async () => {
    let rootExited = false;
    let output = "";
    const build = launch(
      `
      const { spawn } = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
      helper.once('message', () => process.exit(7));
    `,
      new EventEmitter(),
      (chunk) => {
        output += chunk;
      },
    );
    builds[0].once("exit", () => {
      rootExited = true;
    });
    const result = await build.result;
    expect(rootExited).toBe(true);
    expect(result).toEqual({ code: 7, signal: null });
    expect(build.output()).toContain("Build output remained open after process exit");
    await expectDescendantStopped(output);
    expect(builds[0].stdout.destroyed).toBe(true);
    expect(build.signalSource.listenerCount("SIGTERM")).toBe(0);
  },
);

it.skipIf(process.platform === "win32")(
  "cancels the isolated build group, including a descendant retaining output pipes",
  async () => {
    const ready = Promise.withResolvers();
    let output = "";
    const build = launch(
      `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {stdio: 'inherit'}).unref();
      setInterval(() => {}, 1000);
    `,
      new EventEmitter(),
      (chunk) => {
        output += chunk;
        if (output.includes("descendant ready")) ready.resolve();
      },
    );
    await ready.promise;
    build.signalSource.emit("SIGTERM");
    expect(await build.result).toEqual({ code: null, signal: "SIGTERM" });
    await expectDescendantStopped(output);
    expect(builds[0].stdout.destroyed).toBe(true);
    expect(build.signalSource.listenerCount("SIGTERM")).toBe(0);
  },
);

it("bounds output draining even when the root exits without a close event", async () => {
  vi.useFakeTimers();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = new EventEmitter();
  const result = runBuildProcess(
    { command: "fixture", arguments: [] },
    {
      root: "/fixture",
      environment: {},
      signalSource: signals,
      spawnImplementation: () => child,
      onStdout() {},
      onStderr() {},
    },
  );
  child.emit("exit", 7, null);
  await vi.advanceTimersByTimeAsync(1600);
  expect(await result).toEqual({ code: 7, signal: null });
  expect(child.stdout.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(signals.listenerCount("SIGINT")).toBe(0);
});
