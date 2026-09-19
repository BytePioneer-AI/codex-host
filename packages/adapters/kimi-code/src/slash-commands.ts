import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { HarnessCommandInvocation, HarnessResult } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

/**
 * Builds a validated HarnessCommandCatalog from native ACP AvailableCommands.
 * Strips leading slash from names if present, deduplicates command IDs,
 * maps input to argumentMode, and bounds descriptions to schema limits.
 */
export function buildKimiCommandCatalog(
  availableCommands: readonly AvailableCommand[],
): HarnessCommandCatalog {
  const seenIds = new Set<string>();
  const descriptors: HarnessCommandDescriptor[] = [];

  for (const command of availableCommands) {
    const rawName = typeof command.name === "string" ? command.name.trim() : "";
    const cleanId = rawName.replace(/^\/+/, "");
    if (!cleanId || seenIds.has(cleanId)) continue;
    if (!/^[A-Za-z0-9._:-]{1,127}$/u.test(cleanId)) continue;
    seenIds.add(cleanId);

    const argumentMode = command.input ? "text" : "none";
    const rawDesc = typeof command.description === "string" ? command.description.trim() : "";
    const description = rawDesc.length > 0 ? rawDesc.slice(0, 512) : undefined;

    descriptors.push({
      id: cleanId as HarnessCommandDescriptor["id"],
      invocation: `/${cleanId}`,
      label: cleanId,
      argumentMode,
      ...(description ? { description } : {}),
    });
  }

  return harnessCommandCatalogSchema.parse({ commands: descriptors });
}

export const KIMI_DEFAULT_COMMANDS: readonly AvailableCommand[] = [
  {
    name: "compact",
    description: "Compact the conversation context",
    input: { hint: "prompt" },
  },
  {
    name: "status",
    description: "Show current session status",
  },
  {
    name: "usage",
    description: "Show session token usage",
  },
  {
    name: "mcp",
    description: "Show MCP server status",
  },
  {
    name: "tasks",
    description: "List background tasks",
  },
  {
    name: "help",
    description: "Show available ACP commands",
  },
];

export const KIMI_DEFAULT_COMMAND_CATALOG: HarnessCommandCatalog =
  buildKimiCommandCatalog(KIMI_DEFAULT_COMMANDS);

/**
 * Formats a command invocation into a prompt string for Kimi ACP.
 * Formats `/commandName` or `/commandName <args>`.
 */
export function formatKimiCommandPrompt(
  invocation: HarnessCommandInvocation,
): HarnessResult<string> {
  const rawId = typeof invocation.commandId === "string" ? invocation.commandId.trim() : "";
  const cleanId = rawId.replace(/^\/+/, "");
  if (!cleanId) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Command ID cannot be empty",
        retryable: false,
      },
    };
  }

  const base = `/${cleanId}`;
  const text =
    invocation.arguments && typeof invocation.arguments.text === "string"
      ? invocation.arguments.text.trim()
      : "";

  const prompt = text.length > 0 ? `${base} ${text}` : base;
  return { ok: true, value: prompt };
}

/**
 * Strips ANSI terminal escape sequences and normalizes newlines.
 */
export function stripAnsi(text: string): string {
  if (!text) return text;
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/gu, "").replaceAll("\r\n", "\n");
}

/**
 * Formats Kimi command outputs (such as /help, /status, /usage, /tasks, /mcp,
 * or key-value plain text lines) into structured, readable Markdown so they
 * render cleanly in Codex Desktop without text collapsing or terminal artifacts.
 */
export function formatKimiCommandOutput(text: string): string {
  if (!text) return text;
  const cleaned = stripAnsi(text);

  // 1. /help output
  if (/^Available commands:\s*\n/iu.test(cleaned)) {
    const lines = cleaned.split("\n");
    const formatted: string[] = ["### Available Commands\n"];
    for (const rawLine of lines.slice(1)) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^(\/[^\s—:-]+)\s*[—:-]\s*(.+)$/u);
      if (match) {
        formatted.push(`- **\`${match[1]}\`** — ${match[2]}`);
      } else {
        formatted.push(`- ${line}`);
      }
    }
    return formatted.join("\n");
  }

  // 2. /status output
  if (/^Session:\s+[^\n]+\nModel:\s+/iu.test(cleaned)) {
    const lines = cleaned.split("\n");
    const formatted: string[] = ["### Session Status\n"];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const val = trimmed.slice(colonIdx + 1).trim();
        formatted.push(`- **${key}**: \`${val}\``);
      } else {
        formatted.push(`- ${trimmed}`);
      }
    }
    return formatted.join("\n");
  }

  // 3. /usage output
  if (/^Context:\s+\d+\s*\/\s*\d+\s+tokens/iu.test(cleaned)) {
    const lines = cleaned.split("\n");
    const formatted: string[] = ["### Session Token Usage\n"];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const val = trimmed.slice(colonIdx + 1).trim();
        formatted.push(`- **${key}**: ${val}`);
      } else {
        formatted.push(`- ${trimmed}`);
      }
    }
    return formatted.join("\n");
  }

  // 4. Single-line empty status messages
  if (/^No background tasks\.?$/iu.test(cleaned.trim())) {
    return "*No background tasks.*";
  }
  if (/^No MCP servers configured/iu.test(cleaned.trim())) {
    return "*No MCP servers configured for this session.*";
  }

  // 5. Raw command lists (/cmd — desc)
  if (/^\/[a-z0-9_.:-]+\s+[—:-]\s+/imu.test(cleaned) && !cleaned.includes("- **`")) {
    const lines = cleaned.split("\n");
    const formatted = lines.map((l) => {
      const trimmed = l.trim();
      const m = trimmed.match(/^(\/[^\s—:-]+)\s*[—:-]\s*(.+)$/u);
      return m ? `- **\`${m[1]}\`** — ${m[2]}` : trimmed;
    });
    return formatted.join("\n");
  }

  return cleaned;
}
