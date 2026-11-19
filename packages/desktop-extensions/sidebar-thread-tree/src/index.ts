import type {
  DesktopExtensionDefine,
  DesktopSidebarRow,
  ThreadTreeSnapshot,
} from "@codexhost/shared-contracts";
import { appendThreadLabel, openThread } from "../../src/presentation.js";
import { planThreadTree, type DisplayThread } from "./tree.js";

declare const define: DesktopExtensionDefine;

define({
  activate(api) {
    let rows: readonly DesktopSidebarRow[] = [];
    let snapshot: ThreadTreeSnapshot | undefined;
    let marks = new Map<HTMLElement, "hidden" | "replaced">();
    const panels = new Map<HTMLElement, HTMLElement>();
    const expanded = new Set<string>();

    function panelFor(item: HTMLElement): HTMLElement {
      const existing = panels.get(item);
      if (existing) return existing;
      const panel = item.ownerDocument.createElement("div");
      panel.className = "cx-sidebar-tree";
      panel.addEventListener(
        "click",
        (event) => {
          event.stopPropagation();
          if (!(event.target instanceof Element)) return;
          const button = event.target.closest<HTMLButtonElement>("button");
          const { thread, branch } = button?.dataset ?? {};
          if (thread) void openThread(api, thread);
          if (branch) {
            if (!expanded.delete(branch)) expanded.add(branch);
            render();
            for (const toggle of panel.querySelectorAll<HTMLButtonElement>("button[data-branch]")) {
              if (toggle.dataset.branch === branch) {
                toggle.focus({ preventScroll: true });
                break;
              }
            }
          }
        },
        { signal: api.signal },
      );
      api.dom.mount(panel, item);
      panels.set(item, panel);
      return panel;
    }

    function branch(
      document: Document,
      thread: DisplayThread,
      depth: number,
      title: boolean,
    ): HTMLElement {
      const result = document.createElement("div");
      if (title) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cx-tree-thread";
        button.dataset.thread = thread.id;
        appendThreadLabel(api, button, thread.id, thread.node);
        result.append(button);
      }
      if (!thread.children.length) return result;
      const { descendants, running, waiting } = thread.activity;
      const open = expanded.has(thread.id);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "cx-tree-toggle";
      toggle.dataset.branch = thread.id;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = [
        `${open ? "▾" : "▸"} ${descendants} ${descendants === 1 ? "child" : "children"}`,
        running ? `${running} running` : "",
        waiting ? `${waiting} need attention` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      result.append(toggle);
      if (open) {
        const children = document.createElement("div");
        if (depth < 3) children.className = "cx-tree-indent";
        for (const child of thread.children)
          children.append(branch(document, child, depth + 1, true));
        result.append(children);
      }
      return result;
    }

    function render(): void {
      if (!snapshot) return;
      const nextMarks = new Map<HTMLElement, "hidden" | "replaced">();
      const used = new Set<HTMLElement>();
      const mounted = rows.map((row) => ({
        row,
        item: row.element.closest<HTMLElement>('[role="listitem"], li'),
      }));
      const counts = new Map<HTMLElement, number>();
      for (const { item } of mounted) if (item) counts.set(item, (counts.get(item) ?? 0) + 1);
      const candidates = mounted.flatMap(({ row, item }) => {
        // Don't hide an item shared with another row, e.g. a remote Host row.
        if (
          !row.isLocal ||
          !row.threadId ||
          !row.isConnected() ||
          !item?.parentElement ||
          item === row.element ||
          counts.get(item) !== 1
        )
          return [];
        return [
          { key: { row: row.element, item }, list: item.parentElement, threadId: row.threadId },
        ];
      });
      for (const [{ row, item }, placement] of planThreadTree(snapshot, candidates)) {
        if (placement.kind === "hidden") {
          nextMarks.set(item, "hidden");
          continue;
        }
        const panel = panelFor(item);
        if (panel.parentElement !== item) api.dom.mount(panel, item);
        panel.replaceChildren(
          branch(panel.ownerDocument, placement.tree, 0, placement.kind === "virtual"),
        );
        used.add(item);
        if (placement.kind === "virtual") nextMarks.set(row, "replaced");
      }
      for (const [element, mark] of marks)
        if (nextMarks.get(element) !== mark) api.dom.unmark(element, mark);
      for (const [element, mark] of nextMarks)
        if (marks.get(element) !== mark) api.dom.mark(element, mark);
      marks = nextMarks;
      for (const [item, panel] of panels) {
        if (used.has(item)) continue;
        panel.remove();
        panels.delete(item);
      }
    }

    api.sidebar.observeRows((current) => {
      rows = current;
      render();
    });
    api.threads.watchTree((current) => {
      snapshot = current;
      render();
    });
  },
});
