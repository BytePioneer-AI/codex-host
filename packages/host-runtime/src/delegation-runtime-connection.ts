import { readFile } from "node:fs/promises";
import { cliCredentialsPath, readCliCredentials } from "./cli-credentials.js";

import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DelegationControlError,
  EXTERNAL_CLIENT_TOKEN_ENV,
  EXTERNAL_CLIENT_TOKEN_FILE_ENV,
} from "./delegation-types.js";
import {
  externalClientDescriptorPath,
  externalClientPort,
  readExternalClientDescriptor,
} from "./external-client-server.js";

export interface RuntimeConnection {
  endpoint: string;
  token: string;
  /** `host`: parameters the Host gave this process. `client`: an external client token. */
  kind: "host" | "client";
}

async function clientToken(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const direct = environment[EXTERNAL_CLIENT_TOKEN_ENV]?.trim();
  if (direct) return direct;
  const file = environment[EXTERNAL_CLIENT_TOKEN_FILE_ENV];
  if (!file) return undefined;
  try {
    return (await readFile(file, "utf8")).trim() || undefined;
  } catch (error) {
    throw new DelegationControlError(
      "UNAUTHORIZED",
      `${EXTERNAL_CLIENT_TOKEN_FILE_ENV} could not be read`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function missingHostEnvironment(missing: string[], outsideHost: boolean): DelegationControlError {
  return new DelegationControlError(
    "RUNTIME_UNREACHABLE",
    outsideHost
      ? "No local CLI credentials were found. Start or update the local Host with its external listener enabled, or configure an external client token."
      : `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} required. If this command runs inside native Codex, shell_environment_policy may have filtered the Host-provided CODEXHOST_* variables. Prefer inherit = "all" with ignore_default_excludes = true and a narrow include_only allowlist that contains "CODEXHOST_RUNTIME_ENDPOINT" and "CODEXHOST_RUNTIME_TOKEN" plus the variables required by the platform and invoked tools; do not use unconstrained inherit = "all".`,

    {
      reason: "missing_runtime_environment",
      missingEnvironmentVariables: missing,
      nativeCodexRecovery: {
        recommendedPolicy: {
          inherit: "all",
          ignoreDefaultExcludes: true,
          includeOnlyMustContain: [DELEGATION_RUNTIME_ENDPOINT_ENV, DELEGATION_RUNTIME_TOKEN_ENV],
        },
      },
      // Without any Host parameters the caller may be an external client.
      ...(outsideHost
        ? {
            externalClient: {
              environmentVariables: [EXTERNAL_CLIENT_TOKEN_ENV, EXTERNAL_CLIENT_TOKEN_FILE_ENV],
              register: "codexhost client add <name>",
            },
          }
        : {}),
    },
  );
}

/** Explicit client credentials or the current user's private local CLI credentials. */
export async function usesExternalClient(environment: NodeJS.ProcessEnv): Promise<boolean> {
  return (
    !environment[DELEGATION_RUNTIME_ENDPOINT_ENV] &&
    !environment[DELEGATION_RUNTIME_TOKEN_ENV] &&
    Boolean(
      environment[EXTERNAL_CLIENT_TOKEN_ENV]?.trim() ||
      environment[EXTERNAL_CLIENT_TOKEN_FILE_ENV] ||
      (await readCliCredentials(cliCredentialsPath(environment))),
    )
  );
}

/**
 * Host-provided parameters win, so processes the Host started behave as before.
 * Otherwise explicit client credentials win over local CLI discovery.
 * Nothing is looked up on PATH.
 */
export async function resolveRuntimeConnection(
  environment: NodeJS.ProcessEnv,
): Promise<RuntimeConnection> {
  const endpoint = environment[DELEGATION_RUNTIME_ENDPOINT_ENV];
  const token = environment[DELEGATION_RUNTIME_TOKEN_ENV];
  if (endpoint && token) return { endpoint, token, kind: "host" };
  const missing = [
    ...(!endpoint ? [DELEGATION_RUNTIME_ENDPOINT_ENV] : []),
    ...(!token ? [DELEGATION_RUNTIME_TOKEN_ENV] : []),
  ];
  // A partial Host environment is a broken Host session, not an external client.
  if (endpoint || token) throw missingHostEnvironment(missing, false);
  const client = await clientToken(environment);
  if (!client) {
    const local = await readCliCredentials(cliCredentialsPath(environment));
    if (!local) throw missingHostEnvironment(missing, true);
    return { endpoint: local.endpoint, token: local.token, kind: "client" };
  }
  const descriptor = await readExternalClientDescriptor(externalClientDescriptorPath(environment));
  const port = externalClientPort(environment);
  if (!descriptor && port === undefined)
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      "The external client listener is turned off",
    );
  return {
    endpoint: descriptor?.endpoint ?? `http://127.0.0.1:${port}`,
    token: client,
    kind: "client",
  };
}
