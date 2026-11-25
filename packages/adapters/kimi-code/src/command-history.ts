import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HostTurnSnapshot } from "@codexhost/harness-adapter";
import { locateKimiSession } from "./history.js";

type HistoryOptions = { homeDirectory?: string; kimiCodeHome?: string };

// ACP commands do not enter wire.jsonl. This adapter-owned journal preserves
// their actual replies without changing native conversation context.
export async function readKimiCommandHistory(
  sessionId: string,
  options: HistoryOptions,
): Promise<HostTurnSnapshot[]> {
  const located = await locateKimiSession(sessionId, options);
  if (!located) return [];
  let content: string;
  try {
    content = await readFile(path.join(located.sessionDir, "codexhost-commands.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = content.split("\n");
  const turns: HostTurnSnapshot[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let turn: HostTurnSnapshot;
    try {
      turn = JSON.parse(line) as HostTurnSnapshot;
    } catch (error) {
      if (index !== lines.length - 1) throw error;
      break;
    }
    if (
      turn.nativeTurnRef?.harnessId !== "kimi-code" ||
      turn.nativeTurnRef.nativeSessionId !== sessionId ||
      !turn.nativeTurnRef.nativeTurnKey.startsWith("turn:command:")
    ) {
      throw new Error("Invalid Kimi command history identity");
    }
    turns.push(turn);
  }
  return turns;
}

export async function appendKimiCommandHistory(
  turn: HostTurnSnapshot,
  options: HistoryOptions,
): Promise<void> {
  const located = await locateKimiSession(turn.nativeTurnRef.nativeSessionId, options);
  if (!located) throw new Error("Cannot persist Kimi command: native session is missing");
  await appendFile(
    path.join(located.sessionDir, "codexhost-commands.jsonl"),
    `${JSON.stringify(turn)}\n`,
    "utf8",
  );
}

export async function copyKimiCommandHistory(
  turns: HostTurnSnapshot[],
  sessionId: string,
  options: HistoryOptions,
): Promise<void> {
  if (turns.length === 0) return;
  const located = await locateKimiSession(sessionId, options);
  if (!located) throw new Error("Cannot copy Kimi command history: derived session is missing");
  const copied = turns.map((turn) => ({
    ...turn,
    nativeTurnRef: { ...turn.nativeTurnRef, nativeSessionId: sessionId },
    ...(turn.checkpoint ? { checkpoint: { ...turn.checkpoint, nativeSessionId: sessionId } } : {}),
  }));
  await writeFile(
    path.join(located.sessionDir, "codexhost-commands.jsonl"),
    copied.map((turn) => `${JSON.stringify(turn)}\n`).join(""),
    "utf8",
  );
}
