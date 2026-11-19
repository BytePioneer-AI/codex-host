import { decodeHarnessPluginRoute, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { committedReactAncestors } from "./renderer-react-ownership.js";
import { discoverRendererHosts, type RendererHostRoot } from "./renderer-host-discovery.js";
import type { RendererHostRouting } from "./renderer-host-routing.js";
import { createRpcScheduleWorkspaceThread } from "./renderer-schedule-workspace-rpc.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface NativeScheduleWorkspace {
  id: string;
  label: string;
  cwd: string;
}
export interface NativeScheduleWorkspaceThread {
  threadId: string;
  /** The official form may now save this Thread as its target; never archive it on dismissal. */
  retain(): void;
  /** Awaitable cleanup for an unsubmitted RPC-created Thread. */
  discard?(): Promise<void>;
}

/** Desktop 26.1023 sidebar project catalog includes collapsed groups. */
export function readNativeScheduleWorkspaces(root: RendererHostRoot): NativeScheduleWorkspace[] {
  const projects = new Map<string, NativeScheduleWorkspace>();
  const ambiguous = new Set<string>();
  const seen = new Set<unknown>();
  const add = (value: unknown) => {
    if (!record(value) || value.source !== "codex" || !record(value.group)) return;
    const group = value.group;
    if (
      group.projectKind !== "local" ||
      (group.hostId != null && group.hostId !== "local") ||
      typeof group.projectId !== "string" ||
      !group.projectId ||
      typeof group.label !== "string" ||
      typeof group.path !== "string" ||
      !Array.isArray(group.rootPaths) ||
      !group.rootPaths.includes(group.path) ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(group.path) ||
      group.path.includes("\0")
    )
      return;
    const next = { id: group.projectId, label: group.label || group.path, cwd: group.path };
    const previous = projects.get(next.id);
    if (previous && previous.cwd !== next.cwd) ambiguous.add(next.id);
    else projects.set(next.id, next);
  };
  for (const element of root.querySelectorAll("aside [data-sidebar-cycle-item]")) {
    const keys = Object.getOwnPropertyNames(element).filter((key) =>
      key.startsWith("__reactFiber$"),
    );
    const key = keys[0];
    if (keys.length !== 1 || !key) continue;
    for (const fiber of committedReactAncestors(Reflect.get(element, key))) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      if (!record(props)) continue;
      add(props.project);
      if (props.projectByKey instanceof Map)
        for (const project of props.projectByKey.values()) add(project);
    }
  }
  return [...projects.values()].filter(({ id }) => !ambiguous.has(id));
}

export type NativeProjectThreadCreator = (input: {
  scope: unknown;
  target: { type: "project"; projectId: string; environment: { type: "local" } };
  model: string;
  title: string;
  prompt: "";
  startWithoutFirstTurn: true;
  assertRequestCurrent?(): void;
  onSettled(result: unknown): void;
}) => Promise<unknown>;

/** The exported native createThread API supports project preparation, permissions
 * and empty-chat creation. Discover by its reviewed contract, not an export alias. */
export function isNativeProjectThreadCreator(value: unknown): value is NativeProjectThreadCreator {
  try {
    if (typeof value !== "function" || value.length !== 1) return false;
    const source = Function.prototype.toString.call(value);
    return (
      /^async function/u.test(source) &&
      source.includes("startWithoutFirstTurn:") &&
      source.includes("onSettled:") &&
      source.includes("createThread config is not supported for delegated thread creation") &&
      source.includes(
        "createThread serviceName is only supported for local Electron root threads outside worktrees",
      )
    );
  } catch {
    // Native toString polyfills and callable RPC proxies can reject inspection.
    return false;
  }
}

/** Only the explicit external-workspace branch calls this. Native createThread
 * owns project preparation, permissions and Thread registration; no task CRUD. */
export async function createNativeScheduleWorkspaceThread(
  root: RendererHostRoot,
  routing: RendererHostRouting,
  createThread: NativeProjectThreadCreator,
  input: { workspace: NativeScheduleWorkspace; model: string; title: string },
  signal: AbortSignal,
): Promise<NativeScheduleWorkspaceThread> {
  if (!decodeHarnessPluginRoute(input.model)) throw new Error("An external Harness is required");
  const route = routing.forHost("local");
  if (route && Reflect.get(route.manager, "kind") === "main-process-rpc") {
    if (
      !readNativeScheduleWorkspaces(root).some(
        ({ id, cwd }) => id === input.workspace.id && cwd === input.workspace.cwd,
      )
    )
      throw new Error("The selected workspace is no longer available");
    return createRpcScheduleWorkspaceThread(root, routing, route, createThread, input, signal);
  }
  const manager = route?.manager as unknown as RecordValue | undefined;
  if (
    !route?.policy.scopedCreation ||
    !manager ||
    typeof manager.getConversation !== "function" ||
    typeof manager.archiveConversation !== "function"
  )
    throw new Error("Native local chat creation is unavailable");
  const discovery = discoverRendererHosts({
    querySelectorAll: () => root.querySelectorAll("main"),
  });
  const scopes = new Set(
    discovery.registries.flatMap((registry) => {
      try {
        return registry.getForHostId("local") === manager ? [Reflect.get(registry, "scope")] : [];
      } catch {
        return [];
      }
    }),
  );
  const scope = scopes.values().next().value;
  if (scopes.size !== 1 || !record(scope) || typeof scope.get !== "function")
    throw new Error("Native local chat scope is missing or ambiguous");
  if (
    !readNativeScheduleWorkspaces(root).some(
      ({ id, cwd }) => id === input.workspace.id && cwd === input.workspace.cwd,
    )
  )
    throw new Error("The selected workspace is no longer available");
  signal.throwIfAborted();
  let createdId: string | null = null;
  let released = false;
  const discard = () => {
    if (!createdId || released) return;
    const id = createdId;
    released = true;
    // Do not archive a chat that the user has already started using.
    const conversation = (manager.getConversation as (id: string) => unknown)(id);
    if (
      !record(conversation) ||
      !Array.isArray(conversation.turns) ||
      conversation.turns.length ||
      (Array.isArray(conversation.requests) && conversation.requests.length > 0) ||
      conversation.pendingRequest != null
    )
      return;
    void Promise.resolve()
      .then(() =>
        (manager.archiveConversation as (id: string, options: unknown) => unknown)(id, {
          useAppServerPins: false,
          source: "automation_history",
        }),
      )
      .catch(() => undefined);
  };
  signal.addEventListener("abort", discard, { once: true });
  const remember = (result: unknown) => {
    if (!record(result) || result.status !== "created") return;
    const id = hostThreadIdSchema.safeParse(result.conversationId);
    if (id.success) createdId = id.data;
    if (signal.aborted) discard();
  };
  const output = await createThread({
    scope,
    target: { type: "project", projectId: input.workspace.id, environment: { type: "local" } },
    model: input.model,
    title: input.title,
    prompt: "",
    startWithoutFirstTurn: true,
    onSettled: remember,
  });
  const result = record(output) && output.kind === "creation" ? output.result : null;
  remember(result);
  signal.throwIfAborted();
  if (
    !record(result) ||
    result.status !== "created" ||
    !createdId ||
    !record(result.firstTurn) ||
    result.firstTurn.status !== "not-requested"
  )
    throw new Error(
      "Chat creation was not confirmed. Check the chat list before creating another task.",
    );
  if (routing.forHost("local")?.manager !== route.manager)
    throw new Error("The local connection changed. Reopen the task dialog.");
  const conversation = (manager.getConversation as (id: string) => unknown)(createdId);
  const mode = record(conversation) ? conversation.latestCollaborationMode : null;
  if (
    !record(conversation) ||
    conversation.cwd !== input.workspace.cwd ||
    !record(mode) ||
    !record(mode.settings) ||
    mode.settings.model !== input.model
  )
    throw new Error("The created chat's workspace or Model could not be confirmed");
  return {
    threadId: createdId,
    retain() {
      released = true;
      signal.removeEventListener("abort", discard);
    },
  };
}
