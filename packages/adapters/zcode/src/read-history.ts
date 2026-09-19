import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { history } from "./history.js";
import { fileChanges, subagent } from "./projection.js";
import { record, text, type NativeSnapshot, type NativeEvent } from "./protocol.js";
import type { ZcodeConnection } from "./connection.js";
import { withConversation } from "./conversation.js";
import { ZcodeError } from "./errors.js";

/** Tool result strings omit file checkpoints and child IDs; query their owning native APIs. */
export async function readHistory(
  transport: ZcodeConnection,
  snapshot: NativeSnapshot,
  events: readonly NativeEvent[] = [],
) {
  const result = history(snapshot, events, transport.locator);
  const tools = result.turns
    .flatMap((turn) => turn.items)
    .filter(({ item }) => item.type === "toolExecution");
  if (
    tools.some(
      ({ item }) =>
        item.type === "toolExecution" && ["Write", "Edit", "MultiEdit"].includes(item.toolName),
    )
  ) {
    await withConversation(transport, snapshot, async (view) => {
      for (const header of view.rows.filter(
        (row) => row.kind === "turnHeader" && Number(record(row.fileChanges).files) > 0,
      )) {
        const user = view.rows.find(
          (row) => row.kind === "userInput" && row.turnId === header.turnId,
        );
        const turn = result.turns.find(
          (turn) => turn.nativeTurnRef.nativeTurnKey === user?.entityId,
        );
        if (!turn) continue;
        const changes = record(
          await transport.request("v4/conversation/fileChanges", {
            sessionId: snapshot.session.sessionId,
            target: {
              rowId: header.rowId,
              ...(header.entityId ? { entityId: header.entityId } : {}),
            },
            baseRevision: view.revision,
            baseLogEpoch: view.logEpoch,
          }),
        );
        const files = Array.isArray(changes.items)
          ? changes.items.flatMap((value) => {
              const file = record(value);
              return fileChanges({ filePath: file.path, structuredPatch: file.patches });
            })
          : [];
        if (files.length)
          turn.items.push({
            item: {
              type: "fileChange",
              itemId: hostItemIdSchema.parse(`${turn.nativeTurnRef.nativeTurnKey}:files`),
              changes: files,
            },
            outcome: { status: "succeeded" },
          });
      }
    });
  }
  if (
    tools.some(
      ({ item }) =>
        item.type === "toolExecution" && ["Agent", "SendMessage"].includes(item.toolName),
    )
  ) {
    const entries: unknown[] = [],
      cursors = new Set<string>();
    let endedCursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 1000)
        throw new ZcodeError("protocolError", "ZCode subagent pagination did not finish");
      const children = record(
        await transport.request("session/subagents", {
          sessionId: snapshot.session.sessionId,
          endedLimit: 100,
          ...(endedCursor ? { endedCursor } : {}),
        }),
      );
      if (page === 0 && Array.isArray(children.running)) entries.push(...children.running);
      const ended = record(children.ended);
      if (Array.isArray(ended.items)) entries.push(...ended.items);
      endedCursor = text(ended.nextCursor);
      if (!endedCursor) break;
      if (cursors.has(endedCursor))
        throw new ZcodeError("protocolError", "ZCode repeated a subagent pagination cursor");
      cursors.add(endedCursor);
    }
    for (const value of entries) {
      const child = record(value),
        callId = text(child.toolCallId);
      const turn = result.turns.find((turn) =>
        turn.items.some(({ item }) => item.itemId === callId),
      );
      const tool = turn?.items.find(({ item }) => item.itemId === callId)?.item;
      const state = subagent(
        { ...child, status: child.status === "success" ? "completed" : child.status },
        tool?.type === "toolExecution" ? tool.arguments : {},
        text(child.title),
      );
      if (turn && state)
        turn.items.push({
          item: {
            type: "subagentDelegation",
            itemId: hostItemIdSchema.parse(`${callId}:agent`),
            operation: "spawn",
            subagents: [state],
          },
          outcome: { status: "succeeded" },
        });
    }
  }
  return result;
}
