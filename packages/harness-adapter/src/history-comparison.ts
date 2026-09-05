import type { HostItemSnapshot, HostTurnSnapshot } from "./text-session.js";

function comparableItem(snapshot: HostItemSnapshot): unknown {
  const { itemId, ...item } = snapshot.item;
  void itemId;
  if (item.type !== "subagentDelegation") {
    return { item, outcome: snapshot.outcome };
  }
  return {
    item: {
      ...item,
      subagents: item.subagents.map((subagent) => {
        const { subagentId, nativeSubagentId, ...state } = subagent;
        void subagentId;
        void nativeSubagentId;
        return state;
      }),
    },
    outcome: snapshot.outcome,
  };
}

/**
 * Projects a historical Turn to content that must survive a Native Session derivation.
 *
 * Session-, message-, Checkpoint-, Item-, and Subagent-specific identifiers are intentionally
 * excluded because a conforming Harness may allocate fresh identities while copying history.
 * Harness identity and reference format versions remain comparable contract semantics.
 */
export function comparableHistoricalTurn(turn: HostTurnSnapshot): unknown {
  return {
    nativeTurnRef: {
      harnessId: turn.nativeTurnRef.harnessId,
      formatVersion: turn.nativeTurnRef.formatVersion,
    },
    checkpoint: turn.checkpoint
      ? {
          harnessId: turn.checkpoint.harnessId,
          formatVersion: turn.checkpoint.formatVersion,
        }
      : null,
    input: turn.input,
    items: turn.items.map(comparableItem),
    outcome: turn.outcome,
    model: turn.model ?? null,
  };
}
