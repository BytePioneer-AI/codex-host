import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { shouldRestartHost } from "../../../tools/dev-desktop/host-restart.mjs";
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
      readHost: async () => ({ runtime: "/old/host.mjs" }),
      desktopRunning: async () => false,
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

for (const scenario of [
  { name: "unchanged Host", same: true, desktop: true, restart: false },
  { name: "changed Host without Desktop", desktop: false, restart: true },
  { name: "changed Host with Desktop, Enter", desktop: true, answer: "", restart: false },
  { name: "changed Host with Desktop, restart", desktop: true, answer: "restart", restart: true },
  { name: "no Host", absent: true, desktop: true, restart: false },
  {
    name: "no Host even with --restart-host",
    absent: true,
    mode: "restart",
    desktop: true,
    restart: false,
  },
  { name: "non-interactive with Desktop", desktop: true, interactive: false, restart: false },
  {
    name: "forced restart of unchanged Host",
    same: true,
    desktop: true,
    mode: "restart",
    restart: true,
  },
  { name: "forced keep without Desktop", desktop: false, mode: "keep", restart: false },
] as const) {
  it(`Web decision: ${scenario.name}`, async () => {
    const s: {
      same?: boolean;
      desktop: boolean;
      absent?: boolean;
      answer?: string;
      interactive?: boolean;
      mode?: string;
      restart: boolean;
    } = scenario;
    const calls: string[] = [];
    const runtime = resolve("snapshot/app/host-runtime.mjs");
    const messages: string[] = [];
    await restartDevelopmentPreview(
      resolve("distribution"),
      {
        ...(s.mode === "restart" ? { "restart-host": true } : {}),
        ...(s.mode === "keep" ? { "keep-host": true } : {}),
      },
      {},
      {
        snapshot: async () => {
          calls.push("snapshot");
          return resolve("snapshot");
        },
        readHost: async () => (s.absent ? null : { runtime: s.same ? runtime : "/old/host.mjs" }),
        desktopRunning: async () => {
          calls.push("detect");
          return s.desktop;
        },
        decide: (options) =>
          shouldRestartHost({
            ...options,
            interactive: s.interactive ?? true,
            ask: async () => {
              // The old Web must still be running while waiting for an answer.
              assert.equal(calls.includes("stop"), false);
              calls.push("ask");
              return s.answer ?? "";
            },
            warn: (message) => messages.push(message),
            log: (message) => messages.push(message),
          }),
        stopWeb: async () => {
          calls.push("stop");
        },
        run: async () => {
          calls.push("restart");
          return { stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(calls.includes("restart"), s.restart);
    assert.equal(calls.includes("ask"), s.answer !== undefined);
    assert.equal(calls.includes("detect"), !s.same && !s.absent && !s.mode);
    assert.equal(calls[0], "snapshot");
    assert.equal(calls.at(-1), s.restart ? "restart" : "stop");
    if (s.interactive === false)
      assert.ok(messages.some((message) => message.includes("--restart-host")));
    if (!s.restart && !s.same && !s.absent)
      assert.ok(messages.some((message) => message.includes("old Host")));
  });
}

it("uses the explicit runtime override to compare the live Host", async () => {
  let restarted = false;
  await restartDevelopmentPreview(
    resolve("distribution"),
    { "ch-host-runtime": resolve("override.mjs") },
    {},
    {
      snapshot: async () => resolve("snapshot"),
      readHost: async () => ({ runtime: resolve("override.mjs") }),
      desktopRunning: async () => {
        throw new Error("unchanged Host must not need detection");
      },
      stopWeb: async () => {},
      run: async () => {
        restarted = true;
        return { stdout: "", stderr: "" };
      },
    },
  );
  assert.equal(restarted, false);
});

it("rejects conflicting flags before snapshotting or stopping Web", async () => {
  await assert.rejects(
    restartDevelopmentPreview(
      "/distribution",
      { "restart-host": true, "keep-host": true },
      {},
      {
        snapshot: async () => {
          throw new Error("should not snapshot");
        },
      },
    ),
    /mutually exclusive/u,
  );
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
