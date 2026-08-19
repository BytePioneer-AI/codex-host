const DIAGNOSTIC_TAIL_MAX_LENGTH = 8_000;
const SENSITIVE_VALUE_PATTERN =
  /(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)(\s*[:=]\s*)([^\s,;]+)/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;

export function sanitizeDiagnosticTail(value: string): string {
  const redacted = value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SENSITIVE_VALUE_PATTERN, "$1$2[redacted]");
  return redacted.length <= DIAGNOSTIC_TAIL_MAX_LENGTH
    ? redacted
    : redacted.slice(-DIAGNOSTIC_TAIL_MAX_LENGTH);
}
