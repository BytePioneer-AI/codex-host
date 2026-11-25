import os from "node:os";

import type {
  ConsoleSummary,
  ControllerStatus,
  LogFileEntry,
  StartupRecord,
} from "./diagnostics.js";
import type { InspectDocument } from "./installation.js";

export const ISSUE_REPOSITORY_URL = "https://github.com/BytePioneer-AI/codex-host";
const ISSUE_ERROR_CHARS = 800;
const ISSUE_URL_MAX_LENGTH = 7_000;
export const REPORT_LOG_TAIL_BYTES = 32 * 1024;
const REPORT_LOG_FILES = 2;
const REPORT_STARTUP_RECORDS = 5;

export interface DiagnosticInput {
  consoleVersion: string;
  distribution: { version: string; distribution: string; target: string } | null;
  summary: ConsoleSummary;
  inspect: InspectDocument | null;
  inspectError: string | null;
  startup: StartupRecord[];
  controller: ControllerStatus | null;
  controllerAlive: boolean;
  logs: LogFileEntry[];
}

export interface DiagnosticReport {
  schemaVersion: 1;
  generatedAt: string;
  platform: { os: NodeJS.Platform; arch: string; release: string };
  codexhost: { version: string; distribution: string | null; target: string | null };
  summary: ConsoleSummary;
  desktop: InspectDocument["desktop"];
  desktopError: string | null;
  runtime: { running: boolean } | null;
  inspectError: string | null;
  controller: (ControllerStatus & { alive: boolean }) | null;
  startup: StartupRecord[];
  logs: { name: string; size: number; tail: string }[];
}

/** Replaces the home directory with `~` everywhere, including JSON-escaped Windows paths. */
export function redactHome(text: string, home: string = os.homedir()): string {
  if (!home || home === "/" || home.length < 3) return text;
  const variants = new Set([home, JSON.stringify(home).slice(1, -1)]);
  let result = text;
  for (const variant of variants) result = result.split(variant).join("~");
  return result;
}

export async function buildDiagnosticReport(
  input: DiagnosticInput,
  readTail: (name: string, maxBytes: number) => Promise<string | null>,
  now: () => Date = () => new Date(),
): Promise<DiagnosticReport> {
  const logs: DiagnosticReport["logs"] = [];
  for (const entry of input.logs.slice(0, REPORT_LOG_FILES)) {
    const tail = await readTail(entry.name, REPORT_LOG_TAIL_BYTES);
    if (tail !== null) logs.push({ name: entry.name, size: entry.size, tail });
  }
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    platform: { os: process.platform, arch: process.arch, release: os.release() },
    codexhost: {
      version: input.distribution?.version ?? input.consoleVersion,
      distribution: input.distribution?.distribution ?? null,
      target: input.distribution?.target ?? null,
    },
    summary: input.summary,
    desktop: input.inspect?.desktop ?? null,
    desktopError: input.inspect?.desktopError ?? null,
    runtime: input.inspect ? { running: input.inspect.runtime.running } : null,
    inspectError: input.inspectError,
    controller: input.controller ? { ...input.controller, alive: input.controllerAlive } : null,
    startup: input.startup.slice(0, REPORT_STARTUP_RECORDS),
    logs,
  };
}

/** Serialized report with the home directory redacted. */
export function serializeDiagnosticReport(report: DiagnosticReport, home?: string): string {
  return redactHome(`${JSON.stringify(report, null, 2)}\n`, home);
}

function clip(value: string | null | undefined, limit: number): string {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** A prefilled GitHub issue with versions and the failure, never logs. */
export function issueUrl(report: DiagnosticReport, home?: string): string {
  const latest = report.startup[0];
  const renderer = report.controller?.alive ? report.controller.renderer : null;
  const lines = [
    "### What happened",
    "",
    "<!-- Describe what you did and what you saw. -->",
    "",
    "### Environment",
    "",
    `- codexhost: ${report.codexhost.version} (${report.codexhost.distribution ?? "source"}, ${report.codexhost.target ?? "unknown target"})`,
    `- Codex Desktop: ${report.desktop ? `${report.desktop.version} (build ${report.desktop.build})` : "not found"}`,
    `- OS: ${report.platform.os} ${report.platform.release} ${report.platform.arch}`,
    `- Console state: ${report.summary.state}`,
  ];
  if (latest) {
    lines.push(
      "",
      "### Latest start",
      "",
      `- Outcome: ${latest.outcome}`,
      `- Last stage: ${latest.stages.at(-1)?.name ?? "none"}`,
    );
    if (latest.error) lines.push("", "```", clip(latest.error, ISSUE_ERROR_CHARS), "```");
  }
  if (renderer?.error) {
    lines.push(
      "",
      "### Codex UI integration",
      "",
      "```",
      clip(renderer.error, ISSUE_ERROR_CHARS),
      "```",
    );
  }
  lines.push(
    "",
    "<!-- Attach the diagnostics file exported from the codexhost console if it helps. -->",
  );
  const title =
    report.summary.state === "startup-failed"
      ? "codexhost failed to start"
      : report.summary.state === "integration-unavailable"
        ? `codexhost features missing in Codex Desktop ${report.desktop?.version ?? ""}`.trim()
        : "codexhost issue";
  const build = (body: string): string =>
    `${ISSUE_REPOSITORY_URL}/issues/new?${new URLSearchParams({ title, body }).toString()}`;
  let body = redactHome(lines.join("\n"), home);
  let url = build(body);
  while (url.length > ISSUE_URL_MAX_LENGTH && body.length > 200) {
    body = `${body.slice(0, Math.floor(body.length * 0.8))}\n…`;
    url = build(body);
  }
  return url;
}
