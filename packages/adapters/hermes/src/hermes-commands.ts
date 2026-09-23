import type { AvailableCommand } from "@agentclientprotocol/sdk";
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

// The common exclusions cover Hermes' unsuitable commands: model changes use
// session/set_model so the Host sees confirmed configuration, reset would
// invalidate Host history, and queue/steer need overlapping prompt streams.

export function hermesCommandCatalog(commands: readonly AvailableCommand[]): HarnessCommandCatalog {
  const seen = new Set<string>();
  const descriptors = commands.flatMap((command) => {
    if (isExcludedLiveCommand(command.name, "command")) return [];
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

export const HERMES_GATEWAY_COMMANDS: AvailableCommand[] = [
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
