import { type HarnessCommandInvocation, type HarnessResult } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";

export interface DeepSeekCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string; readonly images?: boolean };
}

const commandDefinitions = [
  {
    id: "dsh.compact",
    invocation: "/compact",
    label: "Compact context",
    description: "Compact the current conversation context",
    argumentMode: "none",
  },
  {
    id: "dsh.goal",
    invocation: "/dsh-goal",
    label: "Goal",
    description: "Set or view the goal for a long-running task",
    argumentMode: "text",
  },
  {
    id: "dsh.plan",
    invocation: "/plan",
    label: "Plan mode",
    description: "Enter or leave plan mode",
    argumentMode: "text",
  },
] as const;

export interface ParsedDeepSeekHarnessCommand {
  readonly commandId: string;
  readonly line: string;
}

function invalidArguments(message: string): HarnessResult<never> {
  return {
    ok: false,
    error: { code: "invalidRequest", message, retryable: false },
  };
}

export function deepSeekHarnessCommandCatalog(): HarnessCommandCatalog {
  return harnessCommandCatalogSchema.parse({
    commands: commandDefinitions,
  });
}

export function parseDeepSeekHarnessCommand(
  command: HarnessCommandInvocation,
): HarnessResult<ParsedDeepSeekHarnessCommand> {
  const definition = commandDefinitions.find(({ id }) => id === command.commandId);
  if (!definition) {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: `DeepSeek Harness does not expose command '${command.commandId}'`,
        retryable: false,
      },
    };
  }
  const nativeInvocation = definition.id === "dsh.goal" ? "/goal" : definition.invocation;
  const arguments_ = command.arguments;
  if (definition.argumentMode === "none") {
    return arguments_ && Object.keys(arguments_).length > 0
      ? invalidArguments(`DeepSeek Harness ${nativeInvocation} command does not accept arguments`)
      : { ok: true, value: { commandId: definition.id, line: nativeInvocation } };
  }
  if (arguments_?.text !== undefined && typeof arguments_.text !== "string") {
    return invalidArguments(
      `DeepSeek Harness ${nativeInvocation} command argument 'text' must be a string`,
    );
  }
  if (arguments_ && Object.keys(arguments_).some((key) => key !== "text")) {
    return invalidArguments(`DeepSeek Harness ${nativeInvocation} command has an unknown argument`);
  }
  const text = (arguments_?.text as string | undefined)?.trim() ?? "";
  if (definition.id === "dsh.goal" && text.toLowerCase() === "edit") {
    return invalidArguments("DeepSeek Harness /goal edit command requires a replacement objective");
  }
  return {
    ok: true,
    value: {
      commandId: definition.id,
      line: text.length > 0 ? `${nativeInvocation} ${text}` : nativeInvocation,
    },
  };
}
