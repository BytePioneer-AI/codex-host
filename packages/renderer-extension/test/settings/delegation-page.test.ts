import {
  officialCodexModelRef,
  harnessModelRefKey,
  type HarnessModelRef,
  harnessIdSchema,
  harnessModelRefIdSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessDelegationDefault,
  type HarnessInspection,
  type HarnessPreferencePatch,
  type HarnessPreferenceSnapshot,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => ({ classList: { add() {} } }),
  isRendererSettingsIconName: () => true,
}));

import { createAgentGroupPreferenceStore } from "../../src/agent-group-preference.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import {
  createDelegationSettingsPage,
  type RendererDelegationClient,
} from "../../src/settings/delegation-page.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import {
  createDefaultRendererSettingsPages,
  type RendererConnectionDiagnostics,
  type RendererConnectionSnapshot,
} from "../../src/settings/pages.js";
import { pluginDescriptor } from "../../../../tests/fixtures/harness-plugin-descriptors.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly #listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly #classes = new Set<string>();
  hidden = false;
  textContent = "";
  title = "";
  type = "";
  value = "";
  id = "";
  disabled = false;
  parent: FakeElement | undefined;

  readonly classList = {
    add: (...names: string[]) => {
      for (const name of names) if (name) this.#classes.add(name);
    },
    remove: (...names: string[]) => {
      for (const name of names) this.#classes.delete(name);
    },
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.#classes.has(name);
      if (next) this.#classes.add(name);
      else this.#classes.delete(name);
      return next;
    },
    contains: (name: string) => this.#classes.has(name),
  };

  get className(): string {
    return [...this.#classes].join(" ");
  }

  set className(value: string) {
    this.#classes.clear();
    for (const part of value.split(/\s+/u)) {
      if (part) this.#classes.add(part);
    }
  }

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    const existing = this.#listeners.get(name) ?? [];
    existing.push(listener);
    this.#listeners.set(name, existing);
  }

  removeEventListener(name: string, listener: (event?: unknown) => void): void {
    const existing = this.#listeners.get(name);
    if (!existing) return;
    const index = existing.indexOf(listener);
    if (index >= 0) existing.splice(index, 1);
  }

  dispatch(name: string, event?: unknown): void {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) {
      listener(event);
    }
  }

  remove(): void {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.parent = undefined;
  }

  append(...children: unknown[]): void {
    for (const child of children) {
      if (child instanceof FakeElement) {
        child.remove();
        child.parent = this;
      }
    }
    this.children.push(...children);
  }

  insertBefore(node: unknown, reference: unknown): unknown {
    if (node instanceof FakeElement) {
      node.remove();
      node.parent = this;
    }
    if (reference === null || reference === undefined) {
      this.children.push(node);
      return node;
    }
    const index = this.children.indexOf(reference);
    if (index >= 0) this.children.splice(index, 0, node);
    else this.children.push(node);
    return node;
  }

  replaceChildren(...children: unknown[]): void {
    for (const existing of this.children) {
      if (existing instanceof FakeElement) existing.parent = undefined;
    }
    this.children.length = 0;
    this.append(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/gu, (_, ch: string) => ch.toUpperCase());
      return this.dataset[key] ?? this.attributes.get(name) ?? null;
    }
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  readonly clipboardWriteText = vi.fn(async () => undefined);
  readonly timers: Array<() => void> = [];
  readonly defaultView: Window;

  constructor() {
    this.defaultView = {
      navigator: {
        clipboard: { writeText: this.clipboardWriteText },
      },
      setTimeout: vi.fn((fn: () => void) => {
        this.timers.push(fn);
        return this.timers.length;
      }),
      clearTimeout: vi.fn(),
    } as unknown as Window;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (!(node instanceof FakeElement)) return "";
  if (node.children.length === 0) return node.textContent;
  return node.children.map(textOf).filter(Boolean).join("");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDiagnostics(snapshot: RendererConnectionSnapshot): {
  diagnostics: RendererConnectionDiagnostics;
  emit(next: RendererConnectionSnapshot): void;
} {
  let current = snapshot;
  const listeners = new Set<() => void>();
  return {
    diagnostics: {
      snapshot: () => current,
      refresh: async () => undefined,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(next) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

function readyInspection(options: {
  models: Array<{
    id: string;
    label: string;
    fastModel?: HarnessModelRef;
    supportedThinking?: string[];
  }>;
  defaultModelId?: string;
  thinkingOptions?: Array<{ id: string; label: string }>;
  selectThinkingOption: boolean;
}): HarnessInspection {
  return {
    status: "ready",
    catalog: {
      models: options.models.map((m) => ({
        ref: { id: harnessModelRefIdSchema.parse(m.id) },
        label: m.label,
        ...(m.fastModel ? { fastModel: m.fastModel } : {}),
        ...(m.supportedThinking !== undefined
          ? {
              supportedThinkingOptionIds: m.supportedThinking.map((id) =>
                harnessThinkingOptionIdSchema.parse(id),
              ),
            }
          : {}),
      })),
      ...(options.defaultModelId
        ? { defaultModel: { id: harnessModelRefIdSchema.parse(options.defaultModelId) } }
        : {}),
      thinkingOptions: (options.thinkingOptions ?? []).map((opt) => ({
        id: harnessThinkingOptionIdSchema.parse(opt.id),
        label: opt.label,
      })),
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: options.selectThinkingOption,
        selectPermissionMode: false,
        permissionModeScope: "live",
      },
      history: {
        fork: false,
        forkAcrossCwd: false,
        rollbackLastTurn: false,
      },
    },
  };
}

function preferenceSnapshot(
  byHarness: Record<string, HarnessDelegationDefault>,
  revision = 1,
): HarnessPreferenceSnapshot {
  return {
    scope: "external",
    revision,
    values: {
      favorites: {},
      ...(Object.keys(byHarness).length > 0 ? { delegation: { byHarness } } : {}),
    },
  };
}

function rowFor(content: FakeElement, harnessId: string): FakeElement {
  const row = descendants(content).find(
    (el) => el.classList.contains("settings-delegation__row") && el.dataset.harnessId === harnessId,
  );
  if (!row) throw new Error(`Missing row for ${harnessId}`);
  return row;
}

function selectIn(row: FakeElement, control: "model" | "thinking"): FakeElement {
  const select = descendants(row).find((el) => el.dataset.delegationControl === control);
  if (!select) throw new Error(`Missing ${control} select`);
  return select;
}

function selectOptionLabels(select: FakeElement): string[] {
  return select.children
    .filter(
      (child): child is FakeElement => child instanceof FakeElement && child.tagName === "option",
    )
    .map((option) => option.textContent);
}

describe("Delegation settings page", () => {
  const baseSnapshot = (): RendererConnectionSnapshot => ({
    adapter: { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
    hosts: [
      {
        hostId: "local",
        active: true,
        agents: [
          {
            agent: "claude-code",
            plugin: pluginDescriptor("claude-code"),
            availability: "ready",
            error: null,
          },
          {
            agent: "grok",
            plugin: pluginDescriptor("grok"),
            availability: "ready",
            error: null,
          },
          {
            agent: "pi",
            plugin: pluginDescriptor("pi"),
            availability: "notInstalled",
            error: null,
          },
          {
            agent: "opencode",
            plugin: pluginDescriptor("opencode"),
            availability: "unavailable",
            error: null,
          },
        ],
      },
      {
        hostId: "ssh:remote",
        active: false,
        agents: [
          {
            agent: "antigravity",
            plugin: pluginDescriptor("antigravity"),
            availability: "ready",
            error: null,
          },
        ],
      },
    ],
  });

  it("is registered in default settings pages for both zh-CN and en", () => {
    const zhPage = createDefaultRendererSettingsPages(rendererSettingsMessages("zh-CN")).find(
      ({ id }) => id === "delegation",
    );
    const enPage = createDefaultRendererSettingsPages(rendererSettingsMessages("en")).find(
      ({ id }) => id === "delegation",
    );
    expect(zhPage?.label).toBe("多 Agent 协作");
    expect(enPage?.label).toBe("Multi-Agent");
    expect(zhPage?.icon).toBe("delegation");
  });

  it("renders only codex + local ready harnesses and performs zero inspectHarness calls on mount", async () => {
    const { diagnostics } = makeDiagnostics(baseSnapshot());
    const inspectHarness = vi.fn();
    const getHarnessPreferences = vi.fn(async () => preferenceSnapshot({}));
    const client: RendererDelegationClient = {
      getHarnessPreferences,
      patchHarnessPreferences: vi.fn(async () => preferenceSnapshot({})),
      subscribeHarnessPreferences: vi.fn(() => () => {}),
      inspectHarness,
    };

    const doc = new FakeDocument();
    const content = doc.createElement("main");
    const scope = new RendererSettingsPageScope();
    const page = createDelegationSettingsPage(
      rendererSettingsMessages("zh-CN"),
      () => diagnostics,
      () => client,
      createAgentGroupPreferenceStore(null),
    );
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (op, handlers) => scope.runLatest(op, handlers),
    });

    await vi.waitFor(() => expect(getHarnessPreferences).toHaveBeenCalledTimes(1));
    expect(inspectHarness).not.toHaveBeenCalled();

    const rows = descendants(content).filter((el) =>
      el.classList.contains("settings-delegation__row"),
    );
    expect(rows.map((row) => row.dataset.harnessId)).toEqual(["codex", "claude-code", "grok"]);

    const codexRow = rowFor(content, "codex");
    expect(selectOptionLabels(selectIn(codexRow, "model"))).toEqual(["跟随 Agent 默认"]);
    expect(textOf(codexRow)).toContain("跟随 Agent 默认");

    cleanup?.();
    scope.dispose();
  });

  it("loads catalog on demand when interacting with a dropdown, hides thinking when unsupported, and clears incompatible thinking on model switch", async () => {
    const { diagnostics } = makeDiagnostics(baseSnapshot());
    const base = officialCodexModelRef("gpt-5.4");
    const fast = officialCodexModelRef("gpt-5.4", "priority");
    const mini = officialCodexModelRef("gpt-5.4-mini");
    const native = harnessModelRefSchema.parse({ id: "provider/模型@preview" });
    const savedState: Record<string, HarnessDelegationDefault> = {
      codex: { model: fast },
      grok: { model: native },
    };
    let revision = 1;

    const inspectHarness = vi.fn(async ({ harnessId }: { harnessId: string }) => {
      if (harnessId === "codex") {
        return readyInspection({
          models: [
            {
              id: base.id,
              label: "GPT-5.4",
              fastModel: fast,
              supportedThinking: ["low", "high"],
            },
            { id: mini.id, label: "GPT-5.4 Mini", supportedThinking: ["low"] },
          ],
          defaultModelId: base.id,
          thinkingOptions: [
            { id: "low", label: "低" },
            { id: "high", label: "高" },
          ],
          selectThinkingOption: true,
        });
      }
      return readyInspection({
        models: [
          { id: "grok-4", label: "Grok 4" },
          { id: native.id, label: "Grok Preview" },
        ],
        defaultModelId: "grok-4",
        selectThinkingOption: false,
      });
    });

    const patchHarnessPreferences = vi.fn(async (patch: HarnessPreferencePatch) => {
      for (const op of patch.operations) {
        if (op.kind === "delegation") {
          if (op.configuration) savedState[op.harnessId] = op.configuration;
          else Reflect.deleteProperty(savedState, op.harnessId);
        }
      }
      revision += 1;
      return preferenceSnapshot({ ...savedState }, revision);
    });

    const client: RendererDelegationClient = {
      getHarnessPreferences: vi.fn(async () => preferenceSnapshot({ ...savedState }, revision)),
      patchHarnessPreferences,
      subscribeHarnessPreferences: vi.fn(() => () => {}),
      inspectHarness,
    };

    const doc = new FakeDocument();
    const content = doc.createElement("main");
    const scope = new RendererSettingsPageScope();
    const page = createDelegationSettingsPage(
      rendererSettingsMessages("zh-CN"),
      () => diagnostics,
      () => client,
      createAgentGroupPreferenceStore(null),
    );
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (op, handlers) => scope.runLatest(op, handlers),
    });

    const codexRow = rowFor(content, "codex");
    const codexModel = selectIn(codexRow, "model");
    const codexThinking = selectIn(codexRow, "thinking");

    const codexLane = descendants(content).find(
      (el) =>
        el.classList.contains("settings-delegation__lane") && el.dataset.harnessId === "codex",
    );
    await vi.waitFor(() => expect(selectOptionLabels(codexModel)).toContain("gpt-5.4 · Fast"));
    expect(codexModel.value).toBe(harnessModelRefKey(fast));
    expect(textOf(codexRow)).toContain("当前生效：gpt-5.4 · Fast");
    expect(textOf(codexLane)).toContain("gpt-5.4 · Fast");
    expect(textOf(rowFor(content, "grok"))).toContain(`当前生效：${native.id}`);
    expect(inspectHarness).not.toHaveBeenCalled();

    codexModel.dispatch("focus");
    codexModel.dispatch("mousedown");
    await vi.waitFor(() =>
      expect(selectOptionLabels(codexModel)).toEqual([
        "跟随 Agent 默认",
        "GPT-5.4",
        "GPT-5.4 Mini",
        "GPT-5.4 · Fast",
      ]),
    );
    expect(textOf(codexRow)).toContain("当前生效：GPT-5.4 · Fast");
    expect(textOf(codexLane)).toContain("GPT-5.4 · Fast");
    expect(inspectHarness).toHaveBeenCalledTimes(1);
    expect(inspectHarness).toHaveBeenCalledWith({
      harnessId: harnessIdSchema.parse("codex"),
      credentialAccess: "allow",
    });
    expect(codexThinking.parent?.hidden).toBe(false);
    expect(selectOptionLabels(codexThinking)).toEqual(["默认强度", "低", "高"]);

    // Select model + thinking -> persists kind: "delegation" and updates hero diagram model label.
    codexModel.value = base.id;
    codexModel.dispatch("change");
    await vi.waitFor(() => expect(patchHarnessPreferences).toHaveBeenCalledTimes(1));

    codexThinking.value = "high";
    codexThinking.dispatch("change");
    await vi.waitFor(() => expect(patchHarnessPreferences).toHaveBeenCalledTimes(2));
    expect(patchHarnessPreferences).toHaveBeenLastCalledWith({
      scope: "external",
      operations: [
        {
          kind: "delegation",
          harnessId: "codex",
          configuration: { model: base, thinkingOptionId: "high" },
        },
      ],
    });
    expect(textOf(codexRow)).toContain("GPT-5.4 · 高");

    expect(textOf(codexLane)).toContain("GPT-5.4 · 高");

    // Switching to gpt-5.4-mini (only supports "low") drops incompatible "high" thinking automatically.
    codexModel.value = mini.id;
    codexModel.dispatch("change");
    await vi.waitFor(() => expect(patchHarnessPreferences).toHaveBeenCalledTimes(3));
    expect(patchHarnessPreferences).toHaveBeenLastCalledWith({
      scope: "external",
      operations: [
        {
          kind: "delegation",
          harnessId: "codex",
          configuration: { model: mini },
        },
      ],
    });
    expect(selectOptionLabels(codexThinking)).toEqual(["默认强度", "低"]);

    // Clicking Reset writes configuration: null and restores "跟随 Agent 默认".
    const resetButton = descendants(codexRow).find((el) => el.dataset.delegationAction === "reset");
    if (!resetButton) throw new Error("Expected reset button");
    resetButton.dispatch("click");
    await vi.waitFor(() => expect(patchHarnessPreferences).toHaveBeenCalledTimes(4));
    expect(patchHarnessPreferences).toHaveBeenLastCalledWith({
      scope: "external",
      operations: [{ kind: "delegation", harnessId: "codex", configuration: null }],
    });
    expect(textOf(codexRow)).toContain("跟随 Agent 默认");

    // Grok has selectThinkingOption: false -> hides thinking dropdown after on-demand inspect.
    const grokRow = rowFor(content, "grok");
    const grokModel = selectIn(grokRow, "model");
    const grokThinking = selectIn(grokRow, "thinking");
    grokModel.dispatch("focus");
    await vi.waitFor(() =>
      expect(selectOptionLabels(grokModel)).toEqual(["跟随 Agent 默认", "Grok 4", "Grok Preview"]),
    );
    expect(grokModel.value).toBe(native.id);
    expect(textOf(rowFor(content, "grok"))).toContain("当前生效：Grok Preview");
    expect(grokThinking.parent?.hidden).toBe(true);

    cleanup?.();
    scope.dispose();
  });

  it("syncs external preference updates, retries failed catalog loads, and ignores stale responses after unmount", async () => {
    const { diagnostics } = makeDiagnostics(baseSnapshot());
    const subscription: { listener: (() => void) | null } = { listener: null };
    let remoteState: Record<string, HarnessDelegationDefault> = {};

    const pendingCodex = deferred<HarnessInspection>();
    const inspectHarness = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(
        readyInspection({
          models: [{ id: "sonnet-4-6", label: "Sonnet 4.6" }],
          defaultModelId: "sonnet-4-6",
          selectThinkingOption: false,
        }),
      )
      .mockImplementationOnce(() => pendingCodex.promise);

    const client: RendererDelegationClient = {
      getHarnessPreferences: vi.fn(async () => preferenceSnapshot(remoteState)),
      patchHarnessPreferences: vi.fn(async () => preferenceSnapshot(remoteState)),
      subscribeHarnessPreferences: vi.fn((cb) => {
        subscription.listener = cb;
        return () => {
          subscription.listener = null;
        };
      }),
      inspectHarness,
    };

    const doc = new FakeDocument();
    const content = doc.createElement("main");
    const scope = new RendererSettingsPageScope();
    const page = createDelegationSettingsPage(
      rendererSettingsMessages("en"),
      () => diagnostics,
      () => client,
      createAgentGroupPreferenceStore(null),
    );
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (op, handlers) => scope.runLatest(op, handlers),
    });

    // External update via subscription reflects immediately in the row.
    remoteState = {
      "claude-code": { model: { id: harnessModelRefIdSchema.parse("sonnet-4-6") } },
    };
    if (!subscription.listener) throw new Error("Expected a preference subscription");
    subscription.listener();
    const claudeRow = rowFor(content, "claude-code");
    await vi.waitFor(() => expect(textOf(claudeRow)).toContain("sonnet-4-6"));

    // First inspect fails -> inline Retry button reloads and resolves model label.
    const claudeModel = selectIn(claudeRow, "model");
    claudeModel.dispatch("focus");
    await vi.waitFor(() => expect(textOf(claudeRow)).toContain("Could not load models."));
    const retryBtn = descendants(claudeRow).find((el) =>
      el.classList.contains("settings-delegation__retry-link"),
    );
    if (!retryBtn) throw new Error("Expected retry button");
    retryBtn.dispatch("click");
    await vi.waitFor(() => expect(textOf(claudeRow)).toContain("Sonnet 4.6"));

    // Start codex inspect, then unmount before it resolves -> late resolution is ignored cleanly.
    const codexRow = rowFor(content, "codex");
    selectIn(codexRow, "model").dispatch("focus");
    cleanup?.();
    scope.dispose();
    expect(subscription.listener).toBeNull();

    pendingCodex.resolve(
      readyInspection({
        models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
        selectThinkingOption: false,
      }),
    );
    await Promise.resolve();
    expect(selectOptionLabels(selectIn(codexRow, "model"))).toEqual([
      "Follow Agent default",
      "Loading models…",
    ]);
  });

  it("copies and cycles the # delegation quick-start example", async () => {
    const { diagnostics } = makeDiagnostics(baseSnapshot());
    const doc = new FakeDocument();
    const content = doc.createElement("main");
    const scope = new RendererSettingsPageScope();
    const page = createDelegationSettingsPage(
      rendererSettingsMessages("zh-CN"),
      () => diagnostics,
      () => null,
      createAgentGroupPreferenceStore(null),
    );
    const cleanup = page.mount({
      content: content as unknown as HTMLElement,
      signal: scope.signal,
      runLatest: (op, handlers) => scope.runLatest(op, handlers),
    });

    const trigger = descendants(content).find((el) =>
      el.classList.contains("settings-delegation__demo-trigger"),
    );
    if (!trigger) throw new Error("Expected demo trigger");
    expect(textOf(trigger)).toContain("#codex");

    trigger.dispatch("click");
    await vi.waitFor(() =>
      expect(doc.clipboardWriteText).toHaveBeenCalledWith("#codex 审查这次改动"),
    );
    expect(textOf(trigger)).toContain("已复制");

    // Advance copy timer -> cycles to next ready agent example.
    doc.timers.pop()?.();
    expect(textOf(trigger)).toContain("#claude-code");

    cleanup?.();
    scope.dispose();
  });
});
