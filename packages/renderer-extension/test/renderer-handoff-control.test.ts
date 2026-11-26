// @vitest-environment jsdom
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  type HarnessInspection,
  type HarnessPluginDescriptor,
  type ThreadHandoffMetadata,
  type ThreadHandoffResult,
  type ThreadInspection,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HANDOFF_CONTROL_ATTRIBUTE,
  HANDOFF_DIVIDER_ATTRIBUTE,
  HANDOFF_POPOVER_ATTRIBUTE,
  installRendererHandoffControl,
} from "../src/renderer-handoff-control.js";
import { formatRendererHandoffTurnsSummary } from "../src/renderer-harness-localization.js";
import {
  THREAD_HANDOFF_METHOD,
  createRendererModelClient,
  type RendererModelClient,
} from "../src/renderer-model-client.js";

const claudePlugin: HarnessPluginDescriptor = {
  id: harnessIdSchema.parse("claude-code"),
  name: "Claude Code",
  version: "1.0.0",
};

const antigravityPlugin: HarnessPluginDescriptor = {
  id: harnessIdSchema.parse("antigravity"),
  name: "Antigravity",
  version: "1.0.0",
};

const sampleHandoff: ThreadHandoffMetadata = {
  sourceThreadId: hostThreadIdSchema.parse("source-thread-1"),
  sourceHarnessId: harnessIdSchema.parse("codex"),
  sourceHarnessLabel: "Codex",
  sourceModel: "gpt-5.4",
  targetHarnessId: harnessIdSchema.parse("claude-code"),
  targetHarnessLabel: "Claude Code",
  targetModel: "claude-sonnet-4-6",
  totalTurns: 5,
  boundaryTurnNumber: 4,
  includedTurnNumbers: [2, 3, 4],
  omittedTurns: 2,
  preview: "User: Investigate crash\nAssistant: Narrowed down to auth middleware.",
  createdAtMs: 1_764_000_000_000,
};

function createConversationDom(
  threadId: string | null,
  options: { withTurns?: boolean; externalControls?: boolean } = {},
): {
  shell: HTMLDivElement;
  transcript: HTMLDivElement;
  composer: HTMLDivElement;
  portal: HTMLDivElement;
  setThreadId(next: string | null): void;
  addTurn(turnKey: string): HTMLDivElement;
} {
  const shell = document.createElement("div");
  shell.className = "conversation-shell";

  const transcript = document.createElement("div");
  transcript.className = "conversation-transcript";
  if (options.withTurns !== false) {
    const turn = document.createElement("div");
    turn.setAttribute("data-turn-key", "turn-1");
    turn.textContent = "First message";
    transcript.append(turn);
  }

  const composer = document.createElement("div");
  composer.setAttribute("data-codex-composer-root", "true");

  const portal = document.createElement("div");
  portal.setAttribute("data-above-composer-portal", "true");
  if (threadId !== null) {
    portal.setAttribute("data-above-composer-conversation-id", threadId);
  }
  composer.append(portal);

  const toolbar = document.createElement("div");
  toolbar.className = "composer-toolbar";
  if (options.externalControls) {
    const agentControl = document.createElement("div");
    agentControl.setAttribute("data-codexhost-agent-control", "composer-1");
    toolbar.append(agentControl);
  }
  const sendButton = document.createElement("button");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", "Send");
  toolbar.append(sendButton);
  composer.append(toolbar);

  shell.append(transcript, composer);
  document.body.append(shell);

  return {
    shell,
    transcript,
    composer,
    portal,
    setThreadId(next) {
      if (next === null) portal.removeAttribute("data-above-composer-conversation-id");
      else portal.setAttribute("data-above-composer-conversation-id", next);
    },
    addTurn(turnKey) {
      const turn = document.createElement("div");
      turn.setAttribute("data-turn-key", turnKey);
      transcript.append(turn);
      return turn;
    },
  };
}

function createMockClient(overrides: Partial<RendererModelClient> = {}): RendererModelClient {
  const modelRef = harnessModelRefSchema.parse({ id: "claude-sonnet-4-6" });
  const highThinking = harnessThinkingOptionIdSchema.parse("high");
  const defaultHarnessInspection: HarnessInspection = {
    status: "ready",
    catalog: {
      models: [
        {
          ref: modelRef,
          label: "Claude Sonnet 4.6",
          supportedThinkingOptionIds: [highThinking],
        },
      ],
      defaultModel: modelRef,
      thinkingOptions: [{ id: highThinking, label: "High" }],
      defaultThinkingOptionId: highThinking,
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: false,
        permissionModeScope: "live",
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
    },
  };

  return {
    forkThread: vi.fn(),
    handoffThread: vi.fn(async (input): Promise<ThreadHandoffResult> => ({
      threadId: hostThreadIdSchema.parse("handed-off-thread"),
      handoff: {
        ...sampleHandoff,
        sourceThreadId: input.sourceThreadId,
        targetHarnessId: input.targetHarnessId,
        ...(input.targetModel ? { targetModel: input.targetModel } : {}),
      },
    })),
    inspectHarness: vi.fn(async () => defaultHarnessInspection),
    inspectThread: vi.fn(async (): Promise<ThreadInspection> => ({ owner: "codex", locked: true })),
    listHarnessPlugins: vi.fn(async () => ({ plugins: [claudePlugin, antigravityPlugin] })),
    inspectHarnessCommands: vi.fn(),
    inspectThreadCommands: vi.fn(),
    executeThreadCommand: vi.fn(),
    inspectThreadUsage: vi.fn(),
    listThreadOwnership: vi.fn(),
    selectThreadModel: vi.fn(),
    selectThreadThinking: vi.fn(),
    selectThreadPermissionMode: vi.fn(),
    checkUpdate: vi.fn(),
    startUpdate: vi.fn(),
    readUpdateStatus: vi.fn(),
    listCodexAccounts: vi.fn(),
    refreshCodexAccounts: vi.fn(),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("RendererModelClient.handoffThread", () => {
  it("validates params and response against shared-contracts and invokes THREAD_HANDOFF_METHOD", async () => {
    const expectedResult: ThreadHandoffResult = {
      threadId: hostThreadIdSchema.parse("new-thread-9"),
      handoff: sampleHandoff,
    };
    const sendRequest = vi.fn().mockResolvedValueOnce(expectedResult);
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Expected RendererModelClient");

    const params = {
      sourceThreadId: hostThreadIdSchema.parse("source-thread-1"),
      targetHarnessId: harnessIdSchema.parse("claude-code"),
      targetModel: "claude-sonnet-4-6",
      targetThinkingOptionId: "high",
    };

    await expect(client.handoffThread(params)).resolves.toEqual(expectedResult);
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith(THREAD_HANDOFF_METHOD, params);

    await expect(
      client.handoffThread({
        sourceThreadId: "" as unknown as ReturnType<typeof hostThreadIdSchema.parse>,
        targetHarnessId: harnessIdSchema.parse("claude-code"),
      }),
    ).rejects.toThrow();
    expect(sendRequest).toHaveBeenCalledTimes(1);

    sendRequest.mockResolvedValueOnce({ threadId: "new-thread-9", handoff: { invalid: true } });
    await expect(client.handoffThread(params)).rejects.toThrow();
  });
});

describe("installRendererHandoffControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("renders top handoff divider, caches inspectThread per thread, expands preview, opens source thread, and unmounts on switch/dispose", async () => {
    const dom = createConversationDom("handed-off-1", { withTurns: true });
    const inspectThread = vi.fn(async ({ threadId }): Promise<ThreadInspection> =>
      threadId === "handed-off-1"
        ? {
            owner: "external",
            harnessId: "claude-code",
            transportModelId: "codexhost/claude-code-native",
            history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
            handoff: sampleHandoff,
            locked: true,
          }
        : { owner: "codex", locked: true },
    );
    const openThread = vi.fn(async () => undefined);
    const client = createMockClient({ inspectThread });

    const control = installRendererHandoffControl({
      getClient: () => client,
      getHostId: () => "local",
      getLocale: () => "zh-CN",
      openThread,
    });
    await flush();

    // Divider mounts right before the first turn in the transcript.
    const divider = dom.transcript.querySelector<HTMLElement>(`[${HANDOFF_DIVIDER_ATTRIBUTE}]`);
    expect(divider).not.toBeNull();
    expect(divider?.nextElementSibling?.getAttribute("data-turn-key")).toBe("turn-1");
    expect(divider?.textContent).toContain("上下文交接");
    expect(divider?.textContent).toContain("Codex (gpt-5.4)");
    expect(divider?.textContent).toContain("Claude Code (claude-sonnet-4-6)");
    expect(inspectThread).toHaveBeenCalledTimes(1);

    // Repeated refreshes for the same thread reuse the cache without re-querying inspectThread.
    control.refresh();
    await flush();
    expect(inspectThread).toHaveBeenCalledTimes(1);

    // Detail panel starts collapsed, expands on click, shows turns summary + preview, and opens source thread.
    const toggle = divider?.querySelector<HTMLButtonElement>(
      "[data-codexhost-handoff-divider-toggle]",
    );
    const detail = divider?.querySelector<HTMLElement>("[data-codexhost-handoff-detail]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(detail?.hidden).toBe(true);

    toggle?.click();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(detail?.hidden).toBe(false);
    expect(detail?.textContent).toContain("已携带 3 / 5 轮上下文");
    expect(detail?.textContent).toContain("已省略 2 轮");
    expect(detail?.querySelector("pre")?.textContent).toBe(sampleHandoff.preview);

    const openSourceBtn = detail?.querySelector<HTMLButtonElement>(
      "[data-codexhost-handoff-open-source]",
    );
    openSourceBtn?.click();
    await flush();
    expect(openThread).toHaveBeenCalledExactlyOnceWith(sampleHandoff.sourceThreadId, {
      hostId: "local",
    });

    // Switching to another thread without handoff unmounts the divider cleanly.
    dom.setThreadId("plain-codex-thread");
    control.refresh();
    await flush();
    expect(document.querySelector(`[${HANDOFF_DIVIDER_ATTRIBUTE}]`)).toBeNull();
    expect(inspectThread).toHaveBeenCalledTimes(2);

    // Switching back restores the divider from cache without another inspectThread call.
    dom.setThreadId("handed-off-1");
    control.refresh();
    await flush();
    expect(document.querySelector(`[${HANDOFF_DIVIDER_ATTRIBUTE}]`)).not.toBeNull();
    expect(inspectThread).toHaveBeenCalledTimes(2);

    // Dispose cleans up both divider and trigger control.
    control.dispose();
    expect(document.querySelector(`[${HANDOFF_DIVIDER_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelector(`[${HANDOFF_CONTROL_ATTRIBUTE}]`)).toBeNull();
  });

  it("mounts divider above composer on a newly handed-off thread with zero turns, then moves it above the first turn", async () => {
    const dom = createConversationDom("fresh-handoff-thread", { withTurns: false });
    const client = createMockClient({
      inspectThread: vi.fn(async (): Promise<ThreadInspection> => ({
        owner: "codex",
        locked: true,
        handoff: sampleHandoff,
      })),
    });

    const control = installRendererHandoffControl({
      getClient: () => client,
      getLocale: () => "en",
    });
    await flush();

    const divider = document.querySelector<HTMLElement>(`[${HANDOFF_DIVIDER_ATTRIBUTE}]`);
    expect(divider).not.toBeNull();
    expect(divider?.nextElementSibling).toBe(dom.composer);

    const firstTurn = dom.addTurn("turn-1");
    control.refresh();
    expect(divider?.nextElementSibling).toBe(firstTurn);

    control.dispose();
  });

  it("triggers handoff popover, loads Harness & Model options, calls handoffThread, and opens the new thread", async () => {
    const dom = createConversationDom("source-codex-thread", {
      withTurns: true,
      externalControls: true,
    });
    const openThread = vi.fn(async () => undefined);
    const handoffResult: ThreadHandoffResult = {
      threadId: hostThreadIdSchema.parse("derived-handoff-thread"),
      handoff: {
        ...sampleHandoff,
        sourceThreadId: hostThreadIdSchema.parse("source-codex-thread"),
        targetHarnessId: harnessIdSchema.parse("claude-code"),
        targetModel: "claude-sonnet-4-6",
      },
    };
    const handoffThread = vi.fn(async () => handoffResult);
    const client = createMockClient({ handoffThread });

    const control = installRendererHandoffControl({
      getClient: () => client,
      getHostId: () => "local",
      getLocale: () => "en",
      openThread,
    });
    await flush();

    const trigger = dom.composer.querySelector<HTMLButtonElement>(
      "[data-codexhost-handoff-trigger]",
    );
    expect(trigger).not.toBeNull();
    // Placed before existing owned controls in the Composer footer toolbar.
    expect(
      trigger?.parentElement?.nextElementSibling?.hasAttribute("data-codexhost-agent-control"),
    ).toBe(true);

    trigger?.click();
    await flush();

    const popover = document.querySelector<HTMLElement>(`[${HANDOFF_POPOVER_ATTRIBUTE}]`);
    expect(popover).not.toBeNull();

    const claudeOption = popover?.querySelector<HTMLButtonElement>(
      'button[data-harness-id="claude-code"]',
    );
    expect(claudeOption).not.toBeNull();
    claudeOption?.click();
    await flush();

    const modelSelect = popover?.querySelector<HTMLSelectElement>(
      "[data-codexhost-handoff-model-select]",
    );
    expect(modelSelect).not.toBeNull();
    if (modelSelect) {
      modelSelect.value = "claude-sonnet-4-6";
      modelSelect.dispatchEvent(new Event("change"));
    }

    const thinkingSelect = popover?.querySelector<HTMLSelectElement>(
      "[data-codexhost-handoff-thinking-select]",
    );
    expect(thinkingSelect).not.toBeNull();
    if (thinkingSelect) {
      thinkingSelect.value = "high";
      thinkingSelect.dispatchEvent(new Event("change"));
    }

    const confirmBtn = popover?.querySelector<HTMLButtonElement>(
      "[data-codexhost-handoff-confirm]",
    );
    confirmBtn?.click();
    await flush();

    expect(handoffThread).toHaveBeenCalledExactlyOnceWith({
      sourceThreadId: "source-codex-thread",
      targetHarnessId: "claude-code",
      targetModel: "claude-sonnet-4-6",
      targetThinkingOptionId: "high",
    });
    expect(openThread).toHaveBeenCalledExactlyOnceWith("derived-handoff-thread", {
      hostId: "local",
    });
    expect(document.querySelector(`[${HANDOFF_POPOVER_ATTRIBUTE}]`)).toBeNull();

    control.dispose();
  });

  it("displays an inline error alert inside the popover when handoffThread rejects", async () => {
    createConversationDom("source-err-thread", { withTurns: true });
    const openThread = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const client = createMockClient({
      handoffThread: vi.fn(async () => {
        throw new Error("Target harness is offline");
      }),
    });

    const control = installRendererHandoffControl({
      getClient: () => client,
      getLocale: () => "zh-CN",
      openThread,
      reportError,
    });
    await flush();

    document.querySelector<HTMLButtonElement>("[data-codexhost-handoff-trigger]")?.click();
    await flush();

    document.querySelector<HTMLButtonElement>("[data-codexhost-handoff-confirm]")?.click();
    await flush();

    const popover = document.querySelector<HTMLElement>(`[${HANDOFF_POPOVER_ATTRIBUTE}]`);
    expect(popover).not.toBeNull();
    const alert = popover?.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("上下文交接失败");
    expect(alert?.textContent).toContain("Target harness is offline");
    expect(openThread).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledOnce();

    control.dispose();
    expect(document.querySelector(`[${HANDOFF_POPOVER_ATTRIBUTE}]`)).toBeNull();
  });

  it("fails closed when an explicit hostId is missing from clientForHost instead of falling back to base", async () => {
    createConversationDom("remote-thread-1", { withTurns: true });
    const inspectThread = vi.fn(async (): Promise<ThreadInspection> => ({
      owner: "codex",
      locked: true,
    }));
    const handoffThread = vi.fn();
    const clientForHost = vi.fn(() => null);
    const client = createMockClient({
      inspectThread,
      handoffThread,
      clientForHost,
    });

    const control = installRendererHandoffControl({
      getClient: () => client,
      getHostId: () => "ssh-remote-offline",
      getLocale: () => "en",
    });
    await flush();

    // Must not fall back to base client for inspectThread when clientForHost returns null.
    expect(clientForHost).toHaveBeenCalledWith("ssh-remote-offline");
    expect(inspectThread).not.toHaveBeenCalled();

    // Opening the popover and confirming must also fail closed without invoking base.handoffThread.
    document.querySelector<HTMLButtonElement>("[data-codexhost-handoff-trigger]")?.click();
    await flush();
    document.querySelector<HTMLButtonElement>("[data-codexhost-handoff-confirm]")?.click();
    await flush();

    expect(handoffThread).not.toHaveBeenCalled();
    const alert = document.querySelector<HTMLElement>(
      `[${HANDOFF_POPOVER_ATTRIBUTE}] [role="alert"]`,
    );
    expect(alert).not.toBeNull();

    control.dispose();
  });

  it("keeps the popover open with an inline error when openThread fails and retries opening without duplicating handoff", async () => {
    createConversationDom("source-open-fail", { withTurns: true });
    let shouldFailOpen = true;
    const openThread = vi.fn(async () => {
      if (shouldFailOpen) throw new Error("Sidebar row not ready");
    });
    const handoffThread = vi.fn(async (): Promise<ThreadHandoffResult> => ({
      threadId: hostThreadIdSchema.parse("created-once-thread"),
      handoff: sampleHandoff,
    }));
    const client = createMockClient({ handoffThread });

    const control = installRendererHandoffControl({
      getClient: () => client,
      getLocale: () => "en",
      openThread,
    });
    await flush();

    document.querySelector<HTMLButtonElement>("[data-codexhost-handoff-trigger]")?.click();
    await flush();
    document.querySelector<HTMLButtonElement>("[data-codexhost-handoff-confirm]")?.click();
    await flush();

    // Popover stays open with inline error so user can retry opening the already-created thread.
    const popover = document.querySelector<HTMLElement>(`[${HANDOFF_POPOVER_ATTRIBUTE}]`);
    expect(popover).not.toBeNull();
    expect(popover?.querySelector('[role="alert"]')?.textContent).toContain(
      "Sidebar row not ready",
    );
    expect(handoffThread).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledTimes(1);

    // Retrying confirm calls openThread again without creating a second handoff thread.
    shouldFailOpen = false;
    popover?.querySelector<HTMLButtonElement>("[data-codexhost-handoff-confirm]")?.click();
    await flush();

    expect(handoffThread).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledTimes(2);
    expect(document.querySelector(`[${HANDOFF_POPOVER_ATTRIBUTE}]`)).toBeNull();

    control.dispose();
  });

  it("formats full, prefix-boundary, and omitted turn summaries accurately in zh-CN and en", () => {
    expect(
      formatRendererHandoffTurnsSummary("zh-CN", {
        includedCount: 5,
        totalTurns: 5,
        omittedTurns: 0,
        boundaryTurnNumber: 5,
      }),
    ).toBe("已携带全部 5 轮上下文");
    expect(
      formatRendererHandoffTurnsSummary("en", {
        includedCount: 5,
        totalTurns: 5,
        omittedTurns: 0,
        boundaryTurnNumber: 5,
      }),
    ).toBe("Carried all 5 turns");

    expect(
      formatRendererHandoffTurnsSummary("zh-CN", {
        includedCount: 3,
        totalTurns: 5,
        omittedTurns: 0,
        boundaryTurnNumber: 3,
      }),
    ).toBe("已携带前 3 / 5 轮上下文");
    expect(
      formatRendererHandoffTurnsSummary("en", {
        includedCount: 3,
        totalTurns: 5,
        omittedTurns: 0,
        boundaryTurnNumber: 3,
      }),
    ).toBe("Carried first 3 of 5 turns");

    expect(
      formatRendererHandoffTurnsSummary("zh-CN", {
        includedCount: 3,
        totalTurns: 5,
        omittedTurns: 2,
        boundaryTurnNumber: 4,
      }),
    ).toBe("已携带 3 / 5 轮上下文（已省略 2 轮，截至第 4 轮）");
    expect(
      formatRendererHandoffTurnsSummary("en", {
        includedCount: 3,
        totalTurns: 5,
        omittedTurns: 2,
        boundaryTurnNumber: 4,
      }),
    ).toBe("Carried 3 of 5 turns (2 omitted, up to turn 4)");
  });
});
