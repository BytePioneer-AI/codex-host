import type { SidebarBrowserFrameFormat } from "@codexhost/shared-contracts/sidebar-browser";
import { SIDEBAR_INTERACTION_IDLE_MS, sidebarBrowserReduced } from "./sidebar-browser-delivery.ts";

export type SidebarPictureMode = "full" | "reduced" | "motion";
export const SIDEBAR_MOTION_JPEG_QUALITY = 80;
export const SIDEBAR_MOTION_MAX_FPS = 30;

const MOTION_FRAME_BYTES = 384 * 1024;
const MOTION_BYTES_PER_PIXEL = 0.4;
const MOTION_MIN_FRAMES = 5;
const MOTION_MIN_MS = 100;
const MOTION_MAX_GAP_MS = 150;
const MOTION_MIN_REPLACEMENTS = 2;
const MOTION_IDLE_MS = SIDEBAR_INTERACTION_IDLE_MS;

interface PictureSample {
  readonly at: number;
  readonly bytes: number;
  readonly pixels: number;
  readonly changed: boolean;
  readonly replacedPending: boolean;
}

/** One quality decision per tab. All times are monotonic and supplied by the caller. */
export class SidebarBrowserQualitySelection {
  mode: SidebarPictureMode = "full";
  private lastInput = -Infinity;
  private fullBytes: number | undefined;
  private motionBytes: number | undefined;
  private motionSince = -Infinity;
  private lastMotion = -Infinity;
  private motionFrames = 0;
  private replacements = 0;

  constructor(private readonly normalFormat: SidebarBrowserFrameFormat) {}

  input(at: number): void {
    this.lastInput = at;
  }

  static isMotionCandidate(bytes: number, pixels: number): boolean {
    return bytes >= Math.max(MOTION_FRAME_BYTES, pixels * MOTION_BYTES_PER_PIXEL);
  }

  size(bytes: number): void {
    if (this.mode === "full") this.fullBytes = smooth(this.fullBytes, bytes);
    else if (this.mode === "motion") this.motionBytes = smooth(this.motionBytes, bytes);
  }

  picture({ at, bytes, pixels, changed, replacedPending }: PictureSample): void {
    this.size(bytes);
    if (this.mode === "reduced") return;
    if (this.mode === "motion") {
      if (changed) this.lastMotion = at;
      return;
    }
    // Expensive, distinct PNGs plus actual queue pressure are the motion signal. Encoded size
    // is a proxy for detail, not an estimate of the percentage of pixels that changed.
    if (
      this.normalFormat !== "png" ||
      !SidebarBrowserQualitySelection.isMotionCandidate(bytes, pixels)
    ) {
      this.clearMotion();
      return;
    }
    if (!changed) return;
    if (at - this.lastMotion > MOTION_MAX_GAP_MS) this.clearMotion();
    if (this.motionFrames++ === 0) this.motionSince = at;
    if (replacedPending) this.replacements++;
    this.lastMotion = at;
  }

  update(now: number, visibleRates: readonly (number | undefined)[]): SidebarPictureMode {
    const { mode } = this;
    if (mode === "motion" && now >= this.lastMotion + MOTION_IDLE_MS) {
      this.clearMotion();
      this.lastInput = -Infinity;
      this.mode = "full";
      return this.mode; // Refresh the stopped picture at full resolution.
    }
    if (
      mode === "full" &&
      now - this.lastMotion <= MOTION_MAX_GAP_MS &&
      this.lastMotion - this.motionSince >= MOTION_MIN_MS &&
      this.motionFrames >= MOTION_MIN_FRAMES &&
      this.replacements >= MOTION_MIN_REPLACEMENTS
    ) {
      this.mode = "motion";
      return this.mode;
    }

    const bytes = mode === "motion" ? this.motionBytes : this.fullBytes;
    if (sidebarBrowserReduced(now, this.lastInput, mode === "reduced", bytes, visibleRates)) {
      this.clearMotion();
      this.mode = "reduced";
      return this.mode;
    }
    if (mode === "reduced") this.mode = "full";
    return this.mode;
  }

  get deadline(): number | undefined {
    if (this.mode === "motion") return this.lastMotion + MOTION_IDLE_MS;
    if (this.mode === "reduced") return this.lastInput + SIDEBAR_INTERACTION_IDLE_MS;
    return undefined;
  }

  private clearMotion(): void {
    this.motionSince = this.lastMotion = -Infinity;
    this.motionFrames = this.replacements = 0;
    this.motionBytes = undefined;
  }
}

function smooth(previous: number | undefined, bytes: number): number {
  const average = previous ?? bytes;
  return average + (bytes - average) / 4;
}
