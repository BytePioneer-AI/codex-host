import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { AppServerHost } from "../src/app-server-host.js";
import { boundDelegationToken, threadDelegationEnvironment } from "../src/bearer-token.js";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import {
  routeDelegationRequest,
  startDelegationControlServer,
} from "../src/delegation-control-server.js";
import { externalClientMcp } from "../src/external-client-mcp.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";
import { FilePeerStartIdempotencyStore } from "../src/peer-start-idempotency-store.js";
import {
  dispatchPeerDelegationRequest,
  waitRemotePeerThread,
  type RemotePeerDelegationClient,
} from "../src/remote-peer-delegation.js";
import {
  dispatchSharedDelegation,
  sharedDelegationRegistration,
} from "../src/shared-delegation.js";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import {
  DelegationControlError,
  type DelegationControlRegistration,
  type DelegationThreadSnapshot,
  type PersistedDelegationLookup,
} from "../src/delegation-types.js";
import { JsonLineCollector } from "./app-server-host-fixture.js";

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function localRegistration(
  threadId = "local-thread",
  overrides: Partial<DelegationControlRegistration> = {},
): DelegationControlRegistration {
  return {
    listHarnesses: vi.fn(async () => ({ harnesses: ["codex" as const] })),
    inspect: vi.fn(async () => ({
      harnessId: "codex" as const,
      inspection: {
        status: "ready" as const,
        catalog: { models: [], thinkingOptions: [] },
        capabilities: {
          configuration: {
            selectModel: false,
            selectThinkingOption: false,
            selectPermissionMode: false,
            permissionModeScope: "live" as const,
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      },
    })),
    canHandleStart: () => true,
    ownsThread: (id) => id === threadId,
    start: vi.fn(async (input) => ({
      delegationId: "del-local",
      threadId: "child-local",
      turnId: "turn-local",
      harnessId: input.harnessId,
      deepLink: "codex://threads/child-local",
      status: "running" as const,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      next: { read: "read", wait: "wait" },
    })),
    send: vi.fn(async () => ({
      threadId,
      turnId: "turn-2",
      harnessId: "codex" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    })),
    cancel: vi.fn(async () => ({
      threadId,
      turnId: "turn-1",
      harnessId: "codex" as const,
      cancelled: true,
    })),
    read: vi.fn(async () => ({
      threadId,
      harnessId: "codex" as const,
      status: "completed" as const,
      turn: null,
      progress: [],
      result: { availability: "available" as const, text: "local" },
    })),
    wait: vi.fn(async () => ({
      threadId,
      harnessId: "codex" as const,
      status: "completed" as const,
      turn: null,
      progress: [],
      result: { availability: "available" as const, text: "local" },
      timedOut: false,
    })),
    answer: vi.fn(async (input) => ({
      threadId: input.threadId,
      interactionId: input.interactionId,
      turnId: "turn-1",
      harnessId: "codex" as const,
      status: "running" as const,
      next: { read: "read", wait: "wait" },
    })),
    list: vi.fn(async () => ({ threads: [], nextCursor: null })),
    exportThread: vi.fn(async (input) => ({
      threadId: input.threadId,
      harnessId: "codex" as const,
      path: "/tmp/export.json",
      bytes: 10,
      turns: 1,
      complete: true,
    })),
    ...overrides,
  };
}

describe("Peer remote delegation routing & security boundaries", () => {
  it("routes remote-peer operations without forwarding callerThreadId and never falls back to local", async () => {
    const local = localRegistration("local-caller");
    const remotePeer: RemotePeerDelegationClient = {
      listHosts: vi.fn(async () => ({ hosts: [] })),
      call: vi.fn(async ({ operation }) => {
        if (operation === "read") {
          return {
            threadId: "b-t1",
            harnessId: "pi",
            status: "completed",
            turn: null,
            progress: [],
            result: { availability: "available", text: "from-b" },
          };
        }
        throw new Error("peer offline");
      }),
    };
    const registry = new DelegationControlRegistry({ remotePeer });
    registry.register(local);

    const snap = await registry.read({
      hostId: "remote-peer:peer-b",
      callerThreadId: "local-caller",
      threadId: "b-t1",
      view: "result",
    });
    expect(snap).toMatchObject({ hostId: "remote-peer:peer-b", threadId: "b-t1" });
    expect(local.read).not.toHaveBeenCalled();
    expect(remotePeer.call).toHaveBeenCalledWith({
      hostId: "remote-peer:peer-b",
      operation: "read",
      hopCount: 1,
      input: { threadId: "b-t1", view: "result" },
    });

    await expect(
      registry.send({
        hostId: "remote-peer:peer-b",
        callerThreadId: "local-caller",
        threadId: "b-t1",
        message: "hi",
      }),
    ).rejects.toThrow("peer offline");
    expect(local.send).not.toHaveBeenCalled();
    registry.close();
  });

  it("keeps Codex Desktop remote hosts strictly read-only and never falls back to local", async () => {
    const local = localRegistration();
    const remoteRead = vi.fn(async (input) => ({
      threadId: input.threadId,
      hostId: input.hostId,
      harnessId: "codex" as const,
      status: "completed" as const,
      turn: null,
      progress: [],
      result: { availability: "available" as const, text: "desktop-ssh" },
    }));
    const remotePeer: RemotePeerDelegationClient = {
      listHosts: vi.fn(async () => ({ hosts: [] })),
      call: vi.fn(),
    };
    const registry = new DelegationControlRegistry({ remoteRead, remotePeer });
    registry.register(local);

    await expect(
      registry.read({ hostId: "remote-ssh-discovered:mac", threadId: "t1", view: "result" }),
    ).resolves.toMatchObject({ hostId: "remote-ssh-discovered:mac", threadId: "t1" });
    expect(remoteRead).toHaveBeenCalledOnce();
    expect(remotePeer.call).not.toHaveBeenCalled();

    for (const op of [
      () =>
        registry.send({
          hostId: "remote-ssh-discovered:mac",
          threadId: "t1",
          message: "nope",
        }),
      () =>
        registry.wait({
          hostId: "remote-control:desktop",
          threadId: "t1",
          view: "result",
          timeoutMs: 1000,
        }),
      () => registry.cancel({ hostId: "remote-ssh-discovered:mac", threadId: "t1" }),
      () =>
        registry.start({
          hostId: "remote-ssh-discovered:mac",
          harnessId: "codex",
          task: "nope",
          cwd: "/tmp",
        }),
      () =>
        registry.list({
          hostId: "remote-ssh-discovered:mac",
          limit: 10,
          sort: "created-desc",
        }),
    ]) {
      await expect(op()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    expect(local.send).not.toHaveBeenCalled();
    expect(local.start).not.toHaveBeenCalled();
    expect(remotePeer.call).not.toHaveBeenCalled();
    registry.close();
  });

  it("enforces durable 1-hop limit across restarts, local children, and unforgeable caller identity (P0-1)", async () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), "peer-hop-store-"));
    try {
      const store = new MappingStore({ directory: storeDir });
      await store.initialize();
      const repo = new ExternalThreadRepository(store);

      // Persist a remotely-initiated root Thread (e.g. created on B before restart) and a local child Thread.
      const remoteRootId = hostThreadIdSchema.parse("b-remote-root");
      const localChildId = hostThreadIdSchema.parse("b-local-child");
      const nativeLocalId = hostThreadIdSchema.parse("b-native-local");
      await repo.createDelegation({
        delegationId: hostThreadIdSchema.parse("del-root"),
        parentHostThreadId: hostThreadIdSchema.parse("peer:scope-a"),
        childHostThreadId: remoteRootId,
        sourceHarnessId: harnessIdSchema.parse("codex"),
        targetHarnessId: harnessIdSchema.parse("codex"),
        status: "creating", // Simulates first-turn window before turn completes
        taskDigest: "a".repeat(64),
      });
      await repo.createDelegation({
        delegationId: hostThreadIdSchema.parse("del-child"),
        parentHostThreadId: remoteRootId,
        childHostThreadId: localChildId,
        sourceHarnessId: harnessIdSchema.parse("codex"),
        targetHarnessId: harnessIdSchema.parse("pi"),
        status: "running",
        taskDigest: "b".repeat(64),
      });

      const remoteCall = vi.fn(async () => ({
        threadId: "c-t1",
        harnessId: "codex",
        status: "completed",
        turn: null,
        progress: [],
        result: { availability: "available", text: "ok" },
      }));

      // Fresh Registry (empty in-memory #remoteOriginHops) simulates Host restart.
      const restartedRegistry = new DelegationControlRegistry({
        remotePeer: { listHosts: async () => ({ hosts: [] }), call: remoteCall },
      });
      const activeNativeThreads = new Set<string>([remoteRootId, nativeLocalId]);
      restartedRegistry.register(
        localRegistration(nativeLocalId, {
          activeNativeThreadIds: () => [...activeNativeThreads],
          delegationParent: async (threadId) => {
            const parsed = hostThreadIdSchema.safeParse(threadId);
            if (!parsed.success) return undefined;
            return (await repo.getDelegationByChild(parsed.data))?.parentHostThreadId;
          },
        }),
      );

      // Ancestor walk recovers hop=1 for both root (even while status=creating) and local child after restart.
      expect(await restartedRegistry.resolveRemoteOriginHopCount(remoteRootId)).toBe(1);
      expect(await restartedRegistry.resolveRemoteOriginHopCount(localChildId)).toBe(1);
      expect(await restartedRegistry.resolveRemoteOriginHopCount(nativeLocalId)).toBe(0);

      const baseToken = "runtime-base-token-secret";
      const controlServer = await startDelegationControlServer({
        token: baseToken,
        api: restartedRegistry,
        watchApi: restartedRegistry,
      });

      try {
        // 1. Bound external-harness token ignores spoofed body callerThreadId and blocks remote call.
        const boundEnv = threadDelegationEnvironment(
          { CODEXHOST_RUNTIME_TOKEN: baseToken },
          localChildId,
        );
        expect(boundEnv.CODEXHOST_RUNTIME_TOKEN).toBe(
          boundDelegationToken(baseToken, localChildId),
        );
        const spoofedBound = await fetch(`${controlServer.endpoint}/v1/thread/read`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${boundEnv.CODEXHOST_RUNTIME_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "remote-peer:peer-c",
            callerThreadId: nativeLocalId, // spoofed innocent ID
            threadId: "c-t1",
            view: "result",
          }),
        });
        expect(spoofedBound.status).toBe(400);
        expect(await spoofedBound.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

        // 2. Shared runtime token cannot omit callerThreadId when multiple threads are active.
        const missingCaller = await fetch(`${controlServer.endpoint}/v1/thread/read`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${baseToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "remote-peer:peer-c",
            threadId: "c-t1",
            view: "result",
          }),
        });
        expect(missingCaller.status).toBe(400);
        expect(await missingCaller.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

        // 3. Shared runtime token cannot spoof a non-active or external-harness Thread ID.
        for (const forged of ["forged-idle-thread", localChildId]) {
          const spoofed = await fetch(`${controlServer.endpoint}/v1/thread/read`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${baseToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              hostId: "remote-peer:peer-c",
              callerThreadId: forged,
              threadId: "c-t1",
              view: "result",
            }),
          });
          expect(spoofed.status).toBe(400);
          expect(await spoofed.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
        }

        // 4. Shared runtime token with verified active native local thread is allowed.
        const legitimateNative = await fetch(`${controlServer.endpoint}/v1/thread/read`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${baseToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "remote-peer:peer-c",
            callerThreadId: nativeLocalId,
            threadId: "c-t1",
            view: "result",
          }),
        });
        expect(legitimateNative.status).toBe(200);
        expect(remoteCall).toHaveBeenCalledTimes(1);

        // 5. Authenticated external client succeeds without callerThreadId and ignores forged callerThreadId.
        const extRoute = externalClientRouter({
          api: restartedRegistry,
          watchApi: restartedRegistry,
        });
        const extRes = await extRoute(
          {
            client: "ci-bot",
            scope: "read",
            request: {} as never,
            response: {} as never,
          },
          "/v1/thread/read",
          {
            hostId: "remote-peer:peer-c",
            callerThreadId: remoteRootId, // forged body field must be ignored for authenticated external client
            threadId: "c-t1",
            view: "result",
          },
        );
        expect(extRes).toMatchObject({ hostId: "remote-peer:peer-c", threadId: "c-t1" });
        expect(remoteCall).toHaveBeenCalledTimes(2);
      } finally {
        await controlServer.close();
        restartedRegistry.close();
        await store.close();
      }
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("sanitizes B-side errors so host paths, git stderr, and peer secrets never leak while keeping safe worktree info (P1-1)", async () => {
    const validSha = "deadbeef".repeat(5);
    const diagnose = vi.fn();
    const failingApi = localRegistration("t1", {
      start: vi.fn(async () => {
        throw new DelegationControlError(
          "DELEGATION_FAILED",
          "git failed at /Users/secret/repo with http://10.0.0.9:4321/#token=top-secret-tok",
          {
            secretPath: "/Users/secret/repo/.git",
            validHarnessIds: ["codex", "pi", "/Users/secret/bad", "http://10.0.0.9/#token=x"],
            worktreeRetained: true,
            worktree: {
              path: "/Users/secret/repo.worktrees/feat-x",
              branch: "feat-x",
              base: validSha,
            },
          },
        );
      }),
      send: vi.fn(async () => {
        throw new Error("ENOENT: /Users/secret/private/file.key fatal: bad git stderr");
      }),
    });

    const startRes = await dispatchPeerDelegationRequest(
      failingApi,
      {
        operation: "start",
        hopCount: 1,
        input: { harnessId: "codex", task: "x", cwd: "/tmp" },
      },
      { diagnose },
    );
    expect(startRes.ok).toBe(false);
    const startText = JSON.stringify(startRes);
    expect(startText).not.toContain("/Users/secret");
    expect(startText).not.toContain("top-secret-tok");
    expect(startText).not.toContain("10.0.0.9");
    expect(startRes).toEqual({
      ok: false,
      error: {
        code: "DELEGATION_FAILED",
        message: "Peer delegation operation failed",
        details: {
          validHarnessIds: ["codex", "pi"],
          worktreeRetained: true,
          worktree: { branch: "feat-x", base: validSha },
        },
      },
    });

    const sendRes = await dispatchPeerDelegationRequest(
      failingApi,
      {
        operation: "send",
        hopCount: 1,
        input: { threadId: "t1", message: "hello" },
      },
      { diagnose },
    );
    expect(sendRes.ok).toBe(false);
    const sendText = JSON.stringify(sendRes);
    expect(sendText).not.toContain("/Users/secret");
    expect(sendText).not.toContain("fatal:");
    expect(sendRes).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Peer delegation operation failed" },
    });
    expect(diagnose).toHaveBeenCalledTimes(2);
  });

  it("preserves hostId uniformly across direct HTTP and MCP and blocks unsupported remote operations before touching local threads (P1-2)", async () => {
    const local = localRegistration("shared-id");
    const remoteCall = vi.fn(async ({ operation }) => {
      if (operation === "read") {
        return {
          threadId: "shared-id",
          harnessId: "pi",
          status: "completed",
          turn: null,
          progress: [],
          result: { availability: "available", text: "remote-ok" },
        };
      }
      return {
        threadId: "shared-id",
        turnId: "turn-r",
        harnessId: "pi",
        status: "running",
        next: { read: "read", wait: "wait" },
      };
    });
    const registry = new DelegationControlRegistry({
      remotePeer: { listHosts: async () => ({ hosts: [] }), call: remoteCall },
    });
    registry.register(local);

    const remoteLink = "thread://shared-id?hostId=remote-peer%3Apeer-b";

    // Direct HTTP parses thread:// link and routes remotely instead of passing raw URI to local.
    const httpRead = await routeDelegationRequest(
      { api: registry, watchApi: registry },
      "/v1/thread/read",
      {
        threadId: remoteLink,
        view: "result",
      },
    );
    expect(httpRead).toMatchObject({ hostId: "remote-peer:peer-b", threadId: "shared-id" });
    expect(local.read).not.toHaveBeenCalled();

    // Conflicting hostId is rejected cleanly.
    await expect(
      routeDelegationRequest({ api: registry, watchApi: registry }, "/v1/thread/read", {
        threadId: remoteLink,
        hostId: "remote-peer:other",
        view: "result",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    // Direct HTTP rejects remote thread:// on file, export, watch with UNSUPPORTED without touching local thread.
    for (const [routePath, body] of [
      ["/v1/thread/file", { threadId: remoteLink, path: "out.txt" }],
      ["/v1/thread/export", { threadId: remoteLink }],
      ["/v1/thread/watch", { threadId: remoteLink, notifyThreadId: "caller", timeoutMs: 1000 }],
    ] as const) {
      await expect(
        routeDelegationRequest({ api: registry, watchApi: registry }, routePath, { ...body }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    }
    expect(local.read).not.toHaveBeenCalled();
    expect(local.exportThread).not.toHaveBeenCalled();

    // MCP thread_watch, thread_export, thread_file_read reject remote thread:// with UNSUPPORTED without touching local.
    const extRoute = externalClientRouter({ api: registry, watchApi: registry });
    const mcpHandler = externalClientMcp(extRoute);
    async function callMcpTool(name: string, args: Record<string, unknown>) {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const req = new PassThrough() as PassThrough & {
        method: string;
        headers: Record<string, string>;
      };
      req.method = "POST";
      req.headers = { "content-type": "application/json" };
      req.end(payload);
      let status = 0;
      let rawBody = "";
      const res = {
        setHeader: vi.fn(),
        writeHead: (code: number) => {
          status = code;
          return res;
        },
        end: (chunk?: string) => {
          if (chunk) rawBody += chunk;
        },
      };
      await mcpHandler(
        {
          client: "mcp-client",
          scope: "dispatch",
          request: req as never,
          response: res as never,
        },
        new URL("http://127.0.0.1/mcp"),
      );
      expect(status).toBe(200);
      return JSON.parse(rawBody) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
    }

    for (const [tool, args] of [
      ["thread_watch", { thread: remoteLink }],
      ["thread_export", { thread: remoteLink }],
      ["thread_file_read", { thread: remoteLink, path: "out.txt" }],
    ] as const) {
      const reply = await callMcpTool(tool, { ...args });
      expect(reply.result.isError).toBe(true);
      expect(JSON.parse(reply.result.content[0]?.text ?? "{}")).toMatchObject({
        error: { code: "UNSUPPORTED" },
      });
    }
    expect(local.read).not.toHaveBeenCalled();
    expect(local.exportThread).not.toHaveBeenCalled();
    registry.close();
  });

  it("enforces monotonic total wait deadline with per-read AbortSignal and distinguishes timeout vs error (P1-3)", async () => {
    const baseSnapshot = (
      status: DelegationThreadSnapshot["status"],
    ): DelegationThreadSnapshot => ({
      threadId: "t1",
      harnessId: "pi",
      status,
      turn: null,
      progress: [],
      result: { availability: status === "completed" ? "available" : "pending" },
    });

    // 1. Slow second read is aborted by remaining deadline and returns last valid snapshot with timedOut: true.
    let callCount = 0;
    const startedAt = Date.now();
    const timedOutWithSnapshot = await waitRemotePeerThread(
      async (_read, { signal }) => {
        callCount += 1;
        if (callCount === 1) return baseSnapshot("running");
        return await new Promise<DelegationThreadSnapshot>((_resolve, reject) => {
          const onAbort = () => reject(new Error("aborted"));
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
      { threadId: "t1", view: "result", timeoutMs: 50 },
      { pollIntervalsMs: [10] },
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(timedOutWithSnapshot.timedOut).toBe(true);
    expect(timedOutWithSnapshot.status).toBe("running");

    // 2. Slow first read aborted before any snapshot rejects with RUNTIME_UNREACHABLE (timedOut: true).
    const firstStart = Date.now();
    await expect(
      waitRemotePeerThread(
        async (_read, { signal }) =>
          await new Promise<DelegationThreadSnapshot>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        { threadId: "t1", view: "result", timeoutMs: 40 },
        { pollIntervalsMs: [10] },
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE", details: { timedOut: true } });
    expect(Date.now() - firstStart).toBeLessThan(500);

    // 3. Non-timeout read failure propagates immediately without masquerading as timedOut.
    await expect(
      waitRemotePeerThread(
        async () => {
          throw new DelegationControlError("THREAD_NOT_FOUND", "missing");
        },
        { threadId: "t1", view: "result", timeoutMs: 500 },
        { pollIntervalsMs: [10] },
      ),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  it("keeps --worktree + requestId replay idempotent and isolates implicit dedup per Peer sourceId (P1-4)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "peer-idempotent-wt-"));
    try {
      const repo = path.join(root, "repo");
      initGitRepo(repo);

      const seenParents: string[] = [];
      let seq = 1;
      const persistedByReq = new Map<string, PersistedDelegationLookup>();
      const api = localRegistration("local", {
        start: vi.fn(async (input) => {
          seenParents.push(input.parentThreadId ?? "");
          const existing = input.requestId ? persistedByReq.get(input.requestId) : undefined;
          if (existing) {
            return {
              delegationId: existing.delegationId,
              threadId: existing.childHostThreadId,
              turnId: "turn-1",
              harnessId: existing.targetHarnessId,
              deepLink: `codex://threads/${existing.childHostThreadId}`,
              status: existing.status,
              ...(existing.cwd !== undefined ? { cwd: existing.cwd } : {}),
              parentThreadId: existing.parentHostThreadId,
              next: { read: "read", wait: "wait" },
            };
          }
          const threadId = `b-t-${seq++}`;
          const res = {
            delegationId: `del-${threadId}`,
            threadId,
            turnId: "turn-1",
            harnessId: input.harnessId,
            deepLink: `codex://threads/${threadId}`,
            status: "running" as const,
            cwd: input.cwd,
            parentThreadId: input.parentThreadId,
            next: { read: "read", wait: "wait" },
          };
          if (input.requestId) {
            persistedByReq.set(input.requestId, {
              delegationId: res.delegationId,
              parentHostThreadId: input.parentThreadId ?? "peer:remote",
              childHostThreadId: threadId,
              targetHarnessId: input.harnessId,
              status: "running",
              taskDigest: "digest",
              ...(input.cwd ? { cwd: input.cwd } : {}),
            });
          }
          return res;
        }),
        findDelegationByRequest: async (requestId) => persistedByReq.get(requestId) ?? null,
      });
      const registry = new DelegationControlRegistry();
      registry.register(api);

      // 1. First start creates worktree.
      const first = await registry.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "build feature",
          cwd: repo,
          worktree: "feat-idem",
          requestId: "req-wt-1",
        },
      });
      const firstValue = first.result as {
        ok: true;
        value: { threadId: string; worktree: { path: string; branch: string } };
      };
      expect(firstValue.ok).toBe(true);
      expect(existsSync(firstValue.value.worktree.path)).toBe(true);

      // 2. Identical replay returns exact same threadId and worktree without git collision.
      const replay = await registry.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "build feature",
          cwd: repo,
          worktree: "feat-idem",
          requestId: "req-wt-1",
        },
      });
      expect(replay.result).toEqual(first.result);
      expect(api.start).toHaveBeenCalledTimes(1);

      // 3. Mismatched worktree branch with same requestId fails BEFORE creating branch or directory!
      const conflict = await registry.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "build feature",
          cwd: repo,
          worktree: "feat-conflict-should-not-exist",
          requestId: "req-wt-1",
        },
      });
      expect(conflict.result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
      const branches = execFileSync("git", ["branch", "--list", "feat-conflict-should-not-exist"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      expect(branches).toBe("");

      // 4. Different Peer sourceIds receive distinct peer:<scope> origins (no cross-Peer implicit dedup collision).
      await registry.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: { harnessId: "codex", task: "same task", cwd: repo },
      });
      await registry.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-b",
        input: { harnessId: "codex", task: "same task", cwd: repo },
      });
      expect(seenParents).toContain("peer:peer-a");
      expect(seenParents).toContain("peer:peer-b");
      registry.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("supports thread answer --format text via CLI (P2-1)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "peer-answer-text-"));
    try {
      const answersPath = path.join(dir, "answer.json");
      writeFileSync(answersPath, JSON.stringify({ answer: "yes" }), "utf8");
      const registry = new DelegationControlRegistry({
        remotePeer: {
          listHosts: async () => ({ hosts: [] }),
          call: async () => ({
            threadId: "b-t1",
            interactionId: "q-42",
            turnId: "turn-9",
            harnessId: "pi",
            status: "running",
            next: { read: "read", wait: "wait" },
          }),
        },
      });
      const token = "cli-answer-token";
      const server = await startDelegationControlServer({
        token,
        api: registry,
        watchApi: registry,
      });
      try {
        const out = new PassThrough();
        const err = new PassThrough();
        let stdout = "";
        let stderr = "";
        out.on("data", (chunk) => {
          stdout += String(chunk);
        });
        err.on("data", (chunk) => {
          stderr += String(chunk);
        });
        const code = await runDelegationCli({
          arguments: [
            "thread",
            "answer",
            "thread://b-t1?hostId=remote-peer%3Ab",
            "--interaction",
            "q-42",
            "--answers-file",
            answersPath,
            "--format",
            "text",
          ],
          environment: {
            ...process.env,
            CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
            CODEXHOST_RUNTIME_TOKEN: token,
            CODEXHOST_THREAD_ID: "local-caller",
          },
          output: out,
          diagnosticOutput: err,
        });
        expect(code, stderr).toBe(0);
        expect(stdout).toContain("b-t1");
        expect(stdout).toContain("q-42");
        expect(stdout).toContain("remote-peer%3Ab");
      } finally {
        await server.close();
        registry.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires official, external catalog, and shared Thread delegationParent + findDelegationByRequest (P2-3)", async () => {
    const sharedOwnerApi = localRegistration("shared-ext-1", {
      delegationParent: async (threadId) =>
        threadId === "shared-ext-1" ? "peer:scope-shared" : undefined,
      findDelegationByRequest: async (requestId) =>
        requestId === "req-shared"
          ? {
              delegationId: "del-shared",
              parentHostThreadId: "peer:scope-shared",
              childHostThreadId: "shared-ext-1",
              targetHarnessId: "pi",
              status: "running",
              taskDigest: "digest-shared",
            }
          : null,
    });
    const fakeBridge = {
      options: { delegateCreates: true },
      ownership: async (ids: string[]) =>
        new Map(ids.filter((id) => id === "shared-ext-1").map((id) => [id, "pi" as const])),
      request: async (_method: string, params: Record<string, unknown>) => ({
        result: await dispatchSharedDelegation(sharedOwnerApi, params as never),
      }),
    } as unknown as SharedThreadBridge;

    const officialReg = localRegistration("official-1", {
      delegationParent: async (threadId) =>
        threadId === "official-1" ? "peer:scope-official" : undefined,
    });
    const wrappedShared = sharedDelegationRegistration(officialReg, fakeBridge);

    const catalogReg = localRegistration("external-1", {
      delegationParent: async (threadId) =>
        threadId === "external-1" ? "peer:scope-external" : undefined,
    });

    const registry = new DelegationControlRegistry({
      remotePeer: { listHosts: async () => ({ hosts: [] }), call: vi.fn() },
    });
    registry.register(catalogReg, { harnessCatalog: true });
    registry.register(wrappedShared);

    // All three thread categories (official Codex, external Harness catalog, shared external Thread) resolve hop=1.
    expect(await registry.resolveRemoteOriginHopCount("official-1")).toBe(1);
    expect(await registry.resolveRemoteOriginHopCount("external-1")).toBe(1);
    expect(await registry.resolveRemoteOriginHopCount("shared-ext-1")).toBe(1);

    // Persisted shared request lookup works across SharedThreadBridge.
    expect(await wrappedShared.findDelegationByRequest?.("req-shared")).toMatchObject({
      childHostThreadId: "shared-ext-1",
      parentHostThreadId: "peer:scope-shared",
    });
    registry.close();
  });

  it("allows read-scoped external clients to list hosts and blocks cross-host watch and peer origin forgery", async () => {
    const registry = new DelegationControlRegistry({
      remotePeer: {
        listHosts: async () => ({
          hosts: [
            {
              hostId: "remote-peer:b",
              displayName: "B",
              online: true,
              state: "connected",
              delegation: true,
              projects: [],
            },
          ],
        }),
        call: vi.fn(),
      },
    });
    const route = externalClientRouter({ api: registry, watchApi: registry });
    const readCall = {
      client: "observer",
      scope: "read" as const,
      request: {} as never,
      response: {} as never,
    };
    await expect(route(readCall, "/v1/host/list", {})).resolves.toMatchObject({
      hosts: [{ hostId: "remote-peer:b" }],
    });

    const dispatchCall = { ...readCall, scope: "dispatch" as const };
    await expect(
      route(dispatchCall, "/v1/delegate/start", {
        harnessId: "codex",
        task: "x",
        cwd: "/tmp",
        parentThreadId: "peer:remote",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await expect(
      routeDelegationRequest({ api: registry, watchApi: registry }, "/v1/thread/watch", {
        hostId: "remote-peer:b",
        threadId: "t1",
        notifyThreadId: "caller",
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    registry.close();
  });

  it("prevents explicit plain-parent laundering on local child start and fails closed on ancestry errors or >64 depth", async () => {
    const parents = new Map<string, string>([["remote-origin-1", "peer:scope-a"]]);
    let inFlightParentCheck: number | undefined;
    const registry = new DelegationControlRegistry({
      remotePeer: { listHosts: async () => ({ hosts: [] }), call: vi.fn() },
    });
    const startedInputs: Array<{ parentThreadId?: string }> = [];
    registry.register(
      localRegistration("plain-local", {
        delegationParent: async (threadId) => {
          if (threadId === "broken-lineage") throw new Error("disk read failure");
          if (threadId.startsWith("deep-")) {
            const idx = Number(threadId.slice("deep-".length));
            return idx > 0 ? `deep-${idx - 1}` : undefined;
          }
          return parents.get(threadId);
        },
        start: vi.fn(async (input) => {
          startedInputs.push({
            ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
          });
          // Persist parent before Turn 1 executes and verify hop count is ALREADY 1 in-flight!
          if (input.parentThreadId) parents.set("child-launder-attempt", input.parentThreadId);
          inFlightParentCheck = await registry.resolveRemoteOriginHopCount("child-launder-attempt");
          return {
            delegationId: "del-child",
            threadId: "child-launder-attempt",
            turnId: "turn-1",
            harnessId: input.harnessId,
            deepLink: "codex://threads/child-launder-attempt",
            status: "running" as const,
            parentThreadId: input.parentThreadId,
            next: { read: "read", wait: "wait" },
          };
        }),
      }),
    );

    const token = "anti-launder-token";
    const server = await startDelegationControlServer({ token, api: registry, watchApi: registry });
    try {
      // Bound external-harness token for `remote-origin-1` attempts to pass plain `parentThreadId: "plain-local"`.
      const bound = boundDelegationToken(token, "remote-origin-1");
      const res = await fetch(`${server.endpoint}/v1/delegate/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${bound}`, "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "codex",
          task: "local child",
          cwd: "/tmp",
          parentThreadId: "plain-local",
        }),
      });
      expect(res.status).toBe(200);
      // Parent was forced to `remote-origin-1`, closing both laundering and the child's first-turn window.
      expect(startedInputs[0]?.parentThreadId).toBe("remote-origin-1");
      expect(inFlightParentCheck).toBe(1);
    } finally {
      await server.close();
    }

    // Fail-closed on ancestry lookup error.
    await expect(registry.resolveRemoteOriginHopCount("broken-lineage")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      registry.read({
        hostId: "remote-peer:b",
        callerThreadId: "broken-lineage",
        threadId: "t1",
        view: "result",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Fail-closed when lineage exceeds MAX_LINEAGE_DEPTH (64) on cross-host outbound calls.
    await expect(registry.resolveRemoteOriginHopCount("deep-70")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Depth within limit (e.g. 5) cleanly resolves to 0.
    expect(await registry.resolveRemoteOriginHopCount("deep-5")).toBe(0);

    // Pure-local deep delegation (>64 levels) MUST still succeed locally without throwing FORBIDDEN!
    const deepChild = await registry.start({
      parentThreadId: "deep-65",
      callerThreadId: "deep-65",
      harnessId: "codex",
      task: "local depth 66",
      cwd: "/tmp",
    });
    expect(deepChild.threadId).toBe("child-launder-attempt");
    // Yet that deep thread still fails closed on cross-host outbound calls.
    await expect(
      registry.read({
        hostId: "remote-peer:b",
        callerThreadId: "deep-65",
        threadId: "t1",
        view: "result",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    registry.close();
  });

  it("preserves remote lineage via CLI local delegate start with --parent-thread when 2 native Codex threads are active (P0)", async () => {
    const parents = new Map<string, string>([["remote-native-1", "peer:scope-a"]]);
    const startedInputs: Array<{ parentThreadId?: string }> = [];
    const registry = new DelegationControlRegistry({
      remotePeer: { listHosts: async () => ({ hosts: [] }), call: vi.fn() },
    });
    registry.register(
      localRegistration("plain-native-2", {
        activeNativeThreadIds: () => ["remote-native-1", "plain-native-2"],
        delegationParent: async (threadId) => parents.get(threadId),
        start: vi.fn(async (input) => {
          startedInputs.push({
            ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
          });
          if (input.parentThreadId) parents.set("child-via-cli", input.parentThreadId);
          return {
            delegationId: "del-cli",
            threadId: "child-via-cli",
            turnId: "turn-1",
            harnessId: input.harnessId,
            deepLink: "codex://threads/child-via-cli",
            status: "running" as const,
            parentThreadId: input.parentThreadId,
            next: { read: "read", wait: "wait" },
          };
        }),
      }),
    );

    const token = "native-cli-two-active-token";
    const server = await startDelegationControlServer({ token, api: registry, watchApi: registry });
    try {
      const out = new PassThrough();
      const err = new PassThrough();
      let stderr = "";
      err.on("data", (chunk) => {
        stderr += String(chunk);
      });
      // Normal CLI invocation from remote-native-1 trying to pass --parent-thread plain-native-2.
      const code = await runDelegationCli({
        arguments: [
          "delegate",
          "start",
          "--harness",
          "codex",
          "--task",
          "sub-task",
          "--parent-thread",
          "plain-native-2",
        ],
        environment: {
          CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
          CODEXHOST_RUNTIME_TOKEN: token,
          CODEX_THREAD_ID: "remote-native-1",
        },
        output: out,
        diagnosticOutput: err,
      });
      expect(code, stderr).toBe(0);
      expect(startedInputs[0]?.parentThreadId).toBe("remote-native-1");
      expect(await registry.resolveRemoteOriginHopCount("child-via-cli")).toBe(1);
    } finally {
      await server.close();
      registry.close();
    }
  });

  it("handles write-ahead persistence failure before side effects and recovers from crash before completed write (P1)", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "peer-wal-recovery-")));
    try {
      const repo = path.join(root, "repo");
      initGitRepo(repo);
      const storeDir = path.join(root, "wal-store");
      const backingStore = new FilePeerStartIdempotencyStore(storeDir);

      // Case A: Write failure BEFORE creating worktree aborts with no branch/worktree and no api.start.
      const failingInitialStore = {
        get: (id: string) => backingStore.get(id),
        set: async () => {
          throw new Error("ENOSPC: disk full");
        },
        delete: (id: string) => backingStore.delete(id),
      };
      const apiA = localRegistration("local");
      const regA = new DelegationControlRegistry({ peerStartStore: failingInitialStore });
      regA.register(apiA);
      const failBefore = await regA.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "should abort",
          cwd: repo,
          worktree: "feat-never-created",
          requestId: "req-fail-before",
        },
      });
      expect(failBefore.result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
      expect(apiA.start).not.toHaveBeenCalled();
      expect(
        execFileSync("git", ["branch", "--list", "feat-never-created"], {
          cwd: repo,
          encoding: "utf8",
        }).trim(),
      ).toBe("");
      regA.close();

      // Case B: Crash / write failure AFTER api.start succeeds but BEFORE final `completed` write;
      // error is NOT swallowed, and cold retry recovers the original thread + worktree without touching git!
      const persistedByReq = new Map<string, PersistedDelegationLookup>();
      let startCalls = 0;
      const makeApi = () =>
        localRegistration("local", {
          start: vi.fn(async (input) => {
            startCalls += 1;
            const existing = input.requestId ? persistedByReq.get(input.requestId) : undefined;
            if (existing) {
              return {
                delegationId: existing.delegationId,
                threadId: existing.childHostThreadId,
                turnId: "turn-1",
                harnessId: existing.targetHarnessId,
                deepLink: `codex://threads/${existing.childHostThreadId}`,
                status: existing.status,
                ...(existing.cwd !== undefined ? { cwd: existing.cwd } : {}),
                parentThreadId: existing.parentHostThreadId,
                next: { read: "read", wait: "wait" },
              };
            }
            const res = {
              delegationId: "del-crash-1",
              threadId: "b-crash-thread-1",
              turnId: "turn-1",
              harnessId: input.harnessId,
              deepLink: "codex://threads/b-crash-thread-1",
              status: "running" as const,
              cwd: input.cwd,
              parentThreadId: input.parentThreadId,
              next: { read: "read", wait: "wait" },
            };
            if (input.requestId) {
              persistedByReq.set(input.requestId, {
                delegationId: res.delegationId,
                parentHostThreadId: input.parentThreadId ?? "peer:remote",
                childHostThreadId: res.threadId,
                targetHarnessId: input.harnessId,
                status: "running",
                taskDigest: "c".repeat(64),
                ...(input.cwd ? { cwd: input.cwd } : {}),
              });
            }
            return res;
          }),
          findDelegationByRequest: async (requestId) => persistedByReq.get(requestId) ?? null,
        });

      const failOnCompleteStore = {
        get: (id: string) => backingStore.get(id),
        set: async (record: Parameters<FilePeerStartIdempotencyStore["set"]>[0]) => {
          if (record.state === "completed") {
            throw new Error("simulated crash before final write");
          }
          return backingStore.set(record);
        },
        delete: (id: string) => backingStore.delete(id),
      };
      const regCrash = new DelegationControlRegistry({ peerStartStore: failOnCompleteStore });
      regCrash.register(makeApi());
      const crashed = await regCrash.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "crash mid-commit",
          cwd: repo,
          worktree: "feat-crash-recover",
          requestId: "req-crash-recover",
        },
      });
      // Write failure MUST NOT be silently swallowed.
      expect(crashed.result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
      expect(startCalls).toBe(1);
      regCrash.close();

      // Cold restart (brand new Registry, empty cache, healthy store) recovers from pending + delegation map!
      const regRecovered = new DelegationControlRegistry({ peerStartStore: backingStore });
      regRecovered.register(makeApi());
      const recovered = await regRecovered.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "crash mid-commit",
          cwd: repo,
          worktree: "feat-crash-recover",
          requestId: "req-crash-recover",
        },
      });
      const recVal = recovered.result as {
        ok: true;
        value: { threadId: string; worktree: { path: string; branch: string; base: string } };
      };
      expect(recVal.ok).toBe(true);
      expect(recVal.value.threadId).toBe("b-crash-thread-1");
      expect(recVal.value.worktree.branch).toBe("feat-crash-recover");
      expect(existsSync(recVal.value.worktree.path)).toBe(true);
      // Persisted state is now `completed`.
      expect((await backingStore.get("req-crash-recover"))?.state).toBe("completed");
      regRecovered.close();

      // Case C (P1-1): Mapping persisted as `creating` BEFORE first Turn accepted -> cold replay MUST NOT mark completed!
      const creatingByReq = new Map<string, PersistedDelegationLookup>();
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      const creatingWt = {
        path: path.join(root, "repo.worktrees", "feat-unsubmitted"),
        branch: "feat-unsubmitted",
        base: baseSha,
      };
      const creatingApi = localRegistration("local", {
        start: vi.fn(async (input) => ({
          delegationId: "del-creating-1",
          threadId: "b-creating-thread-1",
          turnId: "pending",
          harnessId: input.harnessId,
          deepLink: "codex://threads/b-creating-thread-1",
          status: "creating" as const,
          cwd: input.cwd,
          parentThreadId: input.parentThreadId,
          next: { read: "read", wait: "wait" },
        })),
        findDelegationByRequest: async (id) => creatingByReq.get(id) ?? null,
      });
      creatingByReq.set("req-unsubmitted", {
        delegationId: "del-creating-1",
        parentHostThreadId: "peer:peer-a",
        childHostThreadId: "b-creating-thread-1",
        targetHarnessId: "codex",
        status: "creating",
        taskDigest: "d".repeat(64),
        cwd: creatingWt.path,
      });
      const regCreating = new DelegationControlRegistry({ peerStartStore: backingStore });
      regCreating.register(creatingApi);
      // Pre-seed pending WAL matching the request (simulates crash after `createDelegation(creating)` before `turn/start`).
      const creatingReq = {
        operation: "start" as const,
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "unsubmitted first turn",
          cwd: repo,
          worktree: "feat-unsubmitted",
          requestId: "req-unsubmitted",
        },
      };
      // Trigger a normal plan-persist by running against an API that rejects right after `creating` mapping exists:
      const failCreatingApi = localRegistration("local", {
        start: vi.fn(async () => {
          throw new DelegationControlError("DELEGATION_FAILED", "interrupted before turn/start");
        }),
        findDelegationByRequest: async () => null,
      });
      const regSeed = new DelegationControlRegistry({ peerStartStore: backingStore });
      regSeed.register(failCreatingApi);
      const seededFail = await regSeed.handlePeerDelegationChannelRequest(creatingReq);
      expect(seededFail.result).toMatchObject({ ok: false, error: { code: "DELEGATION_FAILED" } });
      expect((await backingStore.get("req-unsubmitted"))?.state).toBe("pending");
      expect((await backingStore.get("req-unsubmitted"))?.worktree?.branch).toBe(
        "feat-unsubmitted",
      );
      regSeed.close();

      // Now cold replay sees `pending` WAL + `creating` delegation mapping -> MUST stay `pending` and return failure!
      const unsubmittedReplay = await regCreating.handlePeerDelegationChannelRequest(creatingReq);
      expect(unsubmittedReplay.result).toMatchObject({
        ok: false,
        error: {
          code: "DELEGATION_FAILED",
          details: {
            worktreeRetained: true,
            worktree: { branch: "feat-unsubmitted", base: baseSha },
          },
        },
      });
      expect((await backingStore.get("req-unsubmitted"))?.state).toBe("pending");
      regCreating.close();

      // Case D (P1-2): Plan persisted BEFORE `git worktree add`; intact worktree adopted safely on cold replay,
      // while partial/ambiguous artifact preserves `pending` and returns `worktreeRetained: true`.
      let planSawCleanGit = false;
      const observingStore = {
        get: (id: string) => backingStore.get(id),
        set: async (record: Parameters<FilePeerStartIdempotencyStore["set"]>[0]) => {
          if (
            record.requestId === "req-plan-before-git" &&
            record.worktree &&
            record.state === "pending"
          ) {
            const branchNow = execFileSync("git", ["branch", "--list", record.worktree.branch], {
              cwd: repo,
              encoding: "utf8",
            }).trim();
            planSawCleanGit = !existsSync(record.worktree.path) && branchNow === "";
          }
          return backingStore.set(record);
        },
        delete: (id: string) => backingStore.delete(id),
        claimWorktreeOwner: (target: { path: string; branch: string }, id: string) =>
          backingStore.claimWorktreeOwner(target, id),
        getWorktreeOwner: (target: { path: string; branch: string }) =>
          backingStore.getWorktreeOwner(target),
      };
      // Crash right AFTER `git worktree add` succeeds, BEFORE `api.start` creates any thread!
      const failBeforeThreadApi = localRegistration("local", {
        start: vi.fn(async () => {
          throw new Error("crash before api.start commits");
        }),
      });
      const regPreThreadCrash = new DelegationControlRegistry({ peerStartStore: observingStore });
      regPreThreadCrash.register(failBeforeThreadApi);
      const preThreadReq = {
        operation: "start" as const,
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "adopt intact worktree",
          cwd: repo,
          worktree: "feat-adopt-wt",
          requestId: "req-plan-before-git",
        },
      };
      const preThreadFailed =
        await regPreThreadCrash.handlePeerDelegationChannelRequest(preThreadReq);
      expect(preThreadFailed.result).toMatchObject({
        ok: false,
        error: {
          details: { worktreeRetained: true, worktree: { branch: "feat-adopt-wt", base: baseSha } },
        },
      });
      // Confirmed: `{ path, branch, base }` plan was persisted BEFORE git mutated branch or directory!
      expect(planSawCleanGit).toBe(true);
      expect((await backingStore.get("req-plan-before-git"))?.state).toBe("pending");
      regPreThreadCrash.close();

      // Cold replay adopts the intact planned worktree without colliding on git branch/dir!
      const adoptApi = localRegistration("local", {
        start: vi.fn(async (input) => ({
          delegationId: "del-adopted-1",
          threadId: "b-adopted-thread-1",
          turnId: "turn-adopted-1",
          harnessId: input.harnessId,
          deepLink: "codex://threads/b-adopted-thread-1",
          status: "running" as const,
          cwd: input.cwd,
          parentThreadId: input.parentThreadId,
          next: { read: "read", wait: "wait" },
        })),
      });
      const regAdopt = new DelegationControlRegistry({ peerStartStore: backingStore });
      regAdopt.register(adoptApi);
      const adopted = await regAdopt.handlePeerDelegationChannelRequest(preThreadReq);
      const adoptedVal = adopted.result as {
        ok: true;
        value: { threadId: string; worktree: { path: string; branch: string; base: string } };
      };
      expect(adoptedVal.ok).toBe(true);
      expect(adoptedVal.value.threadId).toBe("b-adopted-thread-1");
      expect(adoptedVal.value.worktree.branch).toBe("feat-adopt-wt");
      expect(adoptedVal.value.worktree.base).toBe(baseSha);
      // Gitdir ownership marker leaves the checkout tree completely clean.
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: adoptedVal.value.worktree.path,
          encoding: "utf8",
        }).trim(),
      ).toBe("");
      expect((await backingStore.get("req-plan-before-git"))?.state).toBe("completed");
      regAdopt.close();

      // Partial/ambiguous artifact (e.g. directory missing while branch still exists): rejects with worktreeRetained, keeps pending.
      const partialReq = {
        operation: "start" as const,
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "partial artifact",
          cwd: repo,
          worktree: "feat-partial-wt",
          requestId: "req-partial-wt",
        },
      };
      const regPartialSeed = new DelegationControlRegistry({ peerStartStore: backingStore });
      regPartialSeed.register(failBeforeThreadApi);
      await regPartialSeed.handlePeerDelegationChannelRequest(partialReq);
      const partialRecord = await backingStore.get("req-partial-wt");
      expect(partialRecord?.worktree).toBeDefined();
      if (!partialRecord?.worktree) throw new Error("missing partialRecord.worktree");
      // Corrupt the worktree into a partial artifact by removing its checkout directory while branch remains.
      rmSync(partialRecord.worktree.path, { recursive: true, force: true });
      regPartialSeed.close();

      const regPartialReplay = new DelegationControlRegistry({ peerStartStore: backingStore });
      regPartialReplay.register(adoptApi);
      const partialReplay = await regPartialReplay.handlePeerDelegationChannelRequest(partialReq);
      expect(partialReplay.result).toMatchObject({
        ok: false,
        error: {
          code: "DELEGATION_FAILED",
          details: {
            worktreeRetained: true,
            worktree: { branch: "feat-partial-wt", base: baseSha },
          },
        },
      });
      expect((await backingStore.get("req-partial-wt"))?.state).toBe("pending");
      regPartialReplay.close();

      // Case E (P1-1): Two different requestIds racing on the same branch/path — loser MUST NEVER adopt winner's checkout!
      const winnerReq = {
        operation: "start" as const,
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "winner task",
          cwd: repo,
          worktree: "feat-race-exclusive",
          requestId: "req-race-winner",
        },
      };
      const loserReq = {
        operation: "start" as const,
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "loser task",
          cwd: repo,
          worktree: "feat-race-exclusive",
          requestId: "req-race-loser",
        },
      };
      const raceApi = localRegistration("local", {
        start: vi.fn(async (input) => ({
          delegationId: `del-${input.requestId}`,
          threadId: `thread-${input.requestId}`,
          turnId: `turn-${input.requestId}`,
          harnessId: input.harnessId,
          deepLink: `codex://threads/thread-${input.requestId}`,
          status: "running" as const,
          cwd: input.cwd,
          parentThreadId: input.parentThreadId,
          next: { read: "read", wait: "wait" },
        })),
      });
      const regRace = new DelegationControlRegistry({ peerStartStore: backingStore });
      regRace.register(raceApi);
      const [r1, r2] = await Promise.all([
        regRace.handlePeerDelegationChannelRequest(winnerReq),
        regRace.handlePeerDelegationChannelRequest(loserReq),
      ]);
      const okCount = [r1.result, r2.result].filter((r) => (r as { ok: boolean }).ok).length;
      expect(okCount).toBe(1);
      const loserResult = (r1.result as { ok: boolean }).ok ? r2.result : r1.result;
      const loserRequest = (r1.result as { ok: boolean }).ok ? loserReq : winnerReq;
      const winnerId = (r1.result as { ok: boolean }).ok ? "req-race-winner" : "req-race-loser";
      const loserId = (r1.result as { ok: boolean }).ok ? "req-race-loser" : "req-race-winner";
      expect(loserResult).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
      // Explicitly persist a stale `pending` plan for the loser pointing to the winner's worktree
      // so cold replay genuinely hits the `getWorktreeOwner !== requestId` rejection path!
      const winnerPlan = await backingStore.get(winnerId);
      expect(winnerPlan?.worktree).toBeDefined();
      if (!winnerPlan?.worktree) throw new Error("missing winnerPlan.worktree");
      const loserConfigHash = createHash("sha256")
        .update(
          JSON.stringify({
            parentThreadId: "peer:peer-a",
            harnessId: "codex",
            task: loserRequest.input.task,
            cwd: path.resolve(repo),
            worktree: "feat-race-exclusive",
            base: null,
            model: null,
            thinkingOptionId: null,
          }),
        )
        .digest("hex");
      await backingStore.set({
        formatVersion: 1,
        requestId: loserId,
        parentThreadId: "peer:peer-a",
        configHash: loserConfigHash,
        state: "pending",
        worktree: winnerPlan.worktree,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const regLoserCold = new DelegationControlRegistry({ peerStartStore: backingStore });
      const loserApi = localRegistration("local");
      regLoserCold.register(loserApi);
      const loserReplay = await regLoserCold.handlePeerDelegationChannelRequest(loserRequest);
      expect(loserReplay.result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
      expect(loserApi.start).not.toHaveBeenCalled();
      regRace.close();
      regLoserCold.close();

      // Case F (P2-3): `absent` planned worktree rerun after HEAD moves MUST reuse original `planned.base` SHA!
      const headBeforeMove = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      const absentReq = {
        operation: "start" as const,
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "rerun absent plan",
          cwd: repo,
          worktree: "feat-absent-locked-base",
          requestId: "req-absent-locked-base",
        },
      };
      const absentPath = path.join(
        path.dirname(repo),
        `${path.basename(repo)}.worktrees`,
        "feat-absent-locked-base",
      );
      // Seed pending plan + ownership atomically, simulating sudden crash right after persisting plan before git ran.
      const absentConfigHash = createHash("sha256")
        .update(
          JSON.stringify({
            parentThreadId: "peer:peer-a",
            harnessId: "codex",
            task: "rerun absent plan",
            cwd: path.resolve(repo),
            worktree: "feat-absent-locked-base",
            base: null,
            model: null,
            thinkingOptionId: null,
          }),
        )
        .digest("hex");
      expect(
        await backingStore.claimWorktreeOwner(
          { path: absentPath, branch: "feat-absent-locked-base" },
          "req-absent-locked-base",
        ),
      ).toBe("claimed");
      await backingStore.set({
        formatVersion: 1,
        requestId: "req-absent-locked-base",
        parentThreadId: "peer:peer-a",
        configHash: absentConfigHash,
        state: "pending",
        worktree: {
          path: absentPath,
          branch: "feat-absent-locked-base",
          base: headBeforeMove,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(existsSync(absentPath)).toBe(false);

      // Now advance repo HEAD to a brand-new commit!
      writeFileSync(path.join(repo, "moved-head.txt"), "new commit on main\n", "utf8");
      execFileSync("git", ["add", "moved-head.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "advance HEAD"], { cwd: repo });
      const headAfterMove = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      expect(headAfterMove).not.toBe(headBeforeMove);

      // Cold replay of the `absent` plan MUST re-enter `"owned"` and lock to `headBeforeMove` (NOT `headAfterMove`)!
      const claimResults: string[] = [];
      const trackingAbsentStore = {
        get: (id: string) => backingStore.get(id),
        set: (record: Parameters<FilePeerStartIdempotencyStore["set"]>[0]) =>
          backingStore.set(record),
        delete: (id: string) => backingStore.delete(id),
        claimWorktreeOwner: async (target: { path: string; branch: string }, id: string) => {
          const outcome = await backingStore.claimWorktreeOwner(target, id);
          claimResults.push(outcome);
          return outcome;
        },
        getWorktreeOwner: (target: { path: string; branch: string }) =>
          backingStore.getWorktreeOwner(target),
        releaseWorktreeOwner: (target: { path: string; branch: string }, id: string) =>
          backingStore.releaseWorktreeOwner(target, id),
      };
      const regRerunAbsent = new DelegationControlRegistry({ peerStartStore: trackingAbsentStore });
      regRerunAbsent.register(adoptApi);
      const rerunAbsent = await regRerunAbsent.handlePeerDelegationChannelRequest(absentReq);
      const rerunVal = rerunAbsent.result as {
        ok: true;
        value: { worktree: { path: string; branch: string; base: string } };
      };
      expect(rerunVal.ok).toBe(true);
      expect(claimResults).toEqual(["owned"]);
      expect(rerunVal.value.worktree.base).toBe(headBeforeMove);
      const actualWtHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: rerunVal.value.worktree.path,
        encoding: "utf8",
      }).trim();
      expect(actualWtHead).toBe(headBeforeMove);
      regRerunAbsent.close();

      // Case G (P1): `savePersistedStart` failing during `onWorktreePlanned` MUST release the newly claimed owner lock
      // so no orphan lock or `.tmp` file remains and a subsequent requestId on the same branch succeeds cleanly.
      const releaseSpy = vi.fn((target: { path: string; branch: string }, id: string) =>
        backingStore.releaseWorktreeOwner(target, id),
      );
      const failOnPlanSaveStore = {
        get: (id: string) => backingStore.get(id),
        set: async (record: Parameters<FilePeerStartIdempotencyStore["set"]>[0]) => {
          if (record.requestId === "req-plan-write-fail" && record.worktree) {
            throw new Error("ENOSPC: plan write failed");
          }
          return backingStore.set(record);
        },
        delete: (id: string) => backingStore.delete(id),
        claimWorktreeOwner: (target: { path: string; branch: string }, id: string) =>
          backingStore.claimWorktreeOwner(target, id),
        getWorktreeOwner: (target: { path: string; branch: string }) =>
          backingStore.getWorktreeOwner(target),
        releaseWorktreeOwner: releaseSpy,
      };
      const regPlanFail = new DelegationControlRegistry({ peerStartStore: failOnPlanSaveStore });
      regPlanFail.register(adoptApi);
      const planFailed = await regPlanFail.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "fail during plan write",
          cwd: repo,
          worktree: "feat-no-orphan-lock",
          requestId: "req-plan-write-fail",
        },
      });
      expect(planFailed.result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      const noOrphanPath = path.join(
        path.dirname(repo),
        `${path.basename(repo)}.worktrees`,
        "feat-no-orphan-lock",
      );
      expect(
        await backingStore.getWorktreeOwner({ path: noOrphanPath, branch: "feat-no-orphan-lock" }),
      ).toBeUndefined();
      // Atomic link publisher leaves zero `.tmp` files behind in `worktree-owners/`.
      const ownerFiles = readdirSync(path.join(storeDir, "worktree-owners"));
      expect(ownerFiles.some((name) => name.endsWith(".tmp"))).toBe(false);
      regPlanFail.close();

      // A brand-new requestId can now claim and create the exact same branch with zero obstruction.
      const regAfterRelease = new DelegationControlRegistry({ peerStartStore: backingStore });
      regAfterRelease.register(adoptApi);
      const afterRelease = await regAfterRelease.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "succeed after lock release",
          cwd: repo,
          worktree: "feat-no-orphan-lock",
          requestId: "req-after-lock-release",
        },
      });
      expect((afterRelease.result as { ok: boolean }).ok).toBe(true);
      regAfterRelease.close();

      // Case H (P1): Local CLI / no-requestId Peer request hijacks `(path, branch)` worktree without gitdir marker;
      // original `requestId` holding the owner lock MUST fail-closed and NEVER adopt or call `api.start`!
      const hijackHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      const hijackBranch = "feat-hijacked-by-cli";
      const hijackPath = path.join(
        path.dirname(repo),
        `${path.basename(repo)}.worktrees`,
        hijackBranch,
      );
      const hijackConfigHash = createHash("sha256")
        .update(
          JSON.stringify({
            parentThreadId: "peer:peer-a",
            harnessId: "codex",
            task: "request with id",
            cwd: path.resolve(repo),
            worktree: hijackBranch,
            base: null,
            model: null,
            thinkingOptionId: null,
          }),
        )
        .digest("hex");
      expect(
        await backingStore.claimWorktreeOwner(
          { path: hijackPath, branch: hijackBranch },
          "req-hijacked-owner",
        ),
      ).toBe("claimed");
      await backingStore.set({
        formatVersion: 1,
        requestId: "req-hijacked-owner",
        parentThreadId: "peer:peer-a",
        configHash: hijackConfigHash,
        state: "pending",
        worktree: { path: hijackPath, branch: hijackBranch, base: hijackHead },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Simulate a no-requestId Peer start (or local CLI) creating the exact same `(path, branch)` worktree
      // (no `<gitdir>/codexhost-peer-worktree-owner.json` marker written!).
      const regNoReqId = new DelegationControlRegistry({ peerStartStore: backingStore });
      regNoReqId.register(adoptApi);
      const noReqStarted = await regNoReqId.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "no requestId hijacker",
          cwd: repo,
          worktree: hijackBranch,
        },
      });
      expect((noReqStarted.result as { ok: boolean }).ok).toBe(true);
      expect(existsSync(hijackPath)).toBe(true);
      regNoReqId.close();

      // Now `req-hijacked-owner` replays (Case H1: missing gitdir marker): even though it holds the owner lock
      // and canonical path/branch/HEAD/worktree-list all match, missing gitdir marker forces fail-closed rejection!
      const hijackApi = localRegistration("local");
      const regHijackReplay = new DelegationControlRegistry({ peerStartStore: backingStore });
      regHijackReplay.register(hijackApi);
      const hijackReplay = await regHijackReplay.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "request with id",
          cwd: repo,
          worktree: hijackBranch,
          requestId: "req-hijacked-owner",
        },
      });
      expect(hijackReplay.result).toMatchObject({
        ok: false,
        error: {
          code: "DELEGATION_FAILED",
          details: {
            worktreeRetained: true,
            worktree: { branch: hijackBranch, base: hijackHead },
          },
        },
      });
      expect(hijackApi.start).not.toHaveBeenCalled();

      // Case H2: gitdir marker exists but belongs to ANOTHER `requestId` -> STILL fails closed!
      const hijackGitDir = path.resolve(
        hijackPath,
        execFileSync("git", ["rev-parse", "--git-dir"], {
          cwd: hijackPath,
          encoding: "utf8",
        }).trim(),
      );
      writeFileSync(
        path.join(hijackGitDir, "codexhost-peer-worktree-owner.json"),
        JSON.stringify({
          formatVersion: 1,
          requestId: "req-some-other-caller",
          path: hijackPath,
          branch: hijackBranch,
          base: hijackHead,
        }),
        "utf8",
      );
      const wrongMarkerReplay = await regHijackReplay.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "request with id",
          cwd: repo,
          worktree: hijackBranch,
          requestId: "req-hijacked-owner",
        },
      });
      expect(wrongMarkerReplay.result).toMatchObject({
        ok: false,
        error: { code: "DELEGATION_FAILED", details: { worktreeRetained: true } },
      });
      expect(hijackApi.start).not.toHaveBeenCalled();
      regHijackReplay.close();

      // Case I (P1-1): Symlinked `<repo>.worktrees` directory adopts cleanly across cold replay.
      const symRepo = path.join(root, "sym-repo");
      const symTargetDir = path.join(root, "real-sym-worktrees");
      initGitRepo(symRepo);
      mkdirSync(symTargetDir, { recursive: true });
      symlinkSync(symTargetDir, `${symRepo}.worktrees`);
      const symReq = {
        operation: "start" as const,
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "symlinked worktrees adopt",
          cwd: symRepo,
          worktree: "feat-sym-wt",
          requestId: "req-sym-wt",
        },
      };
      const regSymFail = new DelegationControlRegistry({ peerStartStore: backingStore });
      regSymFail.register(failBeforeThreadApi);
      const symFailed = await regSymFail.handlePeerDelegationChannelRequest(symReq);
      expect(symFailed.result).toMatchObject({
        ok: false,
        error: { details: { worktreeRetained: true } },
      });
      regSymFail.close();

      const regSymAdopt = new DelegationControlRegistry({ peerStartStore: backingStore });
      regSymAdopt.register(adoptApi);
      const symAdopted = await regSymAdopt.handlePeerDelegationChannelRequest(symReq);
      expect((symAdopted.result as { ok: boolean }).ok).toBe(true);
      regSymAdopt.close();

      // Case J (P1-2): Completed request releases its owner lock so deleting worktree & branch allows branch reuse.
      const reuseStoreDir = path.join(root, "reuse-store");
      const reuseStore = new FilePeerStartIdempotencyStore(reuseStoreDir);
      const regReuse1 = new DelegationControlRegistry({ peerStartStore: reuseStore });
      regReuse1.register(adoptApi);
      const firstReuse = await regReuse1.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "first fix-ci",
          cwd: repo,
          worktree: "fix-ci-reusable",
          requestId: "req-fix-ci-1",
        },
      });
      const firstReuseVal = firstReuse.result as {
        ok: true;
        value: { worktree: { path: string; branch: string } };
      };
      expect(firstReuseVal.ok).toBe(true);
      // Owner lock file was released upon `completed` commit.
      expect(readdirSync(path.join(reuseStoreDir, "worktree-owners"))).toEqual([]);
      regReuse1.close();

      // User merges and deletes worktree & branch, then a new requestId reuses `fix-ci-reusable`.
      execFileSync("git", ["worktree", "remove", "--force", firstReuseVal.value.worktree.path], {
        cwd: repo,
      });
      execFileSync("git", ["branch", "-D", "fix-ci-reusable"], { cwd: repo });
      const regReuse2 = new DelegationControlRegistry({ peerStartStore: reuseStore });
      regReuse2.register(adoptApi);
      const secondReuse = await regReuse2.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "second fix-ci",
          cwd: repo,
          worktree: "fix-ci-reusable",
          requestId: "req-fix-ci-2",
        },
      });
      expect((secondReuse.result as { ok: boolean }).ok).toBe(true);
      expect(readdirSync(path.join(reuseStoreDir, "worktree-owners"))).toEqual([]);
      regReuse2.close();

      // Case K (P2-1): External directory race causing `mkdir` `EEXIST` (`!worktreeRetained`) MUST release
      // the newly claimed owner lock AND delete the newly created `pending` record!
      const eexistStoreDir = path.join(root, "eexist-store");
      const eexistBaseStore = new FilePeerStartIdempotencyStore(eexistStoreDir);
      const eexistBranch = "feat-mkdir-eexist-race";
      const eexistStore = {
        get: (id: string) => eexistBaseStore.get(id),
        set: async (record: Parameters<FilePeerStartIdempotencyStore["set"]>[0]) => {
          await eexistBaseStore.set(record);
          // Right after plan is persisted and BEFORE `mkdir(worktree.path)`, create the directory externally!
          if (record.requestId === "req-eexist-race" && record.worktree) {
            mkdirSync(record.worktree.path, { recursive: true });
          }
        },
        delete: (id: string) => eexistBaseStore.delete(id),
        claimWorktreeOwner: (target: { path: string; branch: string }, id: string) =>
          eexistBaseStore.claimWorktreeOwner(target, id),
        getWorktreeOwner: (target: { path: string; branch: string }) =>
          eexistBaseStore.getWorktreeOwner(target),
        releaseWorktreeOwner: (target: { path: string; branch: string }, id: string) =>
          eexistBaseStore.releaseWorktreeOwner(target, id),
      };
      const regEexist = new DelegationControlRegistry({ peerStartStore: eexistStore });
      regEexist.register(adoptApi);
      const eexistRes = await regEexist.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "mkdir eexist race",
          cwd: repo,
          worktree: eexistBranch,
          requestId: "req-eexist-race",
        },
      });
      expect(eexistRes.result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
      expect(readdirSync(path.join(eexistStoreDir, "worktree-owners"))).toEqual([]);
      expect(await eexistBaseStore.get("req-eexist-race")).toBeUndefined();
      regEexist.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("bounds wait with a single unified deadline across slow ancestry checks and late terminal snapshots", async () => {
    // 1. Slow delegationParent (60ms) under 15ms budget times out within budget without calling remote read.
    let parentLookups = 0;
    const remoteCall = vi.fn(async () => ({
      threadId: "t1",
      harnessId: "pi",
      status: "completed",
      turn: null,
      progress: [],
      result: { availability: "available", text: "too-late" },
    }));
    const slowRegistry = new DelegationControlRegistry({
      remotePeer: { listHosts: async () => ({ hosts: [] }), call: remoteCall },
      remoteWaitPollIntervalsMs: [5],
    });
    slowRegistry.register(
      localRegistration("caller-1", {
        delegationParent: async () => {
          parentLookups += 1;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return undefined;
        },
      }),
    );

    const t0 = Date.now();
    await expect(
      slowRegistry.wait({
        hostId: "remote-peer:b",
        callerThreadId: "caller-1",
        threadId: "t1",
        view: "result",
        timeoutMs: 15,
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE", details: { timedOut: true } });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(remoteCall).not.toHaveBeenCalled();
    expect(parentLookups).toBe(1);
    slowRegistry.close();

    // 2. Multi-poll wait checks delegationParent only ONCE across multiple remote reads.
    let fastLookups = 0;
    let pollReads = 0;
    const fastRegistry = new DelegationControlRegistry({
      remotePeer: {
        listHosts: async () => ({ hosts: [] }),
        call: async () => {
          pollReads += 1;
          return {
            threadId: "t1",
            harnessId: "pi",
            status: pollReads >= 3 ? "completed" : "running",
            turn: null,
            progress: [],
            result:
              pollReads >= 3
                ? { availability: "available", text: "done" }
                : { availability: "pending" },
          };
        },
      },
      remoteWaitPollIntervalsMs: [5],
    });
    fastRegistry.register(
      localRegistration("caller-1", {
        delegationParent: async () => {
          fastLookups += 1;
          return undefined;
        },
      }),
    );
    const done = await fastRegistry.wait({
      hostId: "remote-peer:b",
      callerThreadId: "caller-1",
      threadId: "t1",
      view: "result",
      timeoutMs: 1_000,
    });
    expect(done.timedOut).toBe(false);
    expect(pollReads).toBe(3);
    expect(fastLookups).toBe(1);
    fastRegistry.close();

    // 3. Late-arriving terminal snapshot after deadline reports timedOut: true (never timedOut: false).
    const lateTerminal = await waitRemotePeerThread(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          threadId: "t1",
          harnessId: "pi",
          status: "completed",
          turn: null,
          progress: [],
          result: { availability: "available", text: "late" },
        };
      },
      { threadId: "t1", view: "result", timeoutMs: 25 },
      { deadline: performance.now() - 1 },
    ).catch((err) => err);
    expect(lateTerminal).toMatchObject({
      code: "RUNTIME_UNREACHABLE",
      details: { timedOut: true },
    });
  });

  it("integrates real AppServerHost (native Codex first-turn, restart, worktree cold replay) and SharedThreadOwner", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "peer-prod-wiring-"));
    const repo = path.join(root, "repo");
    const storeDir = path.join(root, "mapping-store");
    const reqStoreDir = path.join(root, "peer-requests");
    initGitRepo(repo);
    const initialCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["branch", "other-base"], { cwd: repo });

    function createOfficialFixture(
      options: {
        onTurnStart?: (threadId: string) => Promise<void>;
      } = {},
    ) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const closed = Promise.withResolvers<OfficialAppServerExit>();
      const requests = new JsonLineCollector(stdin);
      let seq = 1;
      const threadStarts: unknown[] = [];
      stdin.on("data", () => {
        for (const request of requests.messages.splice(0)) {
          if (request.id === undefined) continue;
          const id = request.id;
          void (async () => {
            let response: JsonObject;
            if (request.method === "initialize") {
              response = { result: { userAgent: "fixture" } };
            } else if (request.method === "model/list") {
              response = {
                result: { data: [{ model: "native-default", isDefault: true }] },
              };
            } else if (request.method === "thread/start") {
              const threadId = `native-remote-${seq++}`;
              threadStarts.push(request.params);
              const cwd = (request.params as JsonObject).cwd;
              response = {
                result: { thread: { id: threadId, ...(cwd !== undefined ? { cwd } : {}) } },
              };
            } else if (request.method === "turn/start") {
              const threadId = String((request.params as JsonObject).threadId);
              await options.onTurnStart?.(threadId);
              response = { result: { turn: { id: `turn-${threadId}` } } };
            } else {
              response = { result: {} };
            }
            stdout.write(`${JSON.stringify({ id, ...response })}\n`);
          })();
        }
      });
      const connection = {
        stdin,
        stdout,
        stderr,
        closed: closed.promise,
        close() {
          stdout.end();
          closed.resolve({ code: 0, signal: null });
        },
      };
      const scope = new OfficialRuntimeScope({
        permanentHome: root,
        diagnosticOutput: stderr,
        createBackend: () => ({
          closed: closed.promise,
          start: async () => {},
          connect: async () => connection,
          stop: async () => connection.close(),
        }),
      });
      return { scope, threadStarts };
    }

    const baseToken = "prod-wiring-runtime-token";
    let firstTurnHopCount = -1;
    let firstTurnRemoteStatus = 0;

    try {
      // --- Boot #1: Real AppServerHost + OfficialRuntimeScope + FakeHarnessAdapter + MappingStore ---
      const store1 = new MappingStore({ directory: storeDir });
      await store1.initialize();
      const piAdapter1 = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
      const registry1 = new DelegationControlRegistry({
        remotePeer: {
          listHosts: async () => ({ hosts: [] }),
          call: vi.fn(async () => ({ harnesses: ["codex"] })),
        },
        peerStartStore: new FilePeerStartIdempotencyStore(reqStoreDir),
      });
      const controlServer1 = await startDelegationControlServer({
        token: baseToken,
        api: registry1,
        watchApi: registry1,
      });

      const official1 = createOfficialFixture({
        onTurnStart: async (threadId) => {
          // Inside native Codex `turn/start` (first-turn window BEFORE `turn/start` returns!):
          firstTurnHopCount = await registry1.resolveRemoteOriginHopCount(threadId);
          const attempt = await fetch(`${controlServer1.endpoint}/v1/harness/list`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${baseToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              hostId: "remote-peer:peer-c",
              callerThreadId: threadId,
            }),
          });
          firstTurnRemoteStatus = attempt.status;
        },
      });
      await official1.scope.start();

      const host1 = new AppServerHost({
        externalOnly: true,
        stockCodexPath: "/unused",
        arguments: [],
        desktopInput: new PassThrough(),
        desktopOutput: new PassThrough(),
        diagnosticOutput: new PassThrough(),
        environment: {
          CODEXHOST_DATA_DIR: root,
          CODEXHOST_RUNTIME_TOKEN: baseToken,
        },
        mappingStore: store1,
        closeMappingStoreOnExit: false,
        officialRuntimeScope: official1.scope,
        externalAdapters: new Map([["pi", piAdapter1]]),
        onDelegationApi: (api) => registry1.register(api, { harnessCatalog: true }),
      });
      const run1 = host1.run();

      // 1. Start a remote-origin native Codex Thread with `--worktree` + `--base` + `--request-id`.
      const nativeStart = await registry1.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "codex",
          task: "native worktree task",
          cwd: repo,
          worktree: "feat-native-cold",
          base: "main",
          requestId: "req-native-cold",
        },
      });
      const nativeRes = nativeStart.result as {
        ok: true;
        value: {
          threadId: string;
          cwd: string;
          worktree: { path: string; branch: string; base: string };
        };
      };
      expect(nativeRes.ok).toBe(true);
      expect(nativeRes.value.worktree.base).toBe(initialCommit);
      // Verify first-turn window was closed BEFORE `turn/start` returned!
      expect(firstTurnHopCount).toBe(1);
      expect(firstTurnRemoteStatus).toBe(400);

      // 2. Start a remote-origin external Harness (`pi`) Thread with `--worktree` + `--request-id`.
      const extStart = await registry1.handlePeerDelegationChannelRequest({
        operation: "start",
        hopCount: 1,
        sourceId: "peer-a",
        input: {
          harnessId: "pi",
          task: "ext worktree task",
          cwd: repo,
          worktree: "feat-ext-cold",
          base: "main",
          requestId: "req-ext-cold",
        },
      });
      const extRes = extStart.result as {
        ok: true;
        value: {
          threadId: string;
          cwd: string;
          worktree: { path: string; branch: string; base: string };
        };
      };
      expect(extRes.ok).toBe(true);
      expect(extRes.value.worktree.base).toBe(initialCommit);

      // Verify shared runtime token CANNOT impersonate the running external Harness Thread!
      const spoofExternal = await fetch(`${controlServer1.endpoint}/v1/harness/list`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${baseToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: "remote-peer:peer-c",
          callerThreadId: extRes.value.threadId,
        }),
      });
      expect(spoofExternal.status).toBe(400);
      expect(await spoofExternal.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

      // Make a new commit on BOTH worktree branches so HEAD diverges from original `base`.
      for (const wtPath of [nativeRes.value.worktree.path, extRes.value.worktree.path]) {
        writeFileSync(path.join(wtPath, "work.txt"), "done\n", "utf8");
        execFileSync("git", ["add", "work.txt"], { cwd: wtPath });
        execFileSync("git", ["commit", "-q", "-m", "agent commit"], { cwd: wtPath });
      }

      // Tear down Boot #1 completely (simulates Host restart; empties all in-memory caches).
      host1.close();
      await run1;
      await controlServer1.close();
      registry1.close();
      await official1.scope.close();
      await piAdapter1.close();
      await store1.close();

      // --- Boot #2: Fresh MappingStore + AppServerHost + DelegationControlRegistry + SharedThreadOwner ---
      const store2 = new MappingStore({ directory: storeDir });
      await store2.initialize();
      const piAdapter2 = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
      const official2 = createOfficialFixture();
      await official2.scope.start();

      const owner = new SharedThreadOwner();
      const registry2 = new DelegationControlRegistry({
        remotePeer: {
          listHosts: async () => ({ hosts: [] }),
          call: vi.fn(),
        },
        peerStartStore: new FilePeerStartIdempotencyStore(reqStoreDir),
      });
      const sharedHost = new AppServerHost({
        externalOnly: true,
        stockCodexPath: "/unused",
        arguments: [],
        desktopInput: owner.input,
        desktopOutput: owner.output,
        diagnosticOutput: new PassThrough(),
        environment: {
          CODEXHOST_DATA_DIR: root,
          CODEXHOST_RUNTIME_TOKEN: baseToken,
        },
        mappingStore: store2,
        closeMappingStoreOnExit: false,
        officialRuntimeScope: official2.scope,
        externalAdapters: new Map([["pi", piAdapter2]]),
        onDelegationApi: (api) => registry2.register(api, { harnessCatalog: true }),
      });
      const sharedRun = sharedHost.run();

      // Attach a real frontend proxy over SharedThreadBridge with its OWN separate empty MappingStore
      // so delegationParent MUST traverse SharedThreadBridge -> SharedThreadOwner (never hitting local store).
      const proxyStoreDir = path.join(root, "proxy-mapping-store");
      const proxyStore = new MappingStore({ directory: proxyStoreDir });
      await proxyStore.initialize();
      const sharedBridge = new SharedThreadBridge({
        connect: async () => owner.connect(),
        delegateCreates: true,
        diagnose: () => {},
      });
      const proxyRegistry = new DelegationControlRegistry({
        remotePeer: { listHosts: async () => ({ hosts: [] }), call: vi.fn() },
      });
      let proxyApi!: DelegationControlRegistration;
      const proxyHost = new AppServerHost({
        externalOnly: true,
        stockCodexPath: "/unused",
        arguments: [],
        desktopInput: new PassThrough(),
        desktopOutput: new PassThrough(),
        diagnosticOutput: new PassThrough(),
        environment: { CODEXHOST_DATA_DIR: root },
        mappingStore: proxyStore,
        closeMappingStoreOnExit: false,
        sharedThreads: sharedBridge,
        externalAdapters: new Map(),
        onDelegationApi: (api) => {
          proxyApi = api;
          return proxyRegistry.register(api);
        },
      });
      const proxyRun = proxyHost.run();

      try {
        // Confirm proxyStore truly has NO local delegation record for the shared external thread.
        expect(
          await proxyStore.getDelegationByChild(hostThreadIdSchema.parse(extRes.value.threadId)),
        ).toBeNull();
        // Post-restart 1-hop recovery works for native Codex, external Harness, AND genuinely via SharedThreadBridge!
        expect(await registry2.resolveRemoteOriginHopCount(nativeRes.value.threadId)).toBe(1);
        expect(await registry2.resolveRemoteOriginHopCount(extRes.value.threadId)).toBe(1);
        expect(await proxyApi.delegationParent?.(extRes.value.threadId)).toBe("peer:peer-a");
        expect(await proxyRegistry.resolveRemoteOriginHopCount(extRes.value.threadId)).toBe(1);

        // Cold replay after restart returns exact original threadId & original `base` commit for BOTH Codex and Pi!
        const nativeCold = await registry2.handlePeerDelegationChannelRequest({
          operation: "start",
          hopCount: 1,
          sourceId: "peer-a",
          input: {
            harnessId: "codex",
            task: "native worktree task",
            cwd: repo,
            worktree: "feat-native-cold",
            base: "main",
            requestId: "req-native-cold",
          },
        });
        expect(nativeCold.result).toEqual(nativeStart.result);
        expect(official2.threadStarts).toHaveLength(0);

        const extCold = await registry2.handlePeerDelegationChannelRequest({
          operation: "start",
          hopCount: 1,
          sourceId: "peer-a",
          input: {
            harnessId: "pi",
            task: "ext worktree task",
            cwd: repo,
            worktree: "feat-ext-cold",
            base: "main",
            requestId: "req-ext-cold",
          },
        });
        expect(extCold.result).toEqual(extStart.result);

        // Cold replay with changed `base` rejects with INVALID_ARGUMENT before touching git!
        const baseConflict = await registry2.handlePeerDelegationChannelRequest({
          operation: "start",
          hopCount: 1,
          sourceId: "peer-a",
          input: {
            harnessId: "pi",
            task: "ext worktree task",
            cwd: repo,
            worktree: "feat-ext-cold",
            base: "other-base",
            requestId: "req-ext-cold",
          },
        });
        expect(baseConflict.result).toMatchObject({
          ok: false,
          error: { code: "INVALID_ARGUMENT" },
        });

        // Disconnecting the shared owner causes uncached lineage lookup through proxyRegistry to fail closed!
        sharedHost.close();
        owner.close();
        await sharedRun;
        await expect(
          proxyRegistry.resolveRemoteOriginHopCount("uncached-after-disconnect"),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      } finally {
        proxyHost.close();
        sharedHost.close();
        owner.close();
        await Promise.allSettled([proxyRun, sharedRun]);
        owner.output.end();
        proxyRegistry.close();
        registry2.close();
        await official2.scope.close();
        await piAdapter2.close();
        await proxyStore.close();
        await store2.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
