import { hostThreadIdSchema, threadInspectionSchema } from "@codexhost/shared-contracts";
import type { RendererHostRoot } from "./renderer-host-discovery.js";
import type { RendererHostRoute, RendererHostRouting } from "./renderer-host-routing.js";
import {
  findRendererHostRpcFamily,
  resolveRendererHostRpc,
  type RendererHostRpcStore,
} from "./renderer-host-rpc-discovery.js";
import { committedReactAncestors } from "./renderer-react-ownership.js";
import type {
  NativeProjectThreadCreator,
  NativeScheduleWorkspace,
  NativeScheduleWorkspaceThread,
} from "./renderer-schedule-workspace.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Root useScope handles share one app store. Never borrow a Composer's draft scope. */
function localAppScope(root: RendererHostRoot) {
  const scopes = new Map<
    unknown,
    { handle: Record<string, unknown>; store: RendererHostRpcStore }
  >();
  const seen = new Set<unknown>();
  for (const main of root.querySelectorAll("main")) {
    const keys = Object.getOwnPropertyNames(main).filter((key) => key.startsWith("__reactFiber$"));
    const key = keys[0];
    if (keys.length !== 1 || !key) continue;
    for (const fiber of committedReactAncestors(Reflect.get(main, key))) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      let hook = fiber.memoizedState;
      for (let n = 0; record(hook) && "next" in hook && n < 150; n++, hook = hook.next) {
        const handle = record(hook.memoizedState) ? hook.memoizedState.current : null;
        if (
          !record(handle) ||
          !record(handle.node) ||
          handle.node.parent != null ||
          !("chain" in handle) ||
          !("scope" in handle) ||
          typeof handle.get !== "function" ||
          typeof handle.set !== "function" ||
          typeof handle.watch !== "function" ||
          !(handle.node.familyBindings instanceof Map)
        )
          continue;
        scopes.set(handle.node, { handle, store: handle.node as unknown as RendererHostRpcStore });
      }
    }
  }
  const scope = scopes.values().next().value;
  if (scopes.size !== 1 || !scope)
    throw new Error("Native local app scope is missing or ambiguous");
  const discovery = findRendererHostRpcFamily(scope.store);
  const rpc = discovery && resolveRendererHostRpc(discovery, "local");
  if (!discovery || !rpc) throw new Error("Native local app RPC is unavailable");
  return { ...scope, discovery, rpc };
}

/** Desktop's project creator forwards its explicit Model to collaborationMode;
 * unlike Composer creation it needs no selected-draft carrier or global policy.select.
 * Project preparation, permission selection, title and sidebar registration stay native.
 */
export async function createRpcScheduleWorkspaceThread(
  root: RendererHostRoot,
  routing: RendererHostRouting,
  route: RendererHostRoute,
  createThread: NativeProjectThreadCreator,
  input: { workspace: NativeScheduleWorkspace; model: string; title: string },
  signal: AbortSignal,
): Promise<NativeScheduleWorkspaceThread> {
  if (!route.policy.scopedCreation) throw new Error("Native local chat creation is unavailable");
  const scope = localAppScope(root);
  const assertConnection = () => {
    if (
      routing.forHost("local")?.manager !== route.manager ||
      resolveRendererHostRpc(scope.discovery, "local") !== scope.rpc
    )
      throw new Error("The local connection changed. Reopen the task dialog.");
  };
  const assertCurrent = () => {
    signal.throwIfAborted();
    assertConnection();
  };
  const request = async (method: string, params: unknown) => {
    assertConnection();
    return route.manager.sendRequest(method, params);
  };
  const readEmpty = async (threadId: string) => {
    const read = await request("thread/read", { threadId, includeTurns: false });
    if (
      !record(read) ||
      !record(read.thread) ||
      read.thread.id !== threadId ||
      !record(read.thread.status)
    )
      throw new Error("The created chat could not be read");
    // Metadata reads omit Turns. A one-entry history page also supports paginated Harnesses.
    const turns = await request("thread/turns/list", { threadId, cursor: null, limit: 1 });
    const queue = await request("thread/queue/list", { threadId, cursor: null, limit: 1 });
    if (
      !record(turns) ||
      !Array.isArray(turns.data) ||
      !("nextCursor" in turns) ||
      !record(queue) ||
      !Array.isArray(queue.data) ||
      !("nextCursor" in queue)
    )
      throw new Error("The created chat's history or queue could not be confirmed");
    return {
      thread: read.thread,
      empty:
        read.thread.status.type === "idle" &&
        turns.data.length === 0 &&
        turns.nextCursor === null &&
        queue.data.length === 0 &&
        queue.nextCursor === null,
    };
  };
  assertCurrent();
  let createdId: string | null = null;
  let retained = false;
  let failed = false;
  let cleanup: Promise<void> | undefined;
  const discard = (): Promise<void> => {
    if (!createdId || retained) return Promise.resolve();
    const threadId = createdId;
    return (cleanup ??= (async () => {
      const { empty } = await readEmpty(threadId);
      if (!empty || retained) return;
      await request("thread/archive", { threadId });
    })());
  };
  const discardAfterDismissal = () => {
    void discard().catch((error: unknown) => {
      console.error("Could not discard the unsubmitted schedule chat. Check the chat list.", error);
    });
  };
  signal.addEventListener("abort", discardAfterDismissal, { once: true });
  const remember = (result: unknown) => {
    if (!record(result) || result.status !== "created") return;
    const id = hostThreadIdSchema.safeParse(result.conversationId);
    if (!id.success) return;
    if (createdId && createdId !== id.data)
      throw new Error("Chat creation returned conflicting identities");
    createdId = id.data;
    if (signal.aborted || failed) discardAfterDismissal();
  };
  try {
    const output = await createThread({
      scope: scope.handle,
      target: { type: "project", projectId: input.workspace.id, environment: { type: "local" } },
      model: input.model,
      title: input.title,
      prompt: "",
      startWithoutFirstTurn: true,
      assertRequestCurrent: assertCurrent,
      onSettled: remember,
    });
    const result = record(output) && output.kind === "creation" ? output.result : null;
    remember(result);
    assertCurrent();
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
    const { thread, empty } = await readEmpty(createdId);
    const inspection = threadInspectionSchema.parse(
      await request("codexhost/thread/inspect", { threadId: createdId }),
    );
    assertCurrent();
    if (
      !empty ||
      thread.cwd !== input.workspace.cwd ||
      inspection.owner !== "external" ||
      inspection.transportModelId !== input.model
    )
      throw new Error("The created chat's workspace, Model or empty state could not be confirmed");
    return {
      threadId: createdId,
      discard,
      retain() {
        retained = true;
        signal.removeEventListener("abort", discardAfterDismissal);
      },
    };
  } catch (error) {
    failed = true;
    try {
      await discard();
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; Chat cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Check the chat list.`,
      );
    }
    throw error;
  }
}
