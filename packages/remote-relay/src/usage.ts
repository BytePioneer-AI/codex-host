import { TokenBucket } from "./bandwidth.js";

export class Usage {
  private day = new Date().toISOString().slice(0, 10);
  private acmeHour = "";
  private acmeBytes = 0;
  bytes = 0;
  upload: TokenBucket | undefined;
  download: TokenBucket | undefined;

  constructor(
    rate: number | undefined,
    private quota: number | undefined,
    usedToday = 0,
  ) {
    this.configure(rate, quota, usedToday);
    this.bytes = usedToday;
  }

  configure(rate: number | undefined, quota: number | undefined, usedToday = 0): void {
    if (this.expired) {
      this.day = new Date().toISOString().slice(0, 10);
      this.bytes = usedToday;
    }
    this.quota = quota;
    this.upload = rate === undefined ? undefined : new TokenBucket(rate);
    this.download = rate === undefined ? undefined : new TokenBucket(rate);
  }

  get expired(): boolean {
    return this.day < new Date().toISOString().slice(0, 10);
  }

  get exceeded(): boolean {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.bytes = 0;
    }
    return this.quota !== undefined && this.bytes >= this.quota;
  }

  get acmeRemaining(): number {
    const hour = new Date().toISOString().slice(0, 13);
    if (hour !== this.acmeHour) {
      this.acmeHour = hour;
      this.acmeBytes = 0;
    }
    return 1024 * 1024 - this.acmeBytes;
  }

  /** True only on the first crossing of this UTC day's quota. */
  add(bytes: number, validation = false): boolean {
    const exceeded = this.exceeded;
    if (validation) this.acmeBytes = 1024 * 1024 - this.acmeRemaining + bytes;
    this.bytes += bytes;
    return this.exceeded && !exceeded;
  }
}

export function pruneUsage(
  usageByName: Map<string, Usage>,
  agents: ReadonlyMap<string, unknown>,
): void {
  for (const [name, usage] of usageByName) {
    if (!agents.has(name) && usage.expired) usageByName.delete(name);
  }
}
