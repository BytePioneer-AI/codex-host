import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveClaudeCommand, sanitizedAuthStatus } from "./command.mjs";

export const CLIENT_APP = "codexhost-claude-code-capability-probe/0.0.0";

export function readSdkManifest() {
  const sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const manifestPath = path.join(path.dirname(sdkEntry), "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof manifest.version !== "string" || typeof manifest.claudeCodeVersion !== "string") {
    throw new Error("Claude Agent SDK manifest lacks compatibility versions");
  }
  return {
    sdkVersion: manifest.version,
    claudeCodeVersion: manifest.claudeCodeVersion,
  };
}

function runClaudeJson(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`Claude command exited with status ${result.status ?? "unknown"}`);
    error.code = "CLAUDE_COMMAND_FAILED";
    throw error;
  }
  return result.stdout.trim();
}

export function inspectClaudeInstallation(options = {}) {
  const selected = resolveClaudeCommand(options);
  const versionOutput = runClaudeJson(selected.executable, ["--version"]);
  const version = versionOutput.match(/\b\d+\.\d+\.\d+\b/u)?.[0];
  if (!version) throw new Error("Claude Code version output was not recognized");

  const auth = sanitizedAuthStatus(
    JSON.parse(runClaudeJson(selected.executable, ["auth", "status", "--json"])),
  );
  return {
    executable: selected.executable,
    summary: {
      commandSource: selected.source,
      cliVersion: version,
      auth,
      ...readSdkManifest(),
    },
  };
}

export function claudeOptions({ cwd, executable, sessionId, settingSources = ["user"] }) {
  return {
    cwd,
    sessionId,
    pathToClaudeCodeExecutable: executable,
    settingSources,
    permissionMode: "dontAsk",
    tools: [],
    persistSession: true,
    includePartialMessages: true,
    model: process.env.CODEXHOST_CLAUDE_MODEL || "haiku",
    maxTurns: 6,
    maxBudgetUsd: 0.2,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    },
  };
}

export function createTrackedSpawner() {
  const processes = [];
  return {
    processes,
    spawnClaudeCodeProcess(options) {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
      processes.push(child);
      return child;
    },
  };
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return Boolean(await predicate());
}

export async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeQuery(activeQuery) {
  activeQuery.close();
  await activeQuery.return?.().catch(() => undefined);
}
