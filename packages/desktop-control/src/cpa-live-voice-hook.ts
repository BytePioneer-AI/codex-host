import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { readLiveVoiceInjectFile } from "./live-voice-inject.js";

export const CPA_LIVE_VOICE_ENV = "CODEXHOST_CPA_LIVE_VOICE";
export const CPA_LIVE_VOICE_HOOK_GLOBAL = "__codexhostCpaLiveVoiceHookV1";
export const AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION = "26.1007.30912";
export const AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET = "app-initial-6350d04672d0.js";
export const DESKTOP_VERSION_ENV = "CODEXHOST_DESKTOP_VERSION";

/** Process env wins for one launch. Otherwise the ~/.codexhost inject file (default on). */
export function cpaLiveVoiceHookEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[CPA_LIVE_VOICE_ENV];
  if (value === "0") return false;
  if (value === "1") return true;
  return readLiveVoiceInjectFile(environment);
}

/** Sparkle/CFBundle short version, e.g. 26.1021.31345. Env wins. */
export function detectInstalledDesktopVersion(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = environment[DESKTOP_VERSION_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform !== "darwin") return undefined;
  const home = environment.HOME?.trim() || os.homedir();
  const apps = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    path.join(home, "Applications/ChatGPT.app"),
    path.join(home, "Applications/Codex.app"),
  ];
  for (const app of apps) {
    const plist = path.join(app, "Contents/Info.plist");
    if (!existsSync(plist)) continue;
    try {
      const version = execFileSync(
        "/usr/bin/defaults",
        ["read", plist, "CFBundleShortVersionString"],
        {
          encoding: "utf8",
          timeout: 2000,
        },
      ).trim();
      if (version) return version;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function cpaLiveVoiceHookBootstrap(
  environment: NodeJS.ProcessEnv = process.env,
  desktopVersion?: string,
): string {
  if (!cpaLiveVoiceHookEnabled(environment)) return "";
  const version =
    environment[DESKTOP_VERSION_ENV]?.trim() ||
    desktopVersion ||
    detectInstalledDesktopVersion(environment);
  return `globalThis.${CPA_LIVE_VOICE_HOOK_GLOBAL} = Object.freeze(${JSON.stringify({
    enabled: true,
    auditedDesktopVersion: AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
    auditedAppInitialAsset: AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
    ...(version ? { desktopVersion: version } : {}),
  })});\n`;
}
