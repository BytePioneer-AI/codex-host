import type { DesktopThreadTitleInput } from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChThread } from "./ch-thread-view.ts";

export type ThreadTitleGenerator = (input: DesktopThreadTitleInput) => Promise<string | null>;

/** An optional title request never changes the result of the accepted first message. */
export async function tryGenerateThreadTitle(
  host: ChHostClient,
  row: ChThread,
  prompt: string,
  generate: ThreadTitleGenerator,
  isCurrent: () => boolean,
): Promise<boolean> {
  const expectedName = row.name ?? "";
  const input = prompt.trim().slice(0, 2000);
  if (!input || !isCurrent()) return false;
  try {
    const title = await generate({ prompt: input, cwd: row.cwd || null });
    if (!title || !isCurrent()) return false;
    const { thread } = await host.request<{ thread: ChThread }>("thread/read", {
      threadId: row.id,
      includeTurns: false,
    });
    if (!isCurrent() || (thread.name ?? "") !== expectedName) return false;
    await host.request("thread/name/set", { threadId: row.id, name: title });
    return true;
  } catch {
    // Missing Desktop, native failures and unknown write outcomes keep the existing title.
    return false;
  }
}
