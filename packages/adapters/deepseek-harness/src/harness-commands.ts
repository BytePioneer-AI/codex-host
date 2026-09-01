import { type HarnessCommandInvocation, type HarnessResult } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";

import type { DeepSeekCommandDescriptor } from "./host-client.js";

const commandDefinitions = [
  {
    id: "dsh.compact",
    nativeName: "compact",
    invocation: "/compact",
    label: "Compact context",
    argumentMode: "none",
  },
  {
    id: "dsh.goal",
    nativeName: "goal",
    invocation: "/dsh-goal",
    label: "Goal",
    argumentMode: "text",
  },
  {
    id: "dsh.plan",
    nativeName: "plan",
    invocation: "/plan",
    label: "Plan mode",
    argumentMode: "text",
  },
] as const;

interface CommandLineDescriptor {
  readonly id: string;
  readonly invocation: string;
  readonly argumentMode: "none" | "text";
}

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

export function buildDeepSeekHarnessCommandLine(
  command: HarnessCommandInvocation,
  descriptor: CommandLineDescriptor,
): HarnessResult<string> {
  if (command.commandId !== descriptor.id) {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: `DeepSeek Harness does not expose command '${command.commandId}'`,
        retryable: false,
      },
    };
  }

  const arguments_ = command.arguments;
  if (descriptor.argumentMode === "none") {
    return arguments_ && Object.keys(arguments_).length > 0
      ? invalidArguments(
          `DeepSeek Harness ${descriptor.invocation} command does not accept arguments`,
        )
      : { ok: true, value: descriptor.invocation };
  }

  const text = arguments_?.text;
  if (text !== undefined && typeof text !== "string") {
    return invalidArguments(
      `DeepSeek Harness ${descriptor.invocation} command argument 'text' must be a string`,
    );
  }
  if (arguments_ && Object.keys(arguments_).some((key) => key !== "text")) {
    return invalidArguments(
      `DeepSeek Harness ${descriptor.invocation} command has an unknown argument`,
    );
  }
  return { ok: true, value: text ? `${descriptor.invocation} ${text}` : descriptor.invocation };
}

export function deepSeekHarnessCommandCatalog(
  nativeDescriptors: readonly DeepSeekCommandDescriptor[],
): HarnessCommandCatalog {
  const commands = nativeDescriptors.flatMap((native) => {
    const definition = commandDefinitions.find(({ nativeName }) => nativeName === native.name);
    if (
      !definition ||
      (definition.argumentMode === "none"
        ? native.input !== undefined
        : native.input === undefined || native.input.hint.trim().length === 0)
    ) {
      return [];
    }
    const parsed = harnessCommandDescriptorSchema.safeParse({
      id: definition.id,
      invocation: definition.invocation,
      label: definition.label,
      description: native.description,
      argumentMode: definition.argumentMode,
    });
    return parsed.success ? [parsed.data] : [];
  });
  return harnessCommandCatalogSchema.parse({ commands });
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
  const line = buildDeepSeekHarnessCommandLine(command, {
    ...definition,
    invocation: nativeInvocation,
  });
  if (!line.ok) return line;
  if (definition.id === "dsh.goal") {
    const text = (command.arguments?.text as string | undefined)?.trim() ?? "";
    const control = text.toLowerCase();
    if (control === "edit") {
      return invalidArguments(
        "DeepSeek Harness /goal edit command requires a replacement objective",
      );
    }
    return {
      ok: true,
      value: {
        commandId: definition.id,
        line: text.length > 0 ? `${nativeInvocation} ${text}` : nativeInvocation,
      },
    };
  }
  if (definition.id === "dsh.plan") {
    const text = (command.arguments?.text as string | undefined)?.trim() ?? "";
    return {
      ok: true,
      value: {
        commandId: definition.id,
        line: text.length > 0 ? `${nativeInvocation} ${text}` : nativeInvocation,
      },
    };
  }
  return { ok: true, value: { commandId: definition.id, line: line.value } };
}
