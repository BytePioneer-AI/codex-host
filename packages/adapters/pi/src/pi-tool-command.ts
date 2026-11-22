import type { JsonValue } from "@codexhost/shared-contracts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonValue, key: string): string | undefined {
  if (!record(value)) return undefined;
  for (const source of [value, value.input, value.arguments]) {
    if (record(source) && typeof source[key] === "string" && source[key].length > 0)
      return source[key];
  }
  return undefined;
}

/** Use the same native shell argument aliases for streaming and persisted tool calls. */
export function piToolCommand(
  name: string,
  arguments_: JsonValue,
): { command: string; cwd?: string } | null {
  if (!["bash", "exec", "terminal", "run"].includes(name.toLowerCase())) return null;
  const command = ["command", "cmd", "script", "commandLine", "command_line"]
    .map((key) => stringField(arguments_, key))
    .find((value) => value !== undefined);
  if (!command) return null;
  const cwd = stringField(arguments_, "cwd");
  return { command, ...(cwd ? { cwd } : {}) };
}
