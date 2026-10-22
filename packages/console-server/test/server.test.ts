import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleHarnesses } from "../src/harnesses.js";
import { HostUnavailableError, type ConsoleHostClient } from "../src/host-client.js";
import type { InspectDocument } from "../src/installation.js";
import { consolePaths } from "../src/paths.js";
import { startConsoleServer, type RunningConsoleServer } from "../src/server.js";
import { ConsoleUpdateError, type ConsoleUpdates } from "../src/updates.js";

let directory: string;
let running: RunningConsoleServer | undefined;

function inspectDocument(running: boolean): InspectDocument {
  return {
    schemaVersion: 1,
    launcherVersion: "1.0.0",
    launcherExecutable: "/opt/codexhost/bin/codexhost",
    desktop: {
      platform: "macos",
      version: "26.924.20706",
      build: "11431",
      installRoot: "/Applications/ChatGPT.app",
      processIds: [],
    },
    desktopError: null,
    runtime: { descriptorPath: "/state/desktop-runtime-v1.json", running, launcherPid: null },
  };
}

function fakeUpdates(): ConsoleUpdates {
  return {
    check: vi.fn(async () => ({
      currentVersion: "1.0.0",
      installation: "npm" as const,
      latestVersion: "1.1.0",
      updateAvailable: true,
      installationAvailable: true,
      releaseNotes: null,
      releaseNotesUrl: null,
      status: null,
      error: null,
    })),
    start: vi.fn(async (target) => {
      if (target.codexhostRunning) throw new ConsoleUpdateError("codex-running", "running");
      return {
        status: {
          version: "1.1.0",
          installation: "npm" as const,
          phase: "prepared" as const,
          updatedAt: 1,
          error: null,
        },
      };
    }),
    status: vi.fn(async () => ({ status: null })),
  };
}

function fakeHarnesses(): ConsoleHarnesses {
  const harness = {
    id: "pi",
    name: "Pi",
    version: "1.0.0",
    enabled: true,
    launchCommand: true,
    links: null,
    icon: null,
    launchPath: null as string | null,
  };
  return {
    list: vi.fn(async () => [harness]),
    setLaunchPath: vi.fn(async (_id: string, value: string | null) => ({
      ...harness,
      launchPath: value,
    })),
    setGrokComputerUse: vi.fn(async (update: { enabled?: boolean; browser?: boolean }) => ({
      ...harness,
      computerUse: {
        enabled: update.enabled ?? false,
        available: true,
        browser: update.browser ?? false,
        browserAvailable: true,
      },
    })),
  };
}

async function start(
  options: {
    codexRunning?: boolean;
    launch?: () => void;
    host?: ConsoleHostClient;
    environment?: NodeJS.ProcessEnv;
    restart?: (command: string, args: string[]) => Promise<void>;
    inspect?: () => Promise<InspectDocument>;
  } = {},
) {
  const updates = fakeUpdates();
  const onExit = vi.fn();
  running = await startConsoleServer({
    port: 0,
    version: "1.0.0",
    installation: {
      appDirectory: "/opt/codexhost/app",
      distribution: null,
      launcherExecutable: "/opt/codexhost/bin/codexhost",
    },
    paths: consolePaths({ CODEXHOST_DATA_DIR: directory }),
    updates,
    harnesses: fakeHarnesses(),
    pageScript: "window.consoleLoaded = true;\n",
    host: options.host ?? { available: vi.fn(async () => false), request: vi.fn() },
    inspect: options.inspect ?? (async () => inspectDocument(options.codexRunning ?? false)),
    launch: options.launch ?? vi.fn(),
    ...(options.restart ? { restart: options.restart } : {}),
    onExit,
    environment: { CODEXHOST_DATA_DIR: directory, ...options.environment },
  });
  const base = `http://127.0.0.1:${running.port}`;
  return { updates, onExit, base, port: running.port };
}

const CHANGE = { "x-codexhost-console": "1" };

it("shares validated voice settings, protects writes and blocks changes during a reported call", async () => {
  const { base } = await start();
  const call = async (body: unknown) =>
    fetch(`${base}/api/voice-settings`, {
      method: "POST",
      headers: { ...CHANGE, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const initial = await (await call({ operation: "get" })).json();
  expect(initial).toMatchObject({ initialized: false, activeInject: null, gatewayReady: null });
  const settings = {
    inject: true,
    chatExperience: "codex",
    chatConnection: "desktop",
    workConnection: "desktop",
  };
  expect((await call({ operation: "set", revision: initial.revision, settings })).status).toBe(200);
  const saved = await (await call({ operation: "get" })).json();
  expect(saved.settings).toEqual(settings);
  expect((await call({ operation: "set", revision: initial.revision, settings })).status).toBe(409);
  expect(
    (
      await call({
        operation: "set",
        revision: saved.revision,
        settings: { ...settings, chatExperience: "invalid" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${base}/api/voice-settings`, {
        method: "POST",
        headers: { ...CHANGE, origin: "https://other.example" },
        body: JSON.stringify({ operation: "get" }),
      })
    ).status,
  ).toBe(403);
  await call({
    operation: "get",
    runtime: {
      id: "5b4ca336-19a2-4d9f-a9bc-2603a0019c3a",
      revision: saved.revision,
      activeCall: true,
    },
  });
  expect((await call({ operation: "set", revision: saved.revision, settings })).status).toBe(409);
  expect((await call({ operation: "restart", confirm: true })).status).toBe(409);
});

function rawRequest(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: "/api/health", headers: { host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-server-"));
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  await rm(directory, { recursive: true, force: true });
});

describe("console server", () => {
  it("identifies itself and rejects foreign Host headers", async () => {
    const { base, port } = await start();
    const health = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({
      service: "codexhost-console",
      appDirectory: "/opt/codexhost/app",
    });
    expect(await rawRequest(port, `attacker.example:${port}`)).toBe(421);
  });

  it("serves the overview without a login", async () => {
    const { base } = await start();
    const overview = (await (await fetch(`${base}/api/overview`)).json()) as {
      summary: { state: string };
      inspect: InspectDocument;
      issueUrl: string;
    };
    expect(Object.keys(overview).sort()).toEqual(
      [
        "console",
        "inspect",
        "startup",
        "controller",
        "launchAvailable",
        "liveVoice",
        "restart",
        "summary",
        "issueUrl",
        "hostAvailable",
      ].sort(),
    );
    expect(overview).toHaveProperty("console", { version: "1.0.0", distribution: null });
    expect(overview.summary.state).toBe("stopped");
    expect(overview.inspect.desktop?.version).toBe("26.924.20706");
    expect(overview.issueUrl).toMatch(
      /^https:\/\/github\.com\/karlorz\/codex-host\/issues\/new\?/u,
    );
    expect(decodeURIComponent(overview.issueUrl)).toContain("26.924.20706");
  });

  it("reports a live Launcher startup, then failure without leaving a stale starting state", async () => {
    const { base } = await start();
    const file = consolePaths({ CODEXHOST_DATA_DIR: directory }).startupRecordFile;
    await mkdir(path.dirname(file), { recursive: true });
    const record = {
      id: "active-launch",
      pid: process.pid,
      launcherVersion: "1.0.0",
      startedAtMs: Date.now(),
      finishedAtMs: null,
      outcome: "starting",
      error: null,
      stages: [],
      desktop: null,
    };
    const save = (changes: object) =>
      writeFile(file, JSON.stringify({ schemaVersion: 1, records: [{ ...record, ...changes }] }));
    const summary = async () => {
      const result = (await (await fetch(`${base}/api/overview`)).json()) as {
        summary: { state: string };
      };
      return result.summary.state;
    };
    await save({});
    expect(await summary()).toBe("starting");
    await save({ pid: -1 });
    expect(await summary()).toBe("startup-failed");
    await save({ outcome: "failed", finishedAtMs: Date.now(), error: "startup timeout" });
    expect(await summary()).toBe("startup-failed");
  });

  it("does not expose the unused Host availability route", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/host`)).status).toBe(404);
  });

  it("accepts changes only from the console page", async () => {
    const launch = vi.fn();
    const { base } = await start({ launch });
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/launch`, { method: "POST", headers });

    expect((await post({ origin: base })).status).toBe(403);
    expect((await post({ origin: "http://evil.example", ...CHANGE })).status).toBe(403);
    expect(launch).not.toHaveBeenCalled();
    expect((await post({ origin: base, ...CHANGE })).status).toBe(202);
    expect(launch).toHaveBeenCalledWith("/opt/codexhost/bin/codexhost", ["launch"]);
  });

  it("persists live-voice inject and includes it on overview", async () => {
    const { base } = await start();
    const first = (await (await fetch(`${base}/api/live-voice-inject`)).json()) as {
      inject: boolean;
      envOverride: string | null;
    };
    expect(first).toEqual({ inject: true, savedInject: true, envOverride: null });
    const saved = await fetch(`${base}/api/live-voice-inject`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json", ...CHANGE },
      body: JSON.stringify({ inject: false }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ inject: false, savedInject: false, envOverride: null });
    const overview = (await (await fetch(`${base}/api/overview`)).json()) as {
      liveVoice: { inject: boolean };
    };
    expect(overview.liveVoice.inject).toBe(false);
  });

  it("rejects invalid or foreign voice-setting writes without changing the setting", async () => {
    const { base } = await start();
    const post = (origin: string, inject: unknown) =>
      fetch(`${base}/api/live-voice-inject`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...CHANGE },
        body: JSON.stringify({ inject }),
      });
    expect((await post("https://evil.example", false)).status).toBe(403);
    for (const inject of ["false", null, 0]) {
      expect((await post(base, inject)).status).toBe(400);
    }
    expect(await (await fetch(`${base}/api/live-voice-inject`)).json()).toEqual({
      inject: true,
      savedInject: true,
      envOverride: null,
    });
  });

  it("shows an env override while still persisting the requested setting", async () => {
    const { base } = await start({ environment: { CODEXHOST_CPA_LIVE_VOICE: "1" } });
    const response = await fetch(`${base}/api/live-voice-inject`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json", ...CHANGE },
      body: JSON.stringify({ inject: false }),
    });
    expect(await response.json()).toEqual({ inject: true, savedInject: false, envOverride: "1" });
    await running?.close();
    const restarted = await start();
    expect(await (await fetch(`${restarted.base}/api/live-voice-inject`)).json()).toEqual({
      inject: false,
      savedInject: false,
      envOverride: null,
    });
  });

  it("guards restart, rejects duplicates and verifies a fresh ready controller", async () => {
    let launcherPid = 101;
    const install = async (pid: number, inject: boolean) => {
      const file = consolePaths({ CODEXHOST_DATA_DIR: directory }).controllerStatusFile;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          pid,
          startedAt: Date.now(),
          voiceInjection: inject,
          voiceEnvOverride: null,
          renderer: { state: "installed", failures: 0, updatedAt: Date.now() },
        }),
      );
    };
    await install(process.pid, true);
    const gate = Promise.withResolvers<undefined>();
    const restart = vi.fn(async () => {
      await gate.promise;
      launcherPid = 102;
      await install(process.ppid, false);
    });
    const { base } = await start({
      codexRunning: true,
      restart,
      inspect: async () => ({
        ...inspectDocument(true),
        runtime: { running: true, descriptorPath: "/fixture/runtime.json", launcherPid },
      }),
    });
    const post = (confirm: boolean, origin = base) =>
      fetch(`${base}/api/restart`, {
        method: "POST",
        headers: { origin, ...CHANGE },
        body: JSON.stringify({ confirm }),
      });
    expect((await post(true, "https://evil.example")).status).toBe(403);
    expect((await post(false)).status).toBe(400);
    expect(restart).not.toHaveBeenCalled();
    expect((await post(true)).status).toBe(202);
    expect((await post(true)).status).toBe(409);
    expect(restart).toHaveBeenCalledExactlyOnceWith("/opt/codexhost/bin/codexhost", ["restart"]);
    const read = async () =>
      (await (await fetch(`${base}/api/overview`)).json()) as {
        restart: { phase: string };
        liveVoice: { activeInject: boolean; inject: boolean };
      };
    expect((await read()).restart.phase).toBe("restarting");
    gate.resolve(undefined);
    await vi.waitFor(async () => expect((await read()).restart.phase).toBe("succeeded"));
    expect((await read()).liveVoice).toMatchObject({ activeInject: false, inject: true });
  });

  it("refuses an update while codexhost is running", async () => {
    const { base } = await start({ codexRunning: true });
    const response = await fetch(`${base}/api/update/start`, {
      method: "POST",
      headers: { origin: base, ...CHANGE },
    });
    expect(response.status).toBe(409);
  });

  it("serves the page bundle under a strict CSP", async () => {
    const { base } = await start();
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain('<script src="/app.js"></script>');
    expect(await (await fetch(`${base}/app.js`)).text()).toBe("window.consoleLoaded = true;\n");
  });

  it("shuts down for a local tool but not for another website", async () => {
    const { base, onExit } = await start();
    expect(
      (
        await fetch(`${base}/api/shutdown`, {
          method: "POST",
          headers: { origin: "http://evil.example", ...CHANGE },
        })
      ).status,
    ).toBe(403);
    await fetch(`${base}/api/shutdown`, { method: "POST", headers: CHANGE });
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });

  it("exports a redacted diagnostics report as a download", async () => {
    const { base } = await start();
    const logs = consolePaths({ CODEXHOST_DATA_DIR: directory }).logsDirectory;
    await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, "host-runtime-12.log"), "Runtime diagnostic\n");
    const response = await fetch(`${base}/api/diagnostics/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="codexhost-diagnostics-/u,
    );
    const report = (await response.json()) as {
      schemaVersion: number;
      desktop: { version: string };
      logs: { name: string; tail: string }[];
    };
    expect(report.logs).toEqual([
      expect.objectContaining({ name: "host-runtime-12.log", tail: "Runtime diagnostic\n" }),
    ]);
    expect(report.schemaVersion).toBe(1);
    expect(report.desktop.version).toBe("26.924.20706");
  });

  it("lists Harnesses and saves a launch path with a JSON body", async () => {
    const { base } = await start();
    const list = (await (await fetch(`${base}/api/harnesses`)).json()) as {
      harnesses: { id: string }[];
    };
    expect(list.harnesses.map((harness) => harness.id)).toEqual(["pi"]);
    const headers = { origin: base, ...CHANGE };
    const saved = await fetch(`${base}/api/harnesses/launch-path`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id: "pi", path: "/opt/pi" }),
    });
    expect(((await saved.json()) as { harness: { launchPath: string } }).harness.launchPath).toBe(
      "/opt/pi",
    );
    const invalid = await fetch(`${base}/api/harnesses/launch-path`, {
      method: "POST",
      headers,
      body: "not json",
    });
    expect(invalid.status).toBe(400);
  });

  it("saves the Grok in-app browser switch independently and rejects an empty body", async () => {
    const { base } = await start();
    const headers = { origin: base, ...CHANGE, "content-type": "application/json" };
    const saved = await fetch(`${base}/api/harnesses/grok-computer-use`, {
      method: "POST",
      headers,
      body: JSON.stringify({ browser: true }),
    });
    expect(
      ((await saved.json()) as { harness: { computerUse: { browser: boolean; enabled: boolean } } })
        .harness.computerUse,
    ).toMatchObject({ browser: true, enabled: false });
    const empty = await fetch(`${base}/api/harnesses/grok-computer-use`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

  it("forwards only console Host methods and reports a missing Host", async () => {
    const request = vi.fn(async () => ({ result: { accounts: [] } }));
    const { base } = await start({ host: { available: vi.fn(async () => true), request } });
    const post = (value: unknown) =>
      fetch(`${base}/api/host/request`, {
        method: "POST",
        headers: { origin: base, ...CHANGE },
        body: JSON.stringify(value),
      });
    const forwarded = await post({ method: "codexhost/account/list", params: {} });
    expect(await forwarded.json()).toEqual({ result: { accounts: [] } });
    expect(request).toHaveBeenCalledWith("codexhost/account/list", {});
    expect((await post({ method: "thread/start", params: {} })).status).toBe(400);
    expect(request).toHaveBeenCalledOnce();
  });

  it("exposes remote settings only through guarded console requests", async () => {
    const request = vi.fn(async () => ({ result: null }));
    const { base } = await start({ host: { available: async () => true, request } });
    for (const method of [
      "codexhost/console/remote-connections",
      "codexhost/remote/ssh-setup",
      "codexhost/runtime/status",
    ]) {
      const body = JSON.stringify({ method, params: {} });
      const blocked = await fetch(`${base}/api/host/request`, {
        method: "POST",
        headers: { origin: "https://example.com", ...CHANGE },
        body,
      });
      expect(blocked.status).toBe(403);
      const response = await fetch(`${base}/api/host/request`, {
        method: "POST",
        headers: { origin: base, ...CHANGE },
        body,
      });
      expect(response.status).toBe(200);
      expect(request).toHaveBeenLastCalledWith(method, {});
    }
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("returns 503 when no Host channel is running", async () => {
    const { base } = await start({
      host: {
        available: vi.fn(async () => false),
        request: vi.fn(async () => {
          throw new HostUnavailableError();
        }),
      },
    });
    const response = await fetch(`${base}/api/host/request`, {
      method: "POST",
      headers: { origin: base, ...CHANGE },
      body: JSON.stringify({ method: "codexhost/account/list" }),
    });
    expect(response.status).toBe(503);
  });

  it("updates through the Host while codexhost runs", async () => {
    const request = vi.fn(async () => ({ result: { status: { phase: "prepared" } } }));
    const { base, updates } = await start({
      codexRunning: true,
      host: { available: vi.fn(async () => true), request },
    });
    const response = await fetch(`${base}/api/update/start`, {
      method: "POST",
      headers: { origin: base, ...CHANGE },
    });
    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledWith("codexhost/update/start", {});
    expect(updates.start).not.toHaveBeenCalled();
  });
});
