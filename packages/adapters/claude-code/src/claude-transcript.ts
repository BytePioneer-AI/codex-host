import os from "node:os";
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

function projectDirectoryName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

function configDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.CLAUDE_CONFIG_DIR
    ? path.resolve(environment.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
}

async function existingFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function findTranscript(input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionId: string;
}): Promise<string | null> {
  const projectsDirectory = path.join(configDirectory(input.environment), "projects");
  const name = `${input.sessionId}.jsonl`;
  const expected = path.join(projectsDirectory, projectDirectoryName(input.cwd), name);
  if (await existingFile(expected)) return expected;

  let projects: string[];
  try {
    projects = await readdir(projectsDirectory);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = path.join(projectsDirectory, project, name);
    if (await existingFile(candidate)) return candidate;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TranscriptInput {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionId: string;
}

async function readTranscriptEntries(
  input: TranscriptInput,
  includes?: string,
): Promise<unknown[] | null> {
  const transcript = await findTranscript(input);
  if (!transcript) return null;
  const contents = await readFile(transcript, "utf8");
  return contents.split("\n").flatMap((line) => {
    if (!line.trim() || (includes && !line.includes(includes))) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

/**
 * Reads the complete append-only Claude Code main-session transcript.
 *
 * The Agent SDK's getSessionMessages() intentionally follows one parentUuid
 * branch. Claude can attach a later prompt to a system record before the prior
 * assistant terminal, which makes that otherwise valid branch omit prior
 * assistant messages. History recovery needs every persisted main-session
 * message in transcript order instead.
 */
export async function readClaudeTranscript(input: TranscriptInput): Promise<unknown[] | null> {
  const entries = await readTranscriptEntries(input);
  if (!entries) return null;
  const messages: unknown[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      (entry.type !== "user" && entry.type !== "assistant") ||
      typeof entry.uuid !== "string" ||
      !isRecord(entry.message)
    ) {
      continue;
    }
    messages.push({ ...entry, session_id: input.sessionId });
  }
  return messages;
}

/**
 * Reads the Goal status records Claude appends to its main-session transcript.
 *
 * Claude persists every `/goal` transition as a `goal_status` attachment: a
 * sentinel when a Goal is set or cleared, and an evaluator verdict after each
 * Stop hook round. SDK hosts receive none of these on the message stream, so
 * they are the only native evidence of a Goal's terminal outcome and of a Goal
 * restored by session resume.
 */
export async function readClaudeGoalRecords(input: TranscriptInput): Promise<unknown[] | null> {
  const entries = await readTranscriptEntries(input, '"goal_status"');
  return (
    entries?.filter(
      (entry) =>
        isRecord(entry) &&
        entry.type === "attachment" &&
        isRecord(entry.attachment) &&
        entry.attachment.type === "goal_status",
    ) ?? null
  );
}
