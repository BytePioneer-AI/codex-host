import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessConfigurationSaveParamsSchema,
  harnessConfigurationSnapshotSchema,
  harnessIdSchema,
  type HarnessAuthenticationType,
  type HarnessConfigurationEntrySummary,
  type HarnessConfigurationProfileInput,
  type HarnessConfigurationProfileSummary,
  type HarnessConfigurationSaveParams,
  type HarnessConfigurationSaveResult,
  type HarnessConfigurationSnapshot,
} from "@codexhost/shared-contracts";

import {
  harnessConfigFileV2Schema,
  parseHarnessConfigJson,
  type HarnessConfigFile,
  type HarnessConfigFileV2,
  type HarnessEndpointConfig,
  type HarnessProfileConfig,
  type HarnessProfileSet,
} from "./index.js";

export const HARNESS_CONFIG_PATH_ENV = "CODEXHOST_HARNESS_CONFIG";
const DATA_DIRECTORY_ENV = "CODEXHOST_DATA_DIR";
const DEFAULT_HARNESS_IDS = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "grok",
  "gemini",
  "omp",
] as const;

export interface HarnessConfigurationStore {
  inspect(): Promise<HarnessConfigurationSnapshot>;
  save(input: HarnessConfigurationSaveParams): Promise<HarnessConfigurationSaveResult>;
}

export function resolveHarnessConfigurationPath(environment: NodeJS.ProcessEnv): string {
  const configured = environment[HARNESS_CONFIG_PATH_ENV];
  if (configured) return path.resolve(configured);
  const dataDirectory = environment[DATA_DIRECTORY_ENV];
  const root = dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), ".codexhost");
  return path.join(root, "harnesses.json");
}

function inferAuthenticationType(config: HarnessEndpointConfig): HarnessAuthenticationType {
  if (config.baseUrl) return "third-party-gateway";
  if (config.apiKeyEnv || Object.keys(config.environment ?? {}).length > 0) return "environment";
  if (config.apiKey) return "official-api-key";
  return "none";
}

function apiKeyHint(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.length < 8) return "********";
  return `****${apiKey.slice(-4)}`;
}

function profileSummary(
  id: string,
  profile: HarnessProfileConfig,
): HarnessConfigurationProfileSummary {
  return {
    id,
    label: profile.label,
    authType: profile.authType,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    apiKeyConfigured: profile.apiKey !== undefined,
    ...(profile.apiKey ? { apiKeyHint: apiKeyHint(profile.apiKey) } : {}),
    ...(profile.apiKeyEnv ? { apiKeyEnv: profile.apiKeyEnv } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.models ? { models: profile.models } : {}),
    ...(profile.command ? { command: profile.command } : {}),
    environmentKeys: Object.keys(profile.environment ?? {}).sort(),
  };
}

function emptyProfile(): HarnessProfileConfig {
  return { label: "Default", authType: "none" };
}

function toV2(config: HarnessConfigFile | null): HarnessConfigFileV2 {
  if (!config) return { version: 2, harnesses: {} };
  if (config.version === 2) return config;
  return {
    version: 2,
    harnesses: Object.fromEntries(
      Object.entries(config.harnesses).map(([harnessId, endpoint]) => [
        harnessId,
        {
          enabled: true,
          activeProfile: "default",
          profiles: {
            default: {
              label: "Default",
              authType: inferAuthenticationType(endpoint),
              ...endpoint,
            },
          },
        },
      ]),
    ),
  };
}

function entrySummary(
  harnessId: string,
  entry?: HarnessProfileSet,
): HarnessConfigurationEntrySummary {
  const resolved = entry ?? {
    enabled: false,
    activeProfile: "default",
    profiles: { default: emptyProfile() },
  };
  return {
    harnessId: harnessIdSchema.parse(harnessId),
    enabled: resolved.enabled,
    activeProfileId: resolved.activeProfile,
    profiles: Object.entries(resolved.profiles).map(([id, profile]) => profileSummary(id, profile)),
  };
}

function profileFromInput(
  input: HarnessConfigurationProfileInput,
  previous: HarnessProfileConfig | undefined,
): HarnessProfileConfig {
  const removedEnvironmentKeys = new Set(input.removeEnvironmentKeys ?? []);
  const environment = Object.fromEntries(
    Object.entries(previous?.environment ?? {}).filter(([key]) => !removedEnvironmentKeys.has(key)),
  );
  Object.assign(environment, input.environment ?? {});
  const apiKey = input.clearApiKey ? undefined : (input.apiKey ?? previous?.apiKey);
  return {
    label: input.label,
    authType: input.authType,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.models ? { models: input.models } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
  };
}

async function readConfiguration(configPath: string): Promise<HarnessConfigFile | null> {
  try {
    return parseHarnessConfigJson(await readFile(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeConfiguration(configPath: string, config: HarnessConfigFileV2): Promise<void> {
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(configPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class FileHarnessConfigurationStore implements HarnessConfigurationStore {
  readonly #path: string;
  readonly #source: "managed" | "environment";
  readonly #harnessIds: readonly string[];
  #restartRequired = false;

  constructor(input: { environment: NodeJS.ProcessEnv; harnessIds?: readonly string[] }) {
    this.#path = resolveHarnessConfigurationPath(input.environment);
    this.#source = input.environment[HARNESS_CONFIG_PATH_ENV] ? "environment" : "managed";
    this.#harnessIds = input.harnessIds ?? DEFAULT_HARNESS_IDS;
  }

  async inspect(): Promise<HarnessConfigurationSnapshot> {
    const config = toV2(await readConfiguration(this.#path));
    const harnessIds = [...new Set([...this.#harnessIds, ...Object.keys(config.harnesses)])];
    let writable = true;
    try {
      await access(this.#path, constants.W_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") writable = false;
    }
    return harnessConfigurationSnapshotSchema.parse({
      path: this.#path,
      source: this.#source,
      writable,
      restartRequired: this.#restartRequired,
      harnesses: harnessIds.map((harnessId) =>
        entrySummary(harnessId, config.harnesses[harnessId]),
      ),
    });
  }

  async save(input: HarnessConfigurationSaveParams): Promise<HarnessConfigurationSaveResult> {
    const parsed = harnessConfigurationSaveParamsSchema.parse(input);
    const config = toV2(await readConfiguration(this.#path));
    const previous = config.harnesses[parsed.harnessId];
    config.harnesses[parsed.harnessId] = {
      enabled: parsed.enabled,
      activeProfile: parsed.activeProfileId,
      profiles: Object.fromEntries(
        parsed.profiles.map((profile) => [
          profile.id,
          profileFromInput(profile, previous?.profiles[profile.id]),
        ]),
      ),
    };
    await writeConfiguration(this.#path, harnessConfigFileV2Schema.parse(config));
    this.#restartRequired = true;
    return { snapshot: await this.inspect() };
  }
}
