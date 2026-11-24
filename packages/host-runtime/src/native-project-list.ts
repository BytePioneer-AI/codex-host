import type { ClientWorkspaceSnapshot } from "@codexhost/shared-contracts";
import { z } from "zod";
import { ClientChannelRequestError } from "./client-channel-error.js";
import type { NativeClientChannel } from "./native-client-channel.js";

const pageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      roots: z.array(z.object({ path: z.string().min(1) })),
    }),
  ),
  nextCursor: z.string().min(1).nullable(),
});

/** Follow the official project's display order across all native pages. */
export async function listNativeProjects(
  native: Pick<NativeClientChannel, "request">,
): Promise<ClientWorkspaceSnapshot["projects"] | undefined> {
  const projects: ClientWorkspaceSnapshot["projects"] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const reply = await native.request("project/list", { limit: 100, cursor });
    if ("error" in reply) {
      if (cursor === null && [-32601, -32090].includes(reply.error.code)) return undefined;
      throw new ClientChannelRequestError(reply.error.code, reply.error.message);
    }
    const page = pageSchema.parse(reply.result);
    for (const project of page.data)
      projects.push({
        id: project.id,
        name: project.name,
        rootPaths: project.roots.map((r) => r.path),
      });
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor) || cursors.size >= 100)
        throw new ClientChannelRequestError(-32078, "Native project catalog did not finish.");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return projects;
}
