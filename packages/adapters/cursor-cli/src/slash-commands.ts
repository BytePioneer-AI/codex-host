import type { AvailableCommand } from "@agentclientprotocol/sdk";
import {
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";
import {
  isExcludedLiveCommand,
  type HarnessCommandInvocation,
  type HarnessResult,
} from "@codexhost/harness-adapter";

/** Cursor rewrites its own CLI configuration file. */
const CURSOR_EXCLUSIONS = { names: ["update-cli-config"] };

export function cursorCommands(native: AvailableCommand[]): HarnessCommandCatalog {
  const commands = new Map<string, HarnessCommandCatalog["commands"][number]>();
  for (const command of native) {
    // Cursor does not tell skills and commands apart, so the common command
    // exclusions apply to every entry.
    if (isExcludedLiveCommand(command.name, "command", CURSOR_EXCLUSIONS)) continue;
    const result = harnessCommandDescriptorSchema.safeParse({
      id: `cursor.${command.name}`,
      invocation: `/${command.name}`,
      label: `/${command.name}`,
      ...(command.description.trim() ? { description: command.description.slice(0, 512) } : {}),
      // Cursor 2026.09.10 omits input metadata for both its administrative command
      // and custom commands/skills, whose parser still accepts trailing text.
      // Honor an explicit native no-input declaration without disabling those skills.
      argumentMode: command.input === null || command.name === "copy-request-id" ? "none" : "text",
    });
    if (result.success) commands.set(result.data.id, result.data);
  }
  return { commands: [...commands.values()] };
}

// Host reads this catalog without opening a Session; execution still validates native availability.
export const CURSOR_COMMAND_CATALOG = cursorCommands([
  { name: "copy-request-id", description: "Copy the current request ID", input: null },
]);

export function cursorCommandPrompt(
  command: HarnessCommandInvocation,
  catalog: HarnessCommandCatalog,
): HarnessResult<string> {
  const descriptor = catalog.commands.find(({ id }) => id === command.commandId);
  if (!descriptor)
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: "Cursor did not advertise this command",
        retryable: false,
      },
    };
  const args = command.arguments;
  if (
    args &&
    (Object.keys(args).some((key) => key !== "text") ||
      (args.text !== undefined && typeof args.text !== "string") ||
      (descriptor.argumentMode === "none" && Object.keys(args).length))
  )
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Invalid Cursor command arguments",
        retryable: false,
      },
    };
  const text = typeof args?.text === "string" ? args.text.trim() : "";
  return { ok: true, value: `${descriptor.invocation}${text ? ` ${text}` : ""}` };
}
