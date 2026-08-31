import { createHash } from "node:crypto";
import { z } from "zod";

export {
  FileHarnessConfigurationStore,
  HARNESS_CONFIG_PATH_ENV,
  resolveHarnessConfigurationPath,
  type HarnessConfigurationStore,
} from "./store.js";

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name");
const endpoint = z.string().url();
const runtimeEnvironment = z.record(z.string(), z.string());
const profileId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "must use transport-safe characters");

export const harnessEndpointConfigSchema = z.object({
  command: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  baseUrl: endpoint.optional(),
  apiKeyEnv: envName.optional(),
  /** Direct key managed by CodexHost configuration. */
  apiKey: z.string().min(1).optional(),
  /** Extra environment values injected into this Harness process. */
  environment: runtimeEnvironment.optional(),
  model: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).optional(),
});

export const harnessConfigFileV1Schema = z.object({
  version: z.literal(1).default(1),
  harnesses: z.record(z.string().min(1), harnessEndpointConfigSchema),
});

export const harnessProfileConfigSchema = harnessEndpointConfigSchema.extend({
  label: z.string().min(1).max(128),
  authType: z.enum(["none", "oauth", "official-api-key", "third-party-gateway", "environment"]),
});

export const harnessProfileSetSchema = z
  .object({
    enabled: z.boolean().default(true),
    activeProfile: profileId,
    profiles: z.record(profileId, harnessProfileConfigSchema),
  })
  .superRefine((value, context) => {
    if (!Object.hasOwn(value.profiles, value.activeProfile)) {
      context.addIssue({
        code: "custom",
        message: "activeProfile must reference an existing profile",
        path: ["activeProfile"],
      });
    }
  });

export const harnessConfigFileV2Schema = z.object({
  version: z.literal(2),
  harnesses: z.record(z.string().min(1), harnessProfileSetSchema),
});

export const harnessConfigFileSchema = z.discriminatedUnion("version", [
  harnessConfigFileV1Schema,
  harnessConfigFileV2Schema,
]);

export type HarnessEndpointConfig = z.infer<typeof harnessEndpointConfigSchema>;
export type HarnessProfileConfig = z.infer<typeof harnessProfileConfigSchema>;
export type HarnessProfileSet = z.infer<typeof harnessProfileSetSchema>;
export type HarnessConfigFileV1 = z.infer<typeof harnessConfigFileV1Schema>;
export type HarnessConfigFileV2 = z.infer<typeof harnessConfigFileV2Schema>;
export type HarnessConfigFile = z.infer<typeof harnessConfigFileSchema>;

export function parseHarnessConfig(value: unknown): HarnessConfigFile {
  const candidate =
    typeof value === "object" && value !== null && !("version" in value)
      ? { ...value, version: 1 }
      : value;
  return harnessConfigFileSchema.parse(candidate);
}

/** Parse the JSON representation used by CODEXHOST_HARNESS_CONFIG. */
export function parseHarnessConfigJson(value: string): HarnessConfigFile {
  return parseHarnessConfig(JSON.parse(value) as unknown);
}

export function getHarnessConfig(
  config: HarnessConfigFile,
  harnessId: string,
): HarnessEndpointConfig | undefined {
  if (config.version === 1) return config.harnesses[harnessId];
  const harness = config.harnesses[harnessId];
  if (!harness?.enabled) return undefined;
  const profile = harness.profiles[harness.activeProfile];
  if (!profile) return undefined;
  const endpoint = harnessEndpointConfigSchema.parse(profile);
  const common = {
    ...(endpoint.command ? { command: endpoint.command } : {}),
    ...(endpoint.cwd ? { cwd: endpoint.cwd } : {}),
    ...(endpoint.environment ? { environment: endpoint.environment } : {}),
    ...(endpoint.model ? { model: endpoint.model } : {}),
    ...(endpoint.models ? { models: endpoint.models } : {}),
  };
  if (profile.authType === "third-party-gateway") return { ...common, ...endpoint };
  if (profile.authType === "official-api-key") {
    return {
      ...common,
      ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
      ...(endpoint.apiKeyEnv ? { apiKeyEnv: endpoint.apiKeyEnv } : {}),
    };
  }
  if (profile.authType === "environment") {
    return {
      ...common,
      ...(endpoint.apiKeyEnv ? { apiKeyEnv: endpoint.apiKeyEnv } : {}),
    };
  }
  return common;
}

/** Resolve a configured model while preventing a model from another harness leaking into this session. */
export function selectHarnessModel(
  config: HarnessEndpointConfig | undefined,
  requested?: string,
): string | undefined {
  if (!config) return requested;
  const selected = requested ?? config.model;
  if (selected && config.models && !config.models.includes(selected)) {
    throw new Error(`Model is not enabled for this harness: ${selected}`);
  }
  return selected;
}

/** Build the child-process environment without ever exposing secret values in config objects. */
export function resolveHarnessRuntimeEnv(
  config: HarnessEndpointConfig | undefined,
  parent: NodeJS.ProcessEnv = process.env,
  harnessId = "gemini",
): NodeJS.ProcessEnv {
  if (!config) return { ...parent };
  const environment = { ...parent, ...config.environment };
  const apiKey = config.apiKey ?? (config.apiKeyEnv ? environment[config.apiKeyEnv] : undefined);
  if (harnessId === "gemini") {
    if (config.baseUrl) environment.GOOGLE_GEMINI_BASE_URL = config.baseUrl;
    if (apiKey) environment.GEMINI_API_KEY = apiKey;
    if (config.model) environment.GEMINI_MODEL = config.model;
  } else if (harnessId === "claude-code") {
    if (config.baseUrl) environment.ANTHROPIC_BASE_URL = config.baseUrl;
    if (apiKey) environment.ANTHROPIC_API_KEY = apiKey;
    if (config.model) environment.ANTHROPIC_MODEL = config.model;
  } else if (harnessId === "grok") {
    if (config.baseUrl) environment.GROK_MODELS_BASE_URL = config.baseUrl;
    if (apiKey) environment.XAI_API_KEY = apiKey;
    if (config.model) environment.GROK_DEFAULT_MODEL = config.model;
  } else if (harnessId === "deepseek-harness") {
    if (config.baseUrl) environment.DEEPSEEK_BASE_URL = config.baseUrl;
    if (apiKey) environment.DEEPSEEK_API_KEY = apiKey;
  }
  return environment;
}

/** Stable binding used to prevent resuming a native session against another endpoint. */
export function sessionConfigFingerprint(
  harnessId: string,
  config: HarnessEndpointConfig | undefined,
  model?: string,
): string {
  const payload = JSON.stringify({
    harnessId,
    baseUrl: config?.baseUrl ?? null,
    model: model ?? config?.model ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export const packageMetadata = { name: "@codexhost/harness-config" } as const;
