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

async function findTranscriptFile(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  relativeName: string,
): Promise<string | null> {
  const projectsDirectory = path.join(configDirectory(environment), "projects");
  const expected = path.join(projectsDirectory, projectDirectoryName(cwd), relativeName);
  if (await existingFile(expected)) return expected;

  let projects: string[];
  try {
    projects = await readdir(projectsDirectory);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = path.join(projectsDirectory, project, relativeName);
    if (await existingFile(candidate)) return candidate;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses an append-only Claude transcript file body into every persisted
 * user/assistant record in file order, stamping the owning `session_id`. No
 * parentUuid branch is followed, so records the SDK's branch walker would drop
 * (a later prompt attached before the prior assistant terminal, or attachment
 * records interleaved between messages) survive in transcript order.
 */
function parseTranscriptRecords(contents: string, sessionId: string): unknown[] {
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
    messages.push({ ...entry, session_id: sessionId });
  }
  return messages;
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
  const transcript = await findTranscriptFile(
    input.environment,
    input.cwd,
    `${input.sessionId}.jsonl`,
  );
  if (!transcript) return null;
  return parseTranscriptRecords(await readFile(transcript, "utf8"), input.sessionId);
}

/**
 * Reads a Subagent's raw transcript file directly, in file order.
 *
 * The Agent SDK's getSubagentMessages() reconstructs one parentUuid branch and
 * can drop Subagent messages when attachment records are interleaved. History
 * recovery needs every persisted Subagent user/assistant record instead, so the
 * raw `subagents/agent-<id>.jsonl` file is preferred and getSubagentMessages()
 * is only a fallback when that file is absent.
 */
export async function readClaudeSubagentTranscript(input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sessionId: string;
  nativeSubagentId: string;
}): Promise<unknown[] | null> {
  const relativeName = path.join(
    input.sessionId,
    "subagents",
    `agent-${input.nativeSubagentId}.jsonl`,
  );
  const transcript = await findTranscriptFile(input.environment, input.cwd, relativeName);
  if (!transcript) return null;
  return parseTranscriptRecords(await readFile(transcript, "utf8"), input.sessionId);
}
