import type { ChItem, ChTurn } from "./ch-thread-view.ts";

const IMPORTED_TURN = /^external-import-turn-\d+$/u;
const IMPORT_NOTICE = "<EXTERNAL SESSION IMPORTED>";
const TOOL_CALL =
  /^\[external_agent_tool_call: ([^\]\n]+)\]\n([\s\S]*)\n\[\/external_agent_tool_call\]$/u;
const TOOL_RESULT =
  /^\[external_agent_tool_result\]\n(?:([\s\S]*)\n)?\[\/external_agent_tool_result\]$/u;
const DELEGATION_FOOTER =
  /^\[codexhost delegation\] The user mentioned (.+)\. Use the codexhost-delegation skill to delegate this request to (?:that Harness|each mentioned Harness) with `delegate start --harness <id>` through the executable in CODEXHOST_CLI_PATH, instead of doing the task yourself\.$/u;

function legacyAgentText(item: ChItem | undefined): string {
  if (item?.type !== "agentMessage" || item.phase != null) return "";
  return typeof item.text === "string" ? item.text : "";
}

function visibleUserMessage(item: ChItem): ChItem {
  if (!Array.isArray(item.content)) return item;
  const content = item.content.map((part: unknown) => {
    if (
      part === null ||
      typeof part !== "object" ||
      !("type" in part) ||
      part.type !== "text" ||
      !("text" in part) ||
      typeof part.text !== "string"
    )
      return part;
    const separator = part.text.lastIndexOf("\n\n[codexhost delegation]");
    if (separator < 0) return part;
    const request = part.text.slice(0, separator);
    const targets = DELEGATION_FOOTER.exec(part.text.slice(separator + 2))?.[1];
    if (!targets) return part;
    const mentions = [...targets.matchAll(/@([^@\n]+?) \(Harness `[a-z0-9][a-z0-9-]*`\)/gu)];
    if (
      mentions.map(([target]) => target).join(", ") !== targets ||
      !mentions.every(([, label]) => request.includes(`@${label}`))
    )
      return part;
    return { ...part, text: request, text_elements: [] };
  });
  return { ...item, content };
}

function toolArguments(details: string): unknown {
  if (details.startsWith("file: ")) return { file_path: details.slice(6) };
  if (details.startsWith("input: ")) {
    try {
      return JSON.parse(details.slice(7)) as unknown;
    } catch {
      // Retain the recorded arguments even if the importer truncated the JSON.
    }
  }
  return { input: details };
}

function toolItem(id: string, name: string, details: string, output: string): ChItem {
  const command = name === "Bash" ? /(?:^|\n)command: ([\s\S]+)$/u.exec(details)?.[1] : undefined;
  if (command !== undefined) {
    return { id, type: "commandExecution", status: "completed", command, aggregatedOutput: output };
  }
  return {
    id,
    type: "mcpToolCall",
    status: "completed",
    server: "external",
    tool: name,
    arguments: toolArguments(details),
    result: { content: [{ type: "text", text: output }] },
  };
}

/** Reconstruct display Items for history already flattened by an external session import. */
export function externalImportHistoryItems(turn: ChTurn, items: ChItem[]): ChItem[] {
  if (turn.status !== "completed" || !IMPORTED_TURN.test(turn.id)) return items;
  const visible: ChItem[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;
    const text = legacyAgentText(item);
    if (index === items.length - 1 && text === IMPORT_NOTICE) continue;
    const call = TOOL_CALL.exec(text);
    const result = TOOL_RESULT.exec(legacyAgentText(items[index + 1]));
    // Adjacent calls or results have no persisted correlation ID. Keep those
    // runs readable without assigning one call another call's result.
    if (
      call &&
      result &&
      !TOOL_CALL.test(legacyAgentText(items[index - 1])) &&
      !TOOL_RESULT.test(legacyAgentText(items[index + 2]))
    ) {
      visible.push(toolItem(item.id, call[1] ?? "", call[2] ?? "", result[1] ?? ""));
      index++;
      continue;
    }
    visible.push(item.type === "userMessage" ? visibleUserMessage(item) : item);
  }
  const tail = visible.at(-1);
  const answer = legacyAgentText(tail);
  if (
    tail &&
    answer.trim() &&
    !answer.startsWith("[external_agent_tool_") &&
    !visible.some((item) => item.type === "agentMessage" && item.phase === "final_answer")
  ) {
    visible[visible.length - 1] = { ...tail, phase: "final_answer" };
  }
  return visible;
}
