import { describe, expect, it, vi } from "vitest";

import {
  type RendererSettingsBounds,
  installRendererSettingsHeaderTrigger,
  mountRendererSettingsTrigger,
  selectRendererSettingsHeaderSlot,
} from "../../src/settings/trigger.js";

function bounds(left: number, top: number, width: number, height: number): RendererSettingsBounds {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  };
}

describe("Renderer settings header trigger", () => {
  const header = bounds(240, 36, 942, 46);

  it("selects the right-side group containing Open Location and the context menu", () => {
    expect(
      selectRendererSettingsHeaderSlot(header, [
        { value: "open-location", bounds: bounds(1018, 45, 128, 28), visibleButtonCount: 1 },
        { value: "actions", bounds: bounds(1018, 36, 164, 46), visibleButtonCount: 2 },
        { value: "context-menu", bounds: bounds(1154, 45, 28, 28), visibleButtonCount: 1 },
      ]),
    ).toBe("actions");
  });

  it("selects the structural action group when a blank thread has no native actions", () => {
    expect(
      selectRendererSettingsHeaderSlot(header, [
        {
          value: "empty-actions",
          bounds: bounds(1176, 59, 0, 0),
          visibleButtonCount: 0,
          structuralActionGroup: true,
        },
      ]),
    ).toBe("empty-actions");
  });

  it("shows a dedicated update button and opens the Updates page directly", () => {
    class FakeElement {
      readonly attributes = new Map<string, string>();
      readonly children: FakeElement[] = [];
      readonly listeners = new Map<string, (event: { stopPropagation(): void }) => void>();
      readonly classList = { add: vi.fn() };
      readonly style: Record<string, string | ((name: string, value: string) => void)> = {};
      disabled = false;
      isConnected = true;
      title = "";
      type = "";

      constructor() {
        this.style.setProperty = (name: string, value: string) => {
          this.style[name] = value;
        };
      }

      addEventListener(name: string, listener: (event: { stopPropagation(): void }) => void): void {
        this.listeners.set(name, listener);
      }
      append(...children: FakeElement[]): void {
        this.children.push(...children);
      }
      appendChild(child: FakeElement): FakeElement {
        this.children.push(child);
        return child;
      }
      dispatch(name: string): void {
        this.listeners.get(name)?.({ stopPropagation: vi.fn() });
      }
      hasAttribute(name: string): boolean {
        return this.attributes.has(name);
      }
      remove(): void {
        this.isConnected = false;
      }
      removeEventListener(name: string): void {
        this.listeners.delete(name);
      }
      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }
      toggleAttribute(name: string, force: boolean): void {
        if (force) this.attributes.set(name, "");
        else this.attributes.delete(name);
      }
    }

    const document = {
      createElement: () => new FakeElement(),
      createElementNS: () => new FakeElement(),
    } as unknown as Document;
    vi.stubGlobal("document", document);
    const opened = vi.fn();
    const control = mountRendererSettingsTrigger(
      "test",
      true,
      (opener, pageId) => opened(opener, pageId),
      document,
    );

    expect(control.updateButton.style.display).toBe("none");
    control.setUpdateAvailable(true);
    expect(control.updateButton.style.display).toBe("inline-flex");
    expect(control.updateButton.style.background).toBe("#2563eb");
    expect(control.updateButton.style.color).toBe("#ffffff");
    expect(
      (control.updateButton.children[1] as unknown as { textContent: string }).textContent,
    ).toBe("Updates");
    expect(control.root.hasAttribute("data-update-available")).toBe(true);
    (control.updateButton as unknown as FakeElement).dispatch("click");
    expect(opened).toHaveBeenCalledWith(control.updateButton, "updates");
    control.setUpdateAvailable(false);
    expect(control.updateButton.style.display).toBe("none");
    control.dispose();
    vi.unstubAllGlobals();
  });

  it("mounts directly before the application header end slot without Thread actions", () => {
    class FakeElement {
      readonly attributes = new Map<string, string>();
      readonly children: FakeElement[] = [];
      readonly listeners = new Map<string, (event: { stopPropagation(): void }) => void>();
      readonly classList = { add: vi.fn() };
      readonly style: Record<string, string | ((name: string, value: string) => void)> = {};
      disabled = false;
      isConnected = true;
      parentElement: FakeElement | null = null;
      title = "";
      type = "";

      constructor(readonly left = 0) {
        this.style.setProperty = (name: string, value: string) => {
          this.style[name] = value;
        };
      }

      get firstChild(): FakeElement | null {
        return this.children[0] ?? null;
      }
      get nextSibling(): FakeElement | null {
        if (!this.parentElement) return null;
        const index = this.parentElement.children.indexOf(this);
        return this.parentElement.children[index + 1] ?? null;
      }
      addEventListener(name: string, listener: (event: { stopPropagation(): void }) => void): void {
        this.listeners.set(name, listener);
      }
      append(...children: FakeElement[]): void {
        for (const child of children) this.insertBefore(child, null);
      }
      appendChild(child: FakeElement): FakeElement {
        return this.insertBefore(child, null);
      }
      getBoundingClientRect(): DOMRect {
        return {
          left: this.left,
          right: this.left + 80,
          top: 0,
          bottom: 46,
          width: 80,
          height: 46,
        } as DOMRect;
      }
      insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
        child.remove();
        child.parentElement = this;
        child.isConnected = true;
        const index = before ? this.children.indexOf(before) : -1;
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        return child;
      }
      querySelectorAll(selector: string): FakeElement[] {
        return selector === ':scope > [data-test-id="header-shell-slot"]'
          ? this.children.filter((child) => child.attributes.has("data-test-id"))
          : [];
      }
      remove(): void {
        if (this.parentElement) {
          const index = this.parentElement.children.indexOf(this);
          if (index >= 0) this.parentElement.children.splice(index, 1);
        }
        this.parentElement = null;
        this.isConnected = false;
      }
      removeEventListener(name: string): void {
        this.listeners.delete(name);
      }
      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }
      toggleAttribute(name: string, force: boolean): void {
        if (force) this.attributes.set(name, "");
        else this.attributes.delete(name);
      }
    }

    const header = new FakeElement();
    const startSlot = new FakeElement(0);
    startSlot.setAttribute("data-test-id", "header-shell-slot");
    const content = new FakeElement(240);
    const endSlot = new FakeElement(1120);
    endSlot.setAttribute("data-test-id", "header-shell-slot");
    header.append(startSlot, content, endSlot);
    let currentHeader = header;
    const document = {
      createElement: () => new FakeElement(),
      createElementNS: () => new FakeElement(),
      querySelector: (selector: string) =>
        selector === 'header[data-pip-obstacle="app-shell-header"]' ? currentHeader : null,
      querySelectorAll: () => [],
    } as unknown as Document;
    vi.stubGlobal("document", document);

    try {
      const control = installRendererSettingsHeaderTrigger({
        available: true,
        onOpen: vi.fn(),
        ownerDocument: document,
      });

      expect(control.root).not.toBeNull();
      expect(header.children).toEqual([startSlot, content, control.root, endSlot]);

      const replacementHeader = new FakeElement();
      const replacementStartSlot = new FakeElement(0);
      replacementStartSlot.setAttribute("data-test-id", "header-shell-slot");
      const replacementContent = new FakeElement(240);
      const replacementEndSlot = new FakeElement(1120);
      replacementEndSlot.setAttribute("data-test-id", "header-shell-slot");
      replacementHeader.append(replacementStartSlot, replacementContent, replacementEndSlot);
      currentHeader = replacementHeader;

      expect(control.refresh()).toBe(true);
      expect(header.children).toEqual([startSlot, content, endSlot]);
      expect(replacementHeader.children).toEqual([
        replacementStartSlot,
        replacementContent,
        control.root,
        replacementEndSlot,
      ]);
      control.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed without a visible or structural bounded action group", () => {
    expect(
      selectRendererSettingsHeaderSlot(header, [
        { value: "open-location", bounds: bounds(1018, 45, 128, 28), visibleButtonCount: 1 },
        { value: "hidden", bounds: bounds(1018, 36, 164, 46), visibleButtonCount: 0 },
        {
          value: "outside",
          bounds: bounds(1184, 59, 0, 0),
          visibleButtonCount: 0,
          structuralActionGroup: true,
        },
      ]),
    ).toBeNull();
  });
});
