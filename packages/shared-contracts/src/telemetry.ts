/**
 * Zero-ID, locally deduplicated anonymous product telemetry contract for codexhost.
 *
 * Design & privacy boundary (enforced by the strict schemas below):
 * - Zero persistent identifiers: all daily/weekly/monthly/retention deduplication happens
 *   strictly locally on disk (`$CODEXHOST_DATA_DIR/telemetry-v1.json`). No `installId`, UUID,
 *   device fingerprint, hardware ID, account hash, or client IP is ever generated or transmitted.
 * - Pure aggregate counters: each payload contains only stateless period increment booleans
 *   (`dailyActive`, `weeklyActive`, `monthlyActive`, `newInstall`, `retainedD1`, `retainedD7`,
 *   `remoteAny`) and strictly allowlisted coarse product dimensions (`appVersion`,
 *   `codexDesktopVersion`, `os`, `arch`, `uiLanguage`, `surfaces`, `remoteAccess`, `harnesses`).
 * - Zero personal privacy impact: never collects prompts, conversation content, code, file paths,
 *   repository names, accounts, credentials, model/provider usage, token counts, local extensions,
 *   private Relay hostnames, or custom Harness names (unknown Harnesses collapse to `"custom"`).
 * - Automatically disabled in local source checkouts (`development` builds) and CI environments;
 *   can be disabled at any time via `CODEXHOST_TELEMETRY=0`, `DO_NOT_TRACK=1`,
 *   `CODEXHOST_TELEMETRY_URL=off`, or `telemetry-v1.json`. Set `CODEXHOST_TELEMETRY_DEBUG=1` to
 *   print every outgoing JSON payload to stderr for inspection. See `docs/product/product-telemetry.md`
 *   and `docs/PRIVACY.md`.
 */
import { z } from "zod";

export const DEFAULT_PRODUCT_TELEMETRY_URL = "https://ext-stats.chost.dev";
export const PRODUCT_TELEMETRY_GET_METHOD = "codexhost/telemetry/get";
export const PRODUCT_TELEMETRY_SET_METHOD = "codexhost/telemetry/set";
export const PRODUCT_TELEMETRY_SIGNAL_METHOD = "codexhost/telemetry/signal";

export const TELEMETRY_SURFACES = [
  "codex-desktop",
  "web",
  "web-desktop-shell",
  "web-mobile",
  "ssh-remote",
  "cli",
] as const;

export const TELEMETRY_OS_LIST = ["darwin", "win32", "linux"] as const;
export const TELEMETRY_ARCH_LIST = ["arm64", "x64", "ia32", "arm"] as const;

export const TELEMETRY_UI_LANGUAGES = [
  "zh",
  "en",
  "ja",
  "ko",
  "de",
  "fr",
  "es",
  "pt",
  "ru",
  "other",
] as const;

export const TELEMETRY_OFFICIAL_HARNESSES = [
  "codex",
  "claude-code",
  "antigravity",
  "pi",
  "opencode",
  "cursor-cli",
  "deepseek-harness",
  "grok",
  "omp",
  "qwen-code",
  "kiro-cli",
  "codebuddy",
  "workbuddy",
  "devin",
  "hermes",
  "qoder",
  "qoder-cn",
  "kimi-code",
  "zcode",
  "copilot",
  "custom",
] as const;

export const TELEMETRY_REMOTE_ACCESS_CHANNELS = [
  "official-relay",
  "self-hosted-relay",
  "tailscale-serve",
  "tailscale-funnel",
  "tailscale-ip",
  "lan",
  "custom-proxy",
  "remote-peer",
] as const;

const telemetryVersionSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[0-9A-Za-z._+-]+$/u);

export const telemetrySurfaceSchema = z.enum(TELEMETRY_SURFACES);
export const telemetryUiLanguageSchema = z.enum(TELEMETRY_UI_LANGUAGES);
export const telemetryHarnessSchema = z.enum(TELEMETRY_OFFICIAL_HARNESSES);
export const telemetryRemoteAccessChannelSchema = z.enum(TELEMETRY_REMOTE_ACCESS_CHANNELS);

export type TelemetrySurface = z.infer<typeof telemetrySurfaceSchema>;
export type TelemetryUiLanguage = z.infer<typeof telemetryUiLanguageSchema>;
export type TelemetryHarness = z.infer<typeof telemetryHarnessSchema>;
export type TelemetryRemoteAccessChannel = z.infer<typeof telemetryRemoteAccessChannelSchema>;

const officialHarnessSet: ReadonlySet<string> = new Set(TELEMETRY_OFFICIAL_HARNESSES);
const uiLanguageSet: ReadonlySet<string> = new Set(TELEMETRY_UI_LANGUAGES);

/** Maps official Harness IDs verbatim and collapses private/custom Harnesses to `"custom"`. */
export function normalizeTelemetryHarnessId(harnessId: string): TelemetryHarness {
  const normalized = harnessId.trim().toLowerCase();
  return officialHarnessSet.has(normalized) ? (normalized as TelemetryHarness) : "custom";
}

/** Reduces a language/locale tag (e.g. `zh-CN`, `en_US.UTF-8`) to a coarse 2-letter language code. */
export function normalizeTelemetryUiLanguage(raw: string): TelemetryUiLanguage | undefined {
  const cleaned = raw.trim().replaceAll("_", "-").split(".")[0];
  if (!cleaned) return undefined;
  const primary = cleaned.split("-")[0]?.toLowerCase();
  if (!primary || !/^[a-z]{2,5}$/u.test(primary)) return undefined;
  return uiLanguageSet.has(primary) ? (primary as TelemetryUiLanguage) : "other";
}

export const productTelemetrySettingsSchema = z
  .object({
    enabled: z.boolean(),
    forcedOffByEnv: z.boolean(),
  })
  .strict();

export type ProductTelemetrySettings = z.infer<typeof productTelemetrySettingsSchema>;

export const productTelemetrySetParamsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type ProductTelemetrySetParams = z.infer<typeof productTelemetrySetParamsSchema>;

export const productTelemetrySignalParamsSchema = z
  .object({
    surfaces: z.array(telemetrySurfaceSchema).max(12).optional(),
    harnesses: z.array(telemetryHarnessSchema).max(32).optional(),
    remoteAccess: z.array(telemetryRemoteAccessChannelSchema).max(12).optional(),
  })
  .strict();

export type ProductTelemetrySignalParams = z.infer<typeof productTelemetrySignalParamsSchema>;

export const productTelemetryHeartbeatSchema = z
  .object({
    dailyActive: z.literal(true).optional(),
    weeklyActive: z.literal(true).optional(),
    monthlyActive: z.literal(true).optional(),
    newInstall: z.literal(true).optional(),
    retainedD1: z.literal(true).optional(),
    retainedD7: z.literal(true).optional(),
    remoteAny: z.literal(true).optional(),
    appVersion: telemetryVersionSchema.optional(),
    codexDesktopVersion: telemetryVersionSchema.optional(),
    os: z.enum(TELEMETRY_OS_LIST).optional(),
    arch: z.enum(TELEMETRY_ARCH_LIST).optional(),
    uiLanguage: telemetryUiLanguageSchema.optional(),
    surfaces: z.array(telemetrySurfaceSchema).min(1).max(12).optional(),
    harnesses: z.array(telemetryHarnessSchema).min(1).max(32).optional(),
    remoteAccess: z.array(telemetryRemoteAccessChannelSchema).min(1).max(12).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Telemetry heartbeat must contain at least one countable field",
  });

export type ProductTelemetryHeartbeat = z.infer<typeof productTelemetryHeartbeatSchema>;
