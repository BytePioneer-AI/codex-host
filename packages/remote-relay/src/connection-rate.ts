export class ConnectionRateLimiter {
  private entries = new Map<string, { attempts: number[]; bannedUntil: number }>();

  constructor(
    private limit = 50,
    private window = 10_000,
    private banDuration = 10_000,
  ) {
    for (const [name, value] of [
      ["--ip-connection-limit", limit],
      ["--ip-connection-window", window],
      ["--ip-ban-duration", banDuration],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
  }

  allow(ip: string | undefined): boolean {
    if (ip === undefined) return false;
    const now = performance.now();
    let entry = this.entries.get(ip);
    if (!entry) {
      entry = { attempts: [], bannedUntil: 0 };
      this.entries.set(ip, entry);
    }
    if (now < entry.bannedUntil) return false;
    entry.attempts = entry.attempts.filter((time) => time > now - this.window);
    if (entry.attempts.length >= this.limit) {
      entry.bannedUntil = now + this.banDuration;
      entry.attempts = [];
      return false;
    }
    entry.attempts.push(now);
    return true;
  }

  prune(): void {
    const now = performance.now();
    for (const [ip, entry] of this.entries) {
      const lastAttempt = entry.attempts.at(-1);
      if (
        entry.bannedUntil <= now &&
        (lastAttempt === undefined || lastAttempt <= now - this.window)
      ) {
        this.entries.delete(ip);
      }
    }
  }
}
