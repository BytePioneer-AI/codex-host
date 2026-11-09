export function log(
  reason: "register" | "unregister" | "replace" | "quota",
  id: string,
  ip: string | undefined,
  bytes?: number,
): void {
  process.stdout.write(
    `${JSON.stringify({ id, ip, time: new Date().toISOString(), bytes, reason })}\n`,
  );
}
