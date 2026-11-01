import { liveHarnessCommandPrompt, mergeLiveHarnessCommands } from "@codexhost/harness-adapter";
import type { HarnessCommandCatalog } from "@codexhost/shared-contracts";

/** Entry of Pi's RPC `get_commands` response. */
export interface PiNativeCommand {
  name: string;
  description?: string;
  /** `extension`, `prompt` (template) or `skill`. */
  source?: string;
}

const DYNAMIC_ID_PREFIX = "pi.slash.";
/**
 * pi-subagents management commands act on background runs (stop, steer,
 * detach, watchdog, fleet) or rewrite profiles and provider models, plus the
 * Host-internal inspection helper. Launch and inspection commands stay.
 */
const PI_EXCLUDED_COMMANDS = [
  "subagents-detach",
  "subagents-fleet",
  "subagents-generate-profiles",
  "subagents-inspect-rpc",
  "subagents-load-profile",
  "subagents-refresh-provider-models",
  "subagents-steer",
  "subagents-stop",
  "subagents-watchdog",
];

export function parsePiNativeCommands(response: unknown): PiNativeCommand[] {
  const data =
    typeof response === "object" && response !== null
      ? (response as { data?: { commands?: unknown } }).data
      : undefined;
  if (!Array.isArray(data?.commands)) return [];
  return data.commands.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim().replace(/^\//u, "") : "";
    if (!name) return [];
    return [
      {
        name,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(typeof record.source === "string" ? { source: record.source } : {}),
      },
    ];
  });
}

/** Built-ins plus the running Session's commands, prompt templates and skills. */
export function piLiveCommandCatalog(
  builtIns: HarnessCommandCatalog,
  native: readonly PiNativeCommand[] | null,
): HarnessCommandCatalog {
  return mergeLiveHarnessCommands(
    builtIns,
    DYNAMIC_ID_PREFIX,
    native?.map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      kind: command.source === "skill" ? ("skill" as const) : ("command" as const),
    })) ?? null,
    { names: PI_EXCLUDED_COMMANDS },
  );
}

/** Prompt text for a dynamic command, or null when the id is not dynamic. */
export function piDynamicCommandPrompt(
  catalog: HarnessCommandCatalog,
  commandId: string,
  argumentText: string | undefined,
): string | null {
  return liveHarnessCommandPrompt(catalog, DYNAMIC_ID_PREFIX, commandId, argumentText);
}
