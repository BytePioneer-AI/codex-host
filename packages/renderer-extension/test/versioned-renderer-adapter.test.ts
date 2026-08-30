import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CODE_TRANSPORT_MODEL_ID,
  DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID,
  GROK_TRANSPORT_MODEL_ID,
  PI_TRANSPORT_MODEL_ID,
  activeRendererDraftPrewarmPolicy,
  claudeTransportModelId,
  decodeClaudeTransportModelId,
  decodeDeepSeekHarnessTransportModelId,
  decodeGrokTransportModelId,
  decodePiTransportModelId,
  findActivePrewarmTargets,
  findComposerModelTarget,
  isClaudeTransportModelId,
  isGrokTransportModelId,
  isPiTransportModelId,
  isDraftPrewarmPolicyReady,
  isMainProcessTitlePolicyReady,
  modelSelectionForAgent,
  deepSeekHarnessTransportModelId,
  grokTransportModelId,
  piTransportModelId,
  threadIdFromComposerModelTarget,
} from "../src/index.js";
import {
  createRendererRequestRouteResolver,
  rendererRequestTargetsForHost,
  resolveRendererRequestRoute,
  transitionRendererAdapterStatus,
} from "../src/versioned-renderer-adapter.js";

function composerWithFiber(fiber: object): Element {
  const composer = { matches: () => true, parentElement: null } as unknown as Element;
  Object.defineProperty(composer, "__reactFiber$test", {
    configurable: true,
    value: fiber,
  });
  return composer;
}

function addComposerPortal(composer: Element, conversationId?: string): void {
  const portal = {
    hasAttribute: (name: string) => name === "data-above-composer-portal",
    getAttribute: (name: string) =>
      name === "data-above-composer-conversation-id" ? (conversationId ?? null) : null,
  } as unknown as Element;
  Object.defineProperty(composer, "children", {
    configurable: true,
    value: [portal],
  });
}

describe("current Codex Renderer Agent adapter", () => {
  it("publishes only semantic Adapter status transitions", () => {
    const status = {
      state: "installing" as const,
      reason: "installing" as const,
      modelUpdates: 0,
      hook: null,
    };
    const publish = vi.fn();
    const ready = {
      state: "ready" as const,
      reason: "ready" as const,
      hook: "request-bridge" as const,
    };

    expect(transitionRendererAdapterStatus(status, ready, publish)).toBe(true);
    expect(transitionRendererAdapterStatus(status, ready, publish)).toBe(false);
    expect(status).toEqual({ ...ready, modelUpdates: 0 });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("keeps the outer manager so Usage notifications stay attached after wrapping", () => {
    const editor = {
      parentElement: null,
      querySelectorAll: () => [],
    } as unknown as Element;
    const root = { querySelector: () => editor } as unknown as ParentNode;
    const addNotificationCallback = vi.fn(() => () => undefined);
    const requestClient = {
      hostId: "remote-ssh-discovered:mac",
      sendRequest: vi.fn<(method: string, params: unknown) => void>(),
      prewarmThreadStart: () => undefined,
      enqueueRequest: () => undefined,
    };
    const manager = {
      requestClient,
      sendRequest: async (method: string, params: unknown) =>
        requestClient.sendRequest(method, params),
      addNotificationCallback,
    };
    Object.defineProperty(editor, "__reactFiber$test", {
      configurable: true,
      value: { memoizedState: { memoizedState: manager, next: null }, return: null },
    });

    expect(findActivePrewarmTargets(root)).toEqual([manager]);
    expect(findActivePrewarmTargets(root)[0]?.addNotificationCallback).toBe(
      addNotificationCallback,
    );
  });

  it("keeps local and remote request targets independently addressable", () => {
    const local = {
      hostId: "local",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };
    const remote = {
      hostId: "remote-ssh-discovered:mac",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };

    expect(rendererRequestTargetsForHost([remote, local], "local")).toEqual([local]);
    expect(rendererRequestTargetsForHost([remote, local], remote.hostId)).toEqual([remote]);
    expect(rendererRequestTargetsForHost([local, { ...local }], "local")).toBeNull();
  });

  it("retains the confirmed request manager across transient Composer discovery gaps", () => {
    const manager = {
      hostId: "remote-ssh-discovered:mac",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };
    const policy = {
      state: "ready" as const,
      hostId: "remote-ssh-discovered:mac",
      select: vi.fn(() => true),
      clear: vi.fn(async () => undefined),
    };
    const localManager = {
      hostId: "local",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };

    const discovered = resolveRendererRequestRoute(policy, [localManager, manager], null);
    expect(discovered?.targets).toEqual([manager]);

    const transientGap = resolveRendererRequestRoute(policy, [], discovered);
    expect(transientGap).toBe(discovered);

    const switchedHostManager = {
      hostId: "remote-ssh-discovered:replacement",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };
    expect(resolveRendererRequestRoute(policy, [switchedHostManager], discovered)).toBeNull();

    const replacementPolicy = { ...policy };
    expect(resolveRendererRequestRoute(replacementPolicy, [], discovered)).toBeNull();
  });

  it("prefers a policy-owned exact request target without Composer discovery", () => {
    const manager = {
      hostId: "remote-ssh-discovered:mac",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };
    const policy = {
      state: "ready" as const,
      hostId: manager.hostId,
      requestTarget: vi.fn(() => manager),
      select: vi.fn(() => true),
      clear: vi.fn(async () => undefined),
    };

    const route = resolveRendererRequestRoute(policy, [], null);

    expect(route).toEqual({ policy, targets: [manager] });
    expect(policy.requestTarget).toHaveBeenCalledOnce();

    const discoverTargets = vi.fn(() => [manager]);
    const resolver = createRendererRequestRouteResolver(() => policy, discoverTargets);
    expect(resolver.resolve()?.targets).toEqual([manager]);
    expect(discoverTargets).not.toHaveBeenCalled();
  });

  it.each([
    ["non-callable", {}],
    ["malformed", () => ({})],
    [
      "host-mismatched",
      () => ({
        hostId: "remote-ssh-discovered:other",
        sendRequest: vi.fn(),
        prewarmThreadStart: vi.fn(),
        enqueueRequest: vi.fn(),
      }),
    ],
    [
      "throwing",
      () => {
        throw new Error("synthetic target failure");
      },
    ],
  ])("fails closed for a %s policy-owned request target", (_name, requestTarget) => {
    const matchingDiscoveredManager = {
      hostId: "remote-ssh-discovered:mac",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };
    const policy = {
      state: "ready" as const,
      hostId: matchingDiscoveredManager.hostId,
      requestTarget,
      select: vi.fn(() => true),
      clear: vi.fn(async () => undefined),
    };

    expect(resolveRendererRequestRoute(policy, [matchingDiscoveredManager], null)).toBeNull();
  });

  it("keeps Fiber discovery as the fallback for a legacy policy without requestTarget", () => {
    const manager = {
      hostId: "remote-ssh-discovered:mac",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };
    const policy = {
      state: "ready" as const,
      hostId: manager.hostId,
      select: vi.fn(() => true),
      clear: vi.fn(async () => undefined),
    };

    expect(resolveRendererRequestRoute(policy, [manager], null)).toEqual({
      policy,
      targets: [manager],
    });
  });

  it("does not revive an invalidated request manager after a later discovery gap", () => {
    const policy = {
      state: "ready" as const,
      hostId: "remote-ssh-discovered:mac",
      select: vi.fn(() => true),
      clear: vi.fn(async () => undefined),
    };
    const manager = {
      hostId: policy.hostId,
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };
    const switchedHostManager = {
      hostId: "remote-ssh-discovered:replacement",
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    };
    let discoveredTargets = [manager];
    const routeResolver = createRendererRequestRouteResolver(
      () => policy,
      () => discoveredTargets,
    );

    expect(routeResolver.resolve()?.targets).toEqual([manager]);
    discoveredTargets = [switchedHostManager];
    expect(routeResolver.resolve()).toBeNull();
    discoveredTargets = [];
    expect(routeResolver.resolve()).toBeNull();
  });

  it("finds the current seven-slot new Thread draft identity", () => {
    const wrapper = { isManuallyChanged: false, modelSettings: null, serviceTier: null };
    const draftAtom = { get: vi.fn(() => wrapper) };
    const composer = composerWithFiber({
      updateQueue: {
        memoCache: {
          data: [
            [
              {},
              { resolve: vi.fn(), scope: {}, kind: "value", read: vi.fn() },
              "client-new-thread:opaque",
              draftAtom,
              undefined,
              draftAtom,
              draftAtom,
            ],
          ],
        },
      },
      return: null,
    });

    expect(findComposerModelTarget(composer)).toEqual(["default", "client-new-thread:opaque"]);
  });

  it("uses the current Composer conversation identity", () => {
    const composer = composerWithFiber({
      memoizedProps: { conversationId: "thread-1" },
      return: null,
    });

    expect(findComposerModelTarget(composer)).toEqual(["conversation", "thread-1"]);
  });

  it("keeps a remote client Thread mutable when an ancestor exposes a prewarm identity", () => {
    const wrapper = { isManuallyChanged: false, modelSettings: null, serviceTier: null };
    const draftAtom = { get: vi.fn(() => wrapper) };
    const composer = composerWithFiber({
      updateQueue: {
        memoCache: {
          data: [
            [
              {},
              { resolve: vi.fn(), scope: {}, kind: "value", read: vi.fn() },
              "client-new-thread:remote-draft",
              draftAtom,
              undefined,
              draftAtom,
              draftAtom,
            ],
          ],
        },
      },
      return: { memoizedProps: { conversationId: "prewarm-thread" }, return: null },
    });
    addComposerPortal(composer);

    expect(findComposerModelTarget(composer)).toEqual([
      "default",
      "client-new-thread:remote-draft",
    ]);
  });

  it("uses the scoped Composer Thread after a client draft is bound", () => {
    const wrapper = { isManuallyChanged: true, modelSettings: null, serviceTier: null };
    const draftAtom = { get: vi.fn(() => wrapper) };
    const composer = composerWithFiber({
      updateQueue: {
        memoCache: {
          data: [
            [
              {},
              { resolve: vi.fn(), scope: {}, kind: "value", read: vi.fn() },
              "client-new-thread:bound-draft",
              draftAtom,
              undefined,
              draftAtom,
              draftAtom,
            ],
          ],
        },
      },
      return: { memoizedProps: { conversationId: "unrelated-thread" }, return: null },
    });
    addComposerPortal(composer, "bound-thread");

    expect(findComposerModelTarget(composer)).toEqual(["conversation", "bound-thread"]);
  });

  it("fails closed for ambiguous current identities", () => {
    const wrapper = { isManuallyChanged: false, modelSettings: null };
    const draftAtom = { get: vi.fn(() => wrapper) };
    const composer = composerWithFiber({
      updateQueue: {
        memoCache: {
          data: [
            [{}, {}, "client-new-thread:first", draftAtom, undefined, draftAtom, draftAtom],
            [{}, {}, "client-new-thread:second", draftAtom, undefined, draftAtom, draftAtom],
          ],
        },
      },
      return: null,
    });
    const conflictingConversation = composerWithFiber({
      memoizedProps: { conversationId: "thread-1" },
      return: { memoizedProps: { conversationId: "thread-2" }, return: null },
    });

    expect(findComposerModelTarget(composer)).toBeNull();
    expect(findComposerModelTarget(conflictingConversation)).toBeNull();
  });

  it("requires both current-version policy readiness markers", () => {
    expect(isMainProcessTitlePolicyReady({ state: "ready" })).toBe(true);
    expect(isMainProcessTitlePolicyReady({ state: "installing" })).toBe(false);
    expect(
      isDraftPrewarmPolicyReady({
        state: "ready",
        hostId: "remote-ssh-discovered:mac",
        select: vi.fn(),
        clear: vi.fn(),
      }),
    ).toBe(true);
    expect(isDraftPrewarmPolicyReady({ state: "ready", select: vi.fn(), clear: vi.fn() })).toBe(
      false,
    );
    expect(isDraftPrewarmPolicyReady({ state: "ready", clear: vi.fn() })).toBe(false);
  });

  it("uses a draft routing policy only for the active remote Host", () => {
    const policy = {
      state: "ready" as const,
      hostId: "remote-ssh-discovered:mac",
      select: vi.fn(),
      clear: vi.fn(),
    };
    const active = {
      requestClient: {
        hostId: "remote-ssh-discovered:mac",
        sendRequest: vi.fn(),
        prewarmThreadStart: vi.fn(),
        enqueueRequest: vi.fn(),
      },
    };
    const local = { requestClient: { ...active.requestClient, hostId: "local" } };
    const duplicateActive = {
      requestClient: {
        ...active.requestClient,
        sendRequest: vi.fn(),
      },
    };

    expect(activeRendererDraftPrewarmPolicy(policy, [active])).toBe(policy);
    expect(activeRendererDraftPrewarmPolicy(policy, [local, active])).toBe(policy);
    expect(activeRendererDraftPrewarmPolicy(policy, [local])).toBeNull();
    expect(activeRendererDraftPrewarmPolicy(policy, [active, duplicateActive])).toBeNull();
  });

  it("creates base transport selections and clears routing for Codex", () => {
    expect(modelSelectionForAgent(null, null, "pi")?.model).toBe(PI_TRANSPORT_MODEL_ID);
    expect(modelSelectionForAgent(null, null, "claude-code")?.model).toBe(
      CLAUDE_CODE_TRANSPORT_MODEL_ID,
    );
    expect(modelSelectionForAgent(null, null, "deepseek-harness")?.model).toBe(
      DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID,
    );
    expect(modelSelectionForAgent(null, null, "grok")?.model).toBe(GROK_TRANSPORT_MODEL_ID);
    expect(modelSelectionForAgent(null, null, "codex")).toBeNull();
  });

  it("encodes selected Pi Model and Thinking in the transport carrier", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");

    expect(piTransportModelId(model, thinkingOptionId)).toBe(
      `${PI_TRANSPORT_MODEL_ID}@${model.id}@${thinkingOptionId}`,
    );
    expect(modelSelectionForAgent(null, null, "pi", model, thinkingOptionId)?.model).toBe(
      `${PI_TRANSPORT_MODEL_ID}@${model.id}@${thinkingOptionId}`,
    );
    expect(isPiTransportModelId(`${PI_TRANSPORT_MODEL_ID}@${model.id}@${thinkingOptionId}`)).toBe(
      true,
    );
    expect(
      decodePiTransportModelId(`${PI_TRANSPORT_MODEL_ID}@${model.id}@${thinkingOptionId}`),
    ).toEqual({ model, thinkingOptionId });
  });

  it("encodes Claude Model, Permission Mode, and Thinking in the transport carrier", () => {
    const model = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");
    const permissionModeId = harnessPermissionModeIdSchema.parse("acceptEdits");
    const carrier = claudeTransportModelId(model, permissionModeId, thinkingOptionId);

    expect(isClaudeTransportModelId(carrier)).toBe(true);
    expect(decodeClaudeTransportModelId(carrier)).toEqual({
      model,
      thinkingOptionId,
      permissionModeId,
    });
    expect(
      modelSelectionForAgent(null, null, "claude-code", model, thinkingOptionId, permissionModeId)
        ?.model,
    ).toBe(carrier);
  });

  it("encodes DeepSeek Harness Model and Permission Mode in the transport carrier", () => {
    const model = harnessModelRefSchema.parse({ id: "deepseek-harness-model-v1.Zmxhc2g" });
    const permissionModeId = harnessPermissionModeIdSchema.parse("team-safe");
    const carrier = deepSeekHarnessTransportModelId(model, permissionModeId);

    expect(decodeDeepSeekHarnessTransportModelId(carrier)).toEqual({
      model,
      permissionModeId,
    });
    expect(decodeDeepSeekHarnessTransportModelId(deepSeekHarnessTransportModelId(model))).toEqual({
      model,
    });
    expect(
      modelSelectionForAgent(null, null, "deepseek-harness", model, undefined, permissionModeId)
        ?.model,
    ).toBe(carrier);
  });

  it("encodes Grok Model, Permission Mode, and Thinking in the transport carrier", () => {
    const model = harnessModelRefSchema.parse({ id: "grok-4.6" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    const permissionModeId = harnessPermissionModeIdSchema.parse("auto");
    const carrier = grokTransportModelId(model, permissionModeId, thinkingOptionId);

    expect(isGrokTransportModelId(carrier)).toBe(true);
    expect(decodeGrokTransportModelId(carrier)).toEqual({
      model,
      thinkingOptionId,
      permissionModeId,
    });
    expect(
      modelSelectionForAgent(null, null, "grok", model, thinkingOptionId, permissionModeId)?.model,
    ).toBe(carrier);
    expect(
      decodeGrokTransportModelId(`${GROK_TRANSPORT_MODEL_ID}@${model.id}@@${thinkingOptionId}`),
    ).toEqual({ model, thinkingOptionId });
  });

  it("extracts only a validated conversation Thread identity", () => {
    expect(threadIdFromComposerModelTarget(["conversation", "thread-1"])).toBe("thread-1");
    expect(threadIdFromComposerModelTarget(["default", "thread-1"])).toBeNull();
    expect(threadIdFromComposerModelTarget(["conversation", ""])).toBeNull();
  });
});
