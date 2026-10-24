import type { JsonObject } from "@codexhost/protocol-core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";

export interface NativeVoiceCompatibility {
  arguments: string[];
  prepareRequest?: (method: string, params: JsonObject) => Promise<JsonObject>;
}

export class NativeProviderRestartRequiredError extends Error {
  constructor(project = false) {
    super(
      project
        ? "Project Provider override cannot use native voice compatibility; select an explicit Profile and restart CodexHost"
        : "Native Provider changed; restart CodexHost to apply the new route",
    );
    this.name = "NativeProviderRestartRequiredError";
  }
}

const startsWork = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
  "turn/steer",
  "thread/compact/start",
  "thread/queue/start",
  "review/start",
  "thread/realtime/start",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Recognize only CC Switch's endpoint-free official shared-history alias. */
function officialHistoryAlias(config: Record<string, unknown>): boolean {
  if (
    config.model_provider !== "custom" ||
    config.profile !== undefined ||
    config.openai_base_url !== undefined
  )
    return false;
  const providers = config.model_providers;
  if (!record(providers) || providers.openai !== undefined || !record(providers.custom))
    return false;
  const provider = providers.custom;
  return (
    Object.keys(provider).length === 4 &&
    provider.name === "OpenAI" &&
    provider.requires_openai_auth === true &&
    provider.supports_websockets === true &&
    provider.wire_api === "responses"
  );
}

function explicitRoute(arguments_: readonly string[]): boolean {
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index] ?? "";
    if (
      (argument.startsWith("-p") && !argument.startsWith("--")) ||
      argument === "--profile" ||
      argument.startsWith("--profile=") ||
      argument === "-C" ||
      argument.startsWith("-C") ||
      argument === "--cd" ||
      argument.startsWith("--cd=")
    )
      return true;
    const config =
      argument === "-c" || argument === "--config"
        ? arguments_[++index]
        : argument.startsWith("--config=")
          ? argument.slice("--config=".length)
          : argument.startsWith("-c") && !argument.startsWith("--")
            ? argument.slice(2)
            : undefined;
    if ((argument === "-c" || argument === "--config") && config === undefined) return true;
    if (config !== undefined) {
      // Native CLI overrides accept plugin ids containing @ in dotted keys;
      // those are not bare TOML assignments. Inspect the root key first.
      const key = config.split("=", 1)[0]?.trim() ?? "";
      const bareRoot = /^[A-Za-z0-9_-]+(?=\.|$)/u.exec(key)?.[0];
      if (bareRoot) {
        if (["model_provider", "model_providers", "openai_base_url", "profile"].includes(bareRoot))
          return true;
        continue;
      }
      try {
        if (
          Object.keys(parse(config)).some((key) =>
            ["model_provider", "model_providers", "openai_base_url", "profile"].includes(key),
          )
        )
          return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

async function readConfig(file: string): Promise<Record<string, unknown> | null> {
  try {
    return parse(await readFile(file, "utf8"));
  } catch {
    // Unknown configuration stays on the native path; never infer a route from partial TOML.
    return null;
  }
}

async function checkProjectRoute(cwd: string, home: string): Promise<void> {
  for (let directory = path.resolve(home, cwd); ; directory = path.dirname(directory)) {
    const file = path.join(directory, ".codex", "config.toml");
    if (file !== path.join(home, "config.toml")) {
      let text: string | undefined;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR"].includes(String(error.code))
        ))
          throw new NativeProviderRestartRequiredError(true);
      }
      if (text !== undefined) {
        let config: Record<string, unknown>;
        try {
          config = parse(text);
        } catch {
          throw new NativeProviderRestartRequiredError(true);
        }
        const providers = config.model_providers;
        if (
          config.profile !== undefined ||
          config.openai_base_url !== undefined ||
          (config.model_provider !== undefined &&
            !["custom", "openai"].includes(String(config.model_provider))) ||
          (providers !== undefined &&
            (!record(providers) ||
              providers.openai !== undefined ||
              (providers.custom !== undefined &&
                !officialHistoryAlias({ ...config, model_provider: "custom" }))))
        ) {
          throw new NativeProviderRestartRequiredError(true);
        }
      }
    }
    if (path.dirname(directory) === directory) break;
  }
}

function includeHistoryAlias(params: JsonObject): JsonObject {
  const filters = params.modelProviders;
  if (filters === undefined) return { ...params, modelProviders: ["openai", "custom"] };
  if (!Array.isArray(filters) || !filters.every((value) => typeof value === "string"))
    return params;
  if (filters.includes("openai") === filters.includes("custom")) return params;
  return {
    ...params,
    modelProviders: [...filters, filters.includes("openai") ? "custom" : "openai"],
  };
}

export async function prepareNativeVoiceCompatibility(input: {
  home: string;
  arguments: readonly string[];
  environment: NodeJS.ProcessEnv;
  lookupThreadCwd?: (threadId: string) => Promise<string | undefined>;
}): Promise<NativeVoiceCompatibility> {
  const unchanged = { arguments: [...input.arguments] };
  if (explicitRoute(input.arguments) || input.environment.OPENAI_BASE_URL) return unchanged;
  const file = path.join(input.home, "config.toml");
  const config = await readConfig(file);
  if (!config || !officialHistoryAlias(config)) return unchanged;
  return {
    // This is a real native startup override, not a projected config/capability response.
    // Both Providers use the same stock endpoint, OAuth owner and websocket defaults.
    arguments: [...input.arguments, "-c", 'model_provider="openai"'],
    async prepareRequest(method, params) {
      if (startsWork.has(method)) {
        const current = await readConfig(file);
        const builtInOfficial =
          current &&
          (current.model_provider === undefined || current.model_provider === "openai") &&
          current.profile === undefined &&
          current.openai_base_url === undefined &&
          (current.model_providers === undefined ||
            (record(current.model_providers) && current.model_providers.openai === undefined));
        if (!current || (!officialHistoryAlias(current) && !builtInOfficial)) {
          throw new NativeProviderRestartRequiredError();
        }
        const cwd =
          typeof params.cwd === "string"
            ? params.cwd
            : typeof params.threadId === "string"
              ? await input.lookupThreadCwd?.(params.threadId)
              : undefined;
        if (cwd) await checkProjectRoute(cwd, input.home);
      }
      return method === "thread/list" ? includeHistoryAlias(params) : params;
    },
  };
}
