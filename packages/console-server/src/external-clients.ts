import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { processIsAlive } from "./diagnostics.js";
import { dataDirectory } from "./paths.js";

export type ConsoleClientScope = "read" | "dispatch";
export type ConsoleClientNetwork = "local" | "tailnet" | "public";

export interface ConsoleListenerStatus {
  state: "off" | "on" | "unavailable";
  endpoint?: string;
  mcpUrl?: string;
  reason?: string;
}

export interface ConsoleExternalAccessSettings {
  tailnet: boolean;
  public: boolean;
}

export interface ConsoleWebhookState {
  delivered: number;
  attempts?: number;
  firstAttemptAt?: number;
  nextAttemptAt?: number;
  lastSuccessAt?: string;
  lastFailure?: { eventId: number; at: string; reason: string; final: boolean };
}

export interface ConsoleClientWebhook {
  adapter: string;
  url: string;
  keyConfigured: boolean;
  state: ConsoleWebhookState;
}

export interface ConsoleExternalClient {
  name: string;
  createdAt: string;
  scope: ConsoleClientScope;
  networks: ConsoleClientNetwork[];
  lastAccess?: { network: ConsoleClientNetwork; at: string };
  webhook: ConsoleClientWebhook | null;
}

export interface ConsoleExternalClientsSnapshot {
  settings: ConsoleExternalAccessSettings;
  listeners: {
    local: ConsoleListenerStatus;
    tailnet: ConsoleListenerStatus;
    public: ConsoleListenerStatus;
    updatedAt?: string;
  };
  clients: ConsoleExternalClient[];
}

export interface ConsoleExternalClients {
  get(): Promise<ConsoleExternalClientsSnapshot>;
  setAccess(patch: Partial<ConsoleExternalAccessSettings>): Promise<ConsoleExternalClientsSnapshot>;
}

const VALID_SCOPES: readonly ConsoleClientScope[] = ["read", "dispatch"];
const VALID_NETWORKS: readonly ConsoleClientNetwork[] = ["local", "tailnet", "public"];

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function normalizeClient(
  raw: Record<string, unknown>,
): Omit<ConsoleExternalClient, "webhook"> | null {
  if (typeof raw.name !== "string" || typeof raw.createdAt !== "string") return null;
  const scope: ConsoleClientScope =
    typeof raw.scope === "string" && VALID_SCOPES.includes(raw.scope as ConsoleClientScope)
      ? (raw.scope as ConsoleClientScope)
      : "dispatch";
  const networks = Array.isArray(raw.networks)
    ? raw.networks.filter(
        (network): network is ConsoleClientNetwork =>
          typeof network === "string" && VALID_NETWORKS.includes(network as ConsoleClientNetwork),
      )
    : (["local"] as ConsoleClientNetwork[]);
  const lastAccessRaw =
    typeof raw.lastAccess === "object" && raw.lastAccess !== null && !Array.isArray(raw.lastAccess)
      ? (raw.lastAccess as Record<string, unknown>)
      : null;
  const lastAccess =
    lastAccessRaw &&
    typeof lastAccessRaw.network === "string" &&
    VALID_NETWORKS.includes(lastAccessRaw.network as ConsoleClientNetwork) &&
    typeof lastAccessRaw.at === "string"
      ? { network: lastAccessRaw.network as ConsoleClientNetwork, at: lastAccessRaw.at }
      : undefined;
  return {
    name: raw.name,
    createdAt: raw.createdAt,
    scope,
    networks: networks.length > 0 ? networks : ["local"],
    ...(lastAccess ? { lastAccess } : {}),
  };
}

/**
 * Reads external client registrations, listener status, and webhook delivery
 * state from the user's data directory, and updates the tailnet/public switches.
 * Token hashes and webhook keys are never returned.
 */
export function createConsoleExternalClients(
  environment: NodeJS.ProcessEnv = process.env,
): ConsoleExternalClients {
  const root = dataDirectory(environment);
  const settingsPath = path.join(root, "external-client-access.json");
  const statusPath = path.join(root, "external-client-access-status.json");
  const endpointPath = path.join(root, "external-client-endpoint.json");
  const clientsPath = path.join(root, "external-clients.json");
  const webhooksDirectory = path.join(root, "client-webhooks");

  const readSettings = async (): Promise<ConsoleExternalAccessSettings> => {
    const raw = await readJson<Partial<ConsoleExternalAccessSettings>>(settingsPath);
    return { tailnet: raw?.tailnet === true, public: raw?.public === true };
  };

  const get = async (): Promise<ConsoleExternalClientsSnapshot> => {
    const [settings, status, endpoint, clientsFile] = await Promise.all([
      readSettings(),
      readJson<{
        tailnet?: ConsoleListenerStatus;
        public?: ConsoleListenerStatus;
        updatedAt?: string;
      }>(statusPath),
      readJson<{ schemaVersion?: number; endpoint?: string; pid?: number }>(endpointPath),
      readJson<{ formatVersion?: number; clients?: Array<Record<string, unknown>> }>(clientsPath),
    ]);
    const localAlive =
      endpoint?.schemaVersion === 1 &&
      typeof endpoint.endpoint === "string" &&
      (typeof endpoint.pid !== "number" || processIsAlive(endpoint.pid));
    const local: ConsoleListenerStatus = localAlive
      ? { state: "on", endpoint: endpoint.endpoint as string }
      : { state: "off" };
    const rawClients =
      clientsFile?.formatVersion === 1 && Array.isArray(clientsFile.clients)
        ? clientsFile.clients
        : [];
    const clients = await Promise.all(
      rawClients
        .map(normalizeClient)
        .filter((client): client is Omit<ConsoleExternalClient, "webhook"> => client !== null)
        .map(async (client): Promise<ConsoleExternalClient> => {
          const config = await readJson<{ adapter?: string; url?: string; key?: string }>(
            path.join(webhooksDirectory, `${client.name}.json`),
          );
          if (!config || typeof config.adapter !== "string" || typeof config.url !== "string") {
            return { ...client, webhook: null };
          }
          const state = (await readJson<ConsoleWebhookState>(
            path.join(webhooksDirectory, `${client.name}.state.json`),
          )) ?? { delivered: 0 };
          return {
            ...client,
            webhook: {
              adapter: config.adapter,
              url: config.url,
              keyConfigured: Boolean(config.key),
              state,
            },
          };
        }),
    );
    return {
      settings,
      listeners: {
        local,
        tailnet: status?.tailnet ?? { state: "off" },
        public: status?.public ?? { state: "off" },
        ...(typeof status?.updatedAt === "string" ? { updatedAt: status.updatedAt } : {}),
      },
      clients,
    };
  };

  return {
    get,
    async setAccess(patch) {
      const current = await readSettings();
      const next: ConsoleExternalAccessSettings = {
        tailnet: patch.tailnet ?? current.tailnet,
        public: patch.public ?? current.public,
      };
      await writePrivateJson(settingsPath, { formatVersion: 1, ...next });
      return get();
    },
  };
}
