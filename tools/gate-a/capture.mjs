import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probeExitSchema, probeInvocationSchema } from "./contracts.mjs";

const SENSITIVE_TEXT = /(api[_-]?key|authorization|bearer|password|secret|token|prompt)/iu;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;
const POSIX_ABSOLUTE_PATH = /^\//u;

export function parseRawCapture(buffer) {
  const value = JSON.parse(buffer.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("raw capture must be a JSON object");
  }
  return value;
}

export function encodeRawCapture(record) {
  return Buffer.from(JSON.stringify(record), "utf8");
}

function integer(value, key, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error(`invalid integer field '${key}'`);
  return value;
}

function replacementRoots(record) {
  const values = [
    [record.install_root, "<DESKTOP_INSTALL>"],
    [record.stock_codex_path, "<STOCK_CODEX>"],
    [record.cwd, "<WORKING_DIRECTORY>"],
    [process.env.LOCALAPPDATA ?? "", "<LOCAL_APP_DATA>"],
    [process.env.USERPROFILE ?? "", "<USER_HOME>"],
    [process.env.HOME ?? "", "<USER_HOME>"],
    [process.env.TMPDIR ?? "", "<TEMP>"],
  ];
  return values
    .filter(([value]) => typeof value === "string" && value.length > 0)
    .sort(([left], [right]) => right.length - left.length);
}

function replaceInsensitive(value, search, replacement) {
  const source = value.toLowerCase();
  const needle = search.toLowerCase();
  let cursor = 0;
  let result = "";
  while (true) {
    const found = source.indexOf(needle, cursor);
    if (found < 0) return result + value.slice(cursor);
    result += value.slice(cursor, found) + replacement;
    cursor = found + search.length;
  }
}

function sanitizeText(value, roots) {
  if (SENSITIVE_TEXT.test(value)) return "<REDACTED>";
  let sanitized = value;
  for (const [root, replacement] of roots) {
    sanitized = replaceInsensitive(sanitized, root, replacement);
  }
  if (WINDOWS_ABSOLUTE_PATH.test(sanitized) || POSIX_ABSOLUTE_PATH.test(sanitized)) {
    return `<ABSOLUTE_PATH>/${path.basename(sanitized)}`;
  }
  return sanitized;
}

export function sanitizeCapture(record) {
  const schemaVersion = integer(record.schema_version, "schema_version");
  const platform = record.platform;
  if (!["windows", "macos", "linux"].includes(platform)) {
    throw new Error(`unsupported capture platform '${platform}'`);
  }
  if (record.record_type === "invocation") {
    const roots = replacementRoots(record);
    const environmentPresence = Object.fromEntries(
      Object.entries(record.environment_presence ?? {}).map(([key, value]) => {
        if (typeof value !== "boolean") {
          throw new Error(`invalid environment presence field '${key}'`);
        }
        return [key, value];
      }),
    );
    if (!Array.isArray(record.args) || record.args.some((value) => typeof value !== "string")) {
      throw new Error("invalid invocation args");
    }
    const platformFields =
      platform === "windows"
        ? {}
        : {
            architecture: record.architecture,
            processGroupId: integer(record.process_group_id, "process_group_id"),
            launchMode: record.launch_mode,
          };
    return probeInvocationSchema.parse({
      schemaVersion,
      platform,
      ...platformFields,
      recordType: record.record_type,
      timestampMs: integer(record.timestamp_ms, "timestamp_ms"),
      processId: integer(record.process_id, "process_id"),
      parentProcessId: integer(record.parent_process_id, "parent_process_id", { nullable: true }),
      invocationKind: record.invocation_kind,
      args: record.args.map((value) => sanitizeText(value, roots)),
      cwd: sanitizeText(record.cwd, roots),
      desktopVersion: record.desktop_version,
      stockCodexPath: sanitizeText(record.stock_codex_path, roots),
      environmentPresence,
    });
  }
  if (record.record_type === "exit") {
    const platformFields =
      platform === "windows"
        ? {}
        : {
            exitSignal: integer(record.exit_signal, "exit_signal", { nullable: true }),
          };
    return probeExitSchema.parse({
      schemaVersion,
      platform,
      ...platformFields,
      recordType: record.record_type,
      timestampMs: integer(record.timestamp_ms, "timestamp_ms"),
      processId: integer(record.process_id, "process_id"),
      childProcessId: integer(record.child_process_id, "child_process_id"),
      exitCode: integer(record.exit_code, "exit_code", { nullable: true }),
      success: record.success,
      elapsedMs: integer(record.elapsed_ms, "elapsed_ms"),
    });
  }
  throw new Error(`unsupported record_type '${record.record_type}'`);
}

export function sanitizeCaptureFile(inputPath, outputPath) {
  const capture = sanitizeCapture(parseRawCapture(fs.readFileSync(inputPath)));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  return capture;
}

const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (executedFile === fileURLToPath(import.meta.url)) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    throw new Error("usage: node tools/gate-a/capture.mjs <raw.json> <sanitized.json>");
  }
  sanitizeCaptureFile(path.resolve(inputPath), path.resolve(outputPath));
}
