import { DelegationControlError } from "./delegation-types.js";
import {
  ExternalClientRegistry,
  defaultExternalClientsPath,
  type ClientScope,
} from "./external-clients.js";

/** `codexhost client add|list|set|remove`: edits the local registry; no Runtime is needed. */
export async function runClientCommand(
  command: string | undefined,
  positionals: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: { scope?: string | undefined } = {},
): Promise<unknown> {
  const clients = new ExternalClientRegistry(defaultExternalClientsPath(environment));
  // The registry validates the value.
  const scope = options.scope as ClientScope | undefined;
  if (scope !== undefined && command !== "add" && command !== "set")
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--scope applies only to client add and client set",
    );
  if (command === "list") {
    if (positionals.length > 0)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "client list accepts no positional arguments",
      );
    return { clients: await clients.list() };
  }
  if (command === "add" || command === "remove" || command === "set") {
    const name = positionals.length === 1 ? positionals[0] : undefined;
    if (!name)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `client ${command} requires one client name`,
      );
    if (command === "remove") {
      await clients.remove(name);
      return { name, removed: true };
    }
    if (command === "set") {
      if (scope === undefined)
        throw new DelegationControlError("INVALID_ARGUMENT", "client set requires --scope");
      return clients.setScope(name, scope);
    }
    const { client, token } = await clients.add(name, scope);
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
