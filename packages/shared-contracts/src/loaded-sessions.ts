import { z } from "zod";

export const LOADED_SESSIONS_METHOD = "codexhost/sessions/loaded/list";
export const loadedSessionStateSchema = z.enum([
  "idle",
  "running",
  "busy",
  "closing",
  "failed",
  "blocked",
]);
export const loadedSessionReasonSchema = z.enum([
  "none",
  "disabled",
  "timeout",
  "operation",
  "background",
  "identity",
  "persistence",
  "closeFailed",
]);
export const loadedSessionsSchema = z.array(
  z.strictObject({
    threadId: z.string(),
    title: z.string(),
    harnessId: z.string(),
    state: loadedSessionStateSchema,
    reason: loadedSessionReasonSchema,
    inactiveMs: z.number().nonnegative(),
  }),
);
export type LoadedSession = z.infer<typeof loadedSessionsSchema>[number];
