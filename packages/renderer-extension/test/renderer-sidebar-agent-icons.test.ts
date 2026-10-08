import {
  harnessIdSchema,
  type HarnessPluginDescriptor,
  type HostThreadId,
  type ThreadOwnershipListParams,
  type ThreadOwnershipListResult,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RendererAgent } from "../src/agent-selection-state.js";
import type { RendererModelClient } from "../src/renderer-model-client.js";
import { RendererMethodUnavailableError } from "../src/renderer-request-sender.js";
import {
  installRendererSidebarAgentIcons,
  draftIdFromSidebarRowElement,
  rendererAgentForThreadOwnership,
  threadIdFromSidebarRowElement,
  type SidebarAgentIconDom,
  type SidebarAgentIconRow,
} from "../src/renderer-sidebar-agent-icons.js";

const PI_HARNESS_ID = harnessIdSchema.parse("pi");
const CLAUDE_CODE_HARNESS_ID = harnessIdSchema.parse("claude-code");
const OPENCODE_HARNESS_ID = harnessIdSchema.parse("opencode");
const ANTIGRAVITY_HARNESS_ID = harnessIdSchema.parse("antigravity");
const HERMES_HARNESS_ID = harnessIdSchema.parse("hermes");
const FUTURE_HARNESS_ID = harnessIdSchema.parse("future-agent");

class FakeRow implements SidebarAgentIconRow {
  connected = true;
  agent: Exclude<RendererAgent, "codex"> | null = null;
  renders = 0;
  clears = 0;
  plugin: HarnessPluginDescriptor | undefined;

  constructor(
    public id: string | null,
    public draft: string | null = null,
    public host: string | null = "local",
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  hostId(): string | null {
    return this.host;
  }

  threadId(): string | null {
    return this.id;
  }

  draftId(): string | null {
    return this.draft;
  }

  render(agent: Exclude<RendererAgent, "codex">, plugin?: HarnessPluginDescriptor): void {
    this.agent = agent;
    this.plugin = plugin;
    this.renders += 1;
  }

  clear(): void {
    this.agent = null;
    this.clears += 1;
  }
}

class FakeDom implements SidebarAgentIconDom {
  readonly listeners = new Set<(rows: readonly SidebarAgentIconRow[]) => void>();
  cleared = false;

  constructor(public mountedRows: FakeRow[]) {}

  rows(): readonly SidebarAgentIconRow[] {
    return this.mountedRows;
  }

  observe(onChange: (rows: readonly SidebarAgentIconRow[]) => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  clear(): void {
    this.cleared = true;
    for (const row of this.mountedRows) row.clear();
  }

  change(rows: readonly SidebarAgentIconRow[] = this.mountedRows): void {
    for (const listener of this.listeners) listener(rows);
  }
}

function clientWith(
  listThreadOwnership: (input: ThreadOwnershipListParams) => Promise<ThreadOwnershipListResult>,
): RendererModelClient {
  return {
    forkThread: vi.fn(),
    inspectHarness: vi.fn(),
    inspectThread: vi.fn(),
    inspectHarnessCommands: vi.fn(),
    inspectThreadCommands: vi.fn(),
    executeThreadCommand: vi.fn(),
    inspectThreadUsage: vi.fn(),
    listThreadOwnership: vi.fn(listThreadOwnership),
    selectThreadModel: vi.fn(),
    selectThreadThinking: vi.fn(),
    selectThreadPermissionMode: vi.fn(),
    checkUpdate: vi.fn(),
    startUpdate: vi.fn(),
    readUpdateStatus: vi.fn(),
    listCodexAccounts: vi.fn(),
    refreshCodexAccounts: vi.fn(),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function fiberRow(
  conversationIds: string[],
  options: { matchingAttributes?: boolean; fiberCount?: number } = {},
): HTMLElement {
  const attributes = {
    "data-app-action-sidebar-thread-row": "",
    "data-app-action-sidebar-thread-id": "opaque-task-key",
    "data-app-action-sidebar-thread-host-id": "local",
  };
  const element = {
    getAttribute(name: string) {
      return attributes[name as keyof typeof attributes] ?? null;
    },
  } as HTMLElement;
  let fiber: Record<string, unknown> | null = null;
  for (const conversationId of conversationIds.toReversed()) {
    fiber = {
      memoizedProps: {
        conversationId,
        dataAttributes:
          options.matchingAttributes === false
            ? { ...attributes, "data-app-action-sidebar-thread-id": "other-key" }
            : attributes,
      },
      return: fiber,
    };
  }
  for (let index = 0; index < (options.fiberCount ?? 1); index += 1) {
    Object.defineProperty(element, `__reactFiber$test${index}`, { value: fiber });
  }
  return element;
}

describe("Renderer sidebar Agent ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the draft key separately from the Fiber conversation identity", () => {
    const attributes = {
      "data-app-action-sidebar-thread-row": "",
      "data-app-action-sidebar-thread-id": "local:client-new-thread:opaque",
      "data-app-action-sidebar-thread-host-id": "local",
    };
    const row = {
      getAttribute(attribute: string) {
        return attributes[attribute as keyof typeof attributes] ?? null;
      },
    } as HTMLElement;
    expect(draftIdFromSidebarRowElement(row)).toBe("client-new-thread:opaque");
    expect(threadIdFromSidebarRowElement(fiberRow(["thread-1", "thread-1"]))).toBe("thread-1");
    expect(
      threadIdFromSidebarRowElement(fiberRow(["thread-1"], { matchingAttributes: false })),
    ).toBeNull();
    expect(threadIdFromSidebarRowElement(fiberRow(["thread-1", "thread-2"]))).toBeNull();
    expect(threadIdFromSidebarRowElement(fiberRow(["thread-1"], { fiberCount: 2 }))).toBeNull();
  });

  it("uses a mounted draft Agent before querying ownership", async () => {
    const row = new FakeRow(null, "client-new-thread:opaque");
    const dom = new FakeDom([row]);
    const client = clientWith(async () => ({ threads: [] }));
    const control = installRendererSidebarAgentIcons({
      getClient: () => client,
      getLocalAgent: ({ draftId }) => (draftId === "client-new-thread:opaque" ? "pi" : null),
      dom,
    });

    await settle();

    expect(row.agent).toBe("pi");
    expect(client.listThreadOwnership).not.toHaveBeenCalled();
    control.dispose();
  });

  it("retains local ownership after the draft Composer is no longer matched", async () => {
    const row = new FakeRow("draft-thread", "client-new-thread:opaque");
    const dom = new FakeDom([row]);
    let localAgent: RendererAgent | null = "pi";
    const client = clientWith(async () => ({ threads: [] }));
    const control = installRendererSidebarAgentIcons({
      getClient: () => client,
      getLocalAgent: () => localAgent,
      dom,
    });

    await settle();
    localAgent = null;
    dom.change();
    await settle();

    expect(row.agent).toBe("pi");
    expect(client.listThreadOwnership).not.toHaveBeenCalled();
    control.dispose();
  });

  it("rechecks provisional Codex ownership until an external mapping appears", async () => {
    vi.useFakeTimers();
    try {
      const row = new FakeRow("new-thread");
      const dom = new FakeDom([row]);
      const listThreadOwnership = vi
        .fn<(input: ThreadOwnershipListParams) => Promise<ThreadOwnershipListResult>>()
        .mockResolvedValueOnce({
          threads: [{ threadId: "new-thread" as HostThreadId, owner: "codex" }],
        })
        .mockResolvedValueOnce({
          threads: [
            {
              threadId: "new-thread" as HostThreadId,
              owner: "external",
              harnessId: PI_HARNESS_ID,
            },
          ],
        });
      const client = clientWith(listThreadOwnership);
      const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });

      await vi.runAllTimersAsync();

      expect(listThreadOwnership).toHaveBeenCalledTimes(2);
      expect(row.agent).toBe("pi");
      control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches mounted rows and decorates arbitrary external plugin identities", async () => {
    const rows = [
      new FakeRow("codex-thread"),
      new FakeRow("pi-thread"),
      new FakeRow("claude-thread"),
      new FakeRow("unknown-thread"),
    ];
    const dom = new FakeDom(rows);
    const client = clientWith(async ({ threadIds }) => ({
      threads: threadIds.map((threadId) => {
        if (threadId === "pi-thread") {
          return { threadId, owner: "external" as const, harnessId: PI_HARNESS_ID };
        }
        if (threadId === "claude-thread") {
          return {
            threadId,
            owner: "external" as const,
            harnessId: CLAUDE_CODE_HARNESS_ID,
          };
        }
        if (threadId === "unknown-thread") {
          return { threadId, owner: "external" as const, harnessId: FUTURE_HARNESS_ID };
        }
        return { threadId, owner: "codex" as const };
      }),
    }));

    const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });
    await settle();

    expect(client.listThreadOwnership).toHaveBeenCalledTimes(1);
    expect(client.listThreadOwnership).toHaveBeenCalledWith({
      threadIds: ["codex-thread", "pi-thread", "claude-thread", "unknown-thread"],
    });
    expect(rows.map((row) => row.agent)).toEqual([null, "pi", "claude-code", "future-agent"]);
    control.dispose();
  });

  it("reads each Host's artwork once per scan, including cached ownership, without retaining it across scans", async () => {
    const rows = Array.from(
      { length: 80 },
      (_, index) => new FakeRow(`thread-${index}`, null, index % 2 ? "remote" : "local"),
    );
    const dom = new FakeDom(rows);
    const client = clientWith(async ({ threadIds }) => ({
      threads: threadIds.map((threadId, index) => ({
        threadId,
        owner: "external" as const,
        harnessId: index % 2 ? PI_HARNESS_ID : CLAUDE_CODE_HARNESS_ID,
      })),
    }));
    const plugins = (host: string, version: string): HarnessPluginDescriptor[] =>
      [PI_HARNESS_ID, CLAUDE_CODE_HARNESS_ID].map((id) => ({
        id,
        name: `${host}-${id}`,
        version,
      }));
    let remotePlugins: readonly HarnessPluginDescriptor[] | undefined = plugins("remote", "1");
    const getPlugins = vi.fn((host: string) =>
      host === "local" ? plugins("local", "1") : remotePlugins,
    );
    const control = installRendererSidebarAgentIcons({ getClient: () => client, getPlugins, dom });
    try {
      await settle();
      expect(getPlugins).toHaveBeenCalledTimes(2);
      expect(getPlugins).toHaveBeenCalledWith("local");
      expect(getPlugins).toHaveBeenCalledWith("remote");
      expect(client.listThreadOwnership).toHaveBeenCalledTimes(2);
      for (const row of rows) expect(row.plugin?.name).toBe(`${row.host}-${row.agent}`);

      // Cached ownership still needs fresh artwork on the next scan: a disconnected
      // or replaced Host must not retain the previous connection's presentation.
      for (const next of [undefined, plugins("remote", "2")]) {
        remotePlugins = next;
        getPlugins.mockClear();
        dom.change();
        dom.change();
        await settle();
        expect(getPlugins).toHaveBeenCalledTimes(2);
        expect(client.listThreadOwnership).toHaveBeenCalledTimes(2);
        for (const row of rows) {
          expect(row.plugin?.version).toBe(row.host === "local" ? "1" : next?.[0]?.version);
        }
      }
    } finally {
      control.dispose();
    }
  });

  it("shares a Host artwork read between a local draft and cached sidebar ownership", async () => {
    const draft = new FakeRow(null, "client-new-thread:draft");
    const thread = new FakeRow("thread");
    const dom = new FakeDom([draft, thread]);
    const client = clientWith(async ({ threadIds }) => ({
      threads: threadIds.map((threadId) => ({
        threadId,
        owner: "external" as const,
        harnessId: PI_HARNESS_ID,
      })),
    }));
    const plugin = { id: PI_HARNESS_ID, name: "Pi", version: "1" };
    const getPlugins = vi.fn(() => [plugin]);
    const control = installRendererSidebarAgentIcons({
      getClient: () => client,
      getLocalAgent: ({ draftId }) => (draftId ? "pi" : null),
      getPlugins,
      dom,
    });
    try {
      await settle();
      getPlugins.mockClear();
      dom.change();
      await settle();
      expect(getPlugins).toHaveBeenCalledOnce();
      expect(draft.plugin).toEqual(plugin);
      expect(thread.plugin).toEqual(plugin);
    } finally {
      control.dispose();
    }
  });

  it("only processes appended or changed rows in a long list, including their ownership replies", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => new FakeRow(`thread-${index}`));
    const dom = new FakeDom(rows);
    const client = clientWith(async ({ threadIds }) => ({
      threads: threadIds.map((threadId) => ({
        threadId,
        owner: "external" as const,
        harnessId: PI_HARNESS_ID,
      })),
    }));
    const readRows = vi.spyOn(dom, "rows");
    const getLocalAgent = vi.fn(() => null);
    const control = installRendererSidebarAgentIcons({
      getClient: () => client,
      getLocalAgent,
      dom,
    });
    try {
      await settle();
      const renders = rows.map((row) => row.renders);
      readRows.mockClear();
      getLocalAgent.mockClear();
      vi.mocked(client.listThreadOwnership).mockClear();
      const added = new FakeRow("new-thread");
      rows.push(added);
      dom.change([added]);
      dom.change([added]);
      await settle();
      await settle();
      expect(added.agent).toBe("pi");
      expect(client.listThreadOwnership).toHaveBeenCalledExactlyOnceWith({
        threadIds: ["new-thread"],
      });
      expect(rows.slice(0, 1000).map((row) => row.renders)).toEqual(renders);
      expect(getLocalAgent).toHaveBeenCalledTimes(2); // discovery and its asynchronous reply
      expect(readRows).not.toHaveBeenCalled();

      // A title replacement repairs just that row using cached ownership.
      getLocalAgent.mockClear();
      const first = rows[0];
      if (!first) throw new Error("Missing existing row");
      first.agent = null;
      dom.change([first]);
      await settle();
      expect(first.agent).toBe("pi");
      expect(getLocalAgent).toHaveBeenCalledOnce();
      expect(readRows).not.toHaveBeenCalled();

      // Explicit Host/plugin invalidation still refreshes the entire mounted list.
      getLocalAgent.mockClear();
      control.refresh();
      await settle();
      expect(readRows).toHaveBeenCalledOnce();
      expect(getLocalAgent).toHaveBeenCalledTimes(1001);
    } finally {
      control.dispose();
    }
  });

  it("updates every mounted copy of a Thread, but not recycled or removed rows, on a late ownership reply", async () => {
    const first = new FakeRow("old");
    const duplicate = new FakeRow("old");
    const removed = new FakeRow("old");
    const dom = new FakeDom([first, removed]);
    const pending = Promise.withResolvers<ThreadOwnershipListResult>();
    const client = clientWith(async ({ threadIds }) =>
      threadIds.some((id) => id === "old")
        ? pending.promise
        : {
            threads: threadIds.map((threadId) => ({
              threadId,
              owner: "external" as const,
              harnessId: CLAUDE_CODE_HARNESS_ID,
            })),
          },
    );
    const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });
    try {
      await settle();
      first.id = "replacement";
      removed.connected = false;
      dom.mountedRows = [first, duplicate];
      dom.change([first, removed, duplicate]);
      await settle();
      await settle();
      expect(first.agent).toBe("claude-code");
      const firstRenders = first.renders;
      pending.resolve({
        threads: [{ threadId: "old" as HostThreadId, owner: "external", harnessId: PI_HARNESS_ID }],
      });
      await settle();
      expect(duplicate.agent).toBe("pi");
      expect(removed.agent).toBeNull();
      expect(first.agent).toBe("claude-code");
      expect(first.renders).toBe(firstRenders);
    } finally {
      control.dispose();
    }
  });

  it("queries local and remote sidebar rows independently", async () => {
    const threadId = "shared-thread";
    const localRow = new FakeRow(threadId);
    const remoteRow = new FakeRow(threadId, null, "remote-ssh:company");
    const dom = new FakeDom([localRow, remoteRow]);
    let resolveRemote: ((result: ThreadOwnershipListResult) => void) | undefined;
    const remoteResult = new Promise<ThreadOwnershipListResult>((resolve) => {
      resolveRemote = resolve;
    });
    const localClient = clientWith(async ({ threadIds }) => ({
      threads: threadIds.map((id) => ({
        threadId: id,
        owner: "external" as const,
        harnessId: PI_HARNESS_ID,
      })),
    }));
    const remoteClient = clientWith(async () => remoteResult);
    const control = installRendererSidebarAgentIcons({
      getClient: (hostId) => (hostId === "local" ? localClient : remoteClient),
      dom,
    });

    await settle();
    expect(localRow.agent).toBe("pi");
    expect(remoteRow.agent).toBeNull();
    expect(localClient.listThreadOwnership).toHaveBeenCalledWith({ threadIds: [threadId] });
    expect(remoteClient.listThreadOwnership).toHaveBeenCalledWith({ threadIds: [threadId] });

    resolveRemote?.({
      threads: [
        {
          threadId: threadId as HostThreadId,
          owner: "external",
          harnessId: CLAUDE_CODE_HARNESS_ID,
        },
      ],
    });
    await settle();

    expect(localRow.agent).toBe("pi");
    expect(remoteRow.agent).toBe("claude-code");
    control.dispose();
  });

  it("does not apply a late result to a recycled row", async () => {
    const row = new FakeRow("old-thread");
    const dom = new FakeDom([row]);
    let resolveOld: ((result: ThreadOwnershipListResult) => void) | undefined;
    const oldResult = new Promise<ThreadOwnershipListResult>((resolve) => {
      resolveOld = resolve;
    });
    const client = clientWith(async ({ threadIds }) => {
      if (threadIds[0] === "old-thread") return oldResult;
      return {
        threads: [
          {
            threadId: threadIds[0] as HostThreadId,
            owner: "external",
            harnessId: PI_HARNESS_ID,
          },
        ],
      };
    });

    const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });
    row.id = "new-thread";
    dom.change();
    await settle();
    expect(row.agent).toBe("pi");

    resolveOld?.({
      threads: [
        {
          threadId: "old-thread" as HostThreadId,
          owner: "external",
          harnessId: CLAUDE_CODE_HARNESS_ID,
        },
      ],
    });
    await settle();
    expect(row.agent).toBe("pi");
    control.dispose();
  });

  it("restores cached decoration after title replacement without another request", async () => {
    const row = new FakeRow("pi-thread");
    const dom = new FakeDom([row]);
    const client = clientWith(async ({ threadIds }) => ({
      threads: [
        {
          threadId: threadIds[0] as HostThreadId,
          owner: "external",
          harnessId: PI_HARNESS_ID,
        },
      ],
    }));
    const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });
    await settle();
    const renders = row.renders;

    row.agent = null;
    dom.change();
    await settle();

    expect(row.agent).toBe("pi");
    expect(row.renders).toBeGreaterThan(renders);
    expect(client.listThreadOwnership).toHaveBeenCalledTimes(1);
    control.dispose();
  });

  it("does not schedule retries for an unsupported ownership API and can recover after connection refresh", async () => {
    vi.useFakeTimers();
    try {
      const row = new FakeRow("pi-thread");
      const dom = new FakeDom([row]);
      let client = clientWith(
        vi
          .fn()
          .mockRejectedValue(
            new RendererMethodUnavailableError("codexhost/thread/ownership/list", { code: -32601 }),
          ),
      );
      const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });
      await vi.runAllTimersAsync();
      expect(client.listThreadOwnership).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      client = clientWith(async ({ threadIds }) => ({
        threads: threadIds.map((threadId) => ({
          threadId,
          owner: "external",
          harnessId: PI_HARNESS_ID,
        })),
      }));
      control.refresh();
      await vi.runAllTimersAsync();
      expect(row.agent).toBe("pi");
      control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries provisional ownership without rescanning unrelated rows", async () => {
    vi.useFakeTimers();
    const stable = Array.from({ length: 1000 }, (_, index) => new FakeRow(`stable-${index}`));
    const provisional = new FakeRow("provisional");
    const dom = new FakeDom([...stable, provisional]);
    let ready = false;
    const client = clientWith(async ({ threadIds }) => ({
      threads: threadIds.map((threadId) =>
        threadId === "provisional" && !ready
          ? { threadId, owner: "codex" as const }
          : { threadId, owner: "external" as const, harnessId: PI_HARNESS_ID },
      ),
    }));
    const getLocalAgent = vi.fn(() => null);
    const control = installRendererSidebarAgentIcons({
      getClient: () => client,
      getLocalAgent,
      dom,
    });
    try {
      await vi.advanceTimersByTimeAsync(32);
      expect(provisional.agent).toBeNull();
      expect(stable.every((row) => row.agent === "pi")).toBe(true);
      const renders = stable.map((row) => row.renders);
      getLocalAgent.mockClear();
      ready = true;
      await vi.advanceTimersByTimeAsync(120);
      expect(provisional.agent).toBe("pi");
      expect(getLocalAgent).toHaveBeenCalledTimes(2);
      expect(stable.map((row) => row.renders)).toEqual(renders);
    } finally {
      control.dispose();
      vi.useRealTimers();
    }
  });

  it("retries failed ownership requests without requiring an explicit refresh", async () => {
    vi.useFakeTimers();
    try {
      const row = new FakeRow("pi-thread");
      const dom = new FakeDom([row]);
      const listThreadOwnership = vi
        .fn<(input: ThreadOwnershipListParams) => Promise<ThreadOwnershipListResult>>()
        .mockRejectedValueOnce(new Error("unavailable"))
        .mockResolvedValue({
          threads: [
            {
              threadId: "pi-thread" as HostThreadId,
              owner: "external",
              harnessId: PI_HARNESS_ID,
            },
          ],
        });
      const client = clientWith(listThreadOwnership);
      const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });

      await vi.runAllTimersAsync();

      expect(listThreadOwnership).toHaveBeenCalledTimes(2);
      expect(row.agent).toBe("pi");
      control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a synchronous early-client failure and retries automatically", async () => {
    vi.useFakeTimers();
    try {
      const row = new FakeRow("pi-thread");
      const dom = new FakeDom([row]);
      const listThreadOwnership = vi
        .fn<(input: ThreadOwnershipListParams) => Promise<ThreadOwnershipListResult>>()
        .mockImplementationOnce(() => {
          throw new Error("request manager unavailable");
        })
        .mockResolvedValue({
          threads: [
            {
              threadId: "pi-thread" as HostThreadId,
              owner: "external",
              harnessId: PI_HARNESS_ID,
            },
          ],
        });
      const client = clientWith(listThreadOwnership);
      const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });

      await vi.runAllTimersAsync();

      expect(listThreadOwnership).toHaveBeenCalledTimes(2);
      expect(row.agent).toBe("pi");
      control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries when the ownership client is unavailable during the first scan", async () => {
    vi.useFakeTimers();
    try {
      const row = new FakeRow("pi-thread");
      const dom = new FakeDom([row]);
      const client = clientWith(async () => ({
        threads: [
          {
            threadId: "pi-thread" as HostThreadId,
            owner: "external",
            harnessId: PI_HARNESS_ID,
          },
        ],
      }));
      const getClient = vi.fn<() => RendererModelClient | null>().mockReturnValueOnce(null);
      getClient.mockReturnValue(client);
      const control = installRendererSidebarAgentIcons({ getClient, dom });

      await vi.runAllTimersAsync();

      expect(getClient).toHaveBeenCalledTimes(2);
      expect(client.listThreadOwnership).toHaveBeenCalledTimes(1);
      expect(row.agent).toBe("pi");
      control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps failed ownership retries bounded while the service stays unavailable", async () => {
    vi.useFakeTimers();
    try {
      const row = new FakeRow("pi-thread");
      const dom = new FakeDom([row]);
      const client = clientWith(vi.fn().mockRejectedValue(new Error("unavailable")));
      const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });

      await vi.runAllTimersAsync();

      expect(client.listThreadOwnership).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(0);
      expect(row.agent).toBeNull();
      control.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps external Harness ownership without a static identity list", () => {
    expect(
      rendererAgentForThreadOwnership({
        threadId: "kiro-thread" as HostThreadId,
        owner: "external",
        harnessId: harnessIdSchema.parse("kiro-cli"),
      }),
    ).toBe("kiro-cli");
    expect(
      rendererAgentForThreadOwnership({
        threadId: "pi-thread" as HostThreadId,
        owner: "external",
        harnessId: PI_HARNESS_ID,
      }),
    ).toBe("pi");
    expect(
      rendererAgentForThreadOwnership({
        threadId: "opencode-thread" as HostThreadId,
        owner: "external",
        harnessId: OPENCODE_HARNESS_ID,
      }),
    ).toBe("opencode");
    expect(
      rendererAgentForThreadOwnership({
        threadId: "antigravity-thread" as HostThreadId,
        owner: "external",
        harnessId: ANTIGRAVITY_HARNESS_ID,
      }),
    ).toBe("antigravity");
    expect(
      rendererAgentForThreadOwnership({
        threadId: "hermes-thread" as HostThreadId,
        owner: "external",
        harnessId: HERMES_HARNESS_ID,
      }),
    ).toBe("hermes");
    expect(
      rendererAgentForThreadOwnership({
        threadId: "qoder-thread" as HostThreadId,
        owner: "external",
        harnessId: harnessIdSchema.parse("qoder"),
      }),
    ).toBe("qoder");
    expect(
      rendererAgentForThreadOwnership({
        threadId: "future-thread" as HostThreadId,
        owner: "external",
        harnessId: FUTURE_HARNESS_ID,
      }),
    ).toBe("future-agent");
  });
});
