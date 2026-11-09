export class TokenBucket {
  private tokens: number;
  private updated = performance.now();

  constructor(readonly rate: number) {
    this.tokens = rate;
  }

  /** Returns the wait in milliseconds, or consumes the requested tokens. */
  take(bytes: number): number {
    const now = performance.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.updated) * this.rate) / 1000);
    this.updated = now;
    if (this.tokens < bytes) return Math.ceil(((bytes - this.tokens) * 1000) / this.rate);
    this.tokens -= bytes;
    return 0;
  }
}
