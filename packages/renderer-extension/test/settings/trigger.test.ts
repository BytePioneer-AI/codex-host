import { describe, expect, it, vi } from "vitest";

import {
  inspectRendererSettingsContract,
  installRendererSettingsRailTrigger,
  mountRendererSettingsTrigger,
} from "../../src/settings/trigger.js";

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

  constructor(
    readonly tagName = "DIV",
    readonly height = 36,
  ) {
    this.style.setProperty = (name: string, value: string) => {
      this.style[name] = value;
    };
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null;
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
  dispatch(name: string): void {
    this.listeners.get(name)?.({ stopPropagation: vi.fn() });
  }
  getBoundingClientRect(): DOMRect {
    return { width: this.height > 0 ? 52 : 0, height: this.height } as DOMRect;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
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
  matches(selector: string): boolean {
    const match = /^([a-z]*)\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!match) return false;
    const [, tag, name, value] = match;
    if (tag && tag.toUpperCase() !== this.tagName) return false;
    return (
      name !== undefined &&
      this.attributes.has(name) &&
      (value === undefined || this.attributes.get(name) === value)
    );
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
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

interface FakeRail {
  rail: FakeElement;
  destinations: FakeElement;
  home: FakeElement;
  more: FakeElement;
}

// Mirrors Codex Desktop 26.924: nav > [border, destinations (Home … More), footer].
function createFakeRail(options: { visible?: boolean; destinations?: boolean } = {}): FakeRail {
  const rail = new FakeElement("NAV", options.visible === false ? 0 : 837);
  rail.setAttribute("data-app-navigation-rail", "true");
  const destinations = new FakeElement();
  const home = new FakeElement("BUTTON");
  if (options.destinations !== false) {
    home.setAttribute("data-sidebar-destination", "builtin:home");
  }
  const more = new FakeElement("BUTTON");
  more.setAttribute("aria-haspopup", "dialog");
  destinations.append(home, more);
  rail.append(new FakeElement(), destinations, new FakeElement());
  return { rail, destinations, home, more };
}

function stubRailDocument(current: () => FakeElement): Document {
  const document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
    createElementNS: () => new FakeElement("SVG"),
    querySelector: (selector: string) =>
      selector === "nav[data-app-navigation-rail]" ? current() : null,
    querySelectorAll: (selector: string) =>
      selector === "nav[data-app-navigation-rail]" ? [current()] : [],
  } as unknown as Document;
  vi.stubGlobal("document", document);
  return document;
}

describe("Renderer settings navigation rail trigger", () => {
  it("badges the icon for updates and opens the Updates page directly", () => {
    const document = stubRailDocument(() => createFakeRail().rail);
    try {
      const opened = vi.fn();
      const control = mountRendererSettingsTrigger(
        "test",
        true,
        (opener, pageId) => opened(opener, pageId),
        document,
      );
      const button = control.button as unknown as FakeElement;
      const badge = button.children[1];

      expect(button.style.width).toBe("36px");
      expect(button.style.color).toContain("--color-text-secondary-ghost");
      expect(button.children[0]?.children[0]?.attributes.get("stroke")).toBe("currentColor");
      expect(badge?.style.display).toBe("none");
      button.dispatch("click");
      expect(opened).toHaveBeenLastCalledWith(control.button, undefined);

      control.setUpdateAvailable(true);
      expect(badge?.style.display).toBe("block");
      expect(control.button.title).toBe("codexhost settings · A new version is available.");
      expect(control.root.hasAttribute("data-update-available")).toBe(true);
      button.dispatch("click");
      expect(opened).toHaveBeenLastCalledWith(control.button, "updates");

      control.setUpdateAvailable(false);
      expect(badge?.style.display).toBe("none");
      expect(control.button.title).toBe("codexhost settings");
      control.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mounts directly above the rail's More button", () => {
    const shell = createFakeRail();
    const document = stubRailDocument(() => shell.rail);
    try {
      const control = installRendererSettingsRailTrigger({
        available: true,
        onOpen: vi.fn(),
        ownerDocument: document,
      });

      expect(shell.destinations.children).toEqual([shell.home, control.root, shell.more]);
      control.dispose();
      expect(shell.destinations.children).toEqual([shell.home, shell.more]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("remounts when Codex replaces the navigation rail", () => {
    const shell = createFakeRail();
    let current = shell.rail;
    const document = stubRailDocument(() => current);
    try {
      const control = installRendererSettingsRailTrigger({
        available: true,
        onOpen: vi.fn(),
        ownerDocument: document,
      });
      const replacement = createFakeRail();
      current = replacement.rail;

      expect(control.refresh()).toBe(true);
      expect(shell.destinations.children).toEqual([shell.home, shell.more]);
      expect(replacement.destinations.children).toEqual([
        replacement.home,
        control.root,
        replacement.more,
      ]);
      control.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mounts last when the rail has no More button", () => {
    const shell = createFakeRail();
    shell.more.remove();
    const document = stubRailDocument(() => shell.rail);
    try {
      const control = installRendererSettingsRailTrigger({
        available: true,
        onOpen: vi.fn(),
        ownerDocument: document,
      });
      expect(shell.destinations.children).toEqual([shell.home, control.root]);
      expect(control.refresh()).toBe(true);
      expect(shell.destinations.children).toEqual([shell.home, control.root]);
      control.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stays put when another injected control mounts before the owned trigger", () => {
    const shell = createFakeRail();
    const document = stubRailDocument(() => shell.rail);
    try {
      const control = installRendererSettingsRailTrigger({
        available: true,
        onOpen: vi.fn(),
        ownerDocument: document,
      });
      const foreign = new FakeElement();
      shell.destinations.insertBefore(foreign, control.root as unknown as FakeElement);

      expect(control.refresh()).toBe(true);
      expect(shell.destinations.children).toEqual([shell.home, foreign, control.root, shell.more]);
      control.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("unmounts while the rail is hidden or has no native destinations", () => {
    for (const options of [{ visible: false }, { destinations: false }]) {
      const shell = createFakeRail(options);
      const document = stubRailDocument(() => shell.rail);
      try {
        const control = installRendererSettingsRailTrigger({
          available: true,
          onOpen: vi.fn(),
          ownerDocument: document,
        });
        expect(control.refresh()).toBe(false);
        expect(control.root?.isConnected ?? false).toBe(false);
        expect(shell.destinations.children).toEqual([shell.home, shell.more]);
        control.dispose();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("counts visible rails with a destination column for the contract audit", () => {
    const visible = createFakeRail();
    expect(inspectRendererSettingsContract(stubRailDocument(() => visible.rail))).toEqual({
      railCount: 1,
      visibleRailCount: 1,
      insertionPointCount: 1,
    });
    const hidden = createFakeRail({ visible: false });
    expect(inspectRendererSettingsContract(stubRailDocument(() => hidden.rail))).toEqual({
      railCount: 1,
      visibleRailCount: 0,
      insertionPointCount: 0,
    });
    vi.unstubAllGlobals();
  });
});
