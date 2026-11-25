import { describe, expect, it, vi } from "vitest";

import {
  inspectRendererContracts,
  inspectRendererForkContract,
  inspectRendererSettingsContract,
  inspectRendererSidebarContract,
} from "../src/index.js";

function list<T>(values: T[]): NodeListOf<T & Node> {
  return values as unknown as NodeListOf<T & Node>;
}

describe("Renderer contract audit inspectors", () => {
  it("classifies a semantic Composer without reading content", () => {
    const draftId = "client-new-thread:audit";
    const data: unknown[][] = [];
    const editor = {
      __reactFiber$audit: { updateQueue: { memoCache: { data } } },
      parentElement: null,
      querySelectorAll: () => list([]),
      hidden: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 24 }),
      ownerDocument: { defaultView: null },
    } as unknown as HTMLElement;
    const send = {
      closest: () => null,
      type: "submit",
      parentElement: { children: [], parentElement: null },
      hasAttribute: () => false,
      getAttribute: () => null,
      querySelectorAll: () => list([]),
    } as unknown as HTMLButtonElement;
    const composer = {
      children: [
        {
          hasAttribute: (name: string) => name === "data-above-composer-portal",
          getAttribute: () => null,
        },
      ],
      closest: () => null,
      matches: () => false,
      querySelector: (selector: string) => (selector.includes("contenteditable") ? editor : null),
      hidden: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 600, height: 120 }),
      ownerDocument: { defaultView: null },
      querySelectorAll: (selector: string) => {
        if (selector.includes("textarea")) return list([editor]);
        if (selector === "button") return list([send]);
        return list([]);
      },
    } as unknown as Element;
    const ownerWindow = {
      document: {
        querySelectorAll: (selector: string) =>
          list(selector === "[data-codex-composer-root]" ? [composer] : []),
      },
    } as unknown as Window;
    const inspection = inspectRendererContracts(ownerWindow);
    expect(inspection.composer).toMatchObject({
      composerCount: 1,
      visibleComposerCount: 1,
      activeComposerCount: 1,
      sendButtonCount: 1,
    });
    expect(inspection.draftHarnessBinding).toEqual({
      visibleDraftCount: 1,
      boundCount: 0,
      missingCreationModeCount: 0,
    });

    const updateDraftSettings = vi.fn();
    const setModelAndReasoningEffort = vi.fn();
    const modelSettings = { model: "native", reasoningEffort: "high" };
    const draftSettings = { modelSettings };
    const preferences = { usesAccountPreferences: false };
    data.push(
      [
        preferences,
        { ...preferences, modelSettings, setModelAndReasoningEffort },
        setModelAndReasoningEffort,
        setModelAndReasoningEffort,
        updateDraftSettings,
      ],
      [
        draftId,
        draftId,
        draftSettings,
        { isNewThreadDraft: true, draftSettings, updateDraftSettings },
        updateDraftSettings,
        updateDraftSettings,
      ],
    );
    expect(inspectRendererContracts(ownerWindow).draftHarnessBinding).toEqual({
      visibleDraftCount: 1,
      boundCount: 1,
      missingCreationModeCount: 1,
    });

    const settings = { model: "native", reasoning_effort: "high" };
    const mode = { mode: "default", settings };
    const handleSubmitLocal = vi.fn();
    const handleNewWorktreeConversation = vi.fn();
    data.unshift(
      [draftId, mode, { handleSubmitLocal, handleNewWorktreeConversation }],
      [mode, settings, { activeMode: mode }],
    );
    expect(inspectRendererContracts(ownerWindow).draftHarnessBinding).toEqual({
      visibleDraftCount: 1,
      boundCount: 1,
      missingCreationModeCount: 0,
    });
    for (const callback of [
      updateDraftSettings,
      setModelAndReasoningEffort,
      handleSubmitLocal,
      handleNewWorktreeConversation,
    ]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it("reports inactive Settings, Sidebar, and Fork surfaces with zero counts", () => {
    const root = { querySelectorAll: () => list([]) } as unknown as Document;
    expect(inspectRendererSettingsContract(root)).toEqual({
      railCount: 0,
      visibleRailCount: 0,
      insertionPointCount: 0,
    });
    expect(inspectRendererSidebarContract(root)).toEqual({
      rowCount: 0,
      titleOwnerCount: 0,
      resolvedThreadCount: 0,
      ambiguousThreadCount: 0,
    });
    expect(inspectRendererForkContract(root)).toEqual({
      annotatedResponseCount: 0,
      candidateButtonCount: 0,
      verifiedButtonCount: 0,
    });
  });
});
