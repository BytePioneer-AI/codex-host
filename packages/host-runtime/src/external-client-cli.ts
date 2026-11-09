import { DelegationControlError } from "./delegation-types.js";
import { ExternalClientRegistry, defaultExternalClientsPath } from "./external-clients.js";

/** `codexhost client add|list|remove`: edits the local registry; no Runtime is needed. */
export async function runClientCommand(
  command: string | undefined,
  positionals: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const clients = new ExternalClientRegistry(defaultExternalClientsPath(environment));
  if (command === "list") {
    if (positionals.length > 0)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "client list accepts no positional arguments",
      );
    return { clients: await clients.list() };
  }
  if (command === "add" || command === "remove") {
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
    const { client, token } = await clients.add(name);
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
