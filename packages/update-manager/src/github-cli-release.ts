import { execFile } from "node:child_process";
import path from "node:path";

import { parseLatestGitHubRelease, type CodexhostLatestRelease } from "./github-release.js";

const GITHUB_LATEST_RELEASE_ENDPOINT = "repos/BytePioneer-AI/codex-host/releases/latest";
const MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024;
const GITHUB_CLI_TIMEOUT_MS = 5_000;

interface GitHubCliRunOptions {
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type GitHubCliRunner = (
  executable: string,
  arguments_: readonly string[],
  options: GitHubCliRunOptions,
) => Promise<string>;

export interface GitHubCliReleaseFetchOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  executableCandidates?: readonly string[];
  run?: GitHubCliRunner;
}

function defaultExecutableCandidates(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (environment.CODEXHOST_GH_COMMAND) return [environment.CODEXHOST_GH_COMMAND];
  const candidates = ["gh"];
  if (platform === "darwin") {
    candidates.push("/opt/homebrew/bin/gh", "/usr/local/bin/gh");
  } else if (platform === "win32") {
    const programFiles = environment.ProgramFiles ?? environment.PROGRAMFILES;
    const localAppData = environment.LOCALAPPDATA;
    if (programFiles) candidates.push(path.win32.join(programFiles, "GitHub CLI", "gh.exe"));
    if (localAppData) {
      candidates.push(path.win32.join(localAppData, "Programs", "GitHub CLI", "gh.exe"));
    }
  } else {
    candidates.push("/usr/local/bin/gh", "/usr/bin/gh", "/snap/bin/gh");
  }
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function runGitHubCli(
  executable: string,
  arguments_: readonly string[],
  options: GitHubCliRunOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...arguments_],
      {
        encoding: "utf8",
        env: options.environment,
        maxBuffer: MAX_RELEASE_RESPONSE_BYTES,
        timeout: GITHUB_CLI_TIMEOUT_MS,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Reads the public Release through GitHub CLI so its credential remains owned by
 * `gh` and the system keychain. Returns null when `gh` is unavailable or not
 * authenticated (or fails), allowing callers to retain the anonymous HTTP fallback.
 * CLI stderr is never surfaced because debug output can contain credentials.
 */
export async function fetchLatestGitHubReleaseWithGitHubCli(
  options: GitHubCliReleaseFetchOptions = {},
): Promise<CodexhostLatestRelease | null> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates =
    options.executableCandidates ?? defaultExecutableCandidates(environment, platform);
  const run = options.run ?? runGitHubCli;
  const arguments_ = [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    "X-GitHub-Api-Version: 2022-11-28",
    GITHUB_LATEST_RELEASE_ENDPOINT,
  ] as const;

  for (const executable of candidates) {
    options.signal?.throwIfAborted();
    try {
      return parseLatestGitHubRelease(
        JSON.parse(
          await run(executable, arguments_, {
            environment,
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        ),
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      // Only try another install path when this executable could not be started.
      // Retrying authentication/network/parse failures would repeat the same request.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT" && code !== "EACCES") return null;
    }
  }
  return null;
}
