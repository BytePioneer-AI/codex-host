import type { RendererHostRpcManager } from "@codexhost/desktop-control/renderer-bindings";
import { loadCodexNativeServices } from "./codex-native-services.js";

type ThreadKey = { hostId: string; threadId: string };
interface ThreadCatalog {
  readEntries(keys: ThreadKey[]): Promise<unknown>;
  notifyThread(key: ThreadKey, action: "remove"): Promise<unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sidebarCatalogForWindow(load: () => Promise<ThreadCatalog | null>) {
  let cached: Promise<ThreadCatalog> | undefined;
  return () =>
    (cached ??= load()
      .then((catalog) => {
        if (!catalog) throw new Error("Desktop thread catalog is not available");
        return catalog;
      })
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      }));
}

export async function loadSidebarCatalog(view: Window): Promise<ThreadCatalog | null> {
  const services = await loadCodexNativeServices(
    view,
    (value): value is { localThreadCatalog: ThreadCatalog } =>
      record(value) &&
      Object.hasOwn(value, "appServerManagers") &&
      Object.hasOwn(value, "localThreadCatalog") &&
      typeof (value.localThreadCatalog as ThreadCatalog | null)?.notifyThread === "function" &&
      typeof (value.localThreadCatalog as ThreadCatalog | null)?.readEntries === "function",
  );
  return services?.localThreadCatalog ?? null;
}

export function observeRemoteSidebarClosures(
  view: Window,
  closed: (host: string, id: string) => void,
) {
  const listen = ({ data, source }: MessageEvent<unknown>) => {
    if (
      (source !== null && source !== view) ||
      !record(data) ||
      data.type !== "mcp-notification" ||
      typeof data.hostId !== "string" ||
      !data.hostId.startsWith("remote-ssh") ||
      !record(data.params) ||
      typeof data.params.threadId !== "string"
    )
      return;
    if (
      data.method === "thread/closed" ||
      (data.method === "thread/status/changed" &&
        record(data.params.status) &&
        data.params.status.type === "notLoaded")
    )
      closed(data.hostId, data.params.threadId);
  };
  view.addEventListener("message", listen);
  return () => view.removeEventListener("message", listen);
}

function emptyCachedThread(value: unknown, key: ThreadKey, cwd: string): boolean {
  return (
    record(value) &&
    value.id === key.threadId &&
    value.hostId === key.hostId &&
    value.cwd === cwd &&
    (!value.title || value.title === cwd) &&
    value.modelProvider !== "codexhost" &&
    value.resumeState === "needs_resume" &&
    record(value.threadRuntimeStatus) &&
    value.threadRuntimeStatus.type === "notLoaded" &&
    Array.isArray(value.requests) &&
    value.requests.length === 0 &&
    Array.isArray(value.turns) &&
    value.turns.length === 0
  );
}

/** Called for an SSH row with confirmed native ownership. Metadata-only thread/read
 * consults both persisted history and live threads (including pre-first-turn drafts).
 * A missing list page or an unavailable Harness is never evidence of removal. */
export async function reconcileRemoteSidebarThread(
  manager: Pick<
    RendererHostRpcManager,
    "getConversation" | "discardConversationFromCache" | "sendRequest"
  >,
  key: ThreadKey,
  cwd: string,
  catalogForWindow: () => Promise<ThreadCatalog | null>,
  isCurrent: () => boolean,
): Promise<void> {
  if (!manager.getConversation || !manager.discardConversationFromCache || !isCurrent()) return;
  try {
    await manager.sendRequest("thread/read", { threadId: key.threadId, includeTurns: false });
    return;
  } catch (error) {
    if (!record(error) || (error.jsonRpcCode ?? error.code) !== -32600) throw error;
    if (error.message !== `thread not loaded: ${key.threadId}`) return;
  }
  if (!isCurrent()) return;
  const catalog = await catalogForWindow();
  if (!catalog || !isCurrent()) return;
  const entries = await catalog.readEntries([key]);
  if (!Array.isArray(entries) || entries.length > 1) return;
  const entry: unknown = entries[0];
  if (
    entry != null &&
    (!record(entry) ||
      entry.hostId !== key.hostId ||
      entry.threadId !== key.threadId ||
      entry.modelProvider === "codexhost" ||
      entry.cwd !== cwd ||
      entry.displayTitle !== cwd)
  )
    return;
  const cached = await manager.getConversation(key.threadId);
  if (!isCurrent() || (cached != null && !emptyCachedThread(cached, key, cwd))) return;
  // Evict recents first. Removing the catalog entry first can leave an untitled
  // recent row without its cwd label if the connection breaks between the calls.
  if (cached != null) await manager.discardConversationFromCache(key.threadId);
  if (entry != null && isCurrent()) await catalog.notifyThread(key, "remove");
}
