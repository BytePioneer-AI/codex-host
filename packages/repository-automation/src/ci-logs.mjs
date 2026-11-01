import { stripVTControlCharacters } from "node:util";

// CI logs are untrusted output. Never execute them or publish complete logs/download URLs.
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /u;
const DIAGNOSTIC =
  /\berror TS\d+:|\berror(?:\[[A-Z]\d+\])?:|\bAssertionError\b|^\s*(?:FAIL\s|FAILED\s|npm ERR!|npm error|Error:)|:\d+(?::\d+)?\s+error\b|^\s*\d+:\d+\s+error\b|^thread .+ panicked at |^assertion .+ failed|^\s*--> .+:\d+:\d+/iu;

export function redactLogLine(line) {
  // Named credentials: redact the entire line, including unrecognised token formats.
  if (
    /authorization|\b(?:bearer|password|passwd|secret|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token)\b|\b[A-Z_]*TOKEN\b/iu.test(
      line,
    )
  ) {
    return "[REDACTED: sensitive log line]";
  }
  return line
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[\w-]+/gu, "[REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, "[REDACTED]")
    .replace(/https?:\/\/\S+/gu, "[URL REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED]")
    .replace(/\bxox[baprs]-[\w-]+/gu, "[REDACTED]")
    .replace(/\b(?=[A-Za-z0-9_+-]*\d)[A-Za-z0-9_+-]{40,}={0,2}/gu, "[REDACTED]")
    .replace(/\/(?:Users|home)\/[^/\s]+/gu, "/home/[REDACTED]")
    .replace(/[A-Z]:\\Users\\[^\\\s]+/giu, "C:\\Users\\[REDACTED]");
}

export function extractErrors(log, job) {
  if (typeof log !== "string" || Buffer.byteLength(log) > MAX_LOG_BYTES) return [];
  const windows = (job.steps ?? []).filter(
    (step) => step.conclusion === "failure" && step.started_at && step.completed_at,
  );
  const lines = [];
  const generic = [];
  for (const raw of log.split(/\r?\n/u)) {
    const time = TIMESTAMP.exec(raw)?.[0];
    if (
      windows.length &&
      (!time ||
        !windows.some(
          (step) =>
            Date.parse(time.trim()) >= Date.parse(step.started_at) &&
            Date.parse(time.trim()) < Date.parse(step.completed_at) + 1000,
        ))
    )
      continue;
    const clean = stripVTControlCharacters(raw.replace(TIMESTAMP, "")).replace(
      /[\p{Cc}\p{Cf}]/gu,
      (char) => (char === "\t" ? char : ""),
    );
    if (clean.startsWith("##[error]")) {
      const value = clean.slice("##[error]".length);
      if (!/process completed with exit code/iu.test(value)) generic.push(value);
    }
    if (DIAGNOSTIC.test(clean) && !/^\s*(?:Run |echo |printf )/u.test(clean))
      lines.push(clean.replace(/^##\[error\]/u, ""));
  }
  // No diagnosis or translation: retain only a few literal diagnostics, with redaction.
  return [
    ...new Set((lines.length ? lines : generic).map((line) => redactLogLine(line).slice(0, 500))),
  ].slice(0, 5);
}

async function boundedText(response) {
  if (!response.ok || !response.body) throw new Error("Log download unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_LOG_BYTES) throw new Error("Log exceeds excerpt limit");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readJobErrors({ github, repo, job, fetchLog = fetch }) {
  try {
    let response;
    try {
      response = await github.rest.actions.downloadJobLogsForWorkflowRun({
        ...repo,
        job_id: job.id,
        request: { redirect: "manual" },
      });
    } catch (error) {
      // Octokit reports an unfollowed 302 as a RequestError.
      if (error.status !== 302) throw error;
      response = error.response;
    }
    let log;
    if (response.status === 200 && typeof response.data === "string") {
      log = response.data;
    } else if (response.status === 302) {
      const url = new URL(response.headers.location);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !(
          url.hostname.endsWith(".blob.core.windows.net") ||
          url.hostname.endsWith(".actions.githubusercontent.com")
        )
      )
        throw new Error("Unexpected log host");
      // Signed download URL only. Never forward the GitHub token or follow another redirect.
      log = await boundedText(
        await fetchLog(url, { redirect: "error", signal: AbortSignal.timeout(15000) }),
      );
    }
    return extractErrors(log, job);
  } catch {
    // Expired/missing/unreadable/oversized logs: link to the failed job instead of guessing.
    return [];
  }
}
