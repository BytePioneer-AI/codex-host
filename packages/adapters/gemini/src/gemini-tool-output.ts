import type {
  HostCommandExecutionItem,
  HostToolExecutionItem,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import { jsonValueSchema, type HostItemId, type JsonValue } from "@codexhost/shared-contracts";

export const DEFAULT_GEMINI_TOOL_OUTPUT_LIMIT = 64_000;

const EXECUTE_TOOL_NAMES = new Set(["bash", "run_terminal_command", "shell", "cursor_shell"]);

export interface GeminiToolProjection {
  output?: HostToolOutput;
  exitCode?: number | null;
}

export type GeminiProjectedToolItem = HostCommandExecutionItem | HostToolExecutionItem;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" && value[key].length > 0
    ? value[key]
    : undefined;
}

function numberField(value: unknown, key: string): number | null | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (field === null) return null;
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function decodeBytes(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((entry) => typeof entry === "number" && Number.isInteger(entry))) {
    return undefined;
  }
  try {
    return Buffer.from(value).toString("utf8");
  } catch {
    return undefined;
  }
}

function firstReadableText(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (isRecord(candidate)) {
      const nested =
        stringField(candidate, "content") ??
        stringField(candidate, "text") ??
        stringField(candidate, "tool_result") ??
        stringField(candidate, "raw_output");
      if (nested) return nested;
    }
  }
  return undefined;
}

export function geminiToolName(
  name?: string | null | undefined,
  title?: string | null | undefined,
): string {
  if (typeof name === "string" && name.length > 0) return name;
  if (typeof title === "string" && title.length > 0) return title;
  return "Gemini Tool";
}

export function geminiToolLabel(item: GeminiProjectedToolItem): string {
  return item.type === "commandExecution" ? item.command : item.toolName;
}

export function geminiToolArguments(rawInput: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(rawInput);
  return parsed.success ? parsed.data : {};
}

export function geminiCommand(
  name: string | undefined,
  kind: string | undefined,
  rawInput: unknown,
): string | undefined {
  const command = stringField(rawInput, "command");
  if (!command) return undefined;
  if (kind === "execute") return command;
  if (name && EXECUTE_TOOL_NAMES.has(name)) return command;
  return isRecord(rawInput) && rawInput.variant === "Bash" ? command : undefined;
}

export function geminiCommandCwd(rawInput: unknown, fallback: string): string {
  return stringField(rawInput, "cwd") ?? fallback;
}

export function startGeminiToolItem(input: {
  itemId: HostItemId;
  name?: string | null | undefined;
  title?: string | null | undefined;
  kind?: string | null | undefined;
  rawInput?: unknown;
  cwd: string;
}): GeminiProjectedToolItem {
  const name = geminiToolName(input.name, input.title);
  const command = geminiCommand(name, input.kind ?? undefined, input.rawInput);
  if (command) {
    return {
      type: "commandExecution",
      itemId: input.itemId,
      command,
      cwd: geminiCommandCwd(input.rawInput, input.cwd),
    };
  }
  return {
    type: "toolExecution",
    itemId: input.itemId,
    toolName: name,
    arguments: geminiToolArguments(input.rawInput),
  };
}

function acpContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((entry) => {
      if (!isRecord(entry)) return [];
      if (entry.type === "text" && typeof entry.text === "string") return [entry.text];
      if (entry.type !== "content" || !isRecord(entry.content)) return [];
      return entry.content.type === "text" && typeof entry.content.text === "string"
        ? [entry.content.text]
        : [];
    })
    .join("\n");
}

function acpContentImages(content: unknown, remainingBytes: number): HostToolOutput["content"] {
  if (!Array.isArray(content) || remainingBytes <= 0) return [];
  const images: HostToolOutput["content"] = [];
  let remaining = remainingBytes;
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    const image = entry.type === "image" ? entry : entry.type === "content" ? entry.content : null;
    if (!isRecord(image) || image.type !== "image") continue;
    const mimeType = stringField(image, "mimeType") ?? stringField(image, "mime_type");
    const data = stringField(image, "data");
    if (!mimeType || !data || data.length > remaining) continue;
    images.push({ type: "image", mimeType, base64Data: data });
    remaining -= data.length;
  }
  return images;
}

function bashOutput(rawOutput: Record<string, unknown>): {
  text?: string;
  exitCode?: number | null;
} {
  const output = rawOutput.output;
  const text = typeof output === "string" ? output : decodeBytes(output);
  const exitCode = numberField(rawOutput, "exit_code") ?? numberField(rawOutput, "exitCode");
  return {
    ...(text !== undefined ? { text } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function rawOutputProjection(rawOutput: unknown): { text?: string; exitCode?: number | null } {
  if (typeof rawOutput === "string") return rawOutput.length > 0 ? { text: rawOutput } : {};
  if (!isRecord(rawOutput)) return {};
  if (
    rawOutput.type === "Bash" ||
    rawOutput.variant === "Bash" ||
    numberField(rawOutput, "exit_code") !== undefined ||
    numberField(rawOutput, "exitCode") !== undefined
  ) {
    const bash = bashOutput(rawOutput);
    if (bash.text !== undefined || bash.exitCode !== undefined) return bash;
  }
  const text = firstReadableText(
    rawOutput.content,
    rawOutput.text,
    rawOutput.tool_result,
    rawOutput.raw_output,
    isRecord(rawOutput.FileContent) ? rawOutput.FileContent : undefined,
    isRecord(rawOutput.Content) ? rawOutput.Content : undefined,
  );
  if (text) return { text };
  if (typeof rawOutput.match_count === "number" && Number.isFinite(rawOutput.match_count)) {
    return { text: `found ${rawOutput.match_count} matches` };
  }
  return {};
}

export function projectGeminiToolOutput(
  content: unknown,
  rawOutput: unknown,
  limit = DEFAULT_GEMINI_TOOL_OUTPUT_LIMIT,
): GeminiToolProjection {
  if (!Number.isSafeInteger(limit) || limit <= 0) return {};
  const fromRaw = rawOutputProjection(rawOutput);
  const text = acpContentText(content) || fromRaw.text || "";
  const parts: HostToolOutput["content"] = [];
  if (text.length > 0) {
    const truncated = text.length > limit;
    parts.push({ type: "text", text: truncated ? text.slice(0, limit) : text });
  }
  parts.push(...acpContentImages(content, Math.max(0, limit - text.length)));
  return {
    ...(parts.length > 0
      ? {
          output: {
            content: parts,
            ...(text.length > limit ? { truncated: true } : {}),
          },
        }
      : {}),
    ...(fromRaw.exitCode !== undefined ? { exitCode: fromRaw.exitCode } : {}),
  };
}

export function geminiToolOutputText(output: HostToolOutput | undefined): string {
  return (
    output?.content
      .filter(
        (entry): entry is Extract<(typeof output.content)[number], { type: "text" }> =>
          entry.type === "text",
      )
      .map(({ text }) => text)
      .join("") ?? ""
  );
}

export function applyGeminiToolProjection<T extends GeminiProjectedToolItem>(
  item: T,
  projection: GeminiToolProjection,
): T {
  if (item.type === "commandExecution") {
    const text = geminiToolOutputText(projection.output);
    return {
      ...item,
      ...(projection.output
        ? {
            output: text,
            outputTruncated: projection.output.truncated === true,
          }
        : {}),
      ...(projection.exitCode !== undefined ? { exitCode: projection.exitCode } : {}),
    } as T;
  }
  return {
    ...item,
    ...(projection.output ? { output: projection.output } : {}),
  } as T;
}

export function hasGeminiToolProjection(projection: GeminiToolProjection): boolean {
  return projection.output !== undefined || projection.exitCode !== undefined;
}
