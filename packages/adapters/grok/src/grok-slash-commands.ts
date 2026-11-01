import type { LiveHarnessCommand } from "@codexhost/harness-adapter";

/** Entry of Grok's ACP `available_commands_update`. */
export interface GrokAvailableCommand {
  name: string;
  description: string;
  meta: Record<string, unknown> | null;
}

export const GROK_LIVE_COMMAND_ID_PREFIX = "grok.slash.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGrokAvailableCommands(value: unknown): GrokAvailableCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\//u, "") : "";
    if (!name) return [];
    return [
      {
        name,
        description: typeof entry.description === "string" ? entry.description : "",
        meta: isRecord(entry._meta) ? entry._meta : null,
      },
    ];
  });
}

/** Grok reports skills with their `SKILL.md` path and a qualified name. */
function isGrokSkill(command: GrokAvailableCommand): boolean {
  const path = command.meta?.path;
  return (
    (typeof path === "string" && /(^|[\\/])SKILL\.md$/u.test(path)) ||
    typeof command.meta?.qualifiedName === "string"
  );
}

/**
 * Live Composer entries for Grok's advertised commands, workflows and skills.
 * Approval, hook, feedback and loop commands are removed by the common live
 * command exclusions when the catalog is merged.
 */
export function grokLiveCommands(native: readonly GrokAvailableCommand[]): LiveHarnessCommand[] {
  return native.map((command) => ({
    name: command.name,
    description: command.description,
    kind: isGrokSkill(command) ? "skill" : "command",
  }));
}
