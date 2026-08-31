import { createHash } from "node:crypto";
import { z } from "zod";

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name");
const endpoint = z.string().url();

export const harnessEndpointConfigSchema = z.object({
  command: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  baseUrl: endpoint.optional(),
  apiKeyEnv: envName.optional(),
  model: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).optional(),
});

export const harnessConfigFileSchema = z.object({
  version: z.literal(1).default(1),
  harnesses: z.record(z.string().min(1), harnessEndpointConfigSchema),
});

export type HarnessEndpointConfig = z.infer<typeof harnessEndpointConfigSchema>;
export type HarnessConfigFile = z.infer<typeof harnessConfigFileSchema>;

export function parseHarnessConfig(value: unknown): HarnessConfigFile {
  return harnessConfigFileSchema.parse(value);
}

/** Parse the JSON representation used by CODEXHOST_HARNESS_CONFIG. */
export function parseHarnessConfigJson(value: string): HarnessConfigFile {
  return parseHarnessConfig(JSON.parse(value) as unknown);
}

export function getHarnessConfig(
  config: HarnessConfigFile,
  harnessId: string,
): HarnessEndpointConfig | undefined {
  return config.harnesses[harnessId];
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
): NodeJS.ProcessEnv {
  if (!config) return { ...parent };
  const environment = { ...parent };
  if (config.baseUrl) environment.GOOGLE_GEMINI_BASE_URL = config.baseUrl;
  if (config.apiKeyEnv && parent[config.apiKeyEnv])
    environment.GEMINI_API_KEY = parent[config.apiKeyEnv];
  if (config.model) environment.GEMINI_MODEL = config.model;
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
