import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  HostItemSnapshot,
  HostTextInput,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, type HarnessId, type JsonValue } from "@codexhost/shared-contracts";

const READ_ITEM_OUTPUT_LIMIT = 16_000;

export interface CodeBuddyTranscriptTurn {
  nativeTurnKey: string;
  input: HostTextInput[];
  items: HostItemSnapshot[];
}

export interface CodeBuddyTranscriptIdentity {
  harnessId: HarnessId;
  nativeSessionId: string;
}

interface TranscriptEntry {
  id?: string;
  type: string;
  role?: string;
  content?: unknown;
  rawContent?: unknown;
  callId?: string;
  name?: string;
  arguments?: string;
  status?: string;
  output?: unknown;
}

function parseEntry(line: string): TranscriptEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.type !== "string") return null;
    return entry as unknown as TranscriptEntry;
  } catch {
    return null;
  }
}

function entryText(content: unknown, textType: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === textType &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
}

function truncateOutput(text: string): { text: string; isTruncated: boolean } {
  if (text.length <= READ_ITEM_OUTPUT_LIMIT) return { text, isTruncated: false };
  return { text: text.slice(0, READ_ITEM_OUTPUT_LIMIT), isTruncated: true };
}

/**
 * Groups a CodeBuddy transcript into Host turns. Turns start at persisted
 * user messages; subsequent reasoning, function calls, call results, and
 * assistant messages belong to the same turn.
 */
export function parseCodeBuddyTranscript(transcript: string): CodeBuddyTranscriptTurn[] {
  const turns: CodeBuddyTranscriptTurn[] = [];
  let current: CodeBuddyTranscriptTurn | null = null;
  const toolsByCallId = new Map<string, HostItemSnapshot>();

  for (const line of transcript.split("\n")) {
    const entry = parseEntry(line);
    if (!entry) continue;
    if (entry.type === "message" && entry.role === "user") {
      const text = entryText(entry.content, "input_text") || entryText(entry.content, "text");
      if (text.length === 0) continue;
      current = {
        nativeTurnKey: entry.id ?? `codebuddy-turn-${turns.length + 1}`,
        input: [{ type: "text", text }],
        items: [],
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (entry.type === "reasoning") {
      const text = entryText(entry.content, "text") || entryText(entry.rawContent, "text");
      if (text.length === 0) continue;
      current.items.push({
        item: {
          type: "reasoning",
          itemId: hostItemIdSchema.parse(`reasoning-${entry.id ?? `seq-${current.items.length}`}`),
          text,
        },
        outcome: { status: "succeeded" },
      });
      continue;
    }
    if (entry.type === "function_call" && typeof entry.callId === "string" && entry.name) {
      let args: JsonValue = {};
      if (typeof entry.arguments === "string") {
        try {
          const parsed: unknown = JSON.parse(entry.arguments);
          args = parsed as JsonValue;
        } catch {
          args = entry.arguments;
        }
      }
      const snapshot: HostItemSnapshot = isShellTool(entry.name)
        ? {
            item: {
              type: "commandExecution",
              itemId: hostItemIdSchema.parse(`command-${entry.callId}`),
              command: shellCommand(args, entry.name),
            },
            outcome: { status: "succeeded" },
          }
        : {
            item: {
              type: "toolExecution",
              itemId: hostItemIdSchema.parse(`tool-${entry.callId}`),
              toolName: entry.name,
              arguments: args,
            },
            outcome: { status: "succeeded" },
          };
      toolsByCallId.set(entry.callId, snapshot);
      current.items.push(snapshot);
      continue;
    }
    if (entry.type === "function_call_result" && typeof entry.callId === "string") {
      const snapshot = toolsByCallId.get(entry.callId);
      if (!snapshot) continue;
      const outputText = entryText(entry.output, "text");
      const { text, isTruncated } = truncateOutput(outputText);
      if (snapshot.item.type === "toolExecution") {
        snapshot.item.output = {
          content: [{ type: "text", text }],
          ...(isTruncated ? { truncated: true } : {}),
        };
      } else if (snapshot.item.type === "commandExecution") {
        if (text.length > 0 || isTruncated) {
          snapshot.item.output = text;
          if (isTruncated) snapshot.item.outputTruncated = true;
        }
      }
      if (entry.status === "failed") {
        snapshot.outcome = {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: "CodeBuddy tool execution failed",
            retryable: false,
          },
        };
      }
    }
  }

  return turns;
}

function isShellTool(name: string): boolean {
  return name === "Bash" || name === "PowerShell";
}

function shellCommand(args: JsonValue, fallback: string): string {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const command = (args as Record<string, unknown>).command;
    if (typeof command === "string") return command;
  }
  return fallback;
}

/** Maps transcript turns to the public snapshot with stable Native Turn Refs. */
export function snapshotFromTranscriptTurns(
  turns: CodeBuddyTranscriptTurn[],
  identity: CodeBuddyTranscriptIdentity,
): HostThreadSnapshot {
  return {
    turns: turns.map<HostTurnSnapshot>((turn) => ({
      nativeTurnRef: {
        harnessId: identity.harnessId,
        nativeSessionId: identity.nativeSessionId,
        nativeTurnKey: turn.nativeTurnKey,
        formatVersion: 1,
      },
      input: turn.input,
      items: turn.items,
      outcome: { status: "succeeded" },
    })),
  };
}

/** Resolves `~/.codebuddy/projects/<cwd-slug>/<sessionId>.jsonl`. */
export function codebuddyTranscriptPath(
  homeDirectory: string,
  cwd: string,
  sessionId: string,
): string {
  return path.join(
    homeDirectory,
    ".codebuddy",
    "projects",
    codebuddyProjectSlug(cwd),
    `${sessionId}.jsonl`,
  );
}

export function codebuddyProjectSlug(cwd: string): string {
  return cwd.replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-").replace(/^-+/, "");
}

export function readCodeBuddyTranscript(
  cwd: string,
  sessionId: string,
  dependencies: {
    readFile?: typeof readFileSync;
    readDirectory?: typeof readdirSync;
    homeDirectory?: string;
  } = {},
): string | null {
  const readFile = dependencies.readFile ?? readFileSync;
  const readDirectory = dependencies.readDirectory ?? readdirSync;
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const primary = codebuddyTranscriptPath(homeDirectory, cwd, sessionId);
  try {
    return readFile(primary, "utf-8");
  } catch {
    // Fall back to scanning project slugs: cwd formatting may differ across
    // CLI versions (e.g. symlinked prefixes such as /tmp vs /private/tmp).
    const projectsRoot = path.join(homeDirectory, ".codebuddy", "projects");
    let projectSlugs: string[];
    try {
      projectSlugs = readDirectory(projectsRoot);
    } catch {
      return null;
    }
    for (const projectSlug of projectSlugs) {
      const candidate = path.join(projectsRoot, projectSlug, `${sessionId}.jsonl`);
      try {
        return readFile(candidate, "utf-8");
      } catch {
        continue;
      }
    }
    return null;
  }
}
