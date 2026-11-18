/** Observe the entire window, including after a following Turn completes, to detect duplicates. */
export async function observeSteerDelivery(events, marker, targetTurnId, durationMs = 30_000) {
  const startedAtMs = Date.now();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const observed = events();
  const replies = observed.flatMap((event) => {
    if (
      event.type !== "item.completed" ||
      event.snapshot.item.type !== "agentMessage" ||
      !event.snapshot.item.text.includes(marker)
    )
      return [];
    const terminal = observed.find(
      (candidate) => candidate.type === "turn.completed" && candidate.turnId === event.turnId,
    );
    return [
      {
        turnId: event.turnId,
        itemId: event.snapshot.item.itemId,
        placement: event.turnId === targetTurnId ? "targetTurn" : "followingTurn",
        outcome: terminal?.outcome,
        nativeTurnRef: terminal?.nativeTurnRef,
      },
    ];
  });
  return { startedAtMs, endedAtMs: Date.now(), replies };
}
