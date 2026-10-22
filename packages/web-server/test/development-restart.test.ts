import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import {
  isDevelopmentWeb,
  restartDevelopmentPreview,
  stopDevelopmentWeb,
} from "../src/development-restart.ts";

it("matches only the selected Node entry and port, including paths with spaces", () => {
  const entry = resolve("some worktree/app/server.mjs");
  const candidate = {
    pid: 101,
    created: "start",
    command: `${process.execPath} ${entry} --host 0.0.0.0 --port 4400`,
  };
  assert.equal(isDevelopmentWeb(candidate, entry, "4400"), true);
  assert.equal(isDevelopmentWeb(candidate, entry, "4401"), false);
  assert.equal(
    isDevelopmentWeb(
      { ...candidate, command: `${candidate.command} --workspace "folder --port 4401"` },
      entry,
      "4401",
    ),
    false,
  );
  assert.equal(isDevelopmentWeb(candidate, resolve("other/app/server.mjs"), "4400"), false);
  assert.equal(
    isDevelopmentWeb({ ...candidate, command: `other ${candidate.command}` }, entry, "4400"),
    false,
  );
  assert.equal(
    isDevelopmentWeb(
      { ...candidate, command: `"${process.execPath}" "${entry}" --port 4400` },
      entry,
      "4400",
    ),
    true,
  );
});

it("does not signal a reused PID and rejects a preview that will not exit", async () => {
  const entry = resolve("app/server.mjs");
  const previous = {
    pid: 101,
    created: "old",
    command: `${process.execPath} ${entry} --port 4400`,
  };
  let reads = 0;
  let signals = 0;
  await stopDevelopmentWeb(entry, "4400", {
    list: async () => [{ ...previous, created: reads++ === 0 ? "old" : "new" }],
    signal: () => {
      signals++;
      return true;
    },
  });
  assert.equal(signals, 0);
  await assert.rejects(
    stopDevelopmentWeb(entry, "4400", {
      list: async () => [previous],
      signal: () => true,
      timeoutMs: 0,
    }),
    /did not exit/u,
  );
});

it("prepares the payload, stops Web, then restarts the selected Host with its snapshot", async () => {
  const distribution = resolve("distribution"),
    data = resolve("custom-host"),
    payload = resolve("snapshot");
  const calls: string[] = [];
  await restartDevelopmentPreview(
    distribution,
    { "ch-data": data, port: "4401", "ch-codex-home": resolve("codex-home") },
    {},
    {
      snapshot: async (source, target) => {
        assert.equal(source, distribution);
        assert.equal(target, data);
        calls.push("snapshot");
        return payload;
      },
      stopWeb: async (entry, port) => {
        assert.equal(entry, join(distribution, "app/server.mjs"));
        assert.equal(port, "4401");
        calls.push("stop-web");
      },
      run: async (command, args) => {
        assert.equal(
          command,
          join(payload, "native", process.platform === "win32" ? "codexhost.exe" : "codexhost"),
        );
        assert.deepEqual(args.slice(0, 2), ["host", "restart"]);
        assert.equal(args[args.indexOf("--data") + 1], data);
        assert.equal(
          args[args.indexOf("--host-runtime") + 1],
          join(payload, "app/host-runtime.mjs"),
        );
        assert.equal(args[args.indexOf("--plugins") + 1], join(payload, "adapters"));
        calls.push("restart-host");
        return { stdout: "", stderr: "" };
      },
    },
  );
  assert.deepEqual(calls, ["snapshot", "stop-web", "restart-host"]);
  let stopped = false;
  await assert.rejects(
    restartDevelopmentPreview(
      distribution,
      {},
      {},
      {
        snapshot: async () => {
          throw new Error("missing build");
        },
        stopWeb: async () => {
          stopped = true;
        },
      },
    ),
    /missing build/u,
  );
  assert.equal(stopped, false);
});

it(
  "stops the real matching preview while leaving a different port running",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "codexhost-dev-preview-"));
    await mkdir(join(root, "app"));
    const entry = join(root, "app/server.mjs");
    await writeFile(entry, "setInterval(() => {}, 1000); console.log('ready');");
    const children = ["4400", "4401"].map((port) =>
      spawn(process.execPath, [entry, "--port", port], { stdio: ["ignore", "pipe", "ignore"] }),
    );
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      await rm(root, { recursive: true, force: true });
    });
    await Promise.all(
      children.map((child) => {
        assert.ok(child.stdout);
        return once(child.stdout, "data");
      }),
    );
    const [first, second] = children;
    assert.ok(first && second);
    const stopped = once(first, "exit");
    await stopDevelopmentWeb(entry, "4400");
    await stopped;
    assert.equal(second.exitCode, null);
    assert.equal(second.signalCode, null);
  },
);
