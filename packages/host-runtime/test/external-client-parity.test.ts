import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WATCH_TIMEOUT_MS,
  DelegationControlError,
  type DelegationControlApi,
  type DelegationWatchApi,
} from "../src/delegation-types.js";
import { externalClientMcp } from "../src/external-client-mcp.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import {
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import { ExternalClientRegistry } from "../src/external-clients.js";

const execFileAsync = promisify(execFile);
const next = { read: "read", wait: "wait" };

describe.each(["HTTP", "MCP"] as const)("external client parity: %s", (transport) => {
  let directory: string;
  let repository: string;
  let token: string;
  let server: ExternalClientServer | undefined;
  const start = vi.fn<DelegationControlApi["start"]>();
  const send = vi.fn<DelegationControlApi["send"]>();
  const watch = vi.fn<DelegationWatchApi["watch"]>();
  const watches = vi.fn<DelegationWatchApi["watches"]>();

  async function git(...args: string[]) {
    const { stdout } = await execFileAsync("git", ["-C", repository, ...args]);
    return stdout.trim();
  }

  async function initRepository() {
    await mkdir(repository);
    await git("init", "-b", "main");
    await git("config", "user.name", "Parity Test");
    await git("config", "user.email", "parity@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await git("config", "core.hooksPath", path.join(directory, "no-hooks"));
    await writeFile(path.join(repository, "tracked.txt"), "baseline\n");
    await git("add", ".");
    await git("commit", "-m", "baseline");
    return git("rev-parse", "HEAD");
  }

  async function call(
    tool: "delegate_start" | "thread_send" | "thread_watches",
    args: Record<string, unknown> = {},
  ) {
    const routes = {
      delegate_start: "/v1/delegate/start",
      thread_send: "/v1/thread/send",
      thread_watches: "/v1/thread/watches",
    };
    const { thread, ...rest } = args;
    const response = await fetch(
      new URL(transport === "MCP" ? "/mcp" : routes[tool], server?.endpoint),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(
          transport === "MCP"
            ? {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: tool, arguments: args },
              }
            : { ...rest, ...(thread !== undefined ? { threadId: thread } : {}) },
        ),
      },
    );
    const body = await response.json();
    if (transport === "HTTP") {
      expect(response.status).toBe(body.error ? 400 : 200);
      return body;
    }
    expect(response.status).toBe(200);
    expect(body.error).toBeUndefined();
    return body.result.isError
      ? JSON.parse(body.result.content[0].text)
      : body.result.structuredContent;
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "client-parity-")));
    repository = path.join(directory, "repository");
    start.mockReset().mockImplementation(async (input) => ({
      delegationId: "d1",
      threadId: "child",
      turnId: "turn-1",
      harnessId: "pi",
      deepLink: "codex://threads/child",
      status: "running",
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      next,
    }));
    send.mockReset().mockResolvedValue({
      threadId: "child",
      turnId: "turn-2",
      harnessId: "pi",
      status: "running",
      next,
    });
    watch.mockReset().mockImplementation(async (input) => ({
      ...input,
      state: "watching",
      status: "running",
    }));
    watches.mockReset().mockResolvedValue({ watches: [] });
    const clients = new ExternalClientRegistry(path.join(directory, "clients.json"));
    ({ token } = await clients.add("parity"));
    const route = externalClientRouter({
      api: {
        start,
        send,
        listHarnesses: vi.fn(),
        inspect: vi.fn(),
        answer: vi.fn(),
        cancel: vi.fn(),
        read: vi.fn(),
        wait: vi.fn(),
        list: vi.fn(),
      },
      watchApi: { watch, watches },
    });
    server = await startExternalClientServer({
      port: 0,
      clients,
      route,
      streams: { "/mcp": externalClientMcp(route) },
      descriptorPath: path.join(directory, "endpoint.json"),
    });
  });

  afterEach(async () => {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([true, false])(
    "forwards interrupt=%s without changing the send result",
    async (interrupt) => {
      expect(await call("thread_send", { thread: "child", message: "adjust", interrupt })).toEqual({
        threadId: "child",
        turnId: "turn-2",
        harnessId: "pi",
        status: "running",
        next,
      });
      expect(send).toHaveBeenCalledExactlyOnceWith({
        threadId: "child",
        message: "adjust",
        interrupt,
      });
      expect(watch).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("forwards steer=%s without changing the send result", async (steer) => {
    expect(await call("thread_send", { thread: "child", message: "adjust", steer })).toEqual({
      threadId: "child",
      turnId: "turn-2",
      harnessId: "pi",
      status: "running",
      next,
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      threadId: "child",
      message: "adjust",
      steer,
    });
    expect(watch).not.toHaveBeenCalled();
  });

  it("returns interrupt failures without registering a new watch", async () => {
    send.mockRejectedValueOnce(new DelegationControlError("THREAD_BUSY", "Stop timed out"));
    expect(
      await call("thread_send", {
        thread: "child",
        message: "adjust",
        interrupt: true,
        watch: true,
      }),
    ).toEqual({ error: { code: "THREAD_BUSY", message: "Stop timed out" } });
    expect(watch).not.toHaveBeenCalled();
  });

  it.each([undefined, 1234])(
    "sends then watches the client's event log (timeout=%s)",
    async (watchTimeoutMs) => {
      const result = await call("thread_send", {
        thread: "child",
        message: "continue",
        interrupt: true,
        watch: true,
        ...(watchTimeoutMs !== undefined ? { watchTimeoutMs } : {}),
      });
      const expectedWatch = {
        threadId: "child",
        notifyThreadId: "client:parity",
        timeoutMs: watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
      };
      expect(result.watch).toEqual({ ...expectedWatch, state: "watching", status: "running" });
      expect(send).toHaveBeenCalledExactlyOnceWith({
        threadId: "child",
        message: "continue",
        interrupt: true,
      });
      expect(watch).toHaveBeenCalledExactlyOnceWith(expectedWatch);
      expect(send.mock.invocationCallOrder[0]).toBeLessThan(watch.mock.invocationCallOrder[0] ?? 0);
    },
  );

  it("preserves successful send when watch registration fails", async () => {
    watch.mockRejectedValueOnce(new Error("Cannot persist watch"));
    expect(
      await call("thread_send", { thread: "child", message: "go", watch: true }),
    ).toMatchObject({
      threadId: "child",
      status: "running",
      watch: { state: "notRegistered", reason: "Cannot persist watch" },
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("accepts the CLI's timeout-only watch protocol", async () => {
    expect(
      await call("thread_send", {
        thread: "child",
        message: "continue",
        watchTimeoutMs: 1234,
      }),
    ).toMatchObject({
      watch: { state: "watching", notifyThreadId: "client:parity", timeoutMs: 1234 },
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({ threadId: "child", message: "continue" });
  });

  it("returns alreadyTerminal in the same watch shape as the Host", async () => {
    watch.mockResolvedValueOnce({
      threadId: "child",
      notifyThreadId: "client:parity",
      state: "alreadyTerminal",
      status: "completed",
      timeoutMs: DEFAULT_WATCH_TIMEOUT_MS,
    });
    expect(
      await call("thread_send", {
        thread: "child",
        message: "go",
        watch: true,
      }),
    ).toMatchObject({
      watch: { state: "alreadyTerminal", status: "completed", notifyThreadId: "client:parity" },
    });
  });

  it("leaves watch absent when explicitly disabled", async () => {
    expect(
      await call("thread_send", { thread: "child", message: "go", watch: false }),
    ).not.toHaveProperty("watch");
    expect(send).toHaveBeenCalledExactlyOnceWith({ threadId: "child", message: "go" });
    expect(watch).not.toHaveBeenCalled();
  });

  it.each([
    { watch: "true" },
    { watch: false, watchTimeoutMs: 100 },
    { watch: true, watchTimeoutMs: 0 },
    { watch: true, watchTimeoutMs: -1 },
    { watch: true, watchTimeoutMs: 1.5 },
    { watch: true, watchTimeoutMs: null },
  ])("rejects invalid watch options before sending: %j", async (options) => {
    expect(await call("thread_send", { thread: "child", message: "go", ...options })).toMatchObject(
      {
        error: { code: "INVALID_ARGUMENT" },
      },
    );
    expect(send).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  });

  it("returns Host watch metadata without projecting fields away", async () => {
    const entry = {
      threadId: "child",
      notifyThreadId: "client:parity",
      state: "watching" as const,
      registeredAt: "2026-01-01T00:00:00Z",
      taskName: "Review protocol",
      threadStatus: "running" as const,
      watchedForMs: 1234,
    };
    watches.mockResolvedValueOnce({ watches: [entry] });
    expect(await call("thread_watches")).toEqual({ watches: [entry] });
  });

  it("creates a Host worktree from cwd and base, returning metadata together with watch", async () => {
    const base = await initRepository();
    await writeFile(path.join(repository, "tracked.txt"), "second\n");
    await git("commit", "-am", "second");
    await writeFile(path.join(repository, "tracked.txt"), "uncommitted\n");
    const target = path.join(directory, "repository.worktrees", "feature-review");
    const result = await call("delegate_start", {
      harnessId: "pi",
      task: "review",
      cwd: repository,
      worktree: "feature/review",
      base: "HEAD~1",
      watch: true,
      watchTimeoutMs: 1234,
    });
    expect(result).toMatchObject({
      cwd: target,
      worktree: { path: target, branch: "feature/review", base },
      watch: { state: "watching", notifyThreadId: "client:parity", timeoutMs: 1234 },
    });
    expect(start).toHaveBeenCalledExactlyOnceWith({
      harnessId: "pi",
      task: "review",
      cwd: target,
      parentThreadId: "client:parity",
    });
    expect(await git("branch", "--show-current")).toBe("main");
    expect(await git("-C", target, "branch", "--show-current")).toBe("feature/review");
  });

  it("keeps successful worktree delegation when watch registration fails", async () => {
    const base = await initRepository();
    watch.mockRejectedValueOnce(new Error("Cannot persist watch"));
    expect(
      await call("delegate_start", {
        harnessId: "pi",
        task: "review",
        cwd: repository,
        worktree: "watched",
        watch: true,
      }),
    ).toMatchObject({
      threadId: "child",
      status: "running",
      worktree: {
        path: path.join(directory, "repository.worktrees", "watched"),
        branch: "watched",
        base,
      },
      watch: { state: "notRegistered", reason: "Cannot persist watch" },
    });
    expect(await git("rev-parse", "watched")).toBe(base);
  });

  it("retains worktree and original error details when delegation fails", async () => {
    const base = await initRepository();
    start.mockRejectedValueOnce(
      new DelegationControlError("DELEGATION_FAILED", "Cannot start Harness", { notStarted: true }),
    );
    const target = path.join(directory, "repository.worktrees", "failed");
    expect(
      await call("delegate_start", {
        harnessId: "pi",
        task: "review",
        cwd: repository,
        worktree: "failed",
      }),
    ).toMatchObject({
      error: {
        code: "DELEGATION_FAILED",
        message: expect.stringContaining(target),
        details: {
          notStarted: true,
          worktreeRetained: true,
          worktree: { path: target, branch: "failed", base },
        },
      },
    });
    expect(await git("rev-parse", "failed")).toBe(base);
  });

  it("reports retained artifacts when Git checkout fails, without starting delegation", async () => {
    await initRepository();
    await writeFile(path.join(repository, ".gitattributes"), "tracked.txt filter=broken\n");
    await git("add", ".gitattributes");
    await git("commit", "-m", "filter");
    await git("config", "filter.broken.smudge", "git --invalid-parity-test-filter");
    await git("config", "filter.broken.required", "true");
    const result = await call("delegate_start", {
      harnessId: "pi",
      task: "review",
      cwd: repository,
      worktree: "failed-checkout",
    });
    expect(result.error.details).toEqual({
      worktreeRetained: true,
      worktree: {
        path: path.join(directory, "repository.worktrees", "failed-checkout"),
        branch: "failed-checkout",
        base: await git("rev-parse", "HEAD"),
      },
    });
    expect(start).not.toHaveBeenCalled();
  });

  it.each([undefined, "relative/path"])("requires absolute worktree cwd: %s", async (cwd) => {
    expect(
      await call("delegate_start", {
        harnessId: "pi",
        task: "review",
        worktree: "child",
        ...(cwd !== undefined ? { cwd } : {}),
      }),
    ).toMatchObject({
      error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("absolute cwd") },
    });
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    { base: "HEAD" },
    { worktree: "" },
    { worktree: true },
    { worktree: "../escape" },
    { worktree: "HEAD" },
    { worktree: "child", base: "missing-ref" },
    { worktree: "child", base: false },
  ])("rejects invalid worktree options without starting: %j", async (options) => {
    await initRepository();
    expect(
      await call("delegate_start", {
        harnessId: "pi",
        task: "review",
        cwd: repository,
        ...options,
      }),
    ).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    expect(start).not.toHaveBeenCalled();
    expect(await git("branch", "--list", "child")).toBe("");
  });
});
