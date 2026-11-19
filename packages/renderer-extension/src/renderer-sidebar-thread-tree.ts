import {
  THREAD_TREE_NODES_MAX_LENGTH,
  hostThreadIdSchema,
  type HarnessPluginDescriptor,
  type ThreadTreeNode,
} from "@codexhost/shared-contracts";

import { rendererAgentLabel } from "./renderer-agent-icon.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";
import {
  SIDEBAR_TREE_OWNED_SELECTOR,
  canRenderSidebarThreadTree,
  clearSidebarThreadTree,
  clearSidebarThreadTreeRow,
  measureSidebarThreadTreeRows,
  renderSidebarThreadTreeRoot,
  renderSidebarThreadTreeVirtual,
  setSidebarThreadTreeRowHidden,
  type SidebarThreadTreeDisplay,
  type SidebarThreadTreeHandlers,
  type SidebarThreadTreeLabels,
  type SidebarThreadTreeView,
} from "./renderer-sidebar-thread-tree-dom.js";
import {
  captureSidebarThreadTreeMotion,
  playSidebarThreadTreeMotion,
} from "./renderer-sidebar-thread-tree-motion.js";
import type { RendererSettingsLocale } from "./settings/localization.js";
import {
  planSidebarThreadTree,
  type SidebarThreadTreeRoot,
  type SidebarThreadTreeRowInput,
  type SidebarThreadTreeRowPlan,
  type SidebarThreadTreeThread,
} from "./sidebar-thread-tree.js";

/**
 * Shows the Threads a sidebar Thread delegated under it, as the Web sidebar tree does.
 *
 * The parent relation is the Host's Thread tree and is read when the set of sidebar rows
 * changes; what each Thread shows comes from `codexhost/thread/tree/nodes`. Only the cheap live
 * state is polled, and only for trees on screen. Rows of other Hosts are untouched.
 */

const LOCAL_HOST_ID = "local";
const SIDEBAR_SELECTOR = "[data-app-action-sidebar-scroll]";
const ACTIVE_ATTRIBUTE = "data-app-action-sidebar-thread-active";
const TITLE_ATTRIBUTE = "data-app-action-sidebar-thread-title";
/** Desktop marks the Composer of the open Thread with its id. */
const COMPOSER_THREAD_ATTRIBUTE = "data-above-composer-conversation-id";
/** Nodes whose arrival or removal changes what the tree shows. */
const WATCHED_SELECTOR = `${SIDEBAR_SELECTOR}, [${COMPOSER_THREAD_ATTRIBUTE}]`;
const STATUS_POLL_MS = 5_000;
/** Renames and archives of official Threads reach the sidebar no later than this. */
const STRUCTURE_REFRESH_MS = 60_000;
const ROW_CHANGE_DEBOUNCE_MS = 400;
/** Bound on the Threads described per refresh; rows past it stay as Desktop shows them. */
const MAX_DESCRIBED_THREADS = 4 * THREAD_TREE_NODES_MAX_LENGTH;
const MAX_ANCESTRY = 64;
const MAX_REMEMBERED_EXPANDED = 500;
const PLAIN: SidebarThreadTreeRowPlan = { kind: "plain" };
export const SIDEBAR_THREAD_TREE_EXPANDED_KEY = "codexhost.sidebar-thread-tree.expanded.v1";

/** The wording of the Web sidebar tree. */
export function rendererSidebarThreadTreeLabels(
  locale: RendererSettingsLocale,
): SidebarThreadTreeLabels {
  const chinese = locale === "zh-CN";
  return {
    expand: (count) => (chinese ? `展开 ${count} 个子会话` : `Expand ${count} child sessions`),
    collapse: (count) => (chinese ? `收起 ${count} 个子会话` : `Collapse ${count} child sessions`),
    status: (status) =>
      status === "question"
        ? chinese
          ? "等待回答"
          : "Waiting for an answer"
        : status === "running"
          ? chinese
            ? "正在运行"
            : "Running"
          : "",
    children: (count) => (chinese ? `${count} 个子会话` : `${count} child sessions`),
    running: (count) => (chinese ? `${count} 运行中` : `${count} running`),
    question: (count) => (chinese ? `${count} 待批准` : `${count} needs approval`),
    expandSummary: (title, summary) =>
      chinese ? `${title}，${summary}，展开` : `${title}, ${summary}, expand`,
  };
}

interface ExpandedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readExpanded(storage: ExpandedStorage | null): Set<string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(SIDEBAR_THREAD_TREE_EXPANDED_KEY) ?? "[]");
    if (Array.isArray(value))
      return new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    // An unreadable preference starts collapsed.
  }
  return new Set();
}

/** A local Thread row Desktop has mounted. */
interface MountedRow {
  element: HTMLElement;
  threadId: string;
}

export interface RendererSidebarThreadTree {
  dispose(): void;
}

export function installRendererSidebarThreadTree(options: {
  getClient(hostId: string): RendererModelClient | null;
  getPlugins?(hostId: string): readonly HarnessPluginDescriptor[] | undefined;
  getLocale(): RendererSettingsLocale;
  /** Opens a Thread that has no mounted sidebar row, through Desktop's own router. */
  openThread(threadId: string): Promise<void>;
  /** Whether Desktop lays out a row's list; a collapsed project keeps its rows mounted. */
  isRowListVisible?(row: HTMLElement): boolean;
  storage?: ExpandedStorage | null;
  root?: Document;
}): RendererSidebarThreadTree {
  const root = options.root ?? document;
  const view = root.defaultView ?? window;
  const storage =
    options.storage !== undefined
      ? options.storage
      : (() => {
          try {
            return view.localStorage;
          } catch {
            return null;
          }
        })();
  const isRowListVisible =
    options.isRowListVisible ??
    ((row: HTMLElement) => {
      const list = row.closest('[role="listitem"]')?.parentElement;
      return list !== null && list !== undefined && list.getClientRects().length > 0;
    });

  let disposed = false;
  let unavailable = false;
  /** The Host client the tree was last read from; a replaced client is read again. */
  let structureClient: RendererModelClient | null = null;
  let parents: Readonly<Record<string, string>> = {};
  /** null: the Host no longer has the Thread. */
  const nodes = new Map<string, ThreadTreeNode | null>();
  /** Threads whose title and archive state were read since the last structure refresh. */
  const described = new Set<string>();
  const expanded = readExpanded(storage);
  /** The open Thread whose ancestors were already expanded for it. */
  let expandedForThreadId: string | null = null;
  let wanted: string[] = [];
  let rowSignature = "";
  let generation = 0;
  let structureBusy = false;
  let structureQueued = false;
  let statusBusy = false;
  let applyScheduled = false;
  let rowChangeTimer: ReturnType<typeof setTimeout> | undefined;
  const listIds = new WeakMap<Element, string>();
  let nextListId = 0;

  const saveExpanded = (): void => {
    try {
      storage?.setItem(
        SIDEBAR_THREAD_TREE_EXPANDED_KEY,
        JSON.stringify([...expanded].slice(-MAX_REMEMBERED_EXPANDED)),
      );
    } catch {
      // The choice still holds for this window.
    }
  };

  const mountedRows = (): MountedRow[] => {
    const rows: MountedRow[] = [];
    for (const element of root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)) {
      if (element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE) !== LOCAL_HOST_ID) continue;
      const threadId = threadIdFromSidebarRowElement(element);
      if (threadId) rows.push({ element, threadId });
    }
    return rows;
  };

  const byThread = (rows: readonly MountedRow[]): Map<string, HTMLElement[]> => {
    const map = new Map<string, HTMLElement[]>();
    for (const { element, threadId } of rows) {
      const list = map.get(threadId);
      if (list) list.push(element);
      else map.set(threadId, [element]);
    }
    return map;
  };

  const signatureOf = (rows: ReadonlyMap<string, unknown>): string =>
    [...rows.keys()].sort().join("\n");

  /** The sidebar list a row belongs to; each list shows a tree once. */
  const listOf = (row: HTMLElement): string => {
    const list = row.closest('[role="listitem"]')?.parentElement ?? row;
    let id = listIds.get(list);
    if (id === undefined) listIds.set(list, (id = String((nextListId += 1))));
    return id;
  };

  const childrenIndex = (): Map<string, string[]> => {
    const index = new Map<string, string[]>();
    for (const [childId, parentId] of Object.entries(parents)) {
      const siblings = index.get(parentId);
      if (siblings) siblings.push(childId);
      else index.set(parentId, [childId]);
    }
    return index;
  };

  /** The highest ancestor of `threadId` in the relation, or itself. */
  const topmostOf = (threadId: string): string => {
    const seen = new Set([threadId]);
    let top = threadId;
    for (
      let parentId = parents[top];
      parentId !== undefined && !seen.has(parentId) && seen.size <= MAX_ANCESTRY;
      parentId = parents[top]
    ) {
      seen.add(parentId);
      top = parentId;
    }
    return top;
  };

  /**
   * Every Thread the trees of `threadIds` can show: the topmost ancestor of each row in the
   * relation and everything below it, nearest first, up to the described bound.
   */
  const treeMembersOf = (threadIds: Iterable<string>): string[] => {
    const index = childrenIndex();
    const found = new Set<string>();
    for (const threadId of threadIds) {
      if (parents[threadId] === undefined && !index.has(threadId)) continue;
      found.add(topmostOf(threadId));
    }
    let level = [...found];
    while (level.length > 0 && found.size < MAX_DESCRIBED_THREADS) {
      const next: string[] = [];
      for (const threadId of level) {
        for (const childId of index.get(threadId) ?? []) {
          if (found.has(childId) || found.size >= MAX_DESCRIBED_THREADS) continue;
          found.add(childId);
          next.push(childId);
        }
      }
      level = next;
    }
    return [...found].slice(0, MAX_DESCRIBED_THREADS);
  };

  const plugin = (harnessId: string): HarnessPluginDescriptor | undefined =>
    harnessId === "codex"
      ? undefined
      : options.getPlugins?.(LOCAL_HOST_ID)?.find(({ id }) => id === harnessId);

  const navigate = (threadId: string): void => {
    // A mounted row, even a hidden one, keeps navigation entirely Desktop's own. Rows are read
    // now: Desktop may have replaced or unmounted the one an earlier pass saw.
    const row = mountedRows().find((candidate) => candidate.threadId === threadId)?.element;
    if (row?.isConnected) row.click();
    else
      void options.openThread(threadId).catch((error: unknown) => {
        console.error("codexhost could not open the delegated Thread", error);
      });
  };

  /** The open Thread: the Composer names it even when it has no sidebar row. */
  const openThreadId = (rows: ReadonlyMap<string, HTMLElement[]>): string | null => {
    const composers = new Set<string>();
    for (const portal of root.querySelectorAll(`[${COMPOSER_THREAD_ATTRIBUTE}]`)) {
      const threadId = portal.getAttribute(COMPOSER_THREAD_ATTRIBUTE);
      if (threadId) composers.add(threadId);
    }
    if (composers.size === 1) return [...composers][0] ?? null;
    for (const [threadId, list] of rows) {
      if (list.some((row) => row.getAttribute(ACTIVE_ATTRIBUTE) === "true")) return threadId;
    }
    return null;
  };

  const toggle = (threadId: string, source: Element): void => {
    if (disposed) return;
    const item = source.closest<HTMLElement>('[role="listitem"]');
    const motion = item ? captureSidebarThreadTreeMotion(item) : null;
    if (expanded.has(threadId)) expanded.delete(threadId);
    else expanded.add(threadId);
    saveExpanded();
    // Laid out now, so the motion can start from the positions just recorded.
    apply();
    if (motion) playSidebarThreadTreeMotion(motion);
  };

  // A row press only opens: on the Web it also folds the open Thread, but on Desktop the first
  // press of a double-click on the open row's title is the start of a rename.
  const handlers: SidebarThreadTreeHandlers = { toggle, open: navigate };

  const apply = (): void => {
    applyScheduled = false;
    if (disposed) return;
    const mounted = mountedRows();
    const rows = byThread(mounted);
    // Without a Host to describe them, tree rows would show a stale title and state.
    if (options.getClient(LOCAL_HOST_ID) === null) withdraw();
    else if (clientChanged()) void refreshStructure();
    const signature = signatureOf(rows);
    if (signature !== rowSignature) {
      rowSignature = signature;
      // New or removed rows usually mean a delegation, an archive or a pin changed. A read
      // that is under way compares the rows it used with these when it finishes.
      clearTimeout(rowChangeTimer);
      if (!structureBusy)
        rowChangeTimer = setTimeout(() => void refreshStructure(), ROW_CHANGE_DEBOUNCE_MS);
    }

    const current = openThreadId(rows);
    // Opening a Thread expands its ancestors once; they can be collapsed again afterwards.
    // The Thread stays pending until the tree places it: it may be open before the tree is read.
    if (current === null || parents[current] === undefined) expandedForThreadId = null;
    else if (current !== expandedForThreadId) {
      expandedForThreadId = current;
      let changed = false;
      const seen = new Set<string>([current]);
      for (
        let parentId: string | undefined = parents[current];
        parentId !== undefined && !seen.has(parentId);
        parentId = parents[parentId]
      ) {
        seen.add(parentId);
        if (!expanded.has(parentId)) {
          expanded.add(parentId);
          changed = true;
        }
      }
      if (changed) saveExpanded();
    }

    // Rows of collapsed lists are left to Desktop until they are shown again.
    const planned: (MountedRow & SidebarThreadTreeRowInput & { renderable: boolean })[] = [];
    for (const row of mounted) {
      if (!isRowListVisible(row.element)) continue;
      planned.push({
        ...row,
        key: String(planned.length),
        list: listOf(row.element),
        renderable: canRenderSidebarThreadTree(row.element),
      });
    }
    wanted = treeMembersOf(new Set(planned.map((row) => row.threadId)));

    const threads = new Map<string, SidebarThreadTreeThread>();
    for (const [threadId, node] of nodes) {
      if (!node) continue;
      threads.set(threadId, {
        status: node.status,
        archived: node.archived !== false,
        order: node.delegatedAt ? Date.parse(node.delegatedAt) || 0 : 0,
      });
    }
    const plans = planSidebarThreadTree({
      parents,
      threads,
      rows: planned,
      expanded: (threadId) => expanded.has(threadId),
    });
    // A tree whose place is a row it cannot be attached to shows nothing in that list, so
    // nothing may be hidden for it there.
    const broken = new Set<string>();
    for (const row of planned) {
      const plan = plans.get(row.key);
      if (!row.renderable && (plan?.kind === "root" || plan?.kind === "virtual"))
        broken.add(`${row.list}\u0000${plan.tree.threadId}`);
    }

    const nativeTitle = (threadId: string): string | undefined =>
      rows.get(threadId)?.[0]?.getAttribute(TITLE_ATTRIBUTE)?.trim() || undefined;
    const display = (threadId: string): SidebarThreadTreeDisplay => {
      const harnessId = nodes.get(threadId)?.harnessId ?? "codex";
      const harnessPlugin = plugin(harnessId);
      return {
        title:
          nativeTitle(threadId) ??
          nodes.get(threadId)?.title ??
          rendererAgentLabel(harnessId, harnessPlugin),
        agent: harnessId,
        plugin: harnessPlugin,
        current: threadId === current,
      };
    };
    const viewOf = (tree: SidebarThreadTreeRoot): SidebarThreadTreeView => ({
      ...tree,
      nodes: tree.nodes.map((node) => ({ ...node, ...display(node.threadId) })),
      root: display(tree.threadId),
    });
    const locale = options.getLocale();
    const labels = rendererSidebarThreadTreeLabels(locale);

    const resolved = planned.map((row) => {
      const plan = plans.get(row.key) ?? PLAIN;
      return !row.renderable ||
        (plan.kind === "hidden" && broken.has(`${row.list}\u0000${plan.rootId}`))
        ? { row, plan: PLAIN }
        : { row, plan };
    });
    // Every list that shows a tree is measured before anything is written.
    measureSidebarThreadTreeRows(
      resolved
        .filter(({ plan }) => plan.kind === "root" || plan.kind === "virtual")
        .map(({ row }) => row.element),
    );

    const touched = new Set<HTMLElement>();
    for (const { row, plan } of resolved) {
      touched.add(row.element);
      if (plan.kind === "root" || plan.kind === "virtual") {
        setSidebarThreadTreeRowHidden(row.element, false);
        const render =
          plan.kind === "root" ? renderSidebarThreadTreeRoot : renderSidebarThreadTreeVirtual;
        render(row.element, viewOf(plan.tree), labels, handlers, locale);
        continue;
      }
      clearSidebarThreadTreeRow(row.element);
      setSidebarThreadTreeRowHidden(row.element, plan.kind === "hidden");
    }
    for (const { element } of mounted) {
      if (touched.has(element)) continue;
      clearSidebarThreadTreeRow(element);
      setSidebarThreadTreeRowHidden(element, false);
    }
    // Rows shown for the first time are described before they can move into a tree.
    if (wanted.some((threadId) => !described.has(threadId))) void describe();
  };

  const scheduleApply = (): void => {
    if (disposed || applyScheduled) return;
    applyScheduled = true;
    view.requestAnimationFrame(apply);
  };

  const client = (): RendererModelClient | null =>
    unavailable ? null : options.getClient(LOCAL_HOST_ID);

  /** A reconnect replaces the client object; what an older Host lacked may now exist. */
  const clientChanged = (): boolean => {
    const source = options.getClient(LOCAL_HOST_ID);
    if (source === structureClient) return false;
    unavailable = false;
    return source !== null;
  };

  /** Reads `threadIds` in bounded batches; false when a newer refresh or disposal overtook it. */
  const readNodes = async (
    threadIds: readonly string[],
    includeOfficial: boolean,
    started: number,
  ): Promise<boolean> => {
    const source = client();
    if (!source?.listThreadTreeNodes) return false;
    for (let index = 0; index < threadIds.length; index += THREAD_TREE_NODES_MAX_LENGTH) {
      const batch = threadIds.slice(index, index + THREAD_TREE_NODES_MAX_LENGTH);
      const result = await source.listThreadTreeNodes({
        threadIds: batch.map((threadId) => hostThreadIdSchema.parse(threadId)),
        ...(includeOfficial ? { includeOfficial: true } : {}),
      });
      if (disposed || started !== generation || client() !== source) return false;
      const returned = new Map(result.threads.map((node) => [node.threadId as string, node]));
      for (const threadId of batch) {
        const node = returned.get(threadId);
        const known = nodes.get(threadId);
        if (!node) {
          // Left out of a full read: the Thread is gone. A state-only read proves nothing new.
          if (includeOfficial || known === undefined) nodes.set(threadId, null);
        } else if (includeOfficial || !known) {
          nodes.set(threadId, node);
        } else {
          // A state-only read omits what it did not look up; keep the last known values.
          nodes.set(threadId, {
            ...known,
            ...node,
            ...(node.title === undefined && known.title !== undefined
              ? { title: known.title }
              : {}),
            ...(node.archived === undefined && known.archived !== undefined
              ? { archived: known.archived }
              : {}),
          });
        }
        if (includeOfficial) described.add(threadId);
      }
    }
    return true;
  };

  /** Gives the sidebar back to Desktop: nothing is known, so nothing is nested or hidden. */
  const withdraw = (): void => {
    if (structureClient === null && nodes.size === 0 && Object.keys(parents).length === 0) return;
    generation += 1;
    structureClient = null;
    parents = {};
    nodes.clear();
    described.clear();
    wanted = [];
    scheduleApply();
  };

  const reportFailure = (error: unknown): void => {
    // An older Host has neither method: stay out of the sidebar for this connection.
    if (!(error instanceof RendererMethodUnavailableError)) return;
    const source = options.getClient(LOCAL_HOST_ID);
    withdraw();
    unavailable = true;
    structureClient = source;
  };

  let describing = false;
  const describe = async (): Promise<void> => {
    if (disposed || describing || structureBusy) return;
    const missing = wanted.filter((threadId) => !described.has(threadId));
    if (missing.length === 0) return;
    describing = true;
    const started = generation;
    try {
      if (await readNodes(missing, true, started)) scheduleApply();
    } catch (error) {
      reportFailure(error);
    } finally {
      describing = false;
    }
  };

  const refreshStructure = async (): Promise<void> => {
    if (disposed || root.visibilityState === "hidden") return;
    if (structureBusy) {
      structureQueued = true;
      return;
    }
    const source = client();
    structureClient = options.getClient(LOCAL_HOST_ID);
    if (!source?.readThreadTree || !source.listThreadTreeNodes) return;
    structureBusy = true;
    const started = (generation += 1);
    let usedSignature: string | null = null;
    try {
      const tree = await source.readThreadTree();
      if (disposed || started !== generation || client() !== source) return;
      parents = tree.parents;
      described.clear();
      const placed = new Set([...Object.keys(parents), ...Object.values(parents)]);
      for (const threadId of nodes.keys()) if (!placed.has(threadId)) nodes.delete(threadId);
      const mounted = mountedRows();
      // This read covers the rows mounted now; only a later change asks for another one.
      usedSignature = rowSignature = signatureOf(byThread(mounted));
      const threadIds = treeMembersOf(
        new Set(mounted.filter((row) => isRowListVisible(row.element)).map((row) => row.threadId)),
      );
      if (threadIds.length > 0) await readNodes(threadIds, true, started);
    } catch (error) {
      reportFailure(error);
    } finally {
      structureBusy = false;
      // The new relation is shown even when describing its Threads failed part-way.
      if (usedSignature !== null) scheduleApply();
      if (structureQueued || (usedSignature !== null && usedSignature !== rowSignature)) {
        structureQueued = false;
        void refreshStructure();
      }
    }
  };

  const pollStatus = async (): Promise<void> => {
    if (disposed || statusBusy || structureBusy || root.visibilityState === "hidden") return;
    const threadIds = wanted.filter((threadId) => {
      const node = nodes.get(threadId);
      return node !== undefined && node !== null && node.archived === false;
    });
    if (threadIds.length === 0) return;
    statusBusy = true;
    try {
      if (await readNodes(threadIds, false, generation)) scheduleApply();
    } catch (error) {
      reportFailure(error);
    } finally {
      statusBusy = false;
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target =
        mutation.target instanceof view.Element ? mutation.target : mutation.target.parentElement;
      if (!target) continue;
      // The module's own nodes and the listitems it hides must not start another pass.
      if (target.closest(SIDEBAR_TREE_OWNED_SELECTOR)) continue;
      if (mutation.attributeName === COMPOSER_THREAD_ATTRIBUTE) {
        scheduleApply();
        return;
      }
      const touchesSidebar =
        target.closest(SIDEBAR_SELECTOR) !== null ||
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) =>
            node instanceof view.Element &&
            !node.matches(SIDEBAR_TREE_OWNED_SELECTOR) &&
            (node.matches(WATCHED_SELECTOR) || node.querySelector(WATCHED_SELECTOR) !== null),
        );
      if (!touchesSidebar) continue;
      if (
        mutation.type === "childList" &&
        [...mutation.addedNodes, ...mutation.removedNodes].every(
          (node) => node instanceof view.Element && node.matches(SIDEBAR_TREE_OWNED_SELECTOR),
        )
      )
        continue;
      scheduleApply();
      return;
    }
  });
  observer.observe(root.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-app-action-sidebar-thread-row",
      "data-app-action-sidebar-thread-id",
      SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
      ACTIVE_ATTRIBUTE,
      TITLE_ATTRIBUTE,
      COMPOSER_THREAD_ATTRIBUTE,
      "data-app-action-sidebar-project-collapsed",
      "data-app-action-sidebar-section-collapsed",
    ],
    childList: true,
    subtree: true,
  });

  const statusTimer = view.setInterval(
    () => void (clientChanged() ? refreshStructure() : pollStatus()),
    STATUS_POLL_MS,
  );
  const structureTimer = view.setInterval(() => void refreshStructure(), STRUCTURE_REFRESH_MS);
  const onVisibility = (): void => {
    if (root.visibilityState !== "hidden") void refreshStructure();
  };
  root.addEventListener("visibilitychange", onVisibility);
  void refreshStructure();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      observer.disconnect();
      view.clearInterval(statusTimer);
      view.clearInterval(structureTimer);
      clearTimeout(rowChangeTimer);
      root.removeEventListener("visibilitychange", onVisibility);
      clearSidebarThreadTree(root);
      nodes.clear();
      described.clear();
    },
  };
}
