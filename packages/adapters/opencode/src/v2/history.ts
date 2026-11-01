import path from "node:path";
import type {
  OpenCodeClient,
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistant,
  FileDiffInfo,
} from "@opencode/client";
import type {
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTurnSnapshot,
  HostItemOutcome,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  nativeCheckpointRefSchema,
} from "@codexhost/shared-contracts";
import { encodeOpenCodeModelRef } from "../model-catalog.js";
import { failure, harnessId } from "./state.js";

export async function readMessages(
  client: OpenCodeClient,
  sessionID: string,
): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.message.list({
      sessionID,
      ...(cursor ? { cursor } : { order: "asc" as const, limit: 100 }),
    });
    messages.push(...page.data);
    cursor = page.cursor.next ?? undefined;
    if (cursor && seen.has(cursor))
      throw new Error("OpenCode v2 transcript pagination did not advance");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return messages;
}

export const contentId = (messageID: string, type: "text" | "reasoning", ordinal: number) =>
  hostItemIdSchema.parse(`${messageID}:${type}:${ordinal}`);

export function assistantItems(
  message: SessionMessageAssistant,
  limit: number,
): HostItemSnapshot[] {
  // Native stream ordinals count each content type separately, not array positions.
  const ordinals = { text: 0, reasoning: 0 };
  return message.content.map((part): HostItemSnapshot => {
    if (part.type === "text" || part.type === "reasoning") {
      const itemId = contentId(message.id, part.type, ordinals[part.type]++);
      return {
        item: {
          type: part.type === "text" ? "agentMessage" : "reasoning",
          itemId,
          text: part.text,
        },
        outcome: message.error
          ? { status: "failed", error: failure(message.error.message) }
          : { status: "succeeded" },
      };
    }
    const state = part.state;
    const text =
      "content" in state
        ? state.content?.map((p) => (p.type === "text" ? p.text : `[File: ${p.uri}]`)).join("\n")
        : undefined;
    return {
      item: {
        type: "toolExecution",
        itemId: hostItemIdSchema.parse(`${message.id}:tool:${part.id}`),
        toolName: part.name,
        namespace: "opencode",
        arguments: typeof state.input === "string" ? state.input : state.input,
        ...(text
          ? {
              output: {
                content: [{ type: "text", text: text.slice(0, limit) }],
                ...(text.length > limit ? { truncated: true } : {}),
              },
            }
          : {}),
      },
      outcome:
        state.status === "error"
          ? { status: "failed", error: failure(state.error.message) }
          : state.status === "completed"
            ? { status: "succeeded" }
            : { status: "cancelled", reason: "Native Tool did not complete" },
    };
  });
}

export function projectHistory(
  session: SessionInfo,
  messages: SessionMessageInfo[],
  limit: number,
): HostThreadSnapshot {
  if (session.revert)
    throw new Error("Clear the staged OpenCode v2 revert before using this Session in codexhost");
  const turns: HostTurnSnapshot[] = [];
  let turn: HostTurnSnapshot | undefined;
  for (const message of messages) {
    if (message.type === "user" && turn) {
      turn.input.push({ type: "text", text: message.text });
    } else if (
      message.type === "user" ||
      (message.type === "compaction" && message.reason === "manual" && !turn)
    ) {
      turn = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId,
          nativeSessionId: session.id,
          nativeTurnKey: message.id,
          formatVersion: 1,
        }),
        input: message.type === "user" ? [{ type: "text", text: message.text }] : [],
        items: [],
        outcome: { status: "unknown", reason: "OpenCode execution has no durable terminal" },
        startedAtMs: message.time.created,
      };
      turns.push(turn);
    }
    if (!turn) continue;
    if (message.type === "assistant") {
      turn.items.push(...assistantItems(message, limit));
      turn.model = encodeOpenCodeModelRef({
        providerID: message.model.providerID,
        modelID: message.model.id,
      });
    } else if (message.type === "compaction") {
      turn.items.push({
        item: { type: "contextCompaction", itemId: hostItemIdSchema.parse(message.id) },
        outcome:
          message.status === "failed"
            ? { status: "failed", error: failure(message.error.message) }
            : message.status === "completed"
              ? { status: "succeeded" }
              : { status: "cancelled", reason: "Compaction is incomplete" },
      });
    } else if (message.type === "shell") {
      turn.items.push({
        item: {
          type: "commandExecution",
          itemId: hostItemIdSchema.parse(message.id),
          command: message.command,
          ...(message.output
            ? {
                output: message.output.output.slice(0, limit),
                outputTruncated: message.output.truncated || message.output.output.length > limit,
              }
            : {}),
          ...(typeof message.exit === "number" ? { exitCode: message.exit } : {}),
        },
        outcome:
          message.status === "killed"
            ? { status: "cancelled" }
            : message.exit === 0
              ? { status: "succeeded" }
              : {
                  status: "failed",
                  error: failure(`Shell ${message.status}, exit ${message.exit ?? "unknown"}`),
                },
      });
    } else if (message.type === "idle") {
      turn.outcome =
        message.outcome === "interrupted"
          ? { status: "cancelled" }
          : message.outcome === "failed"
            ? { status: "failed", error: failure("OpenCode v2 execution failed") }
            : { status: "succeeded" };
      turn.completedAtMs = message.time.created;
      turn.checkpoint = nativeCheckpointRefSchema.parse({
        harnessId,
        nativeSessionId: session.id,
        checkpointId: message.id,
        locator: { protocol: 2, userMessageID: turn.nativeTurnRef.nativeTurnKey },
        formatVersion: 1,
      });
      turn = undefined;
    }
  }
  return { turns };
}

export function fileChanges(
  session: SessionInfo,
  turn: HostTurnSnapshot,
  diffs: FileDiffInfo[],
): HostItemSnapshot | undefined {
  if (!diffs.length) return undefined;
  const changes = diffs.map((diff) => {
    const absolute = path.resolve(session.location.directory, diff.file);
    const relative = path.relative(session.location.directory, absolute);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
      throw new Error("OpenCode v2 diff escaped the Session directory");
    return {
      path: absolute,
      kind:
        diff.status === "added"
          ? ("add" as const)
          : diff.status === "deleted"
            ? ("delete" as const)
            : ("update" as const),
      unifiedDiff: diff.patch,
    };
  });
  return {
    item: {
      type: "fileChange",
      itemId: hostItemIdSchema.parse(`${turn.nativeTurnRef.nativeTurnKey}:diff`),
      changes,
    },
    outcome: { status: "succeeded" },
  };
}

export async function readHistory(client: OpenCodeClient, session: SessionInfo, limit: number) {
  const messages = await readMessages(client, session.id);
  const snapshot = projectHistory(session, messages, limit);
  for (const turn of snapshot.turns) {
    if (!turn.checkpoint) continue;
    const first = messages.findIndex((m) => m.id === turn.nativeTurnRef.nativeTurnKey);
    const last = messages.findIndex((m) => m.id === turn.checkpoint?.checkpointId);
    if (
      !messages.slice(first, last).some((m) => m.type === "assistant" && m.snapshot?.files?.length)
    )
      continue;
    const diffs = await client.session.diff({
      sessionID: session.id,
      from: turn.nativeTurnRef.nativeTurnKey,
    });
    const item = fileChanges(session, turn, diffs);
    if (item) turn.items.push(item);
  }
  return { messages, snapshot };
}

export function terminalItemOutcome(outcome: HostTurnSnapshot["outcome"]): HostItemOutcome {
  return outcome.status === "unknown"
    ? { status: "failed", error: failure(outcome.reason, "protocolError") }
    : outcome;
}
