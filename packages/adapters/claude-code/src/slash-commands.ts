import { liveHarnessCommandPrompt, mergeLiveHarnessCommands } from "@codexhost/harness-adapter";
import type { HarnessCommandCatalog } from "@codexhost/shared-contracts";

/** Slash command as reported by the Claude Agent SDK (`supportedCommands`). */
export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/** Live command state of a started Claude transport. */
export interface ClaudeSlashCommandSnapshot {
  commands: readonly ClaudeSlashCommand[];
  /** Names Claude reports as skills in its `init` system message. */
  skillNames: ReadonlySet<string>;
}

const DYNAMIC_ID_PREFIX = "claude.slash.";

/**
 * Claude-specific additions to the common exclusions: account and usage
 * settings, setup doctors, cloud agents, removed or renamed commands, and the
 * server-driven workflow entry points.
 */
const CLAUDE_EXCLUDED_COMMANDS = [
  "advisor",
  "agents",
  "design-consent",
  "design-revoke",
  "doctor",
  "extra-usage",
  "import",
  "team-onboarding",
  "ultrareview",
  "usage-credits",
  "workflow-launch-exec",
];

export function parseClaudeSlashCommands(value: unknown): ClaudeSlashCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim().replace(/^\//u, "") : "";
    if (!name) return [];
    return [
      {
        name,
        description: typeof record.description === "string" ? record.description : "",
        argumentHint: typeof record.argumentHint === "string" ? record.argumentHint : "",
      },
    ];
  });
}

/** Built-ins plus the live commands and skills of the started native Session. */
export function claudeLiveCommandCatalog(
  builtIns: HarnessCommandCatalog,
  snapshot: ClaudeSlashCommandSnapshot | null,
): HarnessCommandCatalog {
  return mergeLiveHarnessCommands(
    builtIns,
    DYNAMIC_ID_PREFIX,
    snapshot?.commands.map((command) => ({
      name: command.name,
      description: command.description,
      kind: snapshot.skillNames.has(command.name) ? ("skill" as const) : ("command" as const),
    })) ?? null,
    { names: CLAUDE_EXCLUDED_COMMANDS },
  );
}

/** Prompt text for a dynamic command, or null when the id is not dynamic. */
export function claudeDynamicCommandPrompt(
  catalog: HarnessCommandCatalog,
  commandId: string,
  argumentText: string | undefined,
): string | null {
  return liveHarnessCommandPrompt(catalog, DYNAMIC_ID_PREFIX, commandId, argumentText);
}
