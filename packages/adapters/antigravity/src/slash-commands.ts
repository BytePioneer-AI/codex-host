import type {
  HarnessCommandInvocation,
  HarnessResult,
} from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

export const ANTIGRAVITY_COMMAND_CATALOG: HarnessCommandCatalog = harnessCommandCatalogSchema.parse({
  commands: [
    {
      id: "antigravity.plan",
      invocation: "/plan",
      label: "Plan",
      description: "Plan an implementation, breakdown, or architecture",
      argumentMode: "text",
    },
    {
      id: "antigravity.goal",
      invocation: "/goal",
      label: "Goal",
      description: "Define high-level objectives and constraints",
      argumentMode: "text",
    },
    {
      id: "antigravity.browser",
      invocation: "/browser",
      label: "Browser",
      description: "Navigate or interact with web resources",
      argumentMode: "text",
    },
    {
      id: "antigravity.grill-me",
      invocation: "/grill-me",
      label: "Grill Me",
      description: "Stress-test assumptions and critique implementation proposals",
      argumentMode: "text",
    },
    {
      id: "antigravity.boost",
      invocation: "/boost",
      label: "Boost",
      description: "Boost reasoning depth and exhaustive verification",
      argumentMode: "text",
    },
    {
      id: "antigravity.learn",
      invocation: "/learn",
      label: "Learn",
      description: "Extract learnings, conventions, and workspace guidelines",
      argumentMode: "text",
    },
    {
      id: "antigravity.schedule",
      invocation: "/schedule",
      label: "Schedule",
      description: "Schedule recurring or delayed tasks",
      argumentMode: "text",
    },
    {
      id: "antigravity.help",
      invocation: "/help",
      label: "Help",
      description: "Display available Antigravity slash commands and guidance",
      argumentMode: "text",
    },
  ],
});

export function findAntigravityCommandDescriptor(
  commandId: string,
): HarnessCommandDescriptor | undefined {
  return ANTIGRAVITY_COMMAND_CATALOG.commands.find(
    (command) =>
      command.id === commandId ||
      command.invocation === commandId ||
      command.id === `antigravity.${commandId}`,
  );
}

export function parseAndFormatAntigravityCommand(
  command: HarnessCommandInvocation,
): HarnessResult<{ prompt: string; descriptor: HarnessCommandDescriptor }> {
  const descriptor = findAntigravityCommandDescriptor(command.commandId);
  if (!descriptor) {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: `Antigravity does not expose Harness command '${command.commandId}'`,
        retryable: false,
      },
    };
  }

  const args = command.arguments;
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Antigravity command arguments must be an object",
        retryable: false,
      },
    };
  }

  if (args) {
    if (Object.keys(args).some((key) => key !== "text")) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Antigravity command has an unknown argument",
          retryable: false,
        },
      };
    }
    if (args.text !== undefined && typeof args.text !== "string") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Antigravity command argument 'text' must be a string",
          retryable: false,
        },
      };
    }
  }

  const text = typeof args?.text === "string" ? args.text.trim() : "";
  const prompt = text.length > 0 ? `${descriptor.invocation} ${text}` : descriptor.invocation;

  return {
    ok: true,
    value: { prompt, descriptor },
  };
}
