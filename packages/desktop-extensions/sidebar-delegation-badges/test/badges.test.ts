// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  harnessIdSchema,
  threadTreeSnapshotSchema,
  type DesktopExtensionApiV1,
  type DesktopSidebarRow,
  type ThreadTreeNode,
  type ThreadTreeSnapshot,
} from "@codexhost/shared-contracts";
import { activate, delegationBadgeState } from "../src/badges.js";

const PI = harnessIdSchema.parse("pi");
const CODEX = harnessIdSchema.parse("codex");
const CLAUDE = harnessIdSchema.parse("claude");

const cleanups: Array<() => void> = [];

function must<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  document.body.replaceChildren();
});

function createHarness() {
  const abort = new AbortController();
  const teardowns = new Set<() => void>();
  const mounted = new Set<Element>();
  const marks = new Map<Element, Set<string>>();
  let onRows: ((rows: readonly DesktopSidebarRow[]) => void) | undefined;
  let onTree: ((snapshot: ThreadTreeSnapshot) => void) | undefined;
  const openThread = vi.fn(async () => undefined);

  const api: DesktopExtensionApiV1 = {
    id: "sidebar-delegation-badges",
    apiVersion: 1,
    signal: abort.signal,
    sidebar: {
      observeRows(cb) {
        onRows = cb;
        return () => {
          onRows = undefined;
        };
      },
    },
    threads: {
      watchTree(cb) {
        onTree = cb;
        return () => {
          onTree = undefined;
        };
      },
    },
    navigate: { openThread },
    harnesses: {
      describe(harnessId) {
        if (harnessId === "pi") return { name: "Pi", icon: "data:image/svg+xml,<svg/>" };
        if (harnessId === "codex") return { name: "Codex" };
        return undefined;
      },
    },
    dom: {
      mount(node, parent, position = "append") {
        mounted.add(node);
        parent[position](node);
      },
      mark(target, name) {
        const attr = `data-cx-${api.id}-${name}`;
        target.setAttribute(attr, "");
        let set = marks.get(target);
        if (!set) marks.set(target, (set = new Set()));
        set.add(attr);
      },
      unmark(target, name) {
        const attr = `data-cx-${api.id}-${name}`;
        target.removeAttribute(attr);
        marks.get(target)?.delete(attr);
      },
    },
    track(teardown) {
      teardowns.add(teardown);
    },
  };

  const cleanup = activate(api);
  const dispose = () => {
    cleanup();
    abort.abort();
    for (const fn of teardowns) fn();
    teardowns.clear();
    for (const node of mounted) node.remove();
    mounted.clear();
    for (const [el, attrs] of marks) {
      for (const attr of attrs) el.removeAttribute(attr);
    }
    marks.clear();
  };
  cleanups.push(dispose);

  return {
    api,
    openThread,
    dispose,
    setRows(rows: readonly DesktopSidebarRow[]) {
      onRows?.(rows);
    },
    setTree(tree: {
      revision: number;
      truncated: boolean;
      parents: Record<string, string>;
      nodes: Record<string, ThreadTreeNode>;
    }) {
      onTree?.(threadTreeSnapshotSchema.parse(tree));
    },
  };
}

function makeSidebarRow(
  threadId: string,
  options: {
    withIcon?: boolean;
    harness?: string;
    isLocal?: boolean;
    iconLabel?: string;
  } = {},
): {
  item: HTMLElement;
  row: DesktopSidebarRow;
  icon: HTMLElement | null;
} {
  const { withIcon = true, harness = "pi", isLocal = true, iconLabel = "Pi Agent" } = options;
  const item = document.createElement("div");
  item.setAttribute("role", "listitem");

  const rowElement = document.createElement("div");
  rowElement.setAttribute("role", "button");
  const trigger = document.createElement("div");
  trigger.setAttribute("data-thread-title-trigger", "");

  let icon: HTMLElement | null = null;
  if (withIcon) {
    icon = document.createElement("span");
    icon.setAttribute("data-codexhost-sidebar-agent-icon", harness);
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", iconLabel);
    icon.title = iconLabel;
    icon.style.pointerEvents = "none";
    const img = document.createElement("img");
    img.src = "data:image/png;base64,AA==";
    icon.append(img);
    trigger.append(icon);
  }

  const title = document.createElement("span");
  title.setAttribute("data-thread-title", "");
  title.textContent = "Parent Thread";
  trigger.append(title);
  rowElement.append(trigger);
  item.append(rowElement);
  document.body.append(item);

  return {
    item,
    icon,
    row: {
      element: rowElement,
      hostId: isLocal ? "local" : "remote-1",
      isLocal,
      threadId,
      draftId: null,
      isConnected: () => rowElement.isConnected,
    },
  };
}

function makeNode(
  harnessId: ThreadTreeNode["harnessId"],
  status: ThreadTreeNode["status"],
  title?: string,
  archived = false,
): ThreadTreeNode {
  return { harnessId, status, ...(title !== undefined ? { title } : {}), archived };
}

describe("delegationBadgeState", () => {
  it("picks the most urgent status: waiting > running > unknown > idle", () => {
    expect(delegationBadgeState([{ status: "idle" }])).toBe("idle");
    expect(delegationBadgeState([{ status: "idle" }, { status: "unknown" }])).toBe("unknown");
    expect(delegationBadgeState([{ status: "unknown" }, { status: "running" }])).toBe("running");
    expect(
      delegationBadgeState([{ status: "running" }, { status: "waiting" }, { status: "idle" }]),
    ).toBe("waiting");
  });
});

describe("sidebar-delegation-badges", () => {
  it("mounts the badge button inside the Agent icon without mutating native styles/classes and skips remote or iconless rows", () => {
    const harness = createHarness();
    const withIcon = makeSidebarRow("parent-1");
    const withoutIcon = makeSidebarRow("parent-2", { withIcon: false });
    const remoteRow = makeSidebarRow("parent-3", { isLocal: false });

    const icon = must(withIcon.icon, "sidebar agent icon");
    const originalStyle = icon.getAttribute("style");
    const originalClass = icon.getAttribute("class");
    const originalRole = icon.getAttribute("role");

    harness.setRows([withIcon.row, withoutIcon.row, remoteRow.row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: {
        "child-1": "parent-1",
        "child-2": "parent-1",
        "child-3": "parent-2",
        "child-4": "parent-3",
      },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent 1"),
        "parent-2": makeNode(PI, "idle", "Parent 2"),
        "parent-3": makeNode(PI, "idle", "Remote Parent"),
        "child-1": makeNode(CODEX, "waiting", "Need input"),
        "child-2": makeNode(PI, "running", "Working"),
        "child-3": makeNode(PI, "idle", "Other child"),
        "child-4": makeNode(PI, "running", "Remote child"),
      },
    });

    const badge = withIcon.icon?.querySelector<HTMLButtonElement>(".cx-delegation-badge");
    expect(badge).not.toBeNull();
    expect(withIcon.row.element.nextElementSibling).toBeNull();
    expect(withIcon.icon?.hasAttribute("data-cx-sidebar-delegation-badges-anchor")).toBe(true);
    // Native icon style/class/role remain untouched; styling is driven solely by api.dom.mark + desktop.css.
    expect(withIcon.icon?.getAttribute("style")).toBe(originalStyle);
    expect(withIcon.icon?.getAttribute("class")).toBe(originalClass);
    expect(withIcon.icon?.getAttribute("role")).toBe(originalRole);

    expect(badge?.getAttribute("aria-label")).toBe("Pi Agent · 已派出 2 个会话，有会话待回答");
    expect(badge?.title).toBe("Pi Agent · 已派出 2 个会话，有会话待回答");

    const count = badge?.querySelector<HTMLSpanElement>(".cx-delegation-count");
    expect(count?.textContent).toBe("2");
    expect(count?.dataset.state).toBe("waiting");

    expect(withoutIcon.item.querySelector(".cx-delegation-badge")).toBeNull();
    expect(remoteRow.item.querySelector(".cx-delegation-badge")).toBeNull();
  });

  it("formats 10+ children as 9+ and omits the state suffix when all children are idle", () => {
    const harness = createHarness();
    const { row } = makeSidebarRow("parent-1");
    const parents: Record<string, string> = {};
    const nodes: Record<string, ThreadTreeNode> = {
      "parent-1": makeNode(PI, "idle", "Parent"),
    };
    for (let index = 1; index <= 10; index += 1) {
      parents[`child-${index}`] = "parent-1";
      nodes[`child-${index}`] = makeNode(PI, "idle", `Child ${index}`);
    }

    harness.setRows([row]);
    harness.setTree({ revision: 1, truncated: false, parents, nodes });

    const badge = row.element.querySelector<HTMLButtonElement>(".cx-delegation-badge");
    const count = badge?.querySelector<HTMLSpanElement>(".cx-delegation-count");
    expect(count?.textContent).toBe("9+");
    expect(count?.dataset.state).toBe("idle");
    expect(badge?.getAttribute("aria-label")).toBe("Pi Agent · 已派出 10 个会话");
  });

  it("blocks press/click propagation, sorts menu items by urgency with exact status labels, and opens the clicked Thread", () => {
    const harness = createHarness();
    const { row } = makeSidebarRow("parent-1");
    const rowEvents: string[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      row.element.addEventListener(type, () => rowEvents.push(type));
    }

    harness.setRows([row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: {
        "child-idle": "parent-1",
        "child-unknown": "parent-1",
        "child-run": "parent-1",
        "child-wait": "parent-1",
      },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent"),
        "child-idle": makeNode(PI, "idle", "整理术语"),
        "child-unknown": makeNode(CLAUDE, "unknown"),
        "child-run": makeNode(CODEX, "running", "核对状态"),
        "child-wait": makeNode(PI, "waiting", "确认规则"),
      },
    });

    const badge = must(
      row.element.querySelector<HTMLButtonElement>(".cx-delegation-badge"),
      "delegation badge",
    );
    badge.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    badge.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    badge.dispatchEvent(new Event("pointerup", { bubbles: true }));
    badge.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    badge.click();
    expect(rowEvents).toEqual([]);

    const popover = must(
      document.body.querySelector<HTMLElement>("[data-codexhost-delegation-popover]"),
      "delegation popover",
    );
    expect(popover.getAttribute("role")).toBe("menu");

    const items = [...popover.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((el) => el.getAttribute("data-codexhost-delegation-child"))).toEqual([
      "child-wait",
      "child-run",
      "child-unknown",
      "child-idle",
    ]);
    expect(items.map((el) => el.querySelector(".cx-delegation-title")?.textContent)).toEqual([
      "确认规则",
      "核对状态",
      "claude",
      "整理术语",
    ]);
    expect(items.map((el) => el.querySelector(".cx-delegation-status")?.textContent)).toEqual([
      "? 待回答",
      "● 运行中",
      "◌ 状态未知",
      "○ 无活动",
    ]);

    must(items[0], "first menu item").click();
    expect(harness.openThread).toHaveBeenCalledWith("child-wait");
    expect(document.body.querySelector("[data-codexhost-delegation-popover]")).toBeNull();
    expect(rowEvents).toEqual([]);
  });

  it("supports keyboard opening, ArrowUp/ArrowDown navigation, live focus preservation, Escape focus return, and outside pointerdown dismissal", () => {
    const harness = createHarness();
    const { row } = makeSidebarRow("parent-1");

    harness.setRows([row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: {
        "child-1": "parent-1",
        "child-2": "parent-1",
      },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent"),
        "child-1": makeNode(PI, "waiting", "First"),
        "child-2": makeNode(CODEX, "running", "Second"),
      },
    });

    const badge = must(
      row.element.querySelector<HTMLButtonElement>(".cx-delegation-badge"),
      "delegation badge",
    );
    badge.focus();
    badge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const popover = document.body.querySelector<HTMLElement>("[data-codexhost-delegation-popover]");
    expect(popover).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-codexhost-delegation-child")).toBe("child-1");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-codexhost-delegation-child")).toBe("child-2");

    // Tree update rebuilds the menu while keeping focus on the same child.
    harness.setTree({
      revision: 2,
      truncated: false,
      parents: {
        "child-1": "parent-1",
        "child-2": "parent-1",
      },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent"),
        "child-1": makeNode(PI, "idle", "First updated"),
        "child-2": makeNode(CODEX, "running", "Second"),
      },
    });
    expect(document.activeElement?.getAttribute("data-codexhost-delegation-child")).toBe("child-2");

    // ArrowUp wraps around when at the top item.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-codexhost-delegation-child")).toBe("child-1");

    // Escape closes the menu and restores focus to the badge trigger.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.body.querySelector("[data-codexhost-delegation-popover]")).toBeNull();
    expect(document.activeElement).toBe(badge);

    // Reopen via Space and dismiss by clicking outside.
    badge.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(document.body.querySelector("[data-codexhost-delegation-popover]")).not.toBeNull();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.body.querySelector("[data-codexhost-delegation-popover]")).toBeNull();
  });

  it("places the popover upward when below-space is smaller than needed and clamps within viewport bounds", () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });

    const harness = createHarness();
    const { row } = makeSidebarRow("parent-1");
    harness.setRows([row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: { "child-1": "parent-1" },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent"),
        "child-1": makeNode(PI, "running", "Child"),
      },
    });

    const badge = must(
      row.element.querySelector<HTMLButtonElement>(".cx-delegation-badge"),
      "delegation badge",
    );
    vi.spyOn(badge, "getBoundingClientRect").mockReturnValue({
      top: 260,
      bottom: 274,
      left: 350,
      right: 364,
      width: 14,
      height: 14,
      x: 350,
      y: 260,
      toJSON: () => ({}),
    });

    // JSDOM reports scrollHeight/offsetWidth as 0 by default; stub realistic dimensions on div prototype.
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(120);
    const offsetWidthSpy = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(220);
    try {
      badge.click();
      const popover = must(
        document.body.querySelector<HTMLElement>("[data-codexhost-delegation-popover]"),
        "delegation popover",
      );
      expect(popover.style.top).toBe("auto");
      expect(popover.style.bottom).toBe("44px"); // 300 - 260 + 4
      expect(popover.style.left).toBe("172px"); // 400 - 8 - 220
      expect(popover.style.maxHeight).toBe("248px"); // min(320, 260 - 4 - 8)
      expect(popover.style.maxWidth).toBe("360px");
    } finally {
      scrollHeightSpy.mockRestore();
      offsetWidthSpy.mockRestore();
    }
  });

  it("re-mounts the badge when the internal Agent icon is replaced inside an unchanged row", async () => {
    const harness = createHarness();
    const { row, icon } = makeSidebarRow("parent-1");

    harness.setRows([row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: { "child-1": "parent-1" },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent"),
        "child-1": makeNode(PI, "running", "Child"),
      },
    });

    expect(icon?.querySelector(".cx-delegation-badge")).not.toBeNull();

    const replacement = document.createElement("span");
    replacement.setAttribute("data-codexhost-sidebar-agent-icon", "codex");
    replacement.setAttribute("aria-label", "Codex Agent");
    must(icon, "sidebar agent icon").replaceWith(replacement);

    await Promise.resolve();
    await Promise.resolve();

    expect(replacement.querySelector(".cx-delegation-badge")).not.toBeNull();
    expect(replacement.hasAttribute("data-cx-sidebar-delegation-badges-anchor")).toBe(true);
    expect(icon?.hasAttribute("data-cx-sidebar-delegation-badges-anchor")).toBe(false);
  });

  it("cleans up mounted badges, marks, and open popovers completely on dispose", () => {
    const harness = createHarness();
    const { row, icon } = makeSidebarRow("parent-1");

    harness.setRows([row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: { "child-1": "parent-1" },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent"),
        "child-1": makeNode(PI, "running", "Child"),
      },
    });

    must(
      row.element.querySelector<HTMLButtonElement>(".cx-delegation-badge"),
      "delegation badge",
    ).click();
    expect(document.body.querySelector("[data-codexhost-delegation-popover]")).not.toBeNull();

    harness.dispose();

    expect(icon?.querySelector(".cx-delegation-badge")).toBeNull();
    expect(icon?.hasAttribute("data-cx-sidebar-delegation-badges-anchor")).toBe(false);
    expect(document.body.querySelector("[data-codexhost-delegation-popover]")).toBeNull();
  });
});
