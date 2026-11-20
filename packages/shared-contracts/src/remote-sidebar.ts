import { z } from "zod";

export const sidebarUnary = z.enum([
  "workspaceFiles/list",
  "workspaceFiles/read",
  "workspaceFiles/stat",
  "workspaceFiles/readBytes",
  "terminal/shells",
  "terminal/list",
  "terminal/environment",
  "terminal/create",
  "terminal/close",
  "terminal/rename",
]);
export const sidebarStream = z.enum([
  "workspaceFiles/changes",
  "terminal/retain",
  "terminal/attach",
]);
export function sidebarIdentityField(method: string) {
  if (method.startsWith("workspaceFiles/")) return "workspaceFileScopeId";
  return method === "terminal/list" || method === "terminal/retain" ? "sessionId" : "agentId";
}
const args = z.record(z.string(), z.unknown());
const handle = z.uuid();
export const sidebarAction = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("unary"),
    method: sidebarUnary,
    args,
    rpcId: z.string().max(256),
  }),
  z.strictObject({ type: z.literal("open"), method: sidebarStream, args }),
  z.strictObject({ type: z.literal("poll"), handle }),
  z.strictObject({
    type: z.literal("input"),
    handle,
    chunk: z.string().max(8192),
    final: z.boolean(),
  }),
  z.strictObject({ type: z.literal("end"), handle }),
  z.strictObject({ type: z.literal("close"), handle }),
]);
export type SidebarAction = z.infer<typeof sidebarAction>;
