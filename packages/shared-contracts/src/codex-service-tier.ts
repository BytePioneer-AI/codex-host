import { z } from "zod";

export const CODEX_SERVICE_TIER_SETTINGS_METHOD = "codexhost/settings/codex-service-tier/set";

/**
 * Tiers the Composer speed button cycles through. `standard` is a real selection that reaches
 * the Host but never the wire: the Host forwards the caller's own tier fields untouched.
 * Codex does not send the other names as-is: `fast` is the config spelling of the `priority`
 * request value, while `ultrafast` is sent verbatim. Whether the provider honors either is
 * decided by the provider.
 */
export const codexServiceTierIdSchema = z.enum(["standard", "fast", "ultrafast"]);
export type CodexServiceTierId = z.infer<typeof codexServiceTierIdSchema>;

/** The selected tiers that have an outgoing request value; Standard deliberately has none. */
export type CodexServiceTierRequestTier = Exclude<CodexServiceTierId, "standard">;

/** The `service_tier` value Codex puts on an outgoing request for a selected tier. */
export function codexServiceTierRequestValue(
  tier: CodexServiceTierRequestTier,
): "priority" | "ultrafast" {
  return tier === "fast" ? "priority" : "ultrafast";
}

export const codexServiceTierSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  tier: codexServiceTierIdSchema,
});
export type CodexServiceTierSettings = z.infer<typeof codexServiceTierSettingsSchema>;

export const DEFAULT_CODEX_SERVICE_TIER_SETTINGS: Readonly<CodexServiceTierSettings> =
  Object.freeze({ enabled: false, tier: "fast" });

/**
 * How an accepted setting reaches new turns of the running native Codex, judged from its
 * default provider and model. Threads on another provider are judged per turn.
 *
 * - `active`: the setting applies to new custom-provider turns. `fast` and `ultrafast` are sent
 *   as the turn's tier; `standard` selects no request value, so such turns are forwarded
 *   unchanged. An optional `notice` is informational only and never stops the tier from being
 *   sent: `notAdvertised` means the model catalog does not list the tier, so the provider may
 *   ignore or reject it. It is never reported for `standard`, which sends nothing.
 * - `inactive` / `officialProvider`: the official OpenAI provider manages its own tier in
 *   the official client; codexhost leaves those turns unchanged.
 */
export const codexServiceTierNoticeSchema = z.enum(["notAdvertised"]);
export type CodexServiceTierNotice = z.infer<typeof codexServiceTierNoticeSchema>;

export const codexServiceTierEffectSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("off") }),
  z.strictObject({ state: z.literal("active"), notice: codexServiceTierNoticeSchema.optional() }),
  z.strictObject({ state: z.literal("inactive"), reason: z.literal("officialProvider") }),
]);
export type CodexServiceTierEffect = z.infer<typeof codexServiceTierEffectSchema>;

export const codexServiceTierResultSchema = z.strictObject({
  settings: codexServiceTierSettingsSchema,
  effect: codexServiceTierEffectSchema,
});
export type CodexServiceTierResult = z.infer<typeof codexServiceTierResultSchema>;
