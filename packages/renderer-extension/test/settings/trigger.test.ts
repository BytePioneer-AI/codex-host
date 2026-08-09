import { describe, expect, it, vi } from "vitest";

import {
  type RendererSettingsBounds,
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
