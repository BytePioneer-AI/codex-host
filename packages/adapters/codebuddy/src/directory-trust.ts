import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  CODEBUDDY_RUNTIME_PROFILE,
  CodeBuddyError,
  type CodeBuddyRuntimeProfile,
} from "./common.js";
import { codeBuddyCanonicalCwd, codeBuddyConfigRoot } from "./history.js";

export type CodeBuddyDirectoryTrustAssessment =
  | { status: "trusted"; settingsPath: string }
  | { status: "untrusted"; settingsPath: string; cwd: string }
  | { status: "unknown"; settingsPath: string; cwd: string; reason: string };

function expandHome(value: string, environment: NodeJS.ProcessEnv): string {
  if (value === "~") return environment.HOME || environment.USERPROFILE || homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(environment.HOME || environment.USERPROFILE || homedir(), value.slice(2));
  }
  return value;
}

function normalizeDirectory(value: string, environment: NodeJS.ProcessEnv): string {
  return codeBuddyCanonicalCwd(expandHome(value, environment));
}

function directoriesMatch(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
  }
  return left === right;
}

function readSettingsObject(settingsPath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function trustedDirectoryEntries(settings: Record<string, unknown>): string[] {
  // Documented field is trustedDirectories; accept trustDirectories as a misspelling seen in the wild.
  const value = settings.trustedDirectories ?? settings.trustDirectories;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Read user settings and decide whether headless ACP can skip the directory-trust prompt. */
export function assessCodeBuddyDirectoryTrust(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): CodeBuddyDirectoryTrustAssessment {
  const settingsPath = path.join(codeBuddyConfigRoot(environment, profile), "settings.json");
  const canonicalCwd = codeBuddyCanonicalCwd(cwd);
  let settings: Record<string, unknown> | undefined;
  try {
    settings = readSettingsObject(settingsPath);
  } catch (error) {
    return {
      status: "unknown",
      settingsPath,
      cwd: canonicalCwd,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!settings) {
    return {
      status: "unknown",
      settingsPath,
      cwd: canonicalCwd,
      reason: "settings.json is missing",
    };
  }
  if (settings.trustAll === true) {
    return { status: "trusted", settingsPath };
  }
  const trusted = trustedDirectoryEntries(settings).map((entry) =>
    normalizeDirectory(entry, environment),
  );
  if (trusted.some((entry) => directoriesMatch(entry, canonicalCwd))) {
    return { status: "trusted", settingsPath };
  }
  return { status: "untrusted", settingsPath, cwd: canonicalCwd };
}

export function codeBuddyDirectoryTrustErrorMessage(
  assessment: Extract<CodeBuddyDirectoryTrustAssessment, { status: "untrusted" }>,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): string {
  return (
    `Working directory is not in ${profile.displayName} trustedDirectories, so headless ACP cannot complete directory trust / worktree setup. ` +
    `Trust this directory once in the ${profile.displayName} CLI, or add "${assessment.cwd}" to trustedDirectories in "${assessment.settingsPath}" (or set "trustAll": true), then retry.`
  );
}

export function codeBuddyMissingModelErrorMessage(
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): string {
  const base = "ACP did not report a valid current Model";
  if (!cwd || !environment) {
    return (
      `${base}. If the working directory is not listed in ${profile.displayName} trustedDirectories ` +
      `(~/${profile.defaultConfigDirectoryName}/settings.json), headless ACP cannot finish directory trust / worktree setup — ` +
      `trust the directory in the ${profile.displayName} CLI once or add it to trustedDirectories, then retry.`
    );
  }
  const assessment = assessCodeBuddyDirectoryTrust(cwd, environment, profile);
  if (assessment.status === "untrusted") {
    return codeBuddyDirectoryTrustErrorMessage(assessment, profile);
  }
  if (assessment.status === "trusted") {
    return base;
  }
  return (
    `${base}. If headless ACP is stuck on directory trust / worktree setup, trust the working directory in the ${profile.displayName} CLI ` +
    `or add it to trustedDirectories in "${assessment.settingsPath}" (or set "trustAll": true), then retry.`
  );
}

/** Fail fast when settings positively show the cwd is untrusted. Missing settings stay unknown. */
export function assertCodeBuddyDirectoryTrusted(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): void {
  const assessment = assessCodeBuddyDirectoryTrust(cwd, environment, profile);
  if (assessment.status === "untrusted") {
    throw new CodeBuddyError(
      "invalidRequest",
      codeBuddyDirectoryTrustErrorMessage(assessment, profile),
    );
  }
}
