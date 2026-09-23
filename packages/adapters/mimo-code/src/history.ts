import type {
  AssistantMessage,
  Message,
  OpencodeClient,
  Part,
  Session,
} from "@mimo-ai/sdk/v2/client";
import type {
  HistoricalTurnOutcome,
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, jsonValueSchema, type NativeTurnRef } from "@codexhost/shared-contracts";
import { checked, encodeModel, errorOf, MIMO_ID, MimoError } from "./protocol.js";
import { observedPermission } from "./permissions.js";

export type NativeMessage = { info: Message; parts: Part[] };
export function turnRef(sessionID: string, messageID: string): NativeTurnRef {
  return {
    harnessId: MIMO_ID,
    nativeSessionId: sessionID,
    nativeTurnKey: messageID,
    formatVersion: 1,
  };
}

export async function readMessages(
  client: OpencodeClient,
  sessionID: string,
): Promise<NativeMessage[]> {
  const pages: NativeMessage[][] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let before: string | undefined;
  // 0.1.14 /session/:id/message emits X-Next-Cursor containing {time,id},
  // base64url encoded. It is NOT the oldest message ID. Never synthesize it.
  do {
    const response = await client.session.messages({
      sessionID,
      limit: 1000,
      ...(before ? { before } : {}),
    });
    const page = checked(response);
    if (!Array.isArray(page)) throw new MimoError("protocolError", "Invalid MiMo history page");
    for (const message of page) {
      if (message.info.sessionID !== sessionID || ids.has(message.info.id))
        throw new MimoError("protocolError", "MiMo history contains duplicate or foreign messages");
      ids.add(message.info.id);
      if (
        message.parts.some(
          (part) => part.sessionID !== sessionID || part.messageID !== message.info.id,
        )
      )
        throw new MimoError("protocolError", "MiMo history part ownership is invalid");
    }
    pages.push(page);
    before = response.response.headers.get("X-Next-Cursor") ?? undefined;
    if (before) {
      if (!page.length || cursors.has(before))
        throw new MimoError("protocolError", "MiMo history pagination did not advance");
      cursors.add(before);
    }
  } while (before);
  return pages.reverse().flat();
}

const MAX_TOOL_OUTPUT = 256_000;
export function projectPart(part: Part, completed: boolean): HostItemSnapshot | undefined {
  const itemId = hostItemIdSchema.parse(`mimo:${part.sessionID}:${part.messageID}:${part.id}`);
  if (part.type === "text" || part.type === "reasoning") {
    if (part.type === "text" && (part.synthetic || part.ignored)) return undefined;
    return {
      item: { type: part.type === "text" ? "agentMessage" : "reasoning", itemId, text: part.text },
      outcome: completed
        ? { status: "succeeded" }
        : {
            status: "failed",
            error: errorOf(new MimoError("nativeFailure", "MiMo message is incomplete")),
          },
    };
  }
  if (part.type === "compaction")
    return { item: { type: "contextCompaction", itemId }, outcome: { status: "succeeded" } };
  if (part.type !== "tool") return undefined;
  const state = part.state;
  const output =
    state.status === "completed" ? state.output : state.status === "error" ? state.error : "";
  const clipped = output.slice(0, MAX_TOOL_OUTPUT);
  const terminal = state.status === "completed" || state.status === "error";
  const duration = terminal ? Math.max(0, state.time.end - state.time.start) : undefined;
  const outcome: HostItemSnapshot["outcome"] =
    state.status === "completed"
      ? { status: "succeeded" }
      : {
          status: "failed",
          error: errorOf(
            new MimoError(
              "nativeFailure",
              state.status === "error" ? "MiMo tool failed" : "MiMo tool did not finish",
            ),
          ),
        };
  if ((part.tool === "bash" || part.tool === "shell") && typeof state.input.command === "string") {
    const metadata = "metadata" in state ? state.metadata : undefined;
    return {
      item: {
        type: "commandExecution",
        itemId,
        command: state.input.command,
        ...(typeof state.input.workdir === "string" ? { cwd: state.input.workdir } : {}),
        ...(output
          ? {
              output: clipped,
              ...(clipped.length < output.length ? { outputTruncated: true } : {}),
            }
          : {}),
        ...(typeof metadata?.exit === "number" ? { exitCode: metadata.exit } : {}),
        ...(duration !== undefined ? { durationMs: duration } : {}),
      },
      outcome,
    };
  }
  return {
    item: {
      type: "toolExecution",
      itemId,
      toolName: part.tool,
      namespace: "mimo-code",
      arguments: jsonValueSchema.parse(state.input),
      ...(output
        ? {
            output: {
              content: [{ type: "text" as const, text: clipped }],
              ...(clipped.length < output.length ? { truncated: true } : {}),
            },
          }
        : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
    },
    outcome,
  };
}

export function messageOutcome(info: AssistantMessage | undefined): HistoricalTurnOutcome {
  if (!info) return { status: "unknown", reason: "MiMo has no assistant result for this turn" };
  if (info.error?.name === "MessageAbortedError") return { status: "cancelled" };
  if (info.error)
    return {
      status: "failed",
      error: errorOf(
        new MimoError(
          info.error.name === "ProviderAuthError" ? "authenticationRequired" : "nativeFailure",
          "MiMo assistant reported a native error",
        ),
      ),
    };
  if (info.time.completed === undefined || !info.finish || info.finish === "tool-calls")
    return { status: "unknown", reason: "MiMo has no confirmed final result for this turn" };
  if (["error", "content-filter"].includes(info.finish))
    return {
      status: "failed",
      error: errorOf(new MimoError("nativeFailure", "MiMo model did not complete successfully")),
    };
  return { status: "succeeded" };
}

export function projectHistory(session: Session, messages: NativeMessage[]): HostThreadSnapshot {
  const turns: HostTurnSnapshot[] = [];
  const byUser = new Map<string, HostTurnSnapshot>();
  let latest: HostTurnSnapshot | undefined;
  let latestAssistant: AssistantMessage | undefined;
  for (const { info, parts } of messages) {
    if (session.revert && info.id >= session.revert.messageID) break;
    if (info.agentID && info.agentID !== "main") continue;
    if (info.role === "user") {
      const input = parts.flatMap((part) =>
        part.type === "text" && !part.synthetic && !part.ignored
          ? [{ type: "text" as const, text: part.text }]
          : [],
      );
      if (input.length) {
        latest = {
          nativeTurnRef: turnRef(session.id, info.id),
          input,
          items: [],
          outcome: { status: "unknown", reason: "MiMo has no final assistant result" },
          startedAtMs: info.time.created,
        };
        turns.push(latest);
      }
      if (latest) {
        byUser.set(info.id, latest);
        for (const part of parts)
          if (part.type === "compaction") {
            const item = projectPart(part, true);
            if (item) latest.items.push(item);
          }
      }
      continue;
    }
    const turn = byUser.get(info.parentID);
    if (!turn)
      throw new MimoError("protocolError", "MiMo assistant history has no parent user message");
    for (const part of parts) {
      const item = projectPart(part, info.time.completed !== undefined);
      if (item) turn.items.push(item);
    }
    turn.outcome = messageOutcome(info);
    turn.model = encodeModel(info);
    if (info.time.completed !== undefined) turn.completedAtMs = info.time.completed;
    latestAssistant = info;
  }
  const permission = observedPermission(session.permission);
  return {
    turns,
    state: {
      nativeRef: { harnessId: MIMO_ID, nativeSessionId: session.id, formatVersion: 1 },
      ...(permission ? { effectivePermissionModeId: permission } : {}),
      ...(latestAssistant ? { effectiveModel: encodeModel(latestAssistant) } : {}),
    },
  };
}
