import type { CDPSession } from "playwright-core";
import type { SidebarBrowserFrameFormat } from "@codexhost/shared-contracts/sidebar-browser";
import {
  SIDEBAR_MOTION_JPEG_QUALITY,
  SIDEBAR_MOTION_MAX_FPS,
  SidebarBrowserQualitySelection,
  type SidebarPictureMode,
} from "./sidebar-browser-quality.ts";

/**
 * Acknowledgements are paced at full frame rate while the picture changes, and back off to at
 * most this gap while the page is static, so idle Chrome stops re-encoding identical frames.
 */
const IDLE_ACK_MAX_MS = 500;

/** Screencast limits; the browser is launched at deviceScale before per-cast downscaling. */
export interface SidebarBrowserQuality {
  readonly format: SidebarBrowserFrameFormat;
  readonly jpegQuality: number;
  readonly maxFps: number;
  readonly deviceScale: number;
  readonly maxPixels: number;
}

export const DEFAULT_SIDEBAR_BROWSER_QUALITY: SidebarBrowserQuality = {
  format: "png",
  jpegQuality: 85,
  maxFps: 30,
  deviceScale: 2,
  maxPixels: 3200,
};

export interface SidebarBrowserViewport {
  readonly width: number;
  readonly height: number;
}

export class SidebarBrowserCast {
  readonly format: SidebarBrowserFrameFormat;
  private readonly jpegQuality: number;
  private readonly scale: number;
  private readonly width: number;
  private readonly height: number;
  private readonly interval: number;
  private lastAck = -Infinity;
  private nextAck = -Infinity;
  private lastSlot = -Infinity;
  private lastPicture: string | undefined;
  private idleSteps = 0;

  constructor(
    readonly cdp: CDPSession,
    readonly viewport: SidebarBrowserViewport,
    readonly mode: SidebarPictureMode,
    private readonly quality: SidebarBrowserQuality,
  ) {
    this.format = mode === "motion" ? "jpeg" : quality.format;
    this.jpegQuality = mode === "motion" ? SIDEBAR_MOTION_JPEG_QUALITY : quality.jpegQuality;
    this.scale = Math.min(
      mode === "reduced" ? 1 : quality.deviceScale,
      quality.maxPixels / Math.max(viewport.width, viewport.height),
    );
    this.width = Math.round(viewport.width * this.scale);
    this.height = Math.round(viewport.height * this.scale);
    this.interval =
      1000 /
      (mode === "motion" ? Math.min(quality.maxFps, SIDEBAR_MOTION_MAX_FPS) : quality.maxFps);
  }

  start(): Promise<boolean> {
    return this.cdp
      .send("Page.startScreencast", {
        format: this.format,
        quality: this.jpegQuality,
        maxWidth: this.width,
        maxHeight: this.height,
        everyNthFrame: 1,
      })
      .then(
        () => true,
        () => false,
      );
  }

  async stop(control: CDPSession): Promise<void> {
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    if (this.cdp !== control) await this.cdp.detach().catch(() => undefined);
  }

  snapshot(control: CDPSession): Promise<{ data: string }> {
    return control.send("Page.captureScreenshot", {
      format: this.format,
      ...(this.format === "jpeg" ? { quality: this.jpegQuality } : {}),
      ...(this.scale < this.quality.deviceScale
        ? { clip: { x: 0, y: 0, ...this.viewport, scale: this.scale / this.quality.deviceScale } }
        : {}),
    });
  }

  sample(data: string, bytes: number, at: number, hasPending: () => boolean) {
    const pixels = this.width * this.height;
    const largePng =
      this.mode === "full" &&
      this.format === "png" &&
      SidebarBrowserQualitySelection.isMotionCandidate(bytes, pixels);
    const compare = this.mode === "motion" || largePng;
    const changed = compare && data !== this.lastPicture;
    this.lastPicture = compare ? data : undefined;
    return {
      at,
      bytes,
      pixels,
      changed,
      replacedPending: largePng && changed && hasPending(),
      compared: compare,
    };
  }

  allowPicture(now: number): boolean {
    if (this.mode !== "motion") return true;
    // Chrome may deliver several already-encoded frames together. Admit one per time slot,
    // including any explicitly requested snapshots.
    const slot = Math.floor(now / this.interval);
    if (slot <= this.lastSlot) return false;
    this.lastSlot = slot;
    return true;
  }

  /** Fresh input or motion ends idle pacing immediately. */
  resetPace(): void {
    this.idleSteps = 0;
  }

  acknowledge(sessionId: number, now: number, current: () => boolean, changed = true): void {
    // Chrome re-captures and re-encodes after every acknowledgement, so a static page would keep
    // the encoder busy at full frame rate. Back off when consecutive frames are identical and
    // resume the base pace as soon as the picture changes again.
    const idle = this.mode !== "motion" || !changed;
    if (changed) this.idleSteps = 0;
    else this.idleSteps++;
    const gap = idle
      ? Math.min(this.interval * 2 ** (this.idleSteps - 1), IDLE_ACK_MAX_MS)
      : this.interval;
    // Reserve separate ACK times in motion mode to pace Chrome's encodes, not just delivery.
    const due = Math.max(now, this.mode === "motion" ? this.nextAck : this.lastAck + gap);
    this.nextAck = due + gap;
    setTimeout(() => {
      if (!current()) return;
      this.lastAck = performance.now();
      void this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    }, due - now);
  }
}
