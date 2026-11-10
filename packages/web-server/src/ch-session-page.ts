import {
  THREAD_CATALOG_READ_METHOD,
  threadCatalogReadParamsSchema,
  threadOwnershipSchema,
  type ThreadCatalogReadResult,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChThread } from "./ch-thread-view.ts";
import type { SessionListTiming } from "./session-list-timing.ts";
import { RpcError } from "./transport.ts";

export type CatalogPage = Omit<ThreadCatalogReadResult, "threads"> & { threads: ChThread[] };

/** Web continuation contains only native cursors and the scope that produced them. */
export function decodeCatalogCursor(cursor: string, includeArchived: boolean) {
  try {
    const value = threadCatalogReadParamsSchema.parse(JSON.parse(cursor));
    if (value.includeArchived !== includeArchived || !value.officialCursor)
      throw new Error("scope mismatch");
    return value.officialCursor;
  } catch {
    throw new RpcError("session/list-invalid", "Invalid session list cursor or archive scope.");
  }
}

export function nextCatalogCursor(page: CatalogPage, includeArchived: boolean): string | null {
  const cursor = page.officialCursor;
  return cursor && (cursor.live !== null || (includeArchived && cursor.archived != null))
    ? JSON.stringify({ includeArchived, officialCursor: cursor })
    : null;
}

/** Pins and project definitions do not depend on discovering historical Threads. */
export async function readSessionPage(
  host: ChHostClient,
  timing: SessionListTiming,
  includeArchived: boolean,
  cursor?: string,
  readPins: () => Promise<string[]> = () => host.pins(),
): Promise<{ page: CatalogPage; pinned: string[] }> {
  const officialCursor =
    cursor === undefined ? undefined : decodeCatalogCursor(cursor, includeArchived);
  const [page, pinned] = await Promise.all([
    timing.measure("host_catalog", () =>
      host.request<CatalogPage>(THREAD_CATALOG_READ_METHOD, {
        includeArchived,
        ...(officialCursor ? { officialCursor } : {}),
      }),
    ),
    timing.measure("pins", readPins),
  ]);
  const present = new Set(page.threads.map((row) => row.id));
  const missing = [...new Set(pinned)].filter((id) => !present.has(id));
  let offset = 0;
  // Only missing pin summaries are read, with a bounded fan-out; never probe omitted history.
  await Promise.all(
    Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (offset < missing.length) {
        const id = missing[offset++];
        if (id === undefined) break;
        const [result, owner] = await Promise.all([
          host.request<{ thread: ChThread }>("thread/read", { threadId: id, includeTurns: false }),
          host
            .request<{ threads: unknown[] }>("codexhost/thread/ownership/list", { threadIds: [id] })
            .then((value) => threadOwnershipSchema.parse(value.threads[0])),
        ]);
        if (result.thread.id !== id || owner.threadId !== id)
          throw new Error("Pinned Thread identity mismatch");
        page.threads.push(result.thread);
        page.ownership.push(owner);
      }
    }),
  );
  return { page, pinned };
}
