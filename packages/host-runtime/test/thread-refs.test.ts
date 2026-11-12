import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { DELEGATION_HELP } from "../src/delegation-cli-help.js";
import { compactDelegationOutput } from "../src/delegation-cli-output.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type {
  DelegationControlRegistration,
  DelegationStartInput,
  DelegationThreadSnapshot,
} from "../src/delegation-types.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import { FileThreadRefsStore, mergeRefs, normalizeRefs } from "../src/thread-refs.js";

const ISSUE = "https://github.com/o/r/issues/12";
const SPEC = "https://github.com/o/r/issues/13";

/** One Host session whose start creates `child-<n>` under whatever parent it is given. */
function session(): DelegationControlRegistration & { starts: DelegationStartInput[] } {
  const starts: DelegationStartInput[] = [];
  const snapshot = (threadId: string): DelegationThreadSnapshot => ({
    threadId,
    harnessId: "pi",
    status: "running",
    turn: null,
    progress: [],
    result: { availability: "pending" },
    nextCursor: null,
  });
  return {
    starts,
    listHarnesses: vi.fn(),
    inspect: vi.fn(),
    canHandleStart: () => true,
    ownsThread: () => true,
    start: vi.fn(async (input: DelegationStartInput) => {
      starts.push(input);
      const threadId = `child-${starts.length}`;
      return {
        delegationId: `delegation-${starts.length}`,
        threadId,
        turnId: "turn",
        harnessId: "pi" as const,
        deepLink: `codex://threads/${threadId}`,
        status: "running" as const,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...((input.taskName ?? input.task) ? { title: input.taskName ?? input.task } : {}),
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        next: { read: "read", wait: "wait" },
      };
    }),
    send: vi.fn(),
    cancel: vi.fn(),
    read: vi.fn(async ({ threadId }: { threadId: string }) => snapshot(threadId)),
    wait: vi.fn(async ({ threadId }: { threadId: string }) => ({
      ...snapshot(threadId),
      timedOut: true,
    })),
    list: vi.fn(async (input) => ({
      threads: [
        {
          threadId: "child-1",
          harnessId: "pi" as const,
          deepLink: "codex://threads/child-1",
          status: "running" as const,
          title: String(input.parentThreadId ?? "workspace"),
        },
      ],
      nextCursor: null,
    })),
  } as unknown as DelegationControlRegistration & { starts: DelegationStartInput[] };
}

describe("Thread references", () => {
  let directory: string;
  let store: FileThreadRefsStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-refs-"));
    store = new FileThreadRefsStore(path.join(directory, "thread-refs"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("validates, strips credentials and removes duplicates", () => {
    expect(normalizeRefs(undefined)).toEqual([]);
    expect(normalizeRefs([ISSUE, ISSUE, "https://user:secret@example.com/x"])).toEqual([
      ISSUE,
      "https://example.com/x",
    ]);
    expect(() => normalizeRefs(["issues/12"])).toThrow(/absolute URI/u);
    expect(() => normalizeRefs([`https://e.com/${"a".repeat(2_100)}`])).toThrow(/2048/u);
    expect(() =>
      normalizeRefs(Array.from({ length: 17 }, (_, index) => `https://e.com/${index}`)),
    ).toThrow(/16/u);
  });

  it("keeps a child's own references when inheritance would exceed the limit", () => {
    const inherited = Array.from({ length: 16 }, (_, index) => `https://e.com/p${index}`);
    const merged = mergeRefs(inherited, [ISSUE]);
    expect(merged).toHaveLength(16);
    expect(merged.at(-1)).toBe(ISSUE);
    expect(mergeRefs([ISSUE], [ISSUE, SPEC])).toEqual([ISSUE, SPEC]);
  });

  it("stores references per Thread and finds Threads by reference, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000);
      await store.set("a", [ISSUE]);
      vi.setSystemTime(2_000);
      await store.set("b", [ISSUE, SPEC]);
    } finally {
      vi.useRealTimers();
    }
    await expect(store.get("b")).resolves.toEqual([ISSUE, SPEC]);
    await expect(store.get("missing")).resolves.toEqual([]);
    await expect(store.find(ISSUE)).resolves.toEqual([{ threadId: "b" }, { threadId: "a" }]);
    await expect(store.find(SPEC)).resolves.toEqual([{ threadId: "b" }]);
  });

  it("records references on start, inherits them, and returns them on read, wait and list", async () => {
    const host = session();
    const registry = new DelegationControlRegistry({ refs: store });
    registry.register(host);

    const parent = await registry.start({
      harnessId: "pi",
      task: "spec",
      parentThreadId: "root",
      refs: [ISSUE],
    });
    expect(parent.refs).toEqual([ISSUE]);
    // The Host session never sees the references.
    expect(host.starts[0]).not.toHaveProperty("refs");

    const child = await registry.start({
      harnessId: "pi",
      task: "stage",
      parentThreadId: parent.threadId,
      refs: [SPEC],
    });
    expect(child.refs).toEqual([ISSUE, SPEC]);
    await expect(
      registry.read({ threadId: child.threadId, view: "result" }),
    ).resolves.toMatchObject({
      refs: [ISSUE, SPEC],
    });
    await expect(
      registry.wait({ threadId: parent.threadId, view: "result", timeoutMs: 1 }),
    ).resolves.toMatchObject({
      refs: [ISSUE],
    });
    await expect(registry.list({ limit: 25, sort: "created-desc" })).resolves.toMatchObject({
      threads: [{ threadId: "child-1", refs: [ISSUE] }],
    });

    const untouched = await registry.read({ threadId: "unrelated", view: "result" });
    expect(untouched).not.toHaveProperty("refs");
  });

  it("rejects an invalid reference before any Thread is created", async () => {
    const host = session();
    const registry = new DelegationControlRegistry({ refs: store });
    registry.register(host);
    await expect(
      registry.start({ harnessId: "pi", task: "x", parentThreadId: "root", refs: ["nope"] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(host.starts).toEqual([]);
  });

  it("lists Threads by reference with a cursor, across workspaces", async () => {
    const host = session();
    const registry = new DelegationControlRegistry({ refs: store });
    registry.register(host);
    for (let index = 0; index < 3; index += 1)
      await registry.start({
        harnessId: "pi",
        task: `t${index}`,
        parentThreadId: "root",
        refs: [ISSUE],
      });

    const first = await registry.list({ ref: ISSUE, limit: 2, sort: "created-desc" });
    expect(first.threads).toHaveLength(2);
    expect(first.threads[0]).toMatchObject({ harnessId: "pi", status: "running", refs: [ISSUE] });
    expect(first.nextCursor).toBe("ref:2");
    const second = await registry.list({
      ref: ISSUE,
      limit: 2,
      sort: "created-desc",
      cursor: first.nextCursor ?? "",
    });
    expect(second).toMatchObject({ nextCursor: null });
    expect([...first.threads, ...second.threads].map((thread) => thread.threadId).sort()).toEqual([
      "child-1",
      "child-2",
      "child-3",
    ]);
    await expect(
      registry.list({ ref: ISSUE, limit: 2, sort: "created-desc", cursor: "bogus" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("routes an external client's start to the only session and lists it by client", async () => {
    const host = session();
    const other = { ...session(), canHandleStart: () => false };
    const registry = new DelegationControlRegistry({ refs: store });
    registry.register(host);
    const route = externalClientRouter({ api: registry, watchApi: registry });
    const call = { client: "grok-bot" } as Parameters<typeof route>[0];

    await expect(
      route(call, "/v1/delegate/start", { harnessId: "pi", task: "triage", cwd: "/w" }),
    ).resolves.toMatchObject({ parentThreadId: "client:grok-bot" });
    expect(host.starts[0]?.parentThreadId).toBe("client:grok-bot");

    await expect(
      route(call, "/v1/delegate/start", {
        harnessId: "pi",
        task: "x",
        parentThreadId: "client:someone-else",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await expect(
      registry.list({ client: "grok-bot", limit: 25, sort: "created-desc" }),
    ).resolves.toMatchObject({
      threads: [{ title: "client:grok-bot" }],
    });
    await expect(
      registry.list({ client: "grok-bot", parentThreadId: "p", limit: 25, sort: "created-desc" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    // With two sessions and no shared catalog, client work has no unique owner.
    registry.register(other);
    await expect(
      registry.start({ harnessId: "pi", task: "y", cwd: "/w", parentThreadId: "client:grok-bot" }),
    ).rejects.toMatchObject({ code: "PARENT_THREAD_AMBIGUOUS" });
  });
  it("sends repeated --ref values and lists an external client's work across workspaces", async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => {
      bodies.push({ url: url.toString(), body: JSON.parse(String(init?.body)) });
      return new Response('{"threads":[],"nextCursor":null}', { status: 200 });
    }) as unknown as typeof fetch;
    const run = (arguments_: string[], environment: NodeJS.ProcessEnv) =>
      runDelegationCli({ arguments: arguments_, environment, fetchImpl });

    await run(
      ["delegate", "start", "--harness", "pi", "--task", "t", "--ref", ISSUE, "--ref", SPEC],
      { CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1", CODEXHOST_RUNTIME_TOKEN: "host" },
    );
    expect(bodies[0]?.body.refs).toEqual([ISSUE, SPEC]);

    await run(["thread", "list", "--client", "grok-bot"], {
      CODEXHOST_DATA_DIR: directory,
      CODEXHOST_CLIENT_TOKEN: "chc_token",
    });
    expect(bodies[1]?.url).toBe("http://127.0.0.1:4398/v1/thread/list");
    expect(bodies[1]?.body).toMatchObject({ client: "grok-bot" });
    expect(bodies[1]?.body).not.toHaveProperty("cwd");
  });
  it("shows where a Thread works and its title when listing by reference", async () => {
    const registry = new DelegationControlRegistry({ refs: store });
    registry.register(session());
    await registry.start({
      harnessId: "pi",
      task: "fix issue 12",
      taskName: "fix #12",
      cwd: "/repo",
      parentThreadId: "root",
      refs: [ISSUE],
    });
    await expect(
      registry.list({ ref: ISSUE, limit: 5, sort: "created-desc" }),
    ).resolves.toMatchObject({
      threads: [{ threadId: "child-1", cwd: "/repo", title: "fix #12", refs: [ISSUE] }],
    });
  });

  it("shows a client parent as is in compact output and lists client commands in help", () => {
    const compact = compactDelegationOutput("delegate start", {
      threadId: "t1",
      harnessId: "pi",
      status: "running",
      parentThreadId: "client:grok-bot",
      next: { read: "r", wait: "w" },
    }) as Record<string, unknown>;
    expect(compact.parent).toBe("client:grok-bot");
    const watched = compactDelegationOutput("delegate start", {
      threadId: "t1",
      harnessId: "pi",
      status: "running",
      parentThreadId: "client:grok-bot",
      watch: {
        threadId: "t1",
        notifyThreadId: "client:grok-bot",
        state: "watching",
        status: "running",
        timeoutMs: 1,
      },
      next: { read: "r", wait: "w" },
    }) as { watch?: { notify?: string } };
    expect(watched.watch?.notify).toBe("client:grok-bot");
    expect(DELEGATION_HELP).toContain("codexhost client add|list|set|pair|remove|access|webhook");
    expect(DELEGATION_HELP).toContain("codexhost events");
  });
});
