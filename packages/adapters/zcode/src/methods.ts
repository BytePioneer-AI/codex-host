/**
 * Adapter operations and the ZCode CLI requests they project to. The CLI parameter schemas are
 * strict; callers pass only native fields, and this table adds what the ZCode Services layer used
 * to add: the workspace reference, the V4 connection identity and per-method timeouts.
 */
export interface CallContext {
  workspace: { workspacePath: string; workspaceKey: string };
  connectionId: string;
}
type Params = Record<string, unknown>;
interface NativeCall {
  method: string;
  params: Params;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const CLIENT_MODE = "desktop-continuous";
const same =
  (method: string) =>
  (params: Params): NativeCall => ({ method, params });

const calls = {
  /** A deferred draft: the full model catalog, never persisted before a first input. */
  createDraftSession: (_: Params, context: CallContext) => ({
    method: "session/create",
    params: { workspace: context.workspace, persistence: "deferred" },
  }),
  resumeSession: (params: Params, context: CallContext) => ({
    method: "session/resume",
    params: { ...params, workspace: context.workspace },
  }),
  readSession: same("session/read"),
  closeSession: same("session/close"),
  setModel: same("session/setModel"),
  setThoughtLevel: same("session/setThoughtLevel"),
  setMode: same("session/setMode"),
  compactSession: (params: Params) => ({
    method: "session/compact",
    params,
    timeoutMs: 5 * 60_000,
  }),
  goalSession: same("session/goal"),
  getTaskTokenUsage: same("v4/conversation/usage"),
  listSessionSubagents: same("session/subagents"),
  subscribeConversationV4: ({ sessionId }: Params, context: CallContext) => ({
    method: "v4/conversation/subscribe",
    params: {
      topic: `conversation/${String(sessionId)}`,
      connectionId: context.connectionId,
      clientMode: CLIENT_MODE,
      workspace: context.workspace,
    },
  }),
  unsubscribeConversationV4: ({ sessionId, subscriptionId }: Params, context: CallContext) => ({
    method: "v4/conversation/unsubscribe",
    params: {
      topic: `conversation/${String(sessionId)}`,
      subscriptionId,
      connectionId: context.connectionId,
    },
  }),
  conversationRowsRangeV4: (params: Params) => ({
    method: "v4/conversation/rowsRange",
    params: { ...params, clientMode: CLIENT_MODE },
  }),
  conversationFileChangesV4: same("v4/conversation/fileChanges"),
} satisfies Record<string, (params: Params, context: CallContext) => NativeCall>;

export type NativeMethod = keyof typeof calls;
export function nativeCall(method: NativeMethod, params: Params, context: CallContext): NativeCall {
  return calls[method](params, context);
}
