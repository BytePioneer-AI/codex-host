import { z } from "zod";
import { ZcodeError } from "../errors.js";

/** Keys that identify one SDK instance; Desktop reuses its instance while these stay equal. */
export interface CaptchaConfig {
  readonly region: string;
  readonly prefix: string;
  readonly sceneId: string;
}

const CONFIG_URL = "https://zcode.z.ai/api/v1/client/configs";
/** Desktop caches the public client configuration for 60 seconds. */
const CONFIG_TTL_MS = 60_000;
/** Desktop bounds the public client configuration request by 15 seconds. */
const CONFIG_TIMEOUT_MS = 15_000;
const field = z.string().min(1).optional().catch(undefined);
const responseSchema = z.object({
  data: z.object({
    configs: z.object({
      captcha: z
        .object({ enabled: z.boolean().optional(), region: field, prefix: field, sceneId: field })
        .optional(),
    }),
  }),
});

/**
 * Reads the unauthenticated client configuration. Returns undefined when Desktop would send no
 * CAPTCHA headers: verification disabled or its fields incomplete.
 */
export function createCaptchaConfigSource(
  /** The installed App's version, which Desktop reports as `app_version`. */
  appVersion: string,
): (signal: AbortSignal) => Promise<CaptchaConfig | undefined> {
  let cached: { expires: number; value: CaptchaConfig | undefined } | undefined;
  return async (signal) => {
    if (cached && cached.expires > Date.now()) return cached.value;
    const url = new URL(CONFIG_URL);
    url.searchParams.set("app_version", appVersion);
    url.searchParams.set("platform", `${process.platform}-${process.arch}`);
    // The bound covers the response body too; the caller can still cancel earlier.
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(CONFIG_TIMEOUT_MS)]);
    const response = await fetch(url, { signal: bounded, credentials: "omit" });
    const parsed = responseSchema.safeParse(response.ok ? await response.json() : undefined);
    if (!parsed.success)
      throw new ZcodeError("unavailable", "ZCode client configuration is unavailable", true);
    const captcha = parsed.data.data.configs.captcha;
    const value =
      captcha?.enabled !== false && captcha?.region && captcha.prefix && captcha.sceneId
        ? { region: captcha.region, prefix: captcha.prefix, sceneId: captcha.sceneId }
        : undefined;
    cached = { expires: Date.now() + CONFIG_TTL_MS, value };
    return value;
  };
}
