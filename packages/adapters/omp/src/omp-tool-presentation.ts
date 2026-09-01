import type { HostCommandExecutionItem } from "@codexhost/harness-adapter";
import type { HostItemId, JsonValue } from "@codexhost/shared-contracts";

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonValue, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function toolCommand(toolName: string, argumentsValue: JsonValue): string {
  if (toolName === "bash") {
    const command = stringField(argumentsValue, "command");
    if (command) return command;
  }
  const serializedArguments = JSON.stringify(argumentsValue);
  return serializedArguments === "{}" ? toolName : `${toolName} ${serializedArguments}`;
}

/**
 * OMP tools use Desktop's inspectable command-output lane. This is an
 * OMP-specific compatibility projection; the shared Host Tool contract remains
 * UI-independent.
 */
export function projectOmpToolItem(input: {
  itemId: HostItemId;
  toolName: string;
  arguments: JsonValue;
  cwd?: string;
}): HostCommandExecutionItem {
  return {
    type: "commandExecution",
    itemId: input.itemId,
    command: toolCommand(input.toolName, input.arguments),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
}
