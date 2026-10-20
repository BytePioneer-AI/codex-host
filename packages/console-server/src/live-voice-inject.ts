import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const CPA_LIVE_VOICE_ENV = "CODEXHOST_CPA_LIVE_VOICE";
export const LIVE_VOICE_INJECT_FILE = "live-voice-inject-v1.json";

export interface LiveVoiceInjectState {
  inject: boolean;
  envOverride: "0" | "1" | null;
}

function injectPath(dataDirectory: string): string {
  return path.join(dataDirectory, LIVE_VOICE_INJECT_FILE);
}

export async function readLiveVoiceInjectState(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LiveVoiceInjectState> {
  const env = environment[CPA_LIVE_VOICE_ENV];
  const envOverride = env === "0" || env === "1" ? env : null;
  let inject = true;
  try {
    const parsed = JSON.parse(await readFile(injectPath(dataDirectory), "utf8")) as {
      version?: unknown;
      inject?: unknown;
    };
    inject = parsed.version !== 1 || parsed.inject !== false;
  } catch {
    inject = true;
  }
  if (envOverride === "0") inject = false;
  if (envOverride === "1") inject = true;
  return { inject, envOverride };
}

export async function writeLiveVoiceInjectFile(
  dataDirectory: string,
  inject: boolean,
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(dataDirectory, `.${LIVE_VOICE_INJECT_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, inject }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, injectPath(dataDirectory));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
