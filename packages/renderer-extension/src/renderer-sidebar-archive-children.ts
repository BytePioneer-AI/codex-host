import createElement from "lucide/dist/esm/createElement.mjs";
import CircleAlert from "lucide/dist/esm/icons/circle-alert.mjs";

import type { HostThreadId } from "@codexhost/shared-contracts";

import {
  readArchiveChildrenMode,
  setArchiveChildrenMode,
  type ArchiveChildrenMode,
} from "./renderer-archive-children-preference.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  sidebarThreadAttributes,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";
import {
  SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE,
  type RendererSidebarThreadTree,
} from "./renderer-sidebar-thread-tree.js";
import { applyRendererPopoverChrome } from "./renderer-usage-control.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

/** How long one child archive may take before it is reported as failed. */
export const ARCHIVE_CHILDREN_CONFIRM_TIMEOUT_MS = 15_000;
const ARCHIVE_CHILDREN_POLL_MS = 250;
const ARCHIVE_CHILDREN_NOTICE_MS = 8_000;
const ARCHIVE_CHILDREN_TITLE_LIMIT = 3;

export interface ArchiveChildrenChoice {
  archiveChildren: boolean;
  remember: boolean;
}

export type ArchiveChildFailureReason = "unavailable" | "timeout";

export interface ArchiveChildFailure {
  threadId: HostThreadId;
  reason: ArchiveChildFailureReason;
}

export interface ArchiveChildrenCascadeDependencies {
  mode(): ArchiveChildrenMode;
  setMode(mode: Exclude<ArchiveChildrenMode, "ask">): void;
  /** Only the window the user archived from reacts; every window gets the notification. */
  isActive(): boolean;
  descendants(hostId: string, threadId: HostThreadId): HostThreadId[];
  ask(request: {
    hostId: string;
    threadId: HostThreadId;
    children: readonly HostThreadId[];
  }): Promise<ArchiveChildrenChoice>;
  /** Start the child's native Sidebar archive; `false` when its row offers none. */
  archive(hostId: string, threadId: HostThreadId): boolean;
  isListed(hostId: string, threadId: HostThreadId): boolean;
  reportFailures(hostId: string, failures: readonly ArchiveChildFailure[]): void;
  confirmTimeoutMs?: number;
  pollMs?: number;
}

export interface ArchiveChildrenCascade {
  /** Feed every `thread/archived` notification for `hostId`. */
  threadArchived(hostId: string, threadId: HostThreadId): void;
  dispose(): void;
}

/**
 * After a Sidebar parent is archived, archive its listed Delegation and Fork
 * descendants through each row's own archive action, one at a time, so pins,
 * worktrees, and undo behave exactly as a manual archive. The parent archive
 * has already completed, so a child failure never affects it.
 */
export function createArchiveChildrenCascade(
  dependencies: ArchiveChildrenCascadeDependencies,
): ArchiveChildrenCascade {
  const timeoutMs = dependencies.confirmTimeoutMs ?? ARCHIVE_CHILDREN_CONFIRM_TIMEOUT_MS;
  const pollMs = dependencies.pollMs ?? ARCHIVE_CHILDREN_POLL_MS;
  const threadKey = (hostId: string, threadId: string): string =>
    JSON.stringify([hostId, threadId]);
  /** Children this cascade archives; their notifications must not cascade again. */
  const expected = new Map<string, () => void>();
  const handling = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;

  const waitArchived = (hostId: string, threadId: HostThreadId): Promise<boolean> =>
    new Promise((resolve) => {
      const key = threadKey(hostId, threadId);
      let settled = false;
      const finish = (archived: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        if (expected.get(key) === onArchived) expected.delete(key);
        resolve(archived);
      };
      const onArchived = (): void => finish(true);
      expected.set(key, onArchived);
      const poll = setInterval(() => {
        if (disposed) finish(false);
        else if (!dependencies.isListed(hostId, threadId)) finish(true);
      }, pollMs);
      const timeout = setTimeout(
        () => finish(!disposed && !dependencies.isListed(hostId, threadId)),
        timeoutMs,
      );
    });

  const cascade = async (hostId: string, threadId: HostThreadId): Promise<void> => {
    if (disposed || dependencies.descendants(hostId, threadId).length === 0) return;
    let mode = dependencies.mode();
    if (mode === "never") return;
    if (mode === "ask") {
      const children = dependencies.descendants(hostId, threadId);
      if (children.length === 0) return;
      const choice = await dependencies.ask({ hostId, threadId, children });
      if (disposed) return;
      mode = choice.archiveChildren ? "always" : "never";
      if (choice.remember) dependencies.setMode(mode);
      if (mode === "never") return;
    }
    const failures: ArchiveChildFailure[] = [];
    // Re-read: the dialog may have been open while rows changed.
    for (const child of dependencies.descendants(hostId, threadId)) {
      if (disposed) return;
      if (!dependencies.isListed(hostId, child)) continue;
      const archived = waitArchived(hostId, child);
      let started = false;
      try {
        started = dependencies.archive(hostId, child);
      } catch {
        started = false;
      }
      if (!started) {
        expected.get(threadKey(hostId, child))?.();
        await archived;
        failures.push({ threadId: child, reason: "unavailable" });
        continue;
      }
      if (!(await archived)) failures.push({ threadId: child, reason: "timeout" });
    }
    if (!disposed && failures.length > 0) dependencies.reportFailures(hostId, failures);
  };

  return {
    threadArchived(hostId, threadId) {
      if (disposed) return;
      const key = threadKey(hostId, threadId);
      const confirm = expected.get(key);
      if (confirm) {
        confirm();
        return;
      }
      if (handling.has(key) || !dependencies.isActive()) return;
      if (dependencies.descendants(hostId, threadId).length === 0) return;
      handling.add(key);
      tail = tail
        .then(() => cascade(hostId, threadId))
        .catch(() => undefined)
        .finally(() => handling.delete(key));
    },
    dispose() {
      disposed = true;
      for (const confirm of [...expected.values()]) confirm();
      expected.clear();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Sidebar row's own archive handler, the one its archive button calls. */
export function archiveActionFromSidebarRowElement(element: HTMLElement): (() => void) | null {
  const attributes = sidebarThreadAttributes(element);
  if (!attributes) return null;
  const fiberNames = Object.getOwnPropertyNames(element).filter((name) =>
    name.startsWith("__reactFiber$"),
  );
  const fiberName = fiberNames[0];
  if (fiberNames.length !== 1 || !fiberName) return null;
  let fiber: unknown = Object.getOwnPropertyDescriptor(element, fiberName)?.value;
  for (let depth = 0; isRecord(fiber) && depth < 12; depth += 1) {
    const props = fiber.memoizedProps;
    if (
      isRecord(props) &&
      typeof props.onArchive === "function" &&
      isRecord(props.dataAttributes) &&
      props.dataAttributes[SIDEBAR_THREAD_ROW_ATTRIBUTE] === attributes.rowMarker &&
      props.dataAttributes[SIDEBAR_THREAD_ID_ATTRIBUTE] === attributes.taskKey &&
      props.dataAttributes[SIDEBAR_THREAD_HOST_ID_ATTRIBUTE] === attributes.hostId
    ) {
      const onArchive = props.onArchive as () => unknown;
      return () => {
        onArchive();
      };
    }
    fiber = fiber.return;
  }
  return null;
}

function nativeSidebarRows(
  document: Document,
  hostId: string,
  threadId: HostThreadId,
): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)].filter(
    (row) =>
      !row.closest(`[${SIDEBAR_THREAD_TREE_MIRROR_ATTRIBUTE}]`) &&
      row.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE) === hostId &&
      threadIdFromSidebarRowElement(row) === threadId,
  );
}

function sidebarThreadTitle(document: Document, hostId: string, threadId: HostThreadId): string {
  const row = nativeSidebarRows(document, hostId, threadId)[0];
  const title =
    row?.getAttribute("data-app-action-sidebar-thread-title") ??
    row?.querySelector("[data-thread-title-trigger]")?.textContent ??
    "";
  return title.trim();
}

export interface ArchiveChildrenMessages {
  title: string;
  body(count: number): string;
  more(count: number): string;
  remember: string;
  settingHint: string;
  parentOnly: string;
  archiveAll(count: number): string;
  failureTitle(count: number): string;
  failureUnavailable: string;
  failureTimeout: string;
  listSeparator: string;
}

const ENGLISH: ArchiveChildrenMessages = {
  title: "Archive child threads too?",
  body: (count) =>
    count === 1
      ? "This thread has 1 unarchived child thread:"
      : `This thread has ${count} unarchived child threads:`,
  more: (count) => `and ${count} more`,
  remember: "Remember my choice",
  settingHint: "You can change this in Settings › General › Sidebar.",
  parentOnly: "Archive parent only",
  archiveAll: (count) => (count === 1 ? "Also archive 1 child" : `Also archive ${count} children`),
  failureTitle: (count) =>
    count === 1 ? "1 child thread was not archived" : `${count} child threads were not archived`,
  failureUnavailable: "It could not be archived from the sidebar. Archive it manually.",
  failureTimeout: "Archiving did not finish. Check the sidebar and archive it manually.",
  listSeparator: ", ",
};

const CHINESE: ArchiveChildrenMessages = {
  title: "同时归档子会话？",
  body: (count) => `该会话还有 ${count} 个未归档的子会话：`,
  more: (count) => `等另外 ${count} 个`,
  remember: "记住我的选择",
  settingHint: "可在 设置 › 通用 › 侧边栏 中修改。",
  parentOnly: "仅归档父会话",
  archiveAll: (count) => `同时归档 ${count} 个子会话`,
  failureTitle: (count) => `${count} 个子会话未能归档`,
  failureUnavailable: "无法从侧边栏归档，请手动归档。",
  failureTimeout: "归档未完成，请在侧边栏中检查并手动归档。",
  listSeparator: "、",
};

export function archiveChildrenMessages(locale: RendererSettingsLocale): ArchiveChildrenMessages {
  return locale === "zh-CN" ? CHINESE : ENGLISH;
}

const DIALOG_CLASS =
  "codex-dialog z-50 outline-none fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-default ring-[0.5px] ring-border shadow-lg bg-surface-elevated-secondary/90 backdrop-blur-xl rounded-2xl max-w-[92vw] overflow-hidden";
const BUTTON_CLASS =
  "no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1";
const PRIMARY_BUTTON_CLASS = `${BUTTON_CLASS} rounded-full border-default bg-primary-solid not-disabled:not-aria-disabled:hover:bg-text/80 text-primary-solid px-2 py-0.5 text-sm leading-[18px] shrink-0`;
const SECONDARY_BUTTON_CLASS = `${BUTTON_CLASS} rounded-full text-default bg-text/5 not-disabled:not-aria-disabled:hover:bg-text/10 border-transparent px-2 py-0.5 text-sm leading-[18px] shrink-0`;
const STYLE_ATTRIBUTE = "data-codexhost-archive-children-style";
const MUTED = "color-mix(in srgb, currentColor 68%, transparent)";

function ensureDialogStyle(document: Document): void {
  if (document.head.querySelector(`[${STYLE_ATTRIBUTE}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent =
    "dialog[data-codexhost-archive-children-dialog]::backdrop{background:var(--color-dialog-overlay,rgba(0,0,0,.32))}";
  document.head.append(style);
}

/** Desktop-styled modal asking whether to archive the listed child threads. */
export function openArchiveChildrenDialog(
  document: Document,
  input: { messages: ArchiveChildrenMessages; titles: readonly string[]; count: number },
): Promise<ArchiveChildrenChoice> {
  ensureDialogStyle(document);
  const { messages, count } = input;
  const dialog = document.createElement("dialog");
  dialog.dataset.codexhostArchiveChildrenDialog = "true";
  dialog.className = DIALOG_CLASS;
  // Undo the user-agent dialog box so Desktop's centered dialog classes apply.
  dialog.style.cssText =
    "margin:0;padding:0;border:0;right:auto;bottom:auto;max-height:none;width:400px;color:inherit;font:13px/1.45 system-ui,sans-serif;letter-spacing:0";
  const titleId = `codexhost-archive-children-title-${Math.random().toString(36).slice(2)}`;
  dialog.setAttribute("aria-labelledby", titleId);

  const body = document.createElement("div");
  body.style.cssText = "display:flex;flex-direction:column;gap:12px;padding:20px";
  const title = document.createElement("h2");
  title.id = titleId;
  title.style.cssText = "margin:0;font-size:15px;font-weight:600;line-height:22px";
  title.textContent = messages.title;
  const summary = document.createElement("p");
  summary.style.cssText = `margin:0;color:${MUTED}`;
  summary.textContent = messages.body(count);
  const list = document.createElement("ul");
  list.style.cssText = "margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px";
  const shown = input.titles.filter(Boolean).slice(0, ARCHIVE_CHILDREN_TITLE_LIMIT);
  for (const text of shown) {
    const item = document.createElement("li");
    item.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    item.textContent = text;
    list.append(item);
  }
  if (count > shown.length && shown.length > 0) {
    const item = document.createElement("li");
    item.style.color = MUTED;
    item.textContent = messages.more(count - shown.length);
    list.append(item);
  }
  const remember = document.createElement("label");
  remember.style.cssText =
    "display:flex;align-items:center;gap:8px;cursor:pointer;width:max-content";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.codexhostArchiveChildrenRemember = "true";
  checkbox.style.cssText = "margin:0;accent-color:currentColor";
  remember.append(checkbox, document.createTextNode(messages.remember));
  const hint = document.createElement("p");
  hint.style.cssText = `margin:-6px 0 0 21px;font-size:12px;color:${MUTED}`;
  hint.textContent = messages.settingHint;
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:4px";
  const parentOnly = document.createElement("button");
  parentOnly.type = "button";
  parentOnly.className = SECONDARY_BUTTON_CLASS;
  parentOnly.dataset.codexhostArchiveChildrenAction = "parent";
  parentOnly.textContent = messages.parentOnly;
  const archiveAll = document.createElement("button");
  archiveAll.type = "button";
  archiveAll.className = PRIMARY_BUTTON_CLASS;
  archiveAll.dataset.codexhostArchiveChildrenAction = "children";
  archiveAll.textContent = messages.archiveAll(count);
  actions.append(parentOnly, archiveAll);
  body.append(title, summary);
  if (list.childElementCount > 0) body.append(list);
  body.append(remember, hint, actions);
  dialog.append(body);
  document.body.append(dialog);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (archiveChildren: boolean): void => {
      if (settled) return;
      settled = true;
      const remember = checkbox.checked;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve({ archiveChildren, remember });
    };
    parentOnly.addEventListener("click", () => finish(false));
    archiveAll.addEventListener("click", () => finish(true));
    // Escape and other dismissals keep the parent-only outcome.
    dialog.addEventListener("close", () => finish(false));
    dialog.addEventListener("cancel", () => finish(false));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        const inside =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;
        if (!inside) finish(false);
      }
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    archiveAll.focus();
  });
}

/** Non-modal notice above the Sidebar listing children that stayed unarchived. */
export function showArchiveChildrenNotice(
  document: Document,
  input: { heading: string; message: string; titles: readonly string[]; separator: string },
): HTMLElement {
  const view = document.defaultView ?? window;
  document.querySelector("[data-codexhost-archive-children-notice]")?.remove();
  const notice = document.createElement("div");
  notice.dataset.codexhostArchiveChildrenNotice = "true";
  notice.setAttribute("role", "alert");
  notice.setAttribute("aria-live", "assertive");
  notice.setAttribute("aria-atomic", "true");
  notice.style.cssText =
    "position:fixed;left:12px;bottom:12px;box-sizing:border-box;max-width:min(360px,calc(100vw - 24px));padding:10px 12px;font:13px/1.45 system-ui,sans-serif;letter-spacing:0;text-align:left;overflow-wrap:anywhere;cursor:pointer;z-index:2147483647";
  applyRendererPopoverChrome(notice);
  notice.style.boxShadow =
    "0 10px 24px light-dark(rgba(15, 23, 42, 0.12), rgba(0, 0, 0, 0.42)), 0 2px 8px light-dark(rgba(15, 23, 42, 0.06), rgba(0, 0, 0, 0.28))";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:flex-start;gap:8px";
  const mark = document.createElement("span");
  mark.style.cssText =
    "display:inline-flex;flex:none;margin-top:1px;color:var(--color-text-danger, #c2413b)";
  mark.append(
    createElement(CircleAlert, {
      width: 16,
      height: 16,
      "aria-hidden": "true",
      focusable: "false",
      "stroke-width": 1.8,
    }),
  );
  const copy = document.createElement("div");
  copy.style.minWidth = "0";
  const heading = document.createElement("div");
  heading.style.fontWeight = "600";
  heading.textContent = input.heading;
  const message = document.createElement("div");
  message.style.cssText = `margin-top:2px;color:${MUTED}`;
  const names = input.titles.filter(Boolean);
  message.textContent =
    names.length > 0 ? `${names.join(input.separator)} — ${input.message}` : input.message;
  copy.append(heading, message);
  row.append(mark, copy);
  notice.append(row);
  document.body.append(notice);

  let timer: number | undefined;
  const hide = (): void => {
    if (timer !== undefined) view.clearTimeout(timer);
    notice.remove();
    document.removeEventListener("keydown", onKeyDown, true);
  };
  const schedule = (): void => {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = view.setTimeout(hide, ARCHIVE_CHILDREN_NOTICE_MS);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") hide();
  };
  notice.addEventListener("pointerenter", () => {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = undefined;
  });
  notice.addEventListener("pointerleave", schedule);
  notice.addEventListener("click", hide);
  document.addEventListener("keydown", onKeyDown, true);
  schedule();
  return notice;
}

export interface RendererSidebarArchiveChildren {
  /** Subscribe to archive notifications for these Hosts; replaced clients resubscribe. */
  observeHosts(hostIds: Iterable<string>): void;
  dispose(): void;
}

export function installRendererSidebarArchiveChildren(options: {
  ownerWindow: Window;
  tree: Pick<RendererSidebarThreadTree, "liveDescendants">;
  getClient(hostId: string): RendererModelClient | null;
  locale(): RendererSettingsLocale;
}): RendererSidebarArchiveChildren {
  const { ownerWindow } = options;
  const document = ownerWindow.document;
  const subscriptions = new Map<string, { client: RendererModelClient; dispose(): void }>();
  let disposed = false;
  const cascade = createArchiveChildrenCascade({
    mode: () => readArchiveChildrenMode(ownerWindow),
    setMode: (mode) => setArchiveChildrenMode(ownerWindow, mode),
    isActive: () => document.hasFocus(),
    descendants: (hostId, threadId) => options.tree.liveDescendants(hostId, threadId),
    ask: ({ hostId, children }) =>
      openArchiveChildrenDialog(document, {
        messages: archiveChildrenMessages(options.locale()),
        count: children.length,
        titles: children.map((child) => sidebarThreadTitle(document, hostId, child)),
      }),
    archive: (hostId, threadId) => {
      for (const row of nativeSidebarRows(document, hostId, threadId)) {
        const action = archiveActionFromSidebarRowElement(row);
        if (!action) continue;
        action();
        return true;
      }
      return false;
    },
    isListed: (hostId, threadId) => nativeSidebarRows(document, hostId, threadId).length > 0,
    reportFailures: (hostId, failures) => {
      const messages = archiveChildrenMessages(options.locale());
      showArchiveChildrenNotice(document, {
        heading: messages.failureTitle(failures.length),
        message: failures.some((failure) => failure.reason === "timeout")
          ? messages.failureTimeout
          : messages.failureUnavailable,
        titles: failures.map((failure) => sidebarThreadTitle(document, hostId, failure.threadId)),
        separator: messages.listSeparator,
      });
    },
  });

  return {
    observeHosts(hostIds) {
      if (disposed) return;
      for (const hostId of hostIds) {
        const client = options.getClient(hostId);
        const previous = subscriptions.get(hostId);
        if (previous?.client === client) continue;
        previous?.dispose();
        subscriptions.delete(hostId);
        if (!client?.subscribeThreadArchived) continue;
        try {
          const dispose = client.subscribeThreadArchived((threadId) => {
            if (subscriptions.get(hostId)?.client !== client) return;
            cascade.threadArchived(hostId, threadId);
          });
          subscriptions.set(hostId, { client, dispose });
        } catch {
          // Without a notification channel the parent archive simply does not cascade.
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions.values()) subscription.dispose();
      subscriptions.clear();
      cascade.dispose();
    },
  };
}
