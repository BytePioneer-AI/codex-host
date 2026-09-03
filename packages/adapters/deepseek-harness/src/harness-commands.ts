import { type HarnessCommandInvocation, type HarnessResult } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
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
