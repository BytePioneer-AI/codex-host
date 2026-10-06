import { describe, expect, it, vi } from "vitest";

// The help tooltip renders a lucide icon through the real DOM; this suite
// exercises the switch and hint wiring, so reuse the page-test double.
vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => ({ classList: { add(): void {} } }),
  isRendererSettingsIconName: () => true,
}));

import { CODEX_SERVICE_TIER_STATUS_EVENT } from "../../src/renderer-codex-service-tier-preference.js";
import { mountCodexServiceTierControls } from "../../src/settings/codex-service-tier-controls.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import type { RendererSettingsPageMountContext } from "../../src/settings/core.js";

/** Minimal DOM double for the preference-row helpers this module consumes. */
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly children: unknown[] = [];
  readonly listeners = new Map<string, ((event?: unknown) => void)[]>();
  readonly style: Record<string, string> = {};
  readonly classList = { add: (): void => undefined };
  className = "";
  hidden = false;
  checked = false;
  type = "";
  id = "";
  htmlFor = "";
  textContent = "";
  title = "";
  parentElement: FakeElement | null = null;
  readonly ownerDocument: FakeDocument;
  constructor(document: FakeDocument) {
    this.ownerDocument = document;
  }
  get isConnected(): boolean {
    return this.parentElement !== null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      // The help tooltip appends a mocked icon node; only real elements join the tree.
      if (node instanceof FakeElement) node.parentElement = this;
      this.children.push(node);
    }
  }
  addEventListener(type: string, listener: (event?: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event?: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  querySelector(): FakeElement | null {
    return null;
  }
}

class FakeDocument {
  readonly defaultView: FakeWindow;
  constructor() {
    this.defaultView = new FakeWindow();
  }
  createElement(tagName: string): FakeElement {
    const element = new FakeElement(this);
    element.className = tagName;
    return element;
  }
  createElementNS(_namespace: string, tagName: string): FakeElement {
    return this.createElement(tagName);
  }
}

class FakeWindow extends EventTarget {
  readonly storage = new Map<string, string>();
  readonly localStorage = {
    getItem: (key: string) => this.storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      this.storage.set(key, value);
    },
  };
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function fixture(locale: "en" | "zh-CN" = "en") {
  const document = new FakeDocument();
  const owner = document.defaultView;
  const content = document.createElement("main");
  const context = { content, signal: new AbortController().signal } as unknown as Parameters<
    typeof mountCodexServiceTierControls
  >[0];
  const messages = rendererSettingsMessages(locale);
  const dispose = mountCodexServiceTierControls(
    context as RendererSettingsPageMountContext,
    messages,
  );
  const switchElement = descendants(content).find((element) => element.type === "checkbox");
  if (!switchElement) throw new Error("Missing switch");
  const status = descendants(content).find((element) => element.getAttribute("role") === "status");
  if (!status) throw new Error("Missing status");
  const statusPill = status.parentElement?.parentElement;
  if (!statusPill) throw new Error("Missing status pill");
  return { document, owner, content, dispose, switchElement, status, statusPill, messages };
}

function effectEvent(detail: unknown): CustomEvent {
  return new CustomEvent(CODEX_SERVICE_TIER_STATUS_EVENT, { detail });
}

describe("Codex service tier settings controls", () => {
  it("presents only the switch — no tier selector and no acknowledgment dialog", () => {
    const f = fixture();
    expect(descendants(f.content).some((element) => element.getAttribute("type") === "radio")).toBe(
      false,
    );
    expect(descendants(f.content).some((element) => element.className === "dialog")).toBe(false);
    // A single switch row, and no `dialog` element is ever created by the module.
    expect(
      descendants(f.content).filter((element) => element.getAttribute("role") === "switch"),
    ).toHaveLength(1);
    f.dispose();
  });

  it("explains the forced tier, the unlisted-tier notice and the official provider", () => {
    const f = fixture();
    // The hint sits under the switch row and is re-read after every Host
    // answer, because its text and visibility change per confirmed effect.
    const hintText = () =>
      descendants(f.content)
        .filter((element) => !element.hidden && element.textContent.length > 0)
        .map((element) => element.textContent)
        .join(" | ");

    f.owner.dispatchEvent(effectEvent({ status: "applied", effect: { state: "active" } }));
    expect(hintText()).toContain("forced on every request");

    f.owner.dispatchEvent(
      effectEvent({ status: "applied", effect: { state: "active", notice: "notAdvertised" } }),
    );
    expect(hintText()).toContain("does not declare this tier");

    f.owner.dispatchEvent(
      effectEvent({ status: "applied", effect: { state: "inactive", reason: "officialProvider" } }),
    );
    expect(hintText()).toContain("official OpenAI provider");

    f.owner.dispatchEvent(effectEvent({ status: "failed" }));
    expect(hintText()).toContain("Sync failed, try again");
    expect(hintText()).not.toContain("forced on every request");
    f.dispose();
  });

  it("never disables the switch and reports the status truthfully", () => {
    const f = fixture();
    f.owner.dispatchEvent(effectEvent({ status: "unavailable" }));
    expect(f.switchElement.checked).toBe(false);
    expect(f.status.textContent).toBe("Not supported by this Host");
    expect(f.statusPill.hidden).toBe(false);
    f.owner.dispatchEvent(effectEvent({ status: "failed" }));
    expect(f.status.textContent).toBe("Sync failed, try again");
    f.dispose();
  });

  it("writes the enabled flag on change while keeping the stored tier", () => {
    const f = fixture();
    f.owner.storage.set(
      "codexhost.codex-service-tier.v1",
      JSON.stringify({ enabled: false, tier: "ultrafast" }),
    );
    f.owner.dispatchEvent(new Event("codexhost:codex-service-tier-changed"));
    expect(f.switchElement.checked).toBe(false);
    f.switchElement.checked = true;
    f.switchElement.dispatch("change");
    expect(JSON.parse(f.owner.storage.get("codexhost.codex-service-tier.v1") ?? "")).toEqual({
      enabled: true,
      tier: "ultrafast",
    });
    f.dispose();
  });

  it("names the applied tier in the UI language, not in a hardcoded English label", () => {
    const f = fixture("zh-CN");
    f.owner.storage.set(
      "codexhost.codex-service-tier.v1",
      JSON.stringify({ enabled: true, tier: "ultrafast" }),
    );
    f.owner.dispatchEvent(effectEvent({ status: "applied", effect: { state: "active" } }));
    // Both the label and the tier name come from the official zh-CN messages.
    expect(f.status.textContent).toBe("已生效 · 超快");

    f.owner.storage.set(
      "codexhost.codex-service-tier.v1",
      JSON.stringify({ enabled: true, tier: "fast" }),
    );
    f.owner.dispatchEvent(effectEvent({ status: "applied", effect: { state: "active" } }));
    expect(f.status.textContent).toBe("已生效 · 快速");

    // Standard is a confirmed tier too, and its label is the official 标准.
    f.owner.storage.set(
      "codexhost.codex-service-tier.v1",
      JSON.stringify({ enabled: true, tier: "standard" }),
    );
    f.owner.dispatchEvent(effectEvent({ status: "applied", effect: { state: "active" } }));
    expect(f.status.textContent).toBe("已生效 · 标准");

    f.owner.storage.set(
      "codexhost.codex-service-tier.v1",
      JSON.stringify({ enabled: true, tier: "standard" }),
    );
    f.dispose();
  });

  it("tells the user Standard keeps the switch on and the switch is the off control", () => {
    const f = fixture();
    const text = descendants(f.content)
      .map((element) => `${element.textContent}`)
      .join(" | ");
    expect(text).toContain("Choosing Standard keeps this switch on");
    expect(text).toContain("use this switch to turn the feature off");
    f.dispose();
  });

  it("stops listening after dispose", () => {
    const f = fixture();
    const remove = vi.spyOn(f.owner, "removeEventListener");
    f.dispose();
    expect(remove.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining([
        "codexhost:codex-service-tier-changed",
        "codexhost:codex-service-tier-status",
        "storage",
      ]),
    );
  });
});
