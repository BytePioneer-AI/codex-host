import { describe, expect, it } from "vitest";

import {
  inspectRendererComposerContract,
  inspectRendererForkContract,
  inspectRendererSettingsContract,
  inspectRendererSidebarContract,
} from "../src/index.js";

function list<T>(values: T[]): NodeListOf<T & Node> {
  return values as unknown as NodeListOf<T & Node>;
}

describe("Renderer contract audit inspectors", () => {
  it("classifies a semantic Composer without reading content", () => {
    const editor = {
      hidden: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 24 }),
      ownerDocument: { defaultView: null },
    } as unknown as HTMLElement;
    const send = {
      type: "submit",
      parentElement: { children: [], parentElement: null },
      hasAttribute: () => false,
      getAttribute: () => null,
      querySelectorAll: () => list([]),
    } as unknown as HTMLButtonElement;
    const composer = {
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
    const root = {
      querySelectorAll: () => list([composer]),
    } as unknown as ParentNode;

    expect(inspectRendererComposerContract(root)).toMatchObject({
      composerCount: 1,
      visibleComposerCount: 1,
      activeComposerCount: 1,
      sendButtonCount: 1,
    });
  });

  it("reports inactive Settings, Sidebar, and Fork surfaces with zero counts", () => {
    const root = { querySelectorAll: () => list([]) } as unknown as Document;
    expect(inspectRendererSettingsContract(root)).toEqual({
      headerCount: 0,
      visibleHeaderCount: 0,
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
