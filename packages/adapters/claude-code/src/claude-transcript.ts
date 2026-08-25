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

/**
 * Reads the complete append-only Claude Code main-session transcript.
 *
 * The Agent SDK's getSessionMessages() intentionally follows one parentUuid
 * branch. Claude can attach a later prompt to a system record before the prior
 * assistant terminal, which makes that otherwise valid branch omit prior
 * assistant messages. History recovery needs every persisted main-session
 * message in transcript order instead.
 */
export async function readClaudeTranscript(input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionId: string;
}): Promise<unknown[] | null> {
  const transcript = await findTranscript(input);
  if (!transcript) return null;
  const contents = await readFile(transcript, "utf8");
  const messages: unknown[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
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
