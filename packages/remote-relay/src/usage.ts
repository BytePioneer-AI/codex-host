import { TokenBucket } from "./bandwidth.js";

export class Usage {
  private day = "";
  private acmeHour = "";
  private acmeBytes = 0;
  bytes = 0;
  readonly upload: TokenBucket | undefined;
  readonly download: TokenBucket | undefined;

  constructor(
    rate: number | undefined,
    private readonly quota: number | undefined,
  ) {
    this.upload = rate === undefined ? undefined : new TokenBucket(rate);
    this.download = rate === undefined ? undefined : new TokenBucket(rate);
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
