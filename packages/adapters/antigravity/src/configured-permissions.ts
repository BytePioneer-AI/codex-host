import path from "node:path";

import type { JsonValue } from "@codexhost/shared-contracts";

import {
  compactToolName,
  synthesizeAntigravityCommand,
  toolTargetFile,
} from "./tool-projection.js";

export interface AntigravityConfiguredPermissions {
  allow: readonly string[];
  ask: readonly string[];
  deny: readonly string[];
}

export interface AntigravityConfiguredPermissionPolicy {
  permissions: AntigravityConfiguredPermissions;
  workspaceRoot: string;
}

const READ_ONLY_TOOLS = new Set([
  "codebasesearch",
  "find",
  "findfiles",
  "grep",
  "grepsearch",
  "listdir",
  "listdirectory",
  "readfile",
  "search",
  "searchfiles",
  "viewfile",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

export function parseAntigravityConfiguredPermissions(
  output: string,
): AntigravityConfiguredPermissions | null {
  for (const line of output.split("\n")) {
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event) || event.event !== "command_result" || !isRecord(event.command)) {
        continue;
      }
      if (event.command.name !== "config" || !isRecord(event.command.data)) continue;
      const config = event.command.data.config;
      if (!isRecord(config) || !isRecord(config.permissions)) return null;
      return {
        allow: stringList(config.permissions.allow),
        ask: stringList(config.permissions.ask),
        deny: stringList(config.permissions.deny),
      };
    } catch {
      /* Ignore non-JSON diagnostic lines. */
    }
  }
  return null;
}

function extractPath(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of [
    "AbsolutePath",
    "absolutePath",
    "DirectoryPath",
    "directoryPath",
    "SearchPath",
    "searchPath",
    "TargetFile",
    "targetFile",
    "filePath",
    "path",
  ]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  for (const key of ["input", "arguments", "params", "parameters"]) {
    const nested = extractPath(value[key]);
    if (nested) return nested;
  }
  return null;
}

function insideWorkspace(candidate: string | null, workspaceRoot: string): boolean {
  if (!candidate) return true;
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(workspaceRoot) || /^[A-Za-z]:[\\/]/u.test(candidate);
  const pathApi = windowsPath ? path.win32 : path;
  const root = pathApi.resolve(workspaceRoot);
  const relative = pathApi.relative(root, pathApi.resolve(root, candidate));
  return (
    relative === "" ||
    (!pathApi.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`))
  );
}

function candidates(toolName: string, args: JsonValue): string[] {
  const values = [toolName, compactToolName(toolName)];
  const command = synthesizeAntigravityCommand(toolName, args);
  if (command) values.push(`command(${command.command})`);
  return values;
}

function ruleMatches(rule: string, values: readonly string[]): boolean {
  const normalized = rule.trim();
  if (!normalized) return false;
  const pattern = new RegExp(
    `^${normalized
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "u",
  );
  return values.some((value) => pattern.test(value));
}

function matchingRule(rules: readonly string[], values: readonly string[]): string | null {
  return rules.find((rule) => ruleMatches(rule, values)) ?? null;
}

export function configuredPermissionDecision(
  toolName: string,
  args: JsonValue,
  policy: AntigravityConfiguredPermissionPolicy,
): { decision: "allow" | "deny" | "prompt"; reason: string } {
  const values = candidates(toolName, args);
  const deniedBy = matchingRule(policy.permissions.deny, values);
  if (deniedBy) {
    return {
      decision: "deny",
      reason: `Antigravity configured deny rule blocked this tool call: ${deniedBy}`,
    };
  }
  const requiresApproval = matchingRule(policy.permissions.ask, values);
  if (requiresApproval) {
    return {
      decision: "prompt",
      reason:
        `Antigravity configured rule requires interactive approval: ${requiresApproval}. ` +
        "Request approval from the Codex Desktop user.",
    };
  }
  const allowedBy = matchingRule(policy.permissions.allow, values);
  if (allowedBy) {
    return {
      decision: "allow",
      reason: `Allowed by the matching Antigravity configured rule: ${allowedBy}`,
    };
  }

  const compact = compactToolName(toolName);
  const target = toolTargetFile(toolName, args) ?? extractPath(args);
  if (READ_ONLY_TOOLS.has(compact) && insideWorkspace(target, policy.workspaceRoot)) {
    return { decision: "allow", reason: "Allowed as a workspace-scoped read-only tool call." };
  }
  if (toolTargetFile(toolName, args) && target && insideWorkspace(target, policy.workspaceRoot)) {
    return { decision: "allow", reason: "Allowed as a workspace-scoped file edit." };
  }
  return {
    decision: "prompt",
    reason: "No Antigravity configured allow rule matched this tool call; request approval.",
  };
}
