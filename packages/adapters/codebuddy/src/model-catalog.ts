import { spawn } from "node:child_process";

import {
  harnessModelRefSchema,
  type HarnessModel,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

/**
 * Fallback catalog matching a recent CodeBuddy CLI release. The catalog is
 * normally parsed from `codebuddy --help`; the static list only covers help
 * parse failures so `inspect()` can still report a usable catalog.
 */
const STATIC_MODELS: readonly HarnessModel[] = [
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.3-codex",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "glm-5.3-ioa",
  "glm-5.2-ioa",
  "kimi-k3-ioa",
  "minimax-m3-ioa",
  "deepseek-v4-pro-ioa",
  "deepseek-v4-flash-ioa",
].map((id) => ({
  ref: harnessModelRefSchema.parse({ id }),
  label: id,
}));

// Transport-safe Model Ref characters enforced by shared-contracts; CodeBuddy
// exposes a few internal IDs (e.g. `custom-local:*`) that cannot be routed.
const TRANSPORT_SAFE_MODEL_ID = /^[A-Za-z0-9._~-]+$/u;

const HELP_MODEL_LIST_PATTERN = /--model <model>[^\n]*Currently supported: \(([^)]*)\)/u;

function labelForModelId(id: string): string {
  const match = /^(claude|gpt|glm|gemini|kimi|minimax|deepseek|hy|echo)-(.+)$/u.exec(id);
  if (!match) return id;
  const family = match[1] ?? id;
  const rest = match[2] ?? "";
  const familyLabel = family.toUpperCase() === "GPT" ? "GPT" : upperFirst(family);
  return `${familyLabel} ${rest.replaceAll("-ioa", "")}`.trim();
}

function upperFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? value}${value.slice(1)}`;
}

/**
 * Parses the CodeBuddy `--model` help line into a Model Catalog. Returns
 * `null` when the help text does not expose a parseable model list.
 */
export function parseModelCatalogFromHelp(helpText: string): HarnessModelCatalog | null {
  const match = HELP_MODEL_LIST_PATTERN.exec(helpText);
  if (!match?.[1]) return null;
  const models = match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && TRANSPORT_SAFE_MODEL_ID.test(entry))
    .map((id) => ({
      ref: harnessModelRefSchema.parse({ id }),
      label: labelForModelId(id),
    }));
  if (models.length === 0) return null;
  return { models, thinkingOptions: [] };
}

export function staticModelCatalog(): HarnessModelCatalog {
  return { models: [...STATIC_MODELS], thinkingOptions: [] };
}

export function resolveCodeBuddyModelRef(id: string): HarnessModelRef {
  return harnessModelRefSchema.parse({ id });
}

export interface ResolveModelCatalogOptions {
  timeoutMs: number;
  /** Catalog to prefer over the static fallback when help parsing fails. */
  fallback: HarnessModelCatalog | null;
  spawn?: typeof spawn;
}

/**
 * Resolves the Model Catalog by running `codebuddy --help` and parsing the
 * model list from its output. Falls back to the provided catalog or the
 * built-in static list when the CLI cannot be spawned or the help text does
 * not expose a parseable model list.
 */
export async function resolveModelCatalogFromCli(
  executable: string,
  cwd: string,
  options: ResolveModelCatalogOptions,
): Promise<HarnessModelCatalog> {
  const spawnFn = options.spawn ?? spawn;
  const helpText = await readHelpText(executable, cwd, options.timeoutMs, spawnFn);
  return parseModelCatalogFromHelp(helpText) ?? options.fallback ?? staticModelCatalog();
}

function readHelpText(
  executable: string,
  cwd: string,
  timeoutMs: number,
  spawnFn: typeof spawn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(executable, ["--help"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`CodeBuddy CLI --help timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`CodeBuddy CLI --help failed to start: ${error.message}`));
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}
