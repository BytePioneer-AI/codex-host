// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_SUMMARY_PANEL_ATTRIBUTE,
  SUMMARY_PANEL_GUARD_STYLE_ATTRIBUTE,
  hasVisibleSummaryPanelContent,
  installRendererSummaryPanelGuard,
} from "../src/renderer-summary-panel-guard.js";

function createFloatingSummaryPanel(): { panel: HTMLDivElement; list: HTMLDivElement } {
  const panel = document.createElement("div");
  panel.className = "group/summary-panel rounded-2xl bg-surface-elevated-secondary";
  panel.setAttribute("data-summary-panel-variant", "summary");
  panel.setAttribute("data-summary-panel-density", "default");

  const scroller = document.createElement("div");
  scroller.className = "flex h-fit max-h-full min-h-0 min-w-0 flex-col overflow-y-auto";

  const list = document.createElement("div");
  list.className = "flex flex-col gap-2 py-2.5";

  scroller.append(list);
  panel.append(scroller);
  return { panel, list };
}

function createSection(title: string): HTMLElement {
  const section = document.createElement("section");
  section.setAttribute("data-slot", "thread-summary-panel-section");
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  return section;
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("renderer summary panel guard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("hides an empty floating summary panel shell and exposes display:none via style", () => {
    const { panel } = createFloatingSummaryPanel();
    document.body.append(panel);

    const guard = installRendererSummaryPanelGuard(document);
    try {
      expect(hasVisibleSummaryPanelContent(panel)).toBe(false);
      expect(panel.getAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe("true");
      expect(window.getComputedStyle(panel).display).toBe("none");
      expect(
        document.querySelector(`style[${SUMMARY_PANEL_GUARD_STYLE_ATTRIBUTE}]`),
      ).not.toBeNull();
    } finally {
      guard.dispose();
    }
  });

  it("keeps a floating summary panel visible when any visible section exists", () => {
    const { panel, list } = createFloatingSummaryPanel();
    list.append(createSection("Subagents"));
    document.body.append(panel);

    const guard = installRendererSummaryPanelGuard(document);
    try {
      expect(hasVisibleSummaryPanelContent(panel)).toBe(true);
      expect(panel.hasAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe(false);
      expect(window.getComputedStyle(panel).display).not.toBe("none");
    } finally {
      guard.dispose();
    }
  });

  it("hides a panel containing only display:none, hidden, class=hidden, aria-hidden, or empty nodes", () => {
    const { panel, list } = createFloatingSummaryPanel();

    const activityHidden = createSection("Sources");
    activityHidden.setAttribute("style", "display: none !important;");

    const attrHidden = createSection("Changes");
    attrHidden.hidden = true;

    const classHidden = createSection("Plan");
    classHidden.className = "hidden";

    const ariaHidden = document.createElement("div");
    ariaHidden.setAttribute("aria-hidden", "true");
    ariaHidden.textContent = "decorative";

    const emptyWrapper = document.createElement("div");
    emptyWrapper.className = "contents";
    emptyWrapper.append(document.createTextNode("   \n  "));
    emptyWrapper.append(document.createComment("placeholder"));

    list.append(activityHidden, attrHidden, classHidden, ariaHidden, emptyWrapper);
    document.body.append(panel);

    const guard = installRendererSummaryPanelGuard(document);
    try {
      expect(hasVisibleSummaryPanelContent(panel)).toBe(false);
      expect(panel.getAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe("true");
      expect(window.getComputedStyle(panel).display).toBe("none");
    } finally {
      guard.dispose();
    }
  });

  it("toggles visibility dynamically when sections mount, unmount, or flip Activity display:none", async () => {
    const { panel, list } = createFloatingSummaryPanel();
    const activitySection = createSection("Sources");
    activitySection.setAttribute("style", "display: none !important;");
    list.append(activitySection);
    document.body.append(panel);

    const guard = installRendererSummaryPanelGuard(document);
    try {
      expect(panel.getAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe("true");

      // React <Activity mode="hidden"> -> <Activity mode="visible"> removes display: none !important.
      activitySection.removeAttribute("style");
      await flushMutations();
      expect(panel.hasAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe(false);
      expect(window.getComputedStyle(panel).display).not.toBe("none");

      // Switching back to hidden re-hides the empty shell.
      activitySection.setAttribute("style", "display: none !important;");
      await flushMutations();
      expect(panel.getAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe("true");

      // Mounting a new section (e.g. Subagents) immediately shows the panel.
      const subagents = createSection("Subagents");
      list.append(subagents);
      await flushMutations();
      expect(panel.hasAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe(false);

      // Removing the mounted section hides the shell again.
      subagents.remove();
      await flushMutations();
      expect(panel.getAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe("true");
    } finally {
      guard.dispose();
    }
  });

  it("never hides popover summary panels or non-summary panel variants", () => {
    const popover = document.createElement("div");
    popover.setAttribute("data-pip-obstacle", "thread-summary-panel-popover");
    const { panel: popoverPanel } = createFloatingSummaryPanel();
    popover.append(popoverPanel);

    const dynamicIsle = document.createElement("div");
    dynamicIsle.setAttribute("data-summary-panel-variant", "dynamic-isle");

    document.body.append(popover, dynamicIsle);

    const guard = installRendererSummaryPanelGuard(document);
    try {
      expect(popoverPanel.hasAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe(false);
      expect(dynamicIsle.hasAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe(false);
    } finally {
      guard.dispose();
    }
  });

  it("ignores unrelated DOM mutations outside summary panels without recomputing styles", async () => {
    const transcript = document.createElement("div");
    transcript.id = "chat-transcript";
    const { panel, list } = createFloatingSummaryPanel();
    list.append(createSection("Subagents"));
    document.body.append(transcript, panel);

    const guard = installRendererSummaryPanelGuard(document);
    const getComputedStyleSpy = vi.spyOn(window, "getComputedStyle");
    const querySelectorAllSpy = vi.spyOn(document, "querySelectorAll");
    try {
      for (let index = 0; index < 5; index += 1) {
        const message = document.createElement("div");
        const text = document.createElement("p");
        text.textContent = `streaming chunk ${index}`;
        message.append(text);
        transcript.append(message);
      }
      transcript.firstChild?.remove();
      await flushMutations();

      expect(getComputedStyleSpy).not.toHaveBeenCalled();
      expect(querySelectorAllSpy).not.toHaveBeenCalled();

      // Mounting a new empty summary panel outside the existing one still triggers sync.
      const { panel: lateEmptyPanel } = createFloatingSummaryPanel();
      const container = document.createElement("div");
      container.append(lateEmptyPanel);
      document.body.append(container);
      await flushMutations();

      expect(lateEmptyPanel.getAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe("true");
    } finally {
      getComputedStyleSpy.mockRestore();
      querySelectorAllSpy.mockRestore();
      guard.dispose();
    }
  });

  it("cleans up style, attributes, and observers on dispose", async () => {
    const { panel, list } = createFloatingSummaryPanel();
    document.body.append(panel);

    const guard = installRendererSummaryPanelGuard(document);
    expect(panel.getAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe("true");
    expect(document.querySelector(`style[${SUMMARY_PANEL_GUARD_STYLE_ATTRIBUTE}]`)).not.toBeNull();

    guard.dispose();
    guard.dispose();

    expect(panel.hasAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe(false);
    expect(document.querySelector(`style[${SUMMARY_PANEL_GUARD_STYLE_ATTRIBUTE}]`)).toBeNull();

    // Subsequent DOM mutations must not re-apply the attribute after disposal.
    const section = createSection("Changes");
    list.append(section);
    section.remove();
    await flushMutations();
    expect(panel.hasAttribute(EMPTY_SUMMARY_PANEL_ATTRIBUTE)).toBe(false);
  });
});
