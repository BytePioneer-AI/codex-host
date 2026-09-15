import {
  harnessIdSchema,
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
  BrowserSidebarAgentIconDom,
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
  SIDEBAR_THREAD_ID_ATTRIBUTE,
  SIDEBAR_AGENT_ICON_ATTRIBUTE,
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
  await new Promise((resolve) => setTimeout(resolve, 10));
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

  it("maps only known external Harness ownership to Renderer Agents", () => {
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
        threadId: "future-thread" as HostThreadId,
        owner: "external",
        harnessId: FUTURE_HARNESS_ID,
      }),
    ).toBeNull();
  });
});

class MockNode {
  static readonly ELEMENT_NODE = 1;
  static readonly TEXT_NODE = 3;
  nodeType = MockNode.ELEMENT_NODE;
  parentElement: MockElement | null = null;
}

class MockElement extends MockNode {
  override nodeType = MockNode.ELEMENT_NODE;
  readonly attributes = new Map<string, string>();
  readonly children: MockElement[] = [];

  constructor(public tagName = "div") {
    super();
  }

  get isConnected(): boolean {
    if (this.isRoot) return true;
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      if (parent.isRoot) return true;
    }
    return false;
  }
  isRoot = false;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  matches(selector: string): boolean {
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const attr = selector.slice(1, -1);
      return this.attributes.has(attr);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  closest(selector: string): MockElement | null {
    if (this.matches(selector)) return this;
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      if (parent.matches(selector)) return parent;
    }
    return null;
  }

  querySelector<E extends Element = Element>(selector: string): E | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child as unknown as E;
      const found = child.querySelector<E>(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll<E extends Element = Element>(selector: string): NodeListOf<E> {
    const results: MockElement[] = [];
    const search = (node: MockElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child);
        search(child);
      }
    };
    search(this);
    return results as unknown as NodeListOf<E>;
  }

  appendChild(child: MockElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  removeChild(child: MockElement): void {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }
}

type MockMutationCallback = (mutations: MutationRecord[], observer: MutationObserver) => void;

class MockMutationObserver {
  static instances: MockMutationObserver[] = [];
  target: MockElement | null = null;
  options?: MutationObserverInit | undefined;
  disconnected = false;

  constructor(public callback: MockMutationCallback) {
    MockMutationObserver.instances.push(this);
  }

  observe(target: Node, options?: MutationObserverInit): void {
    this.target = target as unknown as MockElement;
    this.options = options;
  }

  disconnect(): void {
    this.disconnected = true;
    const idx = MockMutationObserver.instances.indexOf(this);
    if (idx !== -1) MockMutationObserver.instances.splice(idx, 1);
  }

  trigger(mutations: Partial<MutationRecord>[]): void {
    if (this.disconnected) return;
    this.callback(mutations as MutationRecord[], this as unknown as MutationObserver);
  }
}

function firstObserver(): MockMutationObserver {
  const observer = MockMutationObserver.instances[0];
  if (!observer) throw new Error("Missing MockMutationObserver instance");
  return observer;
}

describe("BrowserSidebarAgentIconDom observe filtering", () => {
  let root: MockElement;
  let sidebarContainer: MockElement;
  let transcriptContainer: MockElement;

  beforeEach(() => {
    MockMutationObserver.instances = [];
    vi.stubGlobal("Node", MockNode);
    vi.stubGlobal("Element", MockElement);
    vi.stubGlobal("MutationObserver", MockMutationObserver);

    root = new MockElement("div");
    root.isRoot = true;

    sidebarContainer = new MockElement("div");
    sidebarContainer.setAttribute("data-sidebar-container", "");
    root.appendChild(sidebarContainer);

    transcriptContainer = new MockElement("div");
    transcriptContainer.setAttribute("data-transcript-container", "");
    root.appendChild(transcriptContainer);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not trigger onChange when transcript message content is inserted", () => {
    const dom = new BrowserSidebarAgentIconDom(root as unknown as ParentNode & Node);
    const onChange = vi.fn();
    const cleanup = dom.observe(onChange);

    expect(MockMutationObserver.instances.length).toBe(1);
    const observer = firstObserver();

    const messageElement = new MockElement("div");
    messageElement.setAttribute("data-message-bubble", "");
    transcriptContainer.appendChild(messageElement);

    observer.trigger([
      {
        type: "childList",
        target: transcriptContainer as unknown as Node,
        addedNodes: [messageElement as unknown as Node] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      },
    ]);

    expect(onChange).not.toHaveBeenCalled();
    cleanup();
  });

  it("triggers onChange when a sidebar thread row is inserted or removed", () => {
    const dom = new BrowserSidebarAgentIconDom(root as unknown as ParentNode & Node);
    const onChange = vi.fn();
    const cleanup = dom.observe(onChange);

    const observer = firstObserver();

    const row = new MockElement("div");
    row.setAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE, "");
    sidebarContainer.appendChild(row);

    observer.trigger([
      {
        type: "childList",
        target: sidebarContainer as unknown as Node,
        addedNodes: [row as unknown as Node] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      },
    ]);

    expect(onChange).toHaveBeenCalledTimes(1);

    onChange.mockClear();
    sidebarContainer.removeChild(row);

    observer.trigger([
      {
        type: "childList",
        target: sidebarContainer as unknown as Node,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [row as unknown as Node] as unknown as NodeList,
      },
    ]);

    expect(onChange).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("triggers onChange when a container containing sidebar rows is inserted", () => {
    const dom = new BrowserSidebarAgentIconDom(root as unknown as ParentNode & Node);
    const onChange = vi.fn();
    const cleanup = dom.observe(onChange);

    const observer = firstObserver();

    const section = new MockElement("section");
    const row = new MockElement("div");
    row.setAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE, "");
    section.appendChild(row);
    root.appendChild(section);

    observer.trigger([
      {
        type: "childList",
        target: root as unknown as Node,
        addedNodes: [section as unknown as Node] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      },
    ]);

    expect(onChange).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("triggers onChange when sidebar row identity attributes change", () => {
    const dom = new BrowserSidebarAgentIconDom(root as unknown as ParentNode & Node);
    const onChange = vi.fn();
    const cleanup = dom.observe(onChange);

    const observer = firstObserver();

    const row = new MockElement("div");
    row.setAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE, "");
    row.setAttribute(SIDEBAR_THREAD_ID_ATTRIBUTE, "thread-1");
    sidebarContainer.appendChild(row);

    observer.trigger([
      {
        type: "attributes",
        target: row as unknown as Node,
        attributeName: SIDEBAR_THREAD_ID_ATTRIBUTE,
      },
    ]);

    expect(onChange).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("triggers onChange for non-icon changes inside a sidebar row", () => {
    const dom = new BrowserSidebarAgentIconDom(root as unknown as ParentNode & Node);
    const onChange = vi.fn();
    const cleanup = dom.observe(onChange);

    const observer = firstObserver();

    const row = new MockElement("div");
    row.setAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE, "");
    const titleTrigger = new MockElement("div");
    titleTrigger.setAttribute("data-thread-title-trigger", "");
    row.appendChild(titleTrigger);
    sidebarContainer.appendChild(row);

    const titleText = new MockElement("span");
    titleTrigger.appendChild(titleText);

    observer.trigger([
      {
        type: "childList",
        target: titleTrigger as unknown as Node,
        addedNodes: [titleText as unknown as Node] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      },
    ]);

    expect(onChange).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("ignores mutations that only modify sidebar agent icons", () => {
    const dom = new BrowserSidebarAgentIconDom(root as unknown as ParentNode & Node);
    const onChange = vi.fn();
    const cleanup = dom.observe(onChange);

    const observer = firstObserver();

    const row = new MockElement("div");
    row.setAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE, "");
    sidebarContainer.appendChild(row);

    const icon = new MockElement("span");
    icon.setAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE, "pi");
    row.appendChild(icon);

    observer.trigger([
      {
        type: "childList",
        target: row as unknown as Node,
        addedNodes: [icon as unknown as Node] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      },
    ]);

    expect(onChange).not.toHaveBeenCalled();

    const svg = new MockElement("svg");
    icon.appendChild(svg);

    observer.trigger([
      {
        type: "childList",
        target: icon as unknown as Node,
        addedNodes: [svg as unknown as Node] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      },
    ]);

    expect(onChange).not.toHaveBeenCalled();
    cleanup();
  });

  it("cancels pending scheduled scan and disconnects observer on dispose", () => {
    const dom = new BrowserSidebarAgentIconDom(root as unknown as ParentNode & Node);
    const client = clientWith(async () => ({ threads: [] }));
    const control = installRendererSidebarAgentIcons({
      getClient: () => client,
      dom,
    });

    expect(MockMutationObserver.instances.length).toBe(1);
    const observer = firstObserver();
    expect(observer.disconnected).toBe(false);

    control.dispose();

    expect(observer.disconnected).toBe(true);
  });
});
