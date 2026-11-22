import type { ClientSideConnection, SessionInfo } from "@agentclientprotocol/sdk";

export type DevinSessionListing = Pick<ClientSideConnection, "listSessions">;

/** Native listing is paginated; a partial page cannot establish that a Session is absent. */
export async function listDevinSessions(connection: DevinSessionListing): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await connection.listSessions(cursor === undefined ? {} : { cursor });
    if (!Array.isArray(response.sessions))
      throw new Error("Devin session/list returned no sessions array");
    for (const session of response.sessions) {
      if (ids.has(session.sessionId))
        throw new Error("Devin session/list returned duplicate Session IDs");
      ids.add(session.sessionId);
      sessions.push(session);
    }
    const next = response.nextCursor;
    if (next == null) break;
    if (typeof next !== "string" || !next.trim() || cursors.has(next))
      throw new Error("Devin session/list returned an invalid or repeated cursor");
    cursors.add(next);
    cursor = next;
  } while (true);
  return sessions;
}
