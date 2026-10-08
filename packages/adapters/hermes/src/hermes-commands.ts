import type { HermesNativeCommand } from "./hermes-transport.js";
import { gatewayRecord } from "./gateway-transport.js";
import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";
import {
  isExcludedLiveCommand,
  type HarnessCommandInvocation,
  type HarnessResult,
} from "@codexhost/harness-adapter";

// Additional Hermes aliases and stateful/native-UI commands. Unknown plugin
// commands still run through native slash.exec, not a Host implementation.
// Source/desktop metadata rejects other unreviewed built-ins. These protect
// native control paths and aliases even if a plugin tries to use their names.
// Gateway turn.steer calls session.steer directly.
const HERMES_EXCLUSIONS = new Set([
  "q",
  "s",
  "compact",
  "snap",
  "hb",
  "proactive",
  "codex_runtime",
  "set-home",
  "undo",
  "retry",
  "snapshot",
  "title",
  "reasoning",
  "yolo",
  "stop",
  "pause",
  "approve",
  "deny",
  "approvals",
  "moa",
  "heartbeat",
  "subgoal",
  "codex-runtime",
  "restart",
  "start",
  "topic",
  "sethome",
  "platform",
  "usage",
  "memory",
  "skills",
]);

export function isExcludedHermesCommand(name: string): boolean {
  return isExcludedLiveCommand(name.toLowerCase(), "command", { names: HERMES_EXCLUSIONS });
}

export function hermesCommandCatalog(
  commands: readonly HermesNativeCommand[],
): HarnessCommandCatalog {
  const seen = new Set<string>();
  const descriptors = commands.flatMap((command) => {
    if (isExcludedHermesCommand(command.name)) return [];
    const parsed = harnessCommandDescriptorSchema.safeParse({
      id: `hermes.${command.name}`,
      invocation: `/${command.name}`,
      label: `/${command.name}`,
      description: command.description.slice(0, 512) || `Hermes /${command.name}`,
      argumentMode: command.input ? "text" : "none",
    });
    if (!parsed.success || seen.has(parsed.data.id)) return [];
    seen.add(parsed.data.id);
    return [parsed.data];
  });
  return harnessCommandCatalogSchema.parse({ commands: descriptors });
}

export const HERMES_GATEWAY_COMMANDS: HermesNativeCommand[] = [
  ...["help", "tools", "context", "version"].map((name) => ({
    name,
    description: `Hermes /${name}`,
  })),
  {
    name: "compress",
    description: "Compress conversation context",
    input: { hint: "Optional compression focus" },
  },
];
export function hermesGatewayCommandName(
  text: string,
  commands: readonly HermesNativeCommand[] = HERMES_GATEWAY_COMMANDS,
): string | null {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  const name = match?.[1]?.toLowerCase();
  const command = commands.find(
    (entry) => entry.name === name && !isExcludedHermesCommand(entry.name),
  );
  return command && (command.input || !match?.[2]?.trim()) ? command.name : null;
}

/** Completion is bounded. Catalog supplies source/argument metadata and entries beyond that cap. */
export function hermesCommandsFromCompletion(
  items: unknown,
  value: unknown,
): HermesNativeCommand[] {
  const catalog = gatewayRecord(value);
  if (!Array.isArray(items) || !Array.isArray(catalog.categories) || !Array.isArray(catalog.pairs))
    throw new Error("Hermes returned an invalid slash command catalog");
  const metadata = gatewayRecord(catalog.commands);
  const skills = new Set(Object.keys(gatewayRecord(catalog.skills)));
  for (const item of items) {
    const entry = gatewayRecord(item);
    if (entry.kind === "skill" && typeof entry.text === "string")
      skills.add(`/${entry.text.replace(/^\//u, "")}`);
  }
  const quick = new Set<string>();
  const plugins = new Set<string>();
  for (const category of catalog.categories) {
    const entry = gatewayRecord(category);
    if (!Array.isArray(entry.pairs)) continue;
    const target =
      entry.name === "Plugin commands" ? plugins : entry.name === "User commands" ? quick : null;
    if (target)
      for (const pair of entry.pairs)
        if (Array.isArray(pair) && typeof pair[0] === "string") target.add(pair[0]);
  }
  const reviewed = new Set(["status", "diff", "egress", "whoami", "insights", "bundles"]);
  const commands = new Map(HERMES_GATEWAY_COMMANDS.map((command) => [command.name, command]));
  for (const pair of catalog.pairs) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
    const key = pair[0];
    const name = key.replace(/^\//u, "").toLowerCase();
    const meta = gatewayRecord(metadata[key]);
    // Quick aliases can reach excluded commands. Skills need pending-input/origin
    // handling. Unreviewed built-ins and native-only desktop surfaces fail closed.
    if (
      !/^[a-z0-9][\w-]*$/u.test(name) ||
      commands.has(name) ||
      quick.has(key) ||
      skills.has(key) ||
      isExcludedHermesCommand(name) ||
      (!reviewed.has(name) && !plugins.has(key)) ||
      meta.desktop !== null ||
      ![null, "text", "options", "mixed"].includes(meta.argument_mode as string | null)
    )
      continue;
    commands.set(name, {
      name,
      description: typeof pair[1] === "string" ? pair[1] : `Hermes /${name}`,
      ...(meta.argument_mode === "text" ||
      meta.argument_mode === "options" ||
      meta.argument_mode === "mixed"
        ? { input: { hint: "Native command arguments" } }
        : {}),
    });
  }
  return [...commands.values()];
}
// Static menu metadata; the Session validates its actual native command catalog at execution.
export const HERMES_COMMAND_CATALOG = hermesCommandCatalog(HERMES_GATEWAY_COMMANDS);

export function hermesCommandText(
  command: HarnessCommandInvocation,
  catalog: HarnessCommandCatalog,
): HarnessResult<string> {
  const descriptor = catalog.commands.find((entry) => entry.id === command.commandId);
  if (!descriptor)
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: "Hermes did not advertise this command",
        retryable: false,
      },
    };
  const args = command.arguments ?? {};
  if (
    Object.keys(args).some((key) => key !== "text") ||
    (args.text !== undefined && typeof args.text !== "string") ||
    (descriptor.argumentMode === "none" && typeof args.text === "string" && args.text.trim())
  ) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Invalid Hermes command arguments",
        retryable: false,
      },
    };
  }
  return {
    ok: true,
    value: `${descriptor.invocation}${typeof args.text === "string" && args.text.trim() ? ` ${args.text.trim()}` : ""}`,
  };
}
