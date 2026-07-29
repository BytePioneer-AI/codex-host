const FORBIDDEN_KEY =
  /(?:^|_)(?:account|authorization|credential|cwd|email|message_?id|organization|password|path|prompt|response|session_?id|token|transcript|uuid)(?:$|_)/iu;
const COMPLETE_UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const EMAIL = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;
const POSIX_ABSOLUTE_PATH = /(?:^|\s)\/(?:Users|home|private|tmp|var)\//u;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\/u;

export function assertTrackedSummarySafe(value, location = "summary") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertTrackedSummarySafe(entry, `${location}[${index}]`));
    return value;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
      if (FORBIDDEN_KEY.test(normalizedKey)) {
        throw new Error(`forbidden tracked evidence key at ${location}.${key}`);
      }
      assertTrackedSummarySafe(entry, `${location}.${key}`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (
      COMPLETE_UUID.test(value) ||
      EMAIL.test(value) ||
      POSIX_ABSOLUTE_PATH.test(value) ||
      WINDOWS_ABSOLUTE_PATH.test(value)
    ) {
      throw new Error(`sensitive tracked evidence value at ${location}`);
    }
  }
  return value;
}
