import type {
  HostCommandExecutionItem,
  HostToolExecutionItem,
  HostToolOutput,
} from "@codexhost/harness-adapter";
import { jsonValueSchema, type HostItemId, type JsonValue } from "@codexhost/shared-contracts";

export const DEFAULT_QWEN_CODE_TOOL_OUTPUT_LIMIT = 64_000;

export interface QwenCodeToolProjection {
  output?: HostToolOutput;
  exitCode?: number | null;
}

export type QwenCodeProjectedToolItem = HostCommandExecutionItem | HostToolExecutionItem;

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

export function qwenCodeToolName(
  name?: string | null | undefined,
  title?: string | null | undefined,
): string {
  if (typeof name === "string" && name.length > 0) return name;
  if (typeof title === "string" && title.length > 0) return title;
  return "Qwen Code Tool";
}

export function qwenCodeToolLabel(item: QwenCodeProjectedToolItem): string {
  return item.type === "commandExecution" ? item.command : item.toolName;
}

export function qwenCodeToolArguments(rawInput: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(rawInput);
  return parsed.success ? parsed.data : {};
}

export function qwenCodeCommand(kind: string | undefined, rawInput: unknown): string | undefined {
  if (kind !== "execute") return undefined;
  return stringField(rawInput, "command");
}

export function startQwenCodeToolItem(input: {
  itemId: HostItemId;
  name?: string | null | undefined;
  title?: string | null | undefined;
  kind?: string | null | undefined;
  rawInput?: unknown;
  cwd: string;
}): QwenCodeProjectedToolItem {
  const command = qwenCodeCommand(input.kind ?? undefined, input.rawInput);
  if (command) {
    const rawCwd = stringField(input.rawInput, "cwd");
    return {
      type: "commandExecution",
      itemId: input.itemId,
      command,
      ...(rawCwd !== undefined ? { cwd: rawCwd } : {}),
    };
  }
  return {
    type: "toolExecution",
    itemId: input.itemId,
    toolName: qwenCodeToolName(input.name, input.title),
    arguments: qwenCodeToolArguments(input.rawInput),
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

function rawOutputProjection(rawOutput: unknown): { text?: string; exitCode?: number | null } {
  if (typeof rawOutput === "string") return rawOutput.length > 0 ? { text: rawOutput } : {};
  if (!isRecord(rawOutput)) return {};
  const exitCode = numberField(rawOutput, "exit_code") ?? numberField(rawOutput, "exitCode");
  const output = rawOutput.output;
  const outputText = typeof output === "string" ? output : undefined;
  const text =
    outputText ??
    stringField(rawOutput, "content") ??
    stringField(rawOutput, "text") ??
    stringField(rawOutput, "tool_result") ??
    stringField(rawOutput, "raw_output");
  if (text || exitCode !== undefined) {
    return { ...(text ? { text } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
  }
  return {};
}

export function projectQwenCodeToolOutput(
  content: unknown,
  rawOutput: unknown,
  limit = DEFAULT_QWEN_CODE_TOOL_OUTPUT_LIMIT,
): QwenCodeToolProjection {
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

export function qwenCodeToolOutputText(output: HostToolOutput | undefined): string {
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

export function applyQwenCodeToolProjection<T extends QwenCodeProjectedToolItem>(
  item: T,
  projection: QwenCodeToolProjection,
): T {
  if (item.type === "commandExecution") {
    const text = qwenCodeToolOutputText(projection.output);
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

export function hasQwenCodeToolProjection(projection: QwenCodeToolProjection): boolean {
  return projection.output !== undefined || projection.exitCode !== undefined;
}
