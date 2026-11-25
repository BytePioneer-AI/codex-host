const DIAGNOSTIC_TAIL_MAX_LENGTH = 8_000;
const SENSITIVE_VALUE_PATTERN =
  /(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)(\s*[:=]\s*)([^\s,;]+)/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const NODE_WARNING_PREFIX_PATTERN = /^\(node:\d+\)\s+/u;
const NODE_TRACE_WARNINGS_HINT_PATTERN = /^\(Use\s+`node\s+--trace-warnings/u;

/**
 * Drop ambient Node.js process warnings (e.g. `(node:1234) [UNDICI-EHPA]
 * Warning: ...` plus the matching `Use \`node --trace-warnings ...\` hint)
 * from captured process output. Runtime-injected environment switches such
 * as NODE_USE_ENV_PROXY make Node >= 22 emit these on stderr for every
 * child CLI, and they carry no diagnostic signal about the harness itself.
 */
export function filterAmbientNodeWarnings(output: string): string {
  return output
    .split("\n")
    .filter(
      (line) =>
        !NODE_WARNING_PREFIX_PATTERN.test(line) && !NODE_TRACE_WARNINGS_HINT_PATTERN.test(line),
    )
    .join("\n");
}

export function sanitizeDiagnosticTail(value: string): string {
  const redacted = value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SENSITIVE_VALUE_PATTERN, "$1$2[redacted]");
  return redacted.length <= DIAGNOSTIC_TAIL_MAX_LENGTH
    ? redacted
    : redacted.slice(-DIAGNOSTIC_TAIL_MAX_LENGTH);
}
