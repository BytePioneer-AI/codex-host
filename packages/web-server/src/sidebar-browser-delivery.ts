/** Delivery is measured at the viewer, including relay scheduling and decoding. */
const SAMPLE_MS = 200;
const SAMPLE_MAX_AGE_MS = 10_000;
const SAMPLE_WEIGHT = 0.25;
const DOWNGRADE_FPS = 10;
const UPGRADE_FPS = 12;
/** Interactions form a burst until the first 400 ms of silence. */
export const SIDEBAR_INTERACTION_IDLE_MS = 400;

export function sidebarBrowserReduced(
  now: number,
  lastInput: number,
  reduced: boolean,
  fullFrameBytes: number | undefined,
  visibleRates: readonly (number | undefined)[],
): boolean {
  if (fullFrameBytes === undefined || now - lastInput >= SIDEBAR_INTERACTION_IDLE_MS) return false;
  const target = fullFrameBytes * (reduced ? UPGRADE_FPS : DOWNGRADE_FPS);
  return visibleRates.some((rate) => rate !== undefined && rate < target);
}

export class SidebarBrowserDelivery {
  private busySince: number | undefined;
  private pipelined = false;
  private bytes = 0;
  private duration = 0;
  private sample: { rate: number; at: number } | undefined;

  sent(now: number): void {
    if (this.busySince === undefined) {
      this.busySince = now;
      this.pipelined = false;
    } else {
      this.pipelined = true;
    }
  }

  acknowledged(now: number, bytes: number, remaining: boolean, spareSlot = false): void {
    if (this.busySince === undefined) return;
    // Ignore idle gaps. An isolated probe with room for two cannot measure a full window;
    // use its optimistic capacity until there is a pipelined sample.
    const capacity = !this.pipelined && spareSlot ? 2 : 1;
    this.duration += (now - this.busySince) / capacity;
    this.bytes += bytes;
    this.busySince = remaining ? now : undefined;
    if (this.duration < SAMPLE_MS) return;
    const rate = (1000 * this.bytes) / this.duration;
    const previous = this.recentRate(now) ?? rate;
    this.sample = { rate: previous + SAMPLE_WEIGHT * (rate - previous), at: now };
    this.bytes = this.duration = 0;
  }

  rate(now: number, outstandingBytes: number, spareSlot = false): number | undefined {
    const recent = this.recentRate(now);
    const waiting = this.busySince === undefined ? 0 : now - this.busySince;
    // A stalled relay need not return an ACK before we can see the slowdown.
    if (waiting < SAMPLE_MS || outstandingBytes === 0) return recent;
    const capacity = !this.pipelined && spareSlot ? 2 : 1;
    return Math.min(recent ?? Infinity, (1000 * outstandingBytes * capacity) / waiting);
  }

  private recentRate(now: number): number | undefined {
    return this.sample !== undefined && now - this.sample.at < SAMPLE_MAX_AGE_MS
      ? this.sample.rate
      : undefined;
  }
}
