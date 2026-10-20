import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LIVE_VOICE_INJECT_FILE = "live-voice-inject-v1.json";

/** Missing, malformed or unsupported settings default to injection on. */
export function readLiveVoiceInjectFile(environment: NodeJS.ProcessEnv = process.env): boolean {
  const directory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(directory, LIVE_VOICE_INJECT_FILE), "utf8"),
    ) as {
      version?: unknown;
      inject?: unknown;
    };
    return parsed.version !== 1 || parsed.inject !== false;
  } catch {
    return true;
  }
}
