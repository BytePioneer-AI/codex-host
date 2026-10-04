import { z } from "zod";

export const CODEX_SERVICE_TIER_SETTINGS_METHOD = "codexhost/settings/codex-service-tier/set";

/**
 * Tiers the Composer speed button cycles through. Codex does not send these names as-is:
 * `fast` is the config spelling of the `priority` request value, while `ultrafast` is
 * sent verbatim. Whether the provider honors either is decided by the provider.
 */
export const codexServiceTierIdSchema = z.enum(["fast", "ultrafast"]);
export type CodexServiceTierId = z.infer<typeof codexServiceTierIdSchema>;

/** The `service_tier` value Codex puts on an outgoing request for a selected tier. */
export function codexServiceTierRequestValue(tier: CodexServiceTierId): "priority" | "ultrafast" {
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
 * - `active`: every new custom-provider turn is sent with the selected tier. An optional
 *   `notice` is informational only and never stops the tier from being sent:
 *   `notAdvertised` means the model catalog does not list the tier, so the provider may
 *   ignore or reject it.
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
