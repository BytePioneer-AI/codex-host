import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  applyComposerModelWrite,
  draftPermissionMode,
  draftThinkingOptionForModel,
  isLateConversationTarget,
  isComposerModelWriteAllowed,
  isOwnershipSubmissionBlocked,
  lockedPermissionMode,
  lateConversationTargetResolution,
  passiveHarnessAvailabilityAgents,
  refreshConnectionHosts,
  restoredThreadOwnership,
  retryableHarnessAvailabilityAgents,
  rendererUsageRefreshDelay,
  shouldApplyDraftAgentCarrier,
  shouldPersistNewThreadConfigurationSelection,
  shouldReloadExternalCatalogAfterAvailabilityRefresh,
  shouldRetryExternalThreadUsage,
  shouldTransferComposerState,
} from "../src/renderer-binding-probe.js";
import {
  editorForElement,
  isComposerInputIntent,
  isComposerSubmissionKey,
  isComposerSubmitButton,
  isComposerVoiceButton,
  creditsPlacementAnchor,
  isNativeContextUsageControlCandidate,
  nativeContextUsageControlForComposer,
  reconcileComposerNativeControls,
  trailingActionAnchor,
  type ComposerAgentControl,
} from "../src/renderer-composer-dom.js";
import {
  formatRendererCacheHitRate,
  formatRendererCost,
  formatRendererTokenCount,
  rendererUsageTriggerMaxWidth,
} from "../src/renderer-usage-control.js";

describe("Renderer connection diagnostics", () => {
  it("waits for every Host refresh before completing", async () => {
    let resolveLocal!: () => void;
    let resolveRemote!: () => void;
    const local = new Promise<void>((resolve) => {
      resolveLocal = resolve;
    });
    const remote = new Promise<void>((resolve) => {
      resolveRemote = resolve;
    });
    const refreshHost = vi.fn((hostId: string) => (hostId === "local" ? local : remote));
    let completed = false;
    const refresh = refreshConnectionHosts(["local", "remote"], refreshHost).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(refreshHost).toHaveBeenCalledTimes(2);
    expect(completed).toBe(false);
    resolveLocal();
    await Promise.resolve();
    expect(completed).toBe(false);
    resolveRemote();
    await refresh;
    expect(completed).toBe(true);
  });

  it("rejects when one Host refresh fails", async () => {
    await expect(
      refreshConnectionHosts(["local", "remote"], (hostId) =>
        hostId === "remote" ? Promise.reject(new Error("remote unavailable")) : Promise.resolve(),
      ),
    ).rejects.toThrow("remote unavailable");
  });
});

describe("Renderer Composer DOM behavior", () => {
  it("does not re-probe ready Agents when an optional Harness is not installed", () => {
    expect(
      retryableHarnessAvailabilityAgents(
        {
          pi: "ready",
          "claude-code": "ready",
          "deepseek-harness": "notInstalled",
          opencode: "ready",
          grok: "ready",
          omp: "ready",
        },
        {
          pi: undefined,
          "claude-code": undefined,
          "deepseek-harness": {
            code: "notInstalled",
            message: "DeepSeek Harness is not installed",
            retryable: false,
          },
          opencode: undefined,
          grok: undefined,
          omp: undefined,
        },
      ),
    ).toEqual([]);

    expect(
      retryableHarnessAvailabilityAgents(
        {
          pi: "ready",
          "claude-code": "ready",
          "deepseek-harness": "error",
          opencode: "ready",
          grok: "ready",
          omp: "ready",
        },
        {
          pi: undefined,
          "claude-code": undefined,
          "deepseek-harness": {
            code: "internalError",
            message: "Remote request manager is temporarily unavailable",
            retryable: true,
          },
          opencode: undefined,
          grok: undefined,
          omp: undefined,
        },
      ),
    ).toEqual(["deepseek-harness"]);

    expect(
      retryableHarnessAvailabilityAgents(
        {
          pi: "ready",
          "claude-code": "ready",
          "deepseek-harness": "unavailable",
          opencode: "ready",
          grok: "ready",
          omp: "ready",
        },
        {
          pi: undefined,
          "claude-code": undefined,
          "deepseek-harness": {
            code: "unavailable",
            message: "DeepSeek Harness is temporarily unavailable",
            retryable: true,
          },
          opencode: undefined,
          grok: undefined,
          omp: undefined,
        },
      ),
    ).toEqual(["deepseek-harness"]);
  });

  it("keeps terminal Harness availability stable across passive focus refreshes", () => {
    expect(
      passiveHarnessAvailabilityAgents(
        {
          pi: "checking",
          "claude-code": "checking",
          "deepseek-harness": "checking",
          opencode: "checking",
          grok: "checking",
          omp: "checking",
        },
        {
          pi: undefined,
          "claude-code": undefined,
          "deepseek-harness": undefined,
          opencode: undefined,
          grok: undefined,
          omp: undefined,
        },
      ),
    ).toEqual(["pi", "claude-code", "deepseek-harness", "opencode", "grok", "omp"]);

    expect(
      passiveHarnessAvailabilityAgents(
        {
          pi: "ready",
          "claude-code": "ready",
          "deepseek-harness": "notInstalled",
          opencode: "ready",
          grok: "ready",
          omp: "ready",
        },
        {
          pi: undefined,
          "claude-code": undefined,
          "deepseek-harness": {
            code: "notInstalled",
            message: "DeepSeek Harness is not installed",
            retryable: false,
          },
          opencode: undefined,
          grok: undefined,
          omp: undefined,
        },
      ),
    ).toEqual([]);

    expect(
      passiveHarnessAvailabilityAgents(
        {
          pi: "ready",
          "claude-code": "ready",
          "deepseek-harness": "unavailable",
          opencode: "ready",
          grok: "ready",
          omp: "ready",
        },
        {
          pi: undefined,
          "claude-code": undefined,
          "deepseek-harness": {
            code: "unavailable",
            message: "DeepSeek Harness is temporarily unavailable",
            retryable: true,
          },
          opencode: undefined,
          grok: undefined,
          omp: undefined,
        },
      ),
    ).toEqual(["deepseek-harness"]);
  });

  it("keeps a ready external Model catalog stable during repeated availability checks", () => {
    expect(shouldReloadExternalCatalogAfterAvailabilityRefresh("ready", "ready", true)).toBe(false);
    expect(shouldReloadExternalCatalogAfterAvailabilityRefresh("ready", "ready", false)).toBe(true);
    expect(shouldReloadExternalCatalogAfterAvailabilityRefresh("error", "ready", true)).toBe(true);
    expect(shouldReloadExternalCatalogAfterAvailabilityRefresh("ready", "error", true)).toBe(true);
  });

  it("retries external Usage after an early empty inspection", () => {
    expect(shouldRetryExternalThreadUsage("pi", null)).toBe(true);
    expect(shouldRetryExternalThreadUsage("claude-code", null)).toBe(true);
    expect(shouldRetryExternalThreadUsage("codex", null)).toBe(true);
    expect(shouldRetryExternalThreadUsage("codex", { totalCostUsd: 0.168 })).toBe(true);
    expect(
      shouldRetryExternalThreadUsage(
        "codex",
        { totalCostUsd: 0.168 },
        {
          usedPercent: 33,
          periodType: "five_hour",
        },
      ),
    ).toBe(false);
    expect(shouldRetryExternalThreadUsage("pi", { totalCostUsd: 0.168 })).toBe(false);
    expect(shouldRetryExternalThreadUsage("grok", { totalCostUsd: 0.168 })).toBe(true);
    expect(
      shouldRetryExternalThreadUsage(
        "grok",
        { totalCostUsd: 0.168 },
        {
          usedPercent: 33,
          periodType: "weekly",
        },
      ),
    ).toBe(false);
    // Same "keep retrying for Account Credits" carve-out Grok gets: without it, revisiting a
    // Claude Code Thread whose Usage was already known (so the initial retry never engaged)
    // would leave the credits pill permanently blank.
    expect(shouldRetryExternalThreadUsage("claude-code", { totalCostUsd: 0.168 })).toBe(true);
    expect(
      shouldRetryExternalThreadUsage(
        "claude-code",
        { totalCostUsd: 0.168 },
        { usedPercent: 62, periodType: "five_hour" },
      ),
    ).toBe(false);
    expect(rendererUsageRefreshDelay(0)).toBe(250);
    expect(rendererUsageRefreshDelay(1)).toBe(500);
    expect(rendererUsageRefreshDelay(99)).toBe(8000);
  });

  it("re-hides a replaced native Model control for an external Agent", () => {
    class FakeElement {
      readonly attributes = new Map<string, string>();
      className = "";
      hidden = false;
      readonly style: Record<string, string> = {};

      click(): void {}
      contains(): boolean {
        return false;
      }
      getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
      }
      hasAttribute(name: string): boolean {
        return this.attributes.has(name);
      }
      matches(selector: string): boolean {
        return selector === 'button[aria-haspopup="menu"]';
      }
      closest(): null {
        return null;
      }
      removeAttribute(name: string): void {
        this.attributes.delete(name);
      }
      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }
    }
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("document", { activeElement: null });
    const previous = new FakeElement();
    previous.hidden = true;
    previous.setAttribute("aria-hidden", "true");
    const replacement = new FakeElement();
    replacement.className = "native-model";
    replacement.setAttribute("aria-haspopup", "menu");
    replacement.setAttribute("data-codex-intelligence-trigger", "true");
    replacement.setAttribute("data-composer-navigation-target", "reasoning");
    const composer = {
      querySelectorAll: (selector: string) =>
        selector === 'button[aria-haspopup="menu"]' ? [replacement] : [],
    } as unknown as Element;
    const trigger = new FakeElement();
    const control = {
      composer,
      modelPicker: { trigger, root: { parentElement: {} } },
      nativeModelControl: { element: previous, hidden: false, ariaHidden: null },
      nativePermissionModeControl: null,
      nativeContextUsageControl: null,
      credits: {
        anchor: null,
        place: vi.fn(),
        root: { remove: vi.fn() },
      },
      usage: {
        anchor: null,
        place: vi.fn(),
        dispose: vi.fn(),
        root: { remove: vi.fn() },
      },
      composerId: "test-composer",
    } as unknown as ComposerAgentControl;

    reconcileComposerNativeControls(control, true, true);

    expect(previous.hidden).toBe(false);
    expect(previous.getAttribute("aria-hidden")).toBeNull();
    expect(replacement.hidden).toBe(true);
    expect(replacement.getAttribute("aria-hidden")).toBe("true");
    expect(control.nativeModelControl?.element).toBe(replacement);
    vi.unstubAllGlobals();
  });

  it("resolves an inner contenteditable paragraph to its editor", () => {
    const editor = {} as Element;
    const paragraph = {
      matches: vi.fn(() => false),
      closest: vi.fn(() => editor),
    } as unknown as Element;

    expect(editorForElement(paragraph)).toBe(editor);
    expect(paragraph.closest).toHaveBeenCalledWith(
      'textarea, [contenteditable="true"], [role="textbox"]',
    );
  });

  it("recognizes keyboard input before contenteditable mutation events", () => {
    const event = (key: string, overrides: Partial<KeyboardEvent> = {}) =>
      ({ key, ctrlKey: false, metaKey: false, altKey: false, ...overrides }) as KeyboardEvent;

    expect(isComposerInputIntent(event("p"))).toBe(true);
    expect(isComposerInputIntent(event("Backspace"))).toBe(true);
    expect(isComposerInputIntent(event("v", { ctrlKey: true }))).toBe(true);
    expect(isComposerInputIntent(event("Process"))).toBe(true);
    expect(isComposerInputIntent(event("Delete"))).toBe(true);
    expect(isComposerInputIntent(event("ArrowLeft"))).toBe(false);
    expect(isComposerInputIntent(event("c", { ctrlKey: true }))).toBe(false);
  });

  it("recognizes only a uniquely described native context control", () => {
    const native = {
      hasAttribute: vi.fn(() => false),
      matches: (selector: string) => selector === 'span[role="img"][aria-label]',
      querySelectorAll: () => [{}, {}],
    } as unknown as HTMLElement;
    const composer = {
      querySelectorAll: vi.fn(() => [native]),
    } as unknown as Element;

    expect(isNativeContextUsageControlCandidate(native)).toBe(true);
    expect(nativeContextUsageControlForComposer(composer)).toBe(native);
    expect(formatRendererCacheHitRate(99.9)).toBe("CH 99.9%");
    expect(formatRendererCost(0.168)).toBe("$0.168");
    expect(formatRendererTokenCount(87000)).toBe("87k");
    expect(formatRendererTokenCount(6700)).toBe("6.7k");
    expect(formatRendererTokenCount(375000)).toBe("375k");
    expect(rendererUsageTriggerMaxWidth()).toBe("min(180px, 30vw)");
  });

  it("places Usage beside the native context wrapper when it is present", () => {
    const modelRoot = {
      parentElement: { kind: "model" } as unknown as HTMLElement,
    } as HTMLElement;
    const footer = {} as HTMLElement;
    const contextWrapper = { parentElement: footer } as HTMLElement;
    const nativeContext = {
      parentElement: contextWrapper,
      hidden: false,
      hasAttribute: () => false,
      matches: (selector: string) => selector === 'span[role="img"][aria-label]',
      getAttribute: () => "Context usage: 20%",
      querySelectorAll: () => [{}, {}],
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      contains: () => false,
    } as unknown as HTMLElement;
    const placeUsage = vi.fn();
    const placeCredits = vi.fn();
    const usageRoot = { remove: vi.fn() };
    const control = {
      composer: {
        querySelectorAll: (selector: string) =>
          selector.includes("[aria-label]") ? [nativeContext] : [],
      },
      modelPicker: { root: modelRoot, trigger: {} },
      nativeModelControl: null,
      nativePermissionModeControl: null,
      nativeContextUsageControl: { element: nativeContext, hidden: false, ariaHidden: null },
      credits: {
        anchor: null,
        place: placeCredits,
        root: { remove: vi.fn() },
      },
      usage: {
        anchor: null,
        place: placeUsage,
        root: usageRoot,
      },
    } as unknown as ComposerAgentControl;

    reconcileComposerNativeControls(control, false, false);

    expect(placeUsage).toHaveBeenCalledWith(contextWrapper);
    expect(placeUsage).not.toHaveBeenCalledWith(modelRoot);
    expect(placeCredits).not.toHaveBeenCalled();
  });

  it("places Usage before the Model control when native Context is not ready", () => {
    const modelParent = {} as HTMLElement;
    const modelRoot = { parentElement: modelParent } as HTMLElement;
    const placeUsage = vi.fn();
    const placeCredits = vi.fn();
    const usageRoot = { remove: vi.fn() };
    const control = {
      composer: { querySelectorAll: () => [] },
      modelPicker: { root: modelRoot, trigger: {} },
      nativeModelControl: null,
      nativePermissionModeControl: null,
      nativeContextUsageControl: null,
      credits: {
        anchor: null,
        place: placeCredits,
        root: { remove: vi.fn() },
      },
      usage: {
        anchor: null,
        place: placeUsage,
        root: usageRoot,
      },
    } as unknown as ComposerAgentControl;

    reconcileComposerNativeControls(control, true, false);

    expect(placeUsage).toHaveBeenCalledWith(modelRoot);
    expect(placeCredits).not.toHaveBeenCalled();
  });

  it("anchors credits to the permission-mode picker's own root", () => {
    const permissionModeRoot = { parentElement: {} } as HTMLElement;
    const control = {
      permissionModePicker: { root: permissionModeRoot },
    } as unknown as ComposerAgentControl;

    expect(creditsPlacementAnchor(control)).toBe(permissionModeRoot);
  });

  it("does not anchor credits until the permission-mode picker has been inserted into the DOM", () => {
    const permissionModeRoot = { parentElement: null } as unknown as HTMLElement;
    const control = {
      permissionModePicker: { root: permissionModeRoot },
    } as unknown as ComposerAgentControl;

    expect(creditsPlacementAnchor(control)).toBeNull();
  });

  it("places credits immediately before the permission-mode picker, independent of Usage", () => {
    const permissionModeRoot = { parentElement: {} } as HTMLElement;
    const placeUsage = vi.fn();
    const placeCredits = vi.fn();
    const control = {
      composer: { querySelectorAll: () => [] },
      modelPicker: { root: {}, trigger: {} },
      nativeModelControl: null,
      nativePermissionModeControl: null,
      nativeContextUsageControl: null,
      permissionModePicker: { root: permissionModeRoot },
      credits: {
        anchor: null,
        place: placeCredits,
        root: { remove: vi.fn() },
      },
      usage: {
        anchor: null,
        place: placeUsage,
        root: { remove: vi.fn() },
      },
    } as unknown as ComposerAgentControl;

    reconcileComposerNativeControls(control, true, false);

    expect(placeCredits).toHaveBeenCalledWith(permissionModeRoot);
  });

  it("does not treat codexhost Usage controls as native anchors", () => {
    const usage = {
      hasAttribute: (name: string) => name === "data-codexhost-usage-control",
      getAttribute: () => "Context window usage",
    } as unknown as HTMLElement;
    const credits = {
      hasAttribute: (name: string) => name === "data-codexhost-credits-control",
      getAttribute: () => "Weekly limit",
    } as unknown as HTMLElement;
    expect(isNativeContextUsageControlCandidate(usage)).toBe(false);
    expect(isNativeContextUsageControlCandidate(credits)).toBe(false);
  });

  it("does not treat attachment controls as submission", () => {
    const button = (label: string, type = "button") =>
      ({
        type,
        getAttribute(name: string) {
          return name === "aria-label" ? label : null;
        },
      }) as HTMLButtonElement;

    expect(isComposerSubmitButton(button("Attach files"))).toBe(false);
    expect(isComposerSubmitButton(button("Send"))).toBe(true);
    expect(isComposerSubmitButton(button("", "submit"))).toBe(true);
  });

  it("recognizes a dictation control without treating attach or send as voice", () => {
    const button = (label: string, type = "button") =>
      ({
        type,
        hasAttribute: () => false,
        getAttribute(name: string) {
          return name === "aria-label" ? label : null;
        },
      }) as unknown as HTMLButtonElement;

    expect(isComposerVoiceButton(button("Dictation"))).toBe(true);
    expect(isComposerVoiceButton(button("语音"))).toBe(true);
    expect(isComposerVoiceButton(button("Voice"))).toBe(true);
    expect(isComposerVoiceButton(button("Pause"))).toBe(true);
    expect(isComposerVoiceButton(button("暂停"))).toBe(true);
    expect(isComposerVoiceButton(button("Stop"))).toBe(true);
    expect(isComposerVoiceButton(button("Cancel"))).toBe(false);
    expect(isComposerVoiceButton(button("Cancel recording"))).toBe(false);
    expect(isComposerVoiceButton(button("Send"))).toBe(false);
    expect(isComposerVoiceButton(button("Attach files"))).toBe(false);
    expect(isComposerVoiceButton(button("Model: Grok 4.6 High Effort"))).toBe(false);
  });

  it("uses the voice button as the trailing action when it shares the send toolbar", () => {
    const voice = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Dictation" : null),
      contains: () => false,
    };
    const send = {
      type: "submit",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Send" : null),
      contains: () => false,
      compareDocumentPosition: () => 2,
    };
    const toolbar = {
      children: [voice, send],
      querySelectorAll: () => [voice, send],
    };
    Object.assign(voice, { parentElement: toolbar });
    Object.assign(send, { parentElement: toolbar });

    expect(trailingActionAnchor(send as unknown as HTMLButtonElement)).toBe(voice);
  });

  it("keeps send as the trailing action when voice is absent", () => {
    const send = {
      type: "submit",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Send" : null),
      contains: () => false,
    };
    const toolbar = {
      children: [send],
      querySelectorAll: () => [send],
    };
    Object.assign(send, { parentElement: toolbar });

    expect(trailingActionAnchor(send as unknown as HTMLButtonElement)).toBe(send);
  });

  it("uses the leftmost voice control when dictation and empty-state voice share the toolbar", () => {
    const dictation = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Dictation" : null),
      contains: () => false,
    };
    const waveform = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Voice" : null),
      contains: () => false,
    };
    const toolbar = {
      children: [dictation, waveform],
    };
    Object.assign(dictation, { parentElement: toolbar });
    Object.assign(waveform, { parentElement: toolbar });

    expect(trailingActionAnchor(waveform as unknown as HTMLButtonElement)).toBe(dictation);
  });

  it("uses the pause button as the trailing action while recording", () => {
    const pause = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Pause" : null),
      contains: () => false,
    };
    const send = {
      type: "submit",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Send" : null),
      contains: () => false,
    };
    const toolbar = {
      children: [pause, send],
    };
    Object.assign(pause, { parentElement: toolbar });
    Object.assign(send, { parentElement: toolbar });

    expect(trailingActionAnchor(send as unknown as HTMLButtonElement)).toBe(pause);
  });

  it("does not treat a recording cancel control as the trailing action", () => {
    const cancel = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Cancel recording" : null),
      contains: () => false,
    };
    const pause = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Pause" : null),
      contains: () => false,
    };
    const send = {
      type: "submit",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Send" : null),
      contains: () => false,
    };
    const toolbar = {
      children: [cancel, pause, send],
    };
    Object.assign(cancel, { parentElement: toolbar });
    Object.assign(pause, { parentElement: toolbar });
    Object.assign(send, { parentElement: toolbar });

    expect(trailingActionAnchor(send as unknown as HTMLButtonElement)).toBe(pause);
  });

  it("walks up to a cousin dictation control outside the send cluster", () => {
    const dictation = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Dictation" : null),
      contains: () => false,
    };
    const send = {
      type: "submit",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Send" : null),
      contains: () => false,
    };
    const cluster = {
      hasAttribute: () => false,
      children: [send],
      matches: () => false,
    };
    const footer = {
      hasAttribute: () => false,
      children: [dictation, cluster],
      matches: () => false,
    };
    Object.assign(dictation, { parentElement: footer });
    Object.assign(send, { parentElement: cluster });
    Object.assign(cluster, { parentElement: footer });

    expect(trailingActionAnchor(send as unknown as HTMLButtonElement)).toBe(dictation);
  });

  it("re-places model and agent pickers before the voice button", () => {
    const voice = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Dictation" : null),
      contains: () => false,
    };
    const send = {
      type: "submit",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Send" : null),
      contains: () => false,
      compareDocumentPosition: () => 2,
    };
    const insertBefore = vi.fn();
    const toolbar = {
      children: [voice, send],
      querySelectorAll: () => [voice, send],
      insertBefore,
    };
    Object.assign(voice, { parentElement: toolbar });
    Object.assign(send, { parentElement: toolbar });
    const modelRoot = { parentElement: toolbar, nextElementSibling: send };
    const agentRoot = { parentElement: toolbar, nextElementSibling: send };
    const control = {
      composer: { querySelectorAll: () => [] },
      sendButton: send,
      root: agentRoot,
      picker: { root: agentRoot },
      modelPicker: { root: modelRoot, trigger: {} },
      nativeModelControl: null,
      nativePermissionModeControl: null,
      credits: {
        anchor: null,
        place: vi.fn(),
        root: { remove: vi.fn() },
      },
      usage: {
        anchor: null,
        place: vi.fn(),
        root: { remove: vi.fn() },
      },
    } as unknown as ComposerAgentControl;

    reconcileComposerNativeControls(control, true, false);

    expect(insertBefore).toHaveBeenCalledWith(modelRoot, voice);
    expect(insertBefore).toHaveBeenCalledWith(agentRoot, voice);
  });

  it("re-places model and agent pickers before the pause button", () => {
    const pause = {
      type: "button",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Pause" : null),
      contains: () => false,
    };
    const send = {
      type: "submit",
      hasAttribute: () => false,
      getAttribute: (name: string) => (name === "aria-label" ? "Send" : null),
      contains: () => false,
    };
    const insertBefore = vi.fn();
    const toolbar = {
      children: [pause, send],
      insertBefore,
    };
    Object.assign(pause, { parentElement: toolbar });
    Object.assign(send, { parentElement: toolbar });
    const modelRoot = { parentElement: toolbar, nextElementSibling: send };
    const agentRoot = { parentElement: toolbar, nextElementSibling: send };
    const control = {
      composer: { querySelectorAll: () => [] },
      sendButton: send,
      root: agentRoot,
      picker: { root: agentRoot },
      modelPicker: { root: modelRoot, trigger: {} },
      nativeModelControl: null,
      nativePermissionModeControl: null,
      credits: {
        anchor: null,
        place: vi.fn(),
        root: { remove: vi.fn() },
      },
      usage: {
        anchor: null,
        place: vi.fn(),
        root: { remove: vi.fn() },
      },
    } as unknown as ComposerAgentControl;

    reconcileComposerNativeControls(control, true, false);

    expect(insertBefore).toHaveBeenCalledWith(modelRoot, pause);
    expect(insertBefore).toHaveBeenCalledWith(agentRoot, pause);
  });

  it("freezes only on a non-composing Enter without Shift", () => {
    const event = (overrides: Partial<KeyboardEvent> = {}) =>
      ({ key: "Enter", shiftKey: false, isComposing: false, ...overrides }) as KeyboardEvent;

    expect(isComposerSubmissionKey(event())).toBe(true);
    expect(isComposerSubmissionKey(event({ shiftKey: true }))).toBe(false);
    expect(isComposerSubmissionKey(event({ isComposing: true }))).toBe(false);
    expect(isComposerSubmissionKey(event({ key: "Process" }))).toBe(false);
  });

  it("restores validated Host ownership and blocks unresolved submission", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.restored" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        effectiveModel: model,
        effectiveThinkingOptionId: thinkingOptionId,
        availableThinkingOptions: [
          { id: harnessThinkingOptionIdSchema.parse("off"), label: "Off" },
          { id: thinkingOptionId, label: "High" },
        ],
        locked: true,
      }),
    ).toEqual({ agent: "pi", model, thinkingOptionId });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: `codexhost/pi-native@${model.id}@${thinkingOptionId}`,
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        locked: true,
      }),
    ).toEqual({ agent: "pi", model, thinkingOptionId });
    expect(restoredThreadOwnership({ owner: "codex", locked: true })).toEqual({
      agent: "codex",
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "claude-code",
        transportModelId: "codexhost/claude-code-native@claude-model-v1.c29ubmV0@acceptEdits@high",
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" }),
        effectiveThinkingOptionId: thinkingOptionId,
        availableThinkingOptions: [{ id: thinkingOptionId, label: "High" }],
        effectivePermissionModeId: harnessPermissionModeIdSchema.parse("acceptEdits"),
        resolvedModelLabel: "runtime-custom",
        locked: true,
      }),
    ).toEqual({
      agent: "claude-code",
      model: { id: "claude-model-v1.c29ubmV0" },
      thinkingOptionId: "high",
      permissionModeId: "acceptEdits",
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "opencode",
        transportModelId:
          "codexhost/opencode-native@opencode-model-v1.WyJwcm92aWRlci0xIiwibW9kZWwtMSJd@ask@ocv.aGlnaA",
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        effectiveModel: harnessModelRefSchema.parse({
          id: "opencode-model-v1.WyJwcm92aWRlci0xIiwibW9kZWwtMSJd",
        }),
        effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse("ocv.aGlnaA"),
        effectivePermissionModeId: harnessPermissionModeIdSchema.parse("allow"),
        availableThinkingOptions: [
          { id: harnessThinkingOptionIdSchema.parse("ocv.aGlnaA"), label: "high" },
        ],
        locked: true,
      }),
    ).toEqual({
      agent: "opencode",
      model: { id: "opencode-model-v1.WyJwcm92aWRlci0xIiwibW9kZWwtMSJd" },
      thinkingOptionId: "ocv.aGlnaA",
      permissionModeId: "allow",
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "grok",
        transportModelId: "codexhost/grok-native@grok-4.6@auto@high",
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
        effectiveModel: harnessModelRefSchema.parse({ id: "grok-4.6" }),
        effectiveThinkingOptionId: thinkingOptionId,
        availableThinkingOptions: [{ id: thinkingOptionId, label: "High" }],
        effectivePermissionModeId: harnessPermissionModeIdSchema.parse("auto"),
        locked: true,
      }),
    ).toEqual({
      agent: "grok",
      model: { id: "grok-4.6" },
      thinkingOptionId: "high",
      permissionModeId: "auto",
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "grok",
        transportModelId: "codexhost/grok-native@grok-4.6@always-approve",
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
        locked: true,
      }),
    ).toEqual({
      agent: "grok",
      model: { id: "grok-4.6" },
      permissionModeId: "always-approve",
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "claude-code",
        transportModelId: "codexhost/claude-code-native@claude-model-v1.c29ubmV0@acceptEdits",
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
        locked: true,
      }),
    ).toEqual({
      agent: "claude-code",
      model: { id: "claude-model-v1.c29ubmV0" },
      permissionModeId: "acceptEdits",
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "deepseek-harness",
        transportModelId:
          "codexhost/deepseek-harness-native@deepseek-harness-model-v1.Zmxhc2g@team-safe",
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        effectiveModel: harnessModelRefSchema.parse({
          id: "deepseek-harness-model-v1.Zmxhc2g",
        }),
        effectivePermissionModeId: harnessPermissionModeIdSchema.parse("trusted-run"),
        locked: true,
      }),
    ).toEqual({
      agent: "deepseek-harness",
      model: { id: "deepseek-harness-model-v1.Zmxhc2g" },
      permissionModeId: "trusted-run",
    });
    expect(() =>
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: "official/model",
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        locked: true,
      }),
    ).toThrow("incompatible transport Model");
    expect(isOwnershipSubmissionBlocked("loading")).toBe(true);
    expect(isOwnershipSubmissionBlocked("error")).toBe(true);
    expect(isOwnershipSubmissionBlocked("ready")).toBe(false);
    expect(isOwnershipSubmissionBlocked("not-required")).toBe(false);
  });

  it("resolves Draft Thinking from the selected Model's in-memory Catalog entry", () => {
    const reasoningModel = harnessModelRefSchema.parse({ id: "pi-model-v1.reasoning" });
    const plainModel = harnessModelRefSchema.parse({ id: "pi-model-v1.plain" });
    const catalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: reasoningModel,
          label: "Reasoning",
          supportedThinkingOptionIds: ["off", "high", "max"],
        },
        {
          ref: plainModel,
          label: "Plain",
          supportedThinkingOptionIds: ["off"],
        },
      ],
      defaultModel: reasoningModel,
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
      defaultThinkingOptionId: "high",
    });

    expect(
      draftThinkingOptionForModel(
        catalog,
        reasoningModel,
        harnessThinkingOptionIdSchema.parse("max"),
      ),
    ).toBe("max");
    expect(
      draftThinkingOptionForModel(catalog, plainModel, harnessThinkingOptionIdSchema.parse("max")),
    ).toBe("off");
    expect(draftThinkingOptionForModel(catalog, reasoningModel, undefined)).toBe("high");
  });

  it("falls back draft Permission Mode but fails closed for a stale locked carrier", () => {
    const catalog = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "plan", label: "Plan" },
        { id: "default", label: "Default" },
      ],
      defaultModeId: "default",
    });

    expect(draftPermissionMode(catalog, harnessPermissionModeIdSchema.parse("plan"))).toBe("plan");
    expect(draftPermissionMode(catalog, harnessPermissionModeIdSchema.parse("foreign"))).toBe(
      "default",
    );
    expect(draftPermissionMode(catalog, undefined)).toBe("default");
    const plan = harnessPermissionModeIdSchema.parse("plan");
    const foreign = harnessPermissionModeIdSchema.parse("foreign");
    expect(lockedPermissionMode(catalog, undefined, plan)).toBe(plan);
    expect(lockedPermissionMode(catalog, plan, foreign)).toBe(plan);
    expect(() => lockedPermissionMode(catalog, undefined, foreign)).toThrow(
      "absent from the current Catalog",
    );
  });

  it("persists explicit configuration selections only for a new-Thread draft", () => {
    expect(shouldPersistNewThreadConfigurationSelection("draft")).toBe(true);
    expect(shouldPersistNewThreadConfigurationSelection("locked")).toBe(false);
  });

  it("does not bind readable Thinking when current options are unavailable", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.legacy" });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: `codexhost/pi-native@${model.id}`,
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        effectiveModel: model,
        effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        locked: true,
      }),
    ).toEqual({ agent: "pi", model });
  });

  it("inspects an in-place conversation transition unless the source was submitted", () => {
    const defaultTarget = ["default"];
    const conversationTarget = ["conversation", "opaque-1"];

    expect(isLateConversationTarget(defaultTarget, conversationTarget)).toBe(true);
    expect(lateConversationTargetResolution(defaultTarget, conversationTarget, "draft")).toBe(
      "inspect",
    );
    expect(lateConversationTargetResolution(defaultTarget, conversationTarget, "draft", true)).toBe(
      "transfer",
    );
    expect(lateConversationTargetResolution(defaultTarget, conversationTarget, "locked")).toBe(
      "transfer",
    );
    expect(shouldRetryExternalThreadUsage("pi", null)).toBe(true);
    expect(lateConversationTargetResolution(defaultTarget, defaultTarget, "draft")).toBe("none");
    expect(isLateConversationTarget(conversationTarget, conversationTarget)).toBe(false);
    expect(isLateConversationTarget(conversationTarget, ["conversation", "opaque-2"])).toBe(true);
    expect(
      lateConversationTargetResolution(conversationTarget, ["conversation", "opaque-2"], "locked"),
    ).toBe("inspect");
    expect(isLateConversationTarget(null, conversationTarget)).toBe(true);
    expect(lateConversationTargetResolution(null, conversationTarget, "draft")).toBe("inspect");
  });

  it("does not transfer an unsubmitted default draft when an existing conversation opens", () => {
    const defaultTarget = ["default"];
    const firstConversationTarget = ["conversation", "opaque-1"];
    const otherConversationTarget = ["conversation", "opaque-2"];

    expect(shouldTransferComposerState(defaultTarget, defaultTarget, "draft")).toBe(true);
    expect(shouldTransferComposerState(defaultTarget, firstConversationTarget, "draft")).toBe(
      false,
    );
    expect(shouldTransferComposerState(defaultTarget, firstConversationTarget, "draft", true)).toBe(
      true,
    );
    expect(shouldTransferComposerState(defaultTarget, firstConversationTarget, "locked")).toBe(
      true,
    );
    expect(shouldTransferComposerState(firstConversationTarget, ["default"], "locked")).toBe(false);
    expect(
      shouldTransferComposerState(firstConversationTarget, otherConversationTarget, "locked"),
    ).toBe(false);
    expect(shouldTransferComposerState(null, firstConversationTarget, "locked")).toBe(false);
  });

  it("allows native Model writes only for a new-Thread draft target", () => {
    expect(isComposerModelWriteAllowed(["default", "draft"])).toBe(true);
    expect(isComposerModelWriteAllowed(["conversation", "pi-thread"])).toBe(false);
    expect(isComposerModelWriteAllowed(["conversation", "codex-thread"])).toBe(false);
    expect(isComposerModelWriteAllowed(null)).toBe(false);
  });

  it("does not emit a base external carrier before its concrete configuration loads", () => {
    expect(shouldApplyDraftAgentCarrier("codex", undefined)).toBe(true);
    expect(shouldApplyDraftAgentCarrier("grok", undefined)).toBe(false);
    expect(
      shouldApplyDraftAgentCarrier("grok", harnessModelRefSchema.parse({ id: "grok-4.6" })),
    ).toBe(true);
  });

  it("never writes the native Model while repeatedly switching existing conversations", () => {
    const write = vi.fn(() => true);

    for (let index = 0; index < 100; index += 1) {
      const agent = index % 2 === 0 ? "pi" : "codex";
      expect(applyComposerModelWrite(["conversation", `${agent}-${index}`], write)).toBe(true);
    }

    expect(write).not.toHaveBeenCalled();
  });
});
