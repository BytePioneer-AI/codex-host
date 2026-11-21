import { readFile } from "node:fs/promises";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";
import { ClientEventLog, eventRetentionDays } from "./external-client-events.js";
import { WebhookStore } from "./external-client-webhooks.js";
import {
  externalAccessPaths,
  readAccessSettings,
  readAccessStatus,
  writeAccessSettings,
} from "./external-client-access.js";
import {
  ExternalClientOAuthStore,
  defaultExternalClientOAuthPath,
} from "./external-client-oauth.js";
import {
  ExternalClientRegistry,
  codexhostDataDirectory,
  defaultExternalClientsPath,
  type ClientAccess,
  type ClientNetwork,
  type ClientScope,
} from "./external-clients.js";

/** `--scope` and `--network` as given; the registry validates the values. */
function accessOptions(options: {
  scope?: string | undefined;
  network?: string | undefined;
}): Partial<ClientAccess> {
  return {
    ...(options.scope ? { scope: options.scope as ClientScope } : {}),
    ...(options.network
      ? {
          networks: options.network
            .split(",")
            .map((network) => network.trim())
            .filter(Boolean) as ClientNetwork[],
        }
      : {}),
  };
}

/** `codexhost client add|list|set|remove`: edits the local registry; no Runtime is needed. */
export async function runClientCommand(
  command: string | undefined,
  positionals: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: {
    scope?: string | undefined;
    network?: string | undefined;
    tailnet?: string | undefined;
    public?: string | undefined;
    adapter?: string | undefined;
    url?: string | undefined;
    keyFile?: string | undefined;
    clear?: boolean | undefined;
  } = {},
): Promise<unknown> {
  if (command === "access") return runAccessCommand(positionals, environment, options);
  if (command === "webhook") return runWebhookCommand(positionals, environment, options);
  const clients = new ExternalClientRegistry(defaultExternalClientsPath(environment));
  const access = accessOptions(options);
  if (command === "list") {
    if (positionals.length > 0)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "client list accepts no positional arguments",
      );
    return { clients: await clients.list() };
  }
  if (command === "add" || command === "remove" || command === "set" || command === "pair") {
    const name = positionals.length === 1 ? positionals[0] : undefined;
    if (!name)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `client ${command} requires one client name`,
      );
    const oauth = new ExternalClientOAuthStore(defaultExternalClientOAuthPath(environment));
    if (command === "remove") {
      await clients.remove(name);
      await oauth.revokeClient(name);
      return { name, removed: true };
    }
    if (command === "pair") {
      const existing = (await clients.list()).find((client) => client.name === name);
      if (!existing)
        throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
      const pairing = await oauth.createPairingCode(name);
      return {
        name: pairing.client,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        note: existing.networks.includes("public")
          ? "Enter this one-time pairing code on the public OAuth authorization page within 10 minutes."
          : "Enter this one-time pairing code on the public OAuth authorization page within 10 minutes. Note: allow 'public' network for this client with 'codexhost client set " +
            name +
            " --network local,public' before using the public MCP endpoint.",
      };
    }
    if (command === "set") {
      if (Object.keys(access).length === 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "client set requires --scope or --network",
        );
      return clients.setAccess(name, access);
    }
    const { client, token } = await clients.add(name, access);
    return {
      ...client,
      token,
      note: "Store this token now; it is not shown again. Set CODEXHOST_CLIENT_TOKEN to it in the client.",
    };
  }
  throw new DelegationControlError(
    "INVALID_ARGUMENT",
    "Unknown client command. Run 'codexhost client --help'.",
  );
}

function onOff(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on" || value === "off") return value === "on";
  throw new DelegationControlError("INVALID_ARGUMENT", `${name} must be on or off`);
}

/** `codexhost client access [--tailnet on|off] [--public on|off]`: shows or changes the switches. */
async function runAccessCommand(
  positionals: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: { tailnet?: string | undefined; public?: string | undefined },
): Promise<unknown> {
  if (positionals.length > 0)
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "client access accepts no positional arguments",
    );
  const paths = externalAccessPaths(environment);
  const settings = await readAccessSettings(paths.settings);
  const tailnet = onOff(options.tailnet, "--tailnet");
  const publicAccess = onOff(options.public, "--public");
  const changed = tailnet !== undefined || publicAccess !== undefined;
  if (changed)
    await writeAccessSettings(paths.settings, {
      tailnet: tailnet ?? settings.tailnet,
      public: publicAccess ?? settings.public,
    });
  return {
    settings: await readAccessSettings(paths.settings),
    // Written by the running Runtime; it applies changes within 30 s.
    status: (await readAccessStatus(paths.status)) ?? null,
    ...(changed ? { note: "A running codexhost applies this within 30 seconds." } : {}),
  };
}

export const WEBHOOK_KEY_ENV = "CODEXHOST_WEBHOOK_KEY";

export function webhookDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "client-webhooks");
}

/**
 * `codexhost client webhook <name> [--adapter <id> --url <url> [--key-file <path>] | --clear]`.
 * The key comes from a file or CODEXHOST_WEBHOOK_KEY, never from the command line.
 */
async function runWebhookCommand(
  positionals: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: {
    adapter?: string | undefined;
    url?: string | undefined;
    keyFile?: string | undefined;
    clear?: boolean | undefined;
  },
): Promise<unknown> {
  const name = positionals.length === 1 ? positionals[0] : undefined;
  if (!name)
    throw new DelegationControlError("INVALID_ARGUMENT", "client webhook requires one client name");
  if (!(await new ExternalClientRegistry(defaultExternalClientsPath(environment)).has(name)))
    throw new DelegationControlError("INVALID_ARGUMENT", `Client '${name}' does not exist`);
  const store = new WebhookStore(webhookDirectory(environment));
  if (options.clear) {
    await store.clear(name);
    return { name, webhook: null };
  }
  if (options.adapter || options.url) {
    if (!options.adapter || !options.url)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--adapter and --url are required together",
      );
    const key = options.keyFile
      ? (await readFile(options.keyFile, "utf8")).trim()
      : (environment[WEBHOOK_KEY_ENV]?.trim() ?? "");
    const events = new ClientEventLog({
      directory: path.join(codexhostDataDirectory(environment), "client-events"),
      retentionDays: eventRetentionDays(environment),
    });
    await store.set(
      name,
      { adapter: options.adapter, url: options.url, key },
      await events.lastEventId(name),
    );
  }
  const config = await store.config(name);
  return {
    name,
    webhook: config
      ? { adapter: config.adapter, url: config.url, keyConfigured: Boolean(config.key) }
      : null,
    ...(config ? { state: await store.state(name) } : {}),
  };
}
