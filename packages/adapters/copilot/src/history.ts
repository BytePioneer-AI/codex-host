import type { CopilotClient, SessionEvent } from "@github/copilot-sdk";

/** A complete journal generation; an expired cursor never becomes an empty successful page. */
export async function readPersistedEvents(
  client: CopilotClient,
  sessionId: string,
): Promise<SessionEvent[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const events: SessionEvent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await client.rpc.sessions.readPersistedEvents({
        sessionId,
        max: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.cursorStatus !== "ok") break;
      events.push(...result.events);
      if (!result.hasMore) return events;
      if (result.cursor === cursor) throw new Error("Copilot history cursor did not advance");
      cursor = result.cursor;
    }
  }
  throw new Error("Copilot history could not be read completely");
}

export function rootMessages(events: SessionEvent[]) {
  return events.filter(
    (event): event is UserMessage => event.type === "user.message" && isRootMessage(event),
  );
}

type UserMessage = Extract<SessionEvent, { type: "user.message" }>;
export function hiddenInput(event: UserMessage): boolean {
  return !!(event.data.source?.startsWith("skill-") || event.data.source?.startsWith("agent-"));
}

/** Source controls visibility; delivery controls whether a message starts an independent run. */
export function isRootMessage(event: SessionEvent): boolean {
  if (event.type !== "user.message" || event.agentId || event.data.delivery === "steering")
    return false;
  return !hiddenInput(event) || event.data.delivery === "idle";
}

export function visibleInput(event: UserMessage): Array<{ type: "text"; text: string }> {
  return hiddenInput(event) ? [] : [{ type: "text", text: event.data.content }];
}

/** Checkpoints name a logical message, not the event passed to the exclusive native boundary. */
export function forkBoundary(events: SessionEvent[], messageId: string): string | undefined {
  const messages = rootMessages(events);
  const index = messages.findIndex((event) => event.data.messageId === messageId);
  if (index < 0) throw new Error("Copilot checkpoint was not found");
  return messages[index + 1]?.id;
}
