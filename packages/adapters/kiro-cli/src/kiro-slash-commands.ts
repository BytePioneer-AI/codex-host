import type { LiveHarnessCommand } from "@codexhost/harness-adapter";

/** Entry of Kiro's ACP `available_commands_update`. */
export interface KiroAvailableCommand {
  name: string;
  description: string;
  /** `_meta.kiro.type`, e.g. `steering`, `custom-agent` or `skill`. */
  type: string | null;
}

export const KIRO_LIVE_COMMAND_ID_PREFIX = "kiro.slash.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseKiroAvailableCommands(value: unknown): KiroAvailableCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\//u, "") : "";
    if (!name) return [];
    const kiro = isRecord(entry._meta) && isRecord(entry._meta.kiro) ? entry._meta.kiro : null;
    return [
      {
        name,
        description: typeof entry.description === "string" ? entry.description : "",
        type: typeof kiro?.type === "string" ? kiro.type : null,
      },
    ];
  });
}

/** Live Composer entries for Kiro's advertised steering, agent and skill commands. */
export function kiroLiveCommands(native: readonly KiroAvailableCommand[]): LiveHarnessCommand[] {
  return native.map((command) => ({
    name: command.name,
    description: command.description,
    kind: command.type === "skill" ? "skill" : "command",
  }));
}
