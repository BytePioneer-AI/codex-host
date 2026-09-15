import { describe, expect, it } from "vitest";
import {
  OWNED_CONTROL_SELECTORS,
  OWNED_EXTENSION_CONTROL_ATTRIBUTES,
  isInternalExtensionMutation,
  isOwnedExtensionControl,
} from "../src/renderer-dom-owned-controls.js";

class MockElement {
  nodeType = 1;
  readonly attributes = new Map<string, string>();
  readonly children: MockElement[] = [];
  parentElement: MockElement | null = null;

  constructor(public tagName = "div") {}

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
    const selectors = selector.split(",").map((s) => s.trim());
    const matchesAny = (el: MockElement) => selectors.some((s) => el.matches(s));
    if (matchesAny(this)) return this;
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      if (matchesAny(parent)) return parent;
    }
    return null;
  }

  appendChild(child: MockElement): void {
    child.parentElement = this;
    this.children.push(child);
  }
}

describe("renderer-dom-owned-controls", () => {
  it("includes all expected extension attributes in OWNED_EXTENSION_CONTROL_ATTRIBUTES and SELECTORS", () => {
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-agent-control");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-model-control");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-model-menu");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-permission-mode-control");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-usage-control");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-usage-popover");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-credits-control");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-credits-popover");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-harness-command-control");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-harness-command-menu");
    expect(OWNED_EXTENSION_CONTROL_ATTRIBUTES).toContain("data-codexhost-sidebar-agent-icon");

    for (const attr of OWNED_EXTENSION_CONTROL_ATTRIBUTES) {
      expect(OWNED_CONTROL_SELECTORS).toContain(`[${attr}]`);
    }
  });

  it("identifies owned controls accurately with isOwnedExtensionControl", () => {
    const element = new MockElement("div");
    expect(isOwnedExtensionControl(element as unknown as Element)).toBe(false);

    element.setAttribute("data-codexhost-model-menu", "c-1");
    expect(isOwnedExtensionControl(element as unknown as Element)).toBe(true);

    element.removeAttribute("data-codexhost-model-menu");
    element.setAttribute("data-codexhost-credits-popover", "c-1");
    expect(isOwnedExtensionControl(element as unknown as Element)).toBe(true);
  });

  it("classifies mutations inside owned controls and popovers as internal", () => {
    const popover = new MockElement("div");
    popover.setAttribute("data-codexhost-usage-popover", "c-1");
    const child = new MockElement("span");
    popover.appendChild(child);

    const mutationInside = {
      type: "childList",
      target: child as unknown as Node,
      addedNodes: [] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord;

    expect(isInternalExtensionMutation(mutationInside)).toBe(true);
  });

  it("classifies childList mutations adding owned controls to native container as internal", () => {
    const nativeToolbar = new MockElement("div");
    const modelControl = new MockElement("div");
    modelControl.setAttribute("data-codexhost-model-control", "c-1");

    const mutation = {
      type: "childList",
      target: nativeToolbar as unknown as Node,
      addedNodes: [modelControl as unknown as Node] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord;

    expect(isInternalExtensionMutation(mutation)).toBe(true);
  });

  it("does not classify mutations on native elements as internal", () => {
    const nativeContainer = new MockElement("div");
    const nativeBubble = new MockElement("div");

    const mutation = {
      type: "childList",
      target: nativeContainer as unknown as Node,
      addedNodes: [nativeBubble as unknown as Node] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord;

    expect(isInternalExtensionMutation(mutation)).toBe(false);
  });

  it("identifies all popover attributes as owned controls", () => {
    for (const popoverAttr of [
      "data-codexhost-model-menu",
      "data-codexhost-usage-popover",
      "data-codexhost-credits-popover",
      "data-codexhost-harness-command-menu",
    ]) {
      const popover = new MockElement("div");
      popover.setAttribute(popoverAttr, "test");
      expect(isOwnedExtensionControl(popover as unknown as Element)).toBe(true);

      const inner = new MockElement("button");
      popover.appendChild(inner);
      const mutation = {
        type: "attributes",
        target: inner as unknown as Node,
        attributeName: "aria-expanded",
      } as unknown as MutationRecord;
      expect(isInternalExtensionMutation(mutation)).toBe(true);
    }
  });
});
