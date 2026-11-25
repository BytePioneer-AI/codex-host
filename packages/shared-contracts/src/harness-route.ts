import { z } from "zod";

import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "./harness-models.js";
import { harnessPermissionModeIdSchema } from "./harness-permission-modes.js";
import { harnessPluginIdSchema } from "./harness-plugins.js";
import { HARNESS_TRANSPORT_MODEL_ID_MAX_LENGTH } from "./harness-route-limit.js";

export const HARNESS_PLUGIN_ROUTE_PREFIX = "codexhost/plugin-v1@";

export const harnessPluginRouteSchema = z
  .object({
    harnessId: harnessPluginIdSchema,
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
    /** A draft prewarm create: stays unsubmitted until the user's first Turn.
     * Desktop forwards only the Model of a main-process prewarm to thread/start. */
    prewarm: z.literal(true).optional(),
  })
  .strict();
export type HarnessPluginRoute = z.infer<typeof harnessPluginRouteSchema>;

export function encodeHarnessPluginRoute(route: HarnessPluginRoute): string {
  const parsed = harnessPluginRouteSchema.parse(route);
  const payload = Array.from(new TextEncoder().encode(JSON.stringify(parsed)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${HARNESS_PLUGIN_ROUTE_PREFIX}${payload}`;
}

/** null means another protocol, not an invalid or unavailable external Harness. */
export function decodeHarnessPluginRoute(value: unknown): HarnessPluginRoute | null {
  if (typeof value !== "string" || !value.startsWith(HARNESS_PLUGIN_ROUTE_PREFIX)) return null;
  const payload = value.slice(HARNESS_PLUGIN_ROUTE_PREFIX.length);
  if (
    value.length > HARNESS_TRANSPORT_MODEL_ID_MAX_LENGTH ||
    !/^(?:[a-f0-9]{2})+$/u.test(payload)
  ) {
    throw new Error("Invalid Harness plugin route");
  }
  try {
    const bytes = Uint8Array.from(payload.matchAll(/../gu), ([byte]) => parseInt(byte, 16));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const decoded = harnessPluginRouteSchema.parse(JSON.parse(json));
    if (encodeHarnessPluginRoute(decoded) !== value)
      throw new Error("Noncanonical Harness plugin route");
    return decoded;
  } catch {
    throw new Error("Invalid Harness plugin route");
  }
}
