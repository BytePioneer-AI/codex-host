import {
  harnessIdSchema,
  type HostThreadId,
  type ThreadOwnershipListParams,
  type ThreadOwnershipListResult,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import type { RendererAgent } from "../src/agent-selection-state.js";
import type { RendererModelClient } from "../src/renderer-model-client.js";
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
const FUTURE_HARNESS_ID = harnessIdSchema.parse("future-agent");

class FakeRow implements SidebarAgentIconRow {
  connected = true;
  agent: Exclude<RendererAgent, "codex"> | null = null;
  renders = 0;
  clears = 0;

  constructor(
    public id: string | null,
    public draft: string | null = null,
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  threadId(): string | null {
    return this.id;
  }

  draftId(): string | null {
    return this.draft;
  }

  render(agent: Exclude<RendererAgent, "codex">): void {
    this.agent = agent;
    this.renders += 1;
  }

  clear(): void {
    this.agent = null;
    this.clears += 1;
  }
}

class FakeDom implements SidebarAgentIconDom {
  readonly listeners = new Set<() => void>();
  cleared = false;

  constructor(public mountedRows: FakeRow[]) {}

  rows(): readonly SidebarAgentIconRow[] {
    return this.mountedRows;
  }

  observe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  clear(): void {
    this.cleared = true;
    for (const row of this.mountedRows) row.clear();
  }

  change(): void {
    for (const listener of this.listeners) listener();
  }
}

function clientWith(
  listThreadOwnership: (input: ThreadOwnershipListParams) => Promise<ThreadOwnershipListResult>,
): RendererModelClient {
  return {
    forkThread: vi.fn(),
    inspectHarness: vi.fn(),
    inspectThread: vi.fn(),
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
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("batches mounted rows and decorates only known external Agents", async () => {
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
    expect(rows.map((row) => row.agent)).toEqual([null, "pi", "claude-code", null]);
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

  it("fails undecorated, retries only on refresh, and ignores pending results after disposal", async () => {
    const row = new FakeRow("pi-thread");
    const dom = new FakeDom([row]);
    const client = clientWith(vi.fn().mockRejectedValue(new Error("unavailable")));
    const control = installRendererSidebarAgentIcons({ getClient: () => client, dom });
    await settle();
    dom.change();
    await settle();
    expect(client.listThreadOwnership).toHaveBeenCalledTimes(1);
    expect(row.agent).toBeNull();

    control.refresh();
    await settle();
    expect(client.listThreadOwnership).toHaveBeenCalledTimes(2);
    control.dispose();
    expect(dom.cleared).toBe(true);
    expect(dom.listeners.size).toBe(0);
  });

  it("contains a synchronous early-client failure and retries after refresh", async () => {
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

    await settle();
    expect(row.agent).toBeNull();
    control.refresh();
    await settle();

    expect(listThreadOwnership).toHaveBeenCalledTimes(2);
    expect(row.agent).toBe("pi");
    control.dispose();
  });

  it("maps only known external Harness ownership to Renderer Agents", () => {
    expect(
      rendererAgentForThreadOwnership({
        threadId: "pi-thread" as HostThreadId,
        owner: "external",
        harnessId: PI_HARNESS_ID,
      }),
    ).toBe("pi");
    expect(
      rendererAgentForThreadOwnership({
        threadId: "future-thread" as HostThreadId,
        owner: "external",
        harnessId: FUTURE_HARNESS_ID,
      }),
    ).toBeNull();
  });
});
