import type {
  DesktopExtensionDefine,
  DesktopSidebarRow,
  ThreadTreeNode,
} from "@codexhost/shared-contracts";
import {
  appendThreadLabel,
  openThread,
  statusLabel,
  statusPriority,
} from "../../src/presentation.js";

declare const define: DesktopExtensionDefine;

type Child = readonly [id: string, node: ThreadTreeNode];

// An extension-owned control beside the Agent icon. Read the anchor but never
// mutate it: the core sidebar may replace its icon independently.
const iconSelector = "[data-codexhost-sidebar-agent-icon]";

define({
  activate(api) {
    let rows: readonly DesktopSidebarRow[] = [];
    let byParent = new Map<string, Child[]>();
    const badges = new Map<
      HTMLElement,
      { element: HTMLElement; trigger: HTMLButtonElement; panel: HTMLElement }
    >();

    function render() {
      const visible = new Set<HTMLElement>();
      for (const row of rows) {
        if (!row.isLocal || !row.threadId || !row.isConnected()) continue;
        const children = byParent.get(row.threadId);
        const leading = children?.[0];
        if (!children || !leading) continue;
        const nativeTrigger = row.element.closest("button, a, [role=button], [role=link]");
        const icon = row.element.querySelector(iconSelector);
        const anchor = nativeTrigger ?? icon ?? row.element;
        visible.add(row.element);
        let badge = badges.get(row.element);
        if (!badge) {
          const document = row.element.ownerDocument;
          const element = document.createElement("span");
          element.className = "cx-delegation-badge";
          const trigger = document.createElement("button");
          trigger.type = "button";
          const panel = document.createElement("div");
          panel.className = "cx-delegation-panel";
          panel.popover = "auto";
          trigger.popoverTargetElement = panel;
          panel.addEventListener(
            "click",
            (event) => {
              event.stopPropagation();
              if (!(event.target instanceof Element)) return;
              const id =
                event.target.closest<HTMLButtonElement>("button[data-thread]")?.dataset.thread;
              if (id) {
                panel.hidePopover();
                void openThread(api, id);
              }
            },
            { signal: api.signal },
          );
          trigger.addEventListener("click", (event) => event.stopPropagation(), {
            signal: api.signal,
          });
          element.append(trigger, panel);
          badge = { element, trigger, panel };
          badges.set(row.element, badge);
        }
        if (
          anchor === row.element && !nativeTrigger && !icon
            ? badge.element.parentElement !== anchor
            : badge.element.previousElementSibling !== anchor
        )
          api.dom.mount(
            badge.element,
            anchor,
            anchor === row.element && !nativeTrigger && !icon ? "append" : "after",
          );
        badge.trigger.textContent = children.length > 9 ? "9+" : String(children.length);
        const status = leading[1].status;
        badge.trigger.dataset.state = status;
        const label = `${children.length} delegated Threads · ${statusLabel[status]}`;
        badge.trigger.title = label;
        badge.trigger.setAttribute("aria-label", label);
        const list = badge.panel.ownerDocument.createDocumentFragment();
        for (const [id, child] of children) {
          const button = badge.panel.ownerDocument.createElement("button");
          button.type = "button";
          button.dataset.thread = id;
          appendThreadLabel(api, button, id, child);
          list.append(button);
        }
        badge.panel.replaceChildren(list);
      }
      for (const [row, { element }] of badges) {
        if (visible.has(row)) continue;
        element.remove();
        badges.delete(row);
      }
    }

    api.sidebar.observeRows((current) => {
      rows = current;
      render();
    });
    api.threads.watchTree(({ nodes, parents }) => {
      byParent = new Map();
      const nodeById = new Map(Object.entries(nodes));
      for (const [id, parent] of Object.entries(parents)) {
        const child = nodeById.get(id);
        const parentNode = nodeById.get(parent);
        if (!child || child.archived || !parentNode || parentNode.archived) continue;
        const list = byParent.get(parent) ?? [];
        list.push([id, child]);
        byParent.set(parent, list);
      }
      for (const list of byParent.values())
        list.sort(([, a], [, b]) => statusPriority[a.status] - statusPriority[b.status]);
      render();
    });
  },
});
