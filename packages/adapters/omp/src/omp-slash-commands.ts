import type { LiveHarnessCommand } from "@codexhost/harness-adapter";

/** Entry of OMP's RPC `available_commands_update` event. */
export interface OmpAvailableCommand {
  name: string;
  description: string;
  /** `builtin`, `skill`, or an extension-defined source. */
  source: string | null;
}

export const OMP_LIVE_COMMAND_ID_PREFIX = "omp.slash.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOmpAvailableCommands(value: unknown): OmpAvailableCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\//u, "") : "";
    if (!name) return [];
    return [
      {
        name,
        description: typeof entry.description === "string" ? entry.description : "",
        source: typeof entry.source === "string" ? entry.source : null,
      },
    ];
  });
}

/**
 * OMP built-ins drive its own UI and Session state (model, session, share,
 * browser, plugins, ...), so only skills and extension commands reach the
 * Composer. `/compact` keeps its dedicated Adapter handling.
 */
export function ompLiveCommands(native: readonly OmpAvailableCommand[]): LiveHarnessCommand[] {
  return native
    .filter(({ source }) => source !== "builtin")
    .map((command) => ({
      name: command.name,
      description: command.description,
      kind: command.source === "skill" ? "skill" : "command",
    }));
}
