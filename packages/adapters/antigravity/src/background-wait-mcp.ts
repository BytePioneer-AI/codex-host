import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import { nativeBrainRoot, nativeConversationSummariesDbPath } from "./fork.js";
import { antigravityHome } from "./usage-statistics.js";

export const ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME = "codexhost_background";
export const ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME = "wait_for_background_task";
export const ANTIGRAVITY_BACKGROUND_MCP_FLAG = "--codexhost-antigravity-bg-mcp";
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
const FALLBACK_RECHECK_MS = 1_000;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;
const TASK_SUFFIX_PATTERN = /^task-\d+$/u;

const TRUSTED_QUALIFIED_WAIT_TOOL_NAMES = new Set([
  `${ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME}_${ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME}`,
  `mcp_${ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME}_${ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME}`,
  `mcp__${ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME}__${ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME}`,
  `${ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME}/${ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME}`,
  `${ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME}:${ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME}`,
]);

export const ANTIGRAVITY_BACKGROUND_WAIT_INSTRUCTIONS = `In Antigravity ACP sessions, ending a turn while non-daemon background work is still running prevents follow-up output from reaching the user until their next prompt.
Whenever a non-daemon command or workflow moves to the background (returning "<conversationId>/task-<step>") or you launch/message a native subagent and still need its reply in this turn, call ${ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME} with that ID before ending the turn (and call it again if a wait times out while the work is still running). Never call it for commands that already exited synchronously, IsDaemon=true long-running processes, or recurring cron schedules.`;

export function isAntigravityBackgroundWaitTool(name: string): boolean {
  return TRUSTED_QUALIFIED_WAIT_TOOL_NAMES.has(name.trim().toLowerCase());
}

function resolveMcpEntryPath(): string {
  const selfPath = fileURLToPath(import.meta.url);
  if (path.basename(selfPath) === "plugin.mjs") return selfPath;
  const dir = path.dirname(selfPath);
  const jsSibling = path.join(dir, "background-wait-mcp.js");
  if (existsSync(jsSibling)) return jsSibling;
  const distSibling = path.resolve(dir, "../dist/background-wait-mcp.js");
  if (existsSync(distSibling)) return distSibling;
  return selfPath;
}

export function createAntigravityBackgroundMcpServer(
  home: string,
  boundSessionId?: string,
): McpServer {
  return {
    name: ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME,
    command: process.execPath,
    args: [
      resolveMcpEntryPath(),
      ANTIGRAVITY_BACKGROUND_MCP_FLAG,
      "--home",
      home,
      ...(boundSessionId ? ["--session-id", boundSessionId] : []),
    ],
    env: [],
  };
}

interface ParsedTaskTarget {
  kind: "task";
  parentId: string;
  sender: string;
}

interface ParsedSubagentTarget {
  kind: "subagent";
  explicitParentId?: string;
  childId: string;
}

type ParsedWaitTarget = ParsedTaskTarget | ParsedSubagentTarget;

function parseWaitTarget(
  rawTaskId: string,
  rawConversationId?: string,
  boundSessionId?: string,
): ParsedWaitTarget | null {
  const taskId = rawTaskId.trim();
  const explicitParent = rawConversationId?.trim() || undefined;
  if (explicitParent && !SAFE_ID_PATTERN.test(explicitParent)) return null;
  if (boundSessionId && explicitParent && explicitParent !== boundSessionId) return null;
  const effectiveParent = boundSessionId ?? explicitParent;

  const slash = taskId.indexOf("/");
  if (slash >= 0) {
    const parentId = taskId.slice(0, slash);
    const suffix = taskId.slice(slash + 1);
    if (!SAFE_ID_PATTERN.test(parentId) || !TASK_SUFFIX_PATTERN.test(suffix)) return null;
    if (effectiveParent && effectiveParent !== parentId) return null;
    return { kind: "task", parentId, sender: `${parentId}/${suffix}` };
  }
  if (TASK_SUFFIX_PATTERN.test(taskId)) {
    if (!effectiveParent) return null;
    return { kind: "task", parentId: effectiveParent, sender: `${effectiveParent}/${taskId}` };
  }
  if (!SAFE_ID_PATTERN.test(taskId)) return null;
  return {
    kind: "subagent",
    ...(effectiveParent ? { explicitParentId: effectiveParent } : {}),
    childId: taskId,
  };
}

async function readMessageIndex(
  messagesDir: string,
): Promise<Record<string, boolean> | "unreadable"> {
  try {
    const raw = await readFile(path.join(messagesDir, "read.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? {} : "unreadable";
  }
}

interface StoredMessage {
  id: string;
  sender: string;
}

async function listMessagesFromSender(
  messagesDir: string,
  sender: string,
): Promise<StoredMessage[] | null> {
  const entries = await readdir(messagesDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    return null;
  });
  if (!entries) return null;
  const matched: StoredMessage[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "read.json") continue;
    try {
      const msg = JSON.parse(await readFile(path.join(messagesDir, entry), "utf8")) as {
        id?: unknown;
        sender?: unknown;
      };
      if (typeof msg.id !== "string") return null;
      if (msg.sender !== sender) continue;
      matched.push({ id: msg.id, sender });
    } catch {
      return null;
    }
  }
  return matched;
}

type SubagentSummaryLookup =
  | { state: "unavailable" }
  | { state: "foreign" }
  | { state: "matched"; parentId: string; idle: boolean };

async function lookupSubagentSummary(
  home: string,
  childId: string,
  expectedParentId?: string,
): Promise<SubagentSummaryLookup> {
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(nativeConversationSummariesDbPath(home), { readOnly: true });
    const row = db
      .prepare(
        "SELECT status, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?",
      )
      .get(childId) as { status?: unknown; parent_conversation_id?: unknown } | undefined;
    if (!row) return { state: "unavailable" };
    const parentId =
      typeof row.parent_conversation_id === "string" &&
      SAFE_ID_PATTERN.test(row.parent_conversation_id)
        ? row.parent_conversation_id
        : null;
    if (!parentId || (expectedParentId && parentId !== expectedParentId)) {
      return { state: "foreign" };
    }
    return {
      state: "matched",
      parentId,
      idle: row.status === "CASCADE_RUN_STATUS_IDLE",
    };
  } catch {
    return { state: "unavailable" };
  } finally {
    db?.close();
  }
}

async function checkSubagentSettled(
  home: string,
  brainRoot: string,
  target: ParsedSubagentTarget,
): Promise<"settled" | "pending" | "foreign"> {
  // Step 1: Verify parent-child ownership before touching any message directory.
  const ownership = await lookupSubagentSummary(home, target.childId, target.explicitParentId);
  if (ownership.state === "foreign") return "foreign";
  if (ownership.state === "unavailable") return "pending";

  const childMessagesDir = path.join(brainRoot, target.childId, ".system_generated", "messages");

  // Step 2: Confirm every parent->child dispatch is completely written and already consumed by the
  // child BEFORE checking whether the child has returned to IDLE. Because agy marks a dispatch as
  // read only after entering RUNNING for that turn, observing IDLE strictly AFTER observing
  // consumption proves the IDLE state belongs to this dispatch rather than an earlier turn.
  const [childReadIds, childDispatches] = await Promise.all([
    readMessageIndex(childMessagesDir),
    listMessagesFromSender(childMessagesDir, ownership.parentId),
  ]);
  if (
    childReadIds === "unreadable" ||
    childDispatches === null ||
    childDispatches.length === 0 ||
    !childDispatches.every((dispatch) => childReadIds[dispatch.id] === true)
  ) {
    return "pending";
  }

  // Step 3: Re-query summary status and dispatch count strictly after Step 2 so neither an older
  // pre-consumption IDLE nor a brand-new dispatch arriving mid-check can be misclassified as done.
  const [postSummary, postDispatches] = await Promise.all([
    lookupSubagentSummary(home, target.childId, ownership.parentId),
    listMessagesFromSender(childMessagesDir, ownership.parentId),
  ]);
  if (postSummary.state === "foreign") return "foreign";
  if (
    postSummary.state !== "matched" ||
    !postSummary.idle ||
    postDispatches === null ||
    postDispatches.length !== childDispatches.length
  ) {
    return "pending";
  }
  return "settled";
}

export interface WaitForBackgroundTaskInput {
  home: string;
  taskId: string;
  conversationId?: string;
  boundSessionId?: string;
  timeoutMs?: number;
  recheckIntervalMs?: number;
  signal?: AbortSignal;
}

export interface WaitForBackgroundTaskResult {
  isError?: boolean;
  message: string;
}

export async function waitForBackgroundTask(
  input: WaitForBackgroundTaskInput,
): Promise<WaitForBackgroundTaskResult> {
  const target = parseWaitTarget(input.taskId, input.conversationId, input.boundSessionId);
  if (!target) {
    return {
      isError: true,
      message:
        "Invalid or unauthorized taskId. Pass '<conversationId>/task-<step>' for background commands in this session, or a child subagent conversationId.",
    };
  }
  if (input.signal?.aborted) return { isError: true, message: "Wait cancelled." };

  const brainRoot = nativeBrainRoot(input.home);
  const summaryDbDir = path.dirname(nativeConversationSummariesDbPath(input.home));
  const label = target.kind === "task" ? target.sender : target.childId;

  const evaluate = async (): Promise<WaitForBackgroundTaskResult | null> => {
    if (target.kind === "task") {
      const messagesDir = path.join(brainRoot, target.parentId, ".system_generated", "messages");
      const matches = await listMessagesFromSender(messagesDir, target.sender);
      if (matches && matches.length > 0) {
        return {
          message: `Background target ${label} has completed; its notification is ready in context.`,
        };
      }
      return null;
    }
    const state = await checkSubagentSettled(input.home, brainRoot, target);
    if (state === "foreign") {
      return {
        isError: true,
        message: `Subagent ${target.childId} does not belong to this conversation.`,
      };
    }
    if (state === "settled") {
      return {
        message: `Background target ${label} has completed; its notification is ready in context.`,
      };
    }
    return null;
  };

  const initial = await evaluate();
  if (input.signal?.aborted) return { isError: true, message: "Wait cancelled." };
  if (initial) return initial;

  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, 50), 3_600_000);
  const fallbackMs = Math.max(input.recheckIntervalMs ?? FALLBACK_RECHECK_MS, 25);

  return new Promise<WaitForBackgroundTaskResult>((resolve) => {
    let settled = false;
    const watchers = new Map<string, { dir: string; handle: FSWatcher }>();
    let fallbackTimer: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    let queued = false;

    const cleanup = () => {
      settled = true;
      for (const { handle } of watchers.values()) handle.close();
      watchers.clear();
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = undefined;
      }
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: WaitForBackgroundTaskResult) => {
      if (settled) return;
      cleanup();
      resolve(result);
    };

    const desiredWatchTargets = (): Array<{
      slot: string;
      exactDir: string;
      candidates: string[];
    }> => {
      if (target.kind === "task") {
        const convDir = path.join(brainRoot, target.parentId);
        const sysDir = path.join(convDir, ".system_generated");
        const msgDir = path.join(sysDir, "messages");
        return [
          {
            slot: "parentMessages",
            exactDir: msgDir,
            candidates: [msgDir, sysDir, convDir, brainRoot],
          },
        ];
      }
      const childConvDir = path.join(brainRoot, target.childId);
      const childSysDir = path.join(childConvDir, ".system_generated");
      const childMsgDir = path.join(childSysDir, "messages");
      return [
        {
          slot: "childMessages",
          exactDir: childMsgDir,
          candidates: [childMsgDir, childSysDir, childConvDir, brainRoot],
        },
        {
          slot: "summariesDb",
          exactDir: summaryDbDir,
          candidates: [summaryDbDir, path.dirname(summaryDbDir)],
        },
      ];
    };

    const syncFallbackTimer = (allExactWatched: boolean) => {
      if (settled) return;
      if (allExactWatched) {
        if (fallbackTimer) {
          clearInterval(fallbackTimer);
          fallbackTimer = undefined;
        }
      } else if (!fallbackTimer) {
        fallbackTimer = setInterval(() => {
          void triggerCheck();
        }, fallbackMs);
        fallbackTimer.unref?.();
      }
    };

    const refreshWatchers = (): { rebound: boolean; allExact: boolean } => {
      const slots = desiredWatchTargets();
      let rebound = false;
      let allExact = slots.length > 0;
      for (const { slot, exactDir, candidates } of slots) {
        const existing = candidates.find((dir) => existsSync(dir));
        const current = watchers.get(slot);
        if (!existing) {
          allExact = false;
          continue;
        }
        if (current?.dir === existing) {
          if (existing !== exactDir) allExact = false;
          continue;
        }
        current?.handle.close();
        watchers.delete(slot);
        try {
          const handle = watch(existing, () => {
            void triggerCheck();
          });
          handle.on("error", () => {
            if (watchers.get(slot)?.handle === handle) {
              handle.close();
              watchers.delete(slot);
              syncFallbackTimer(false);
            }
          });
          handle.unref?.();
          watchers.set(slot, { dir: existing, handle });
          rebound = true;
          if (existing !== exactDir) allExact = false;
        } catch {
          allExact = false;
        }
      }
      syncFallbackTimer(allExact);
      return { rebound, allExact };
    };

    const triggerCheck = async () => {
      if (settled) return;
      if (checking) {
        queued = true;
        return;
      }
      checking = true;
      try {
        do {
          queued = false;
          const beforeWatch = refreshWatchers();
          const outcome = await evaluate();
          if (settled) return;
          if (outcome) {
            finish(outcome);
            return;
          }
          const afterWatch = refreshWatchers();
          if (beforeWatch.rebound || afterWatch.rebound) {
            const rechecked = await evaluate();
            if (settled) return;
            if (rechecked) {
              finish(rechecked);
              return;
            }
          }
        } while (queued && !settled);
      } finally {
        checking = false;
      }
    };

    const onAbort = () => finish({ isError: true, message: "Wait cancelled." });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }

    const deadline = setTimeout(() => {
      finish({
        message: `Timed out waiting for ${label}; it is still running. Call ${ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME} again with the same taskId if you still need its result before ending this turn.`,
      });
    }, timeoutMs);
    deadline.unref?.();

    void triggerCheck();
  });
}

export interface ServeBackgroundWaitMcpOptions {
  home: string;
  boundSessionId?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  timeoutMs?: number;
  recheckIntervalMs?: number;
}

export function serveBackgroundWaitMcp(options: ServeBackgroundWaitMcpOptions): { close(): void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const pending = new Map<string | number, AbortController>();
  let closed = false;

  const send = (payload: Record<string, unknown>) => {
    if (!closed) output.write(`${JSON.stringify(payload)}\n`);
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const close = () => {
    if (closed) return;
    closed = true;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    rl.close();
  };

  rl.on("close", close);
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id as string | number | undefined;
    const method = typeof message.method === "string" ? message.method : "";
    const params =
      message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};

    if (id === undefined) {
      if (method === "notifications/cancelled") {
        const requestId = params.requestId as string | number | undefined;
        if (requestId !== undefined) {
          pending.get(requestId)?.abort();
          pending.delete(requestId);
        }
      }
      return;
    }

    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: ANTIGRAVITY_BACKGROUND_MCP_SERVER_NAME, version: "1.0.0" },
        },
      });
      return;
    }

    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME,
              description:
                "Wait until a non-daemon Antigravity background command/workflow (<conversationId>/task-<step>) or native subagent (<subagentConversationId>) finishes and posts its message.",
              inputSchema: {
                type: "object",
                properties: {
                  taskId: {
                    type: "string",
                    description:
                      "Background task ID ('<conversationId>/task-<step>') or native subagent conversation ID.",
                  },
                  conversationId: {
                    type: "string",
                    description:
                      "Optional current conversation ID when waiting on a subagent or bare 'task-<step>'.",
                  },
                },
                required: ["taskId"],
                additionalProperties: false,
              },
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            },
          ],
        },
      });
      return;
    }

    if (method === "tools/call") {
      if (params.name !== ANTIGRAVITY_BACKGROUND_WAIT_TOOL_NAME) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${String(params.name)}` },
        });
        return;
      }
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const controller = new AbortController();
      pending.set(id, controller);
      void waitForBackgroundTask({
        home: options.home,
        taskId: typeof args.taskId === "string" ? args.taskId : "",
        ...(typeof args.conversationId === "string" ? { conversationId: args.conversationId } : {}),
        ...(options.boundSessionId ? { boundSessionId: options.boundSessionId } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.recheckIntervalMs !== undefined
          ? { recheckIntervalMs: options.recheckIntervalMs }
          : {}),
        signal: controller.signal,
      }).then((result) => {
        pending.delete(id);
        if (controller.signal.aborted) return;
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result.message }],
            ...(result.isError ? { isError: true } : {}),
          },
        });
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  });

  return { close };
}

export function maybeRunBackgroundWaitMcpFromCli(argv: readonly string[] = process.argv): boolean {
  if (!argv.includes(ANTIGRAVITY_BACKGROUND_MCP_FLAG)) return false;
  const homeIndex = argv.indexOf("--home");
  const homeArg = homeIndex >= 0 ? argv[homeIndex + 1] : undefined;
  const sessionIndex = argv.indexOf("--session-id");
  const sessionArg = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
  serveBackgroundWaitMcp({
    home: homeArg || antigravityHome(process.env),
    ...(sessionArg && SAFE_ID_PATTERN.test(sessionArg) ? { boundSessionId: sessionArg } : {}),
  });
  return true;
}

maybeRunBackgroundWaitMcpFromCli();
