import type { HarnessCommandInvocation, HarnessResult } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";
import type { QoderSlashCommand } from "./qoder-sdk-types.js";

export const QODER_FALLBACK_COMMAND_CATALOG: HarnessCommandCatalog =
  harnessCommandCatalogSchema.parse({
    commands: [
      {
        id: "qoder.compact",
        invocation: "/compact",
        label: "Compact",
        description: "Compresses the context by replacing it with a summary",
        argumentMode: "text",
      },
    ],
  });

export const QODER_COMMAND_CATALOG = QODER_FALLBACK_COMMAND_CATALOG;
export const QODER_COMMANDS: readonly HarnessCommandDescriptor[] =
  QODER_FALLBACK_COMMAND_CATALOG.commands;

export const QODER_VERIFIED_HEADLESS_COMMAND_IDS: ReadonlySet<string> = new Set(["qoder.compact"]);

export function humanize(name: string): string {
  const parts = name.replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return name;
  return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function mapQoderSlashCommands(
  commands: readonly QoderSlashCommand[],
): HarnessCommandCatalog {
  const rawDescriptors: Array<{
    id: string;
    invocation: string;
    label: string;
    description?: string;
    argumentMode: "none" | "text";
  }> = [];
  const seenIds = new Set<string>();

  for (const native of commands) {
    if (!native?.name) continue;
    const cleanName = native.name.replace(/^\//, "").trim();
    if (!cleanName) continue;
    const id = `qoder.${cleanName}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const hasArg = typeof native.argumentHint === "string" && native.argumentHint.trim().length > 0;
    rawDescriptors.push({
      id,
      invocation: `/${cleanName}`,
      label: humanize(cleanName),
      ...(native.description ? { description: native.description } : {}),
      argumentMode: hasArg ? "text" : "none",
    });
  }

  return harnessCommandCatalogSchema.parse({
    commands: rawDescriptors,
  });
}

export function findQoderCommandDescriptor(
  commandIdOrInvocation: string,
  catalog: HarnessCommandCatalog = QODER_FALLBACK_COMMAND_CATALOG,
): HarnessCommandDescriptor | undefined {
  const normalized = commandIdOrInvocation.trim().toLowerCase();
  return catalog.commands.find(
    (c) =>
      c.id.toLowerCase() === normalized ||
      c.invocation.toLowerCase() === normalized ||
      c.invocation.toLowerCase() === `/${normalized}` ||
      c.id.toLowerCase() === `qoder.${normalized}`,
  );
}

export interface ParsedQoderCommand {
  prompt: string;
  descriptor: HarnessCommandDescriptor;
}

export function parseQoderCommandInvocation(
  command: HarnessCommandInvocation,
  catalog: HarnessCommandCatalog = QODER_FALLBACK_COMMAND_CATALOG,
): HarnessResult<ParsedQoderCommand> {
  const descriptor = findQoderCommandDescriptor(command.commandId, catalog);
  if (!descriptor) {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: `Qoder does not expose Harness command '${command.commandId}'`,
        retryable: false,
      },
    };
  }

  if (!QODER_VERIFIED_HEADLESS_COMMAND_IDS.has(descriptor.id)) {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: `Qoder slash command '${descriptor.invocation}' is not verified for headless execution`,
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
        message: "Qoder command arguments must be an object",
        retryable: false,
      },
    };
  }

  if (descriptor.argumentMode === "none" && args && Object.keys(args).length > 0) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: `Qoder command '${descriptor.invocation}' does not accept arguments`,
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
          message: "Qoder command has an unknown argument",
          retryable: false,
        },
      };
    }
    if (args.text !== undefined && typeof args.text !== "string") {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Qoder command argument 'text' must be a string",
          retryable: false,
        },
      };
    }
  }

  const text = typeof args?.text === "string" ? args.text.trim() : "";
  const prompt = text.length > 0 ? `${descriptor.invocation} ${text}` : descriptor.invocation;

  return {
    ok: true,
    value: {
      prompt,
      descriptor,
    },
  };
}

export const parseAndFormatQoderCommand = parseQoderCommandInvocation;
