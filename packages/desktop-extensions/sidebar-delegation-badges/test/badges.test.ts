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
import { activate } from "../src/badges.js";

const PI = harnessIdSchema.parse("pi");
const CODEX = harnessIdSchema.parse("codex");

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  document.body.replaceChildren();
  document.documentElement.lang = "";
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

  const dispose = () => {
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

  activate(api);

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
  withIcon = true,
): {
  item: HTMLElement;
  row: DesktopSidebarRow;
  icon: HTMLElement | null;
} {
  const item = document.createElement("div");
  item.setAttribute("role", "listitem");

  const rowElement = document.createElement("div");
  rowElement.setAttribute("role", "button");
  const trigger = document.createElement("div");
  trigger.setAttribute("data-thread-title-trigger", "");

  let icon: HTMLElement | null = null;
  if (withIcon) {
    icon = document.createElement("span");
    icon.setAttribute("data-codexhost-sidebar-agent-icon", "pi");
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
      hostId: "local",
      isLocal: true,
      threadId,
      draftId: null,
      isConnected: () => rowElement.isConnected,
    },
  };
}

function makeNode(
  harnessId: ThreadTreeNode["harnessId"],
  status: ThreadTreeNode["status"],
  title: string,
): ThreadTreeNode {
  return { harnessId, status, title, archived: false };
}

describe("sidebar-delegation-badges", () => {
  it("mounts the badge inside the internal Agent icon and never falls back after the block row", () => {
    const harness = createHarness();
    const withIcon = makeSidebarRow("parent-1", true);
    const withoutIcon = makeSidebarRow("parent-2", false);

    harness.setRows([withIcon.row, withoutIcon.row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: { "child-1": "parent-1", "child-2": "parent-1", "child-3": "parent-2" },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent 1"),
        "parent-2": makeNode(PI, "idle", "Parent 2"),
        "child-1": makeNode(CODEX, "waiting", "Need input"),
        "child-2": makeNode(PI, "running", "Working"),
        "child-3": makeNode(PI, "idle", "Other child"),
      },
    });

    const badge = withIcon.icon?.querySelector(".cx-delegation-badge");
    expect(badge).not.toBeNull();
    expect(withIcon.row.element.nextElementSibling).toBeNull();
    expect(withIcon.icon?.hasAttribute("data-cx-sidebar-delegation-badges-anchor")).toBe(true);

    const trigger = badge?.querySelector<HTMLButtonElement>(".cx-delegation-trigger");
    expect(trigger?.textContent).toBe("2");
    expect(trigger?.dataset.state).toBe("waiting");

    // Row without internal Agent icon is skipped instead of mounting after row.element.
    expect(withoutIcon.item.querySelector(".cx-delegation-badge")).toBeNull();
    expect(withoutIcon.row.element.nextElementSibling).toBeNull();
  });

  it("stops pointerdown, mousedown, and click propagation and localizes popover status labels", () => {
    document.documentElement.lang = "zh-CN";
    const harness = createHarness();
    const { row } = makeSidebarRow("parent-1", true);
    const rowEvents: string[] = [];
    for (const type of ["pointerdown", "mousedown", "click"]) {
      row.element.addEventListener(type, () => rowEvents.push(type));
    }

    harness.setRows([row]);
    harness.setTree({
      revision: 1,
      truncated: false,
      parents: {
        "child-wait": "parent-1",
        "child-run": "parent-1",
        "child-idle": "parent-1",
      },
      nodes: {
        "parent-1": makeNode(PI, "idle", "Parent"),
        "child-wait": makeNode(PI, "waiting", "确认规则"),
        "child-run": makeNode(CODEX, "running", "核对状态"),
        "child-idle": makeNode(PI, "idle", "整理术语"),
      },
    });

    const trigger = row.element.querySelector<HTMLButtonElement>(".cx-delegation-trigger");
    expect(trigger).not.toBeNull();
    trigger!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    trigger!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger!.click();
    expect(rowEvents).toEqual([]);

    const statusTexts = [...row.element.querySelectorAll(".cx-delegation-status-text")].map(
      (el) => el.textContent,
    );
    expect(statusTexts).toEqual(["待回答", "运行中", "无活动"]);

    const firstItem = row.element.querySelector<HTMLButtonElement>(
      '.cx-delegation-item[data-thread="child-wait"]',
    );
    firstItem!.click();
    expect(harness.openThread).toHaveBeenCalledWith("child-wait");
    expect(rowEvents).toEqual([]);
  });

  it("re-mounts the badge when the internal Agent icon is replaced inside an unchanged row", async () => {
    const harness = createHarness();
    const { row, icon } = makeSidebarRow("parent-1", true);

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
    icon!.replaceWith(replacement);

    await Promise.resolve();
    await Promise.resolve();

    expect(replacement.querySelector(".cx-delegation-badge")).not.toBeNull();
    expect(replacement.hasAttribute("data-cx-sidebar-delegation-badges-anchor")).toBe(true);
    expect(icon?.hasAttribute("data-cx-sidebar-delegation-badges-anchor")).toBe(false);
  });
});
