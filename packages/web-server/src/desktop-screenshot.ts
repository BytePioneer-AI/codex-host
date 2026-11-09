/** One-shot native capture; main.ts owns the existing authentication and same-origin gates. */
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DESKTOP_SCREENSHOT_TIME_HEADER,
  isDesktopScreenshotError,
  type DesktopScreenshotErrorCode,
} from "@codexhost/shared-contracts/desktop-screenshot";
import { inspectImage, WEB_IMAGE_LIMITS } from "./web-images.ts";

const STATUS: Record<DesktopScreenshotErrorCode, number> = {
  unsupported: 501,
  "permission-denied": 403,
  "display-unavailable": 409,
  "capture-failed": 502,
  "image-too-large": 413,
  busy: 429,
  timeout: 504,
  unavailable: 503,
};

/** The trusted command is installation-owned, never read from the browser request. */
export class DesktopScreenshots {
  private active: AbortController | undefined;
  private closed = false;

  constructor(
    private readonly command: readonly [string, ...string[]],
    private readonly timeoutMs = 15_000,
  ) {}

  close(): void {
    this.closed = true;
    this.active?.abort();
  }

  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const fail = (error: DesktopScreenshotErrorCode) => {
      if (!response.destroyed)
        response
          .writeHead(STATUS[error], { "content-type": "application/json" })
          .end(JSON.stringify({ error }));
    };
    if (this.closed || this.active !== undefined) {
      request.resume();
      fail(this.closed ? "unavailable" : "busy");
      return;
    }
    const controller = new AbortController();
    this.active = controller;
    const disconnected = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", disconnected);
    if (response.destroyed) controller.abort();
    // This endpoint takes no arguments, file paths, or body data.
    request.resume();
    try {
      const image = await this.capture(controller.signal);
      if (!response.destroyed)
        response
          .writeHead(200, {
            "content-type": "image/png",
            "content-length": image.length,
            [DESKTOP_SCREENSHOT_TIME_HEADER]: new Date().toISOString(),
          })
          .end(image);
    } catch (error) {
      fail(isDesktopScreenshotError(error) ? error : "capture-failed");
    } finally {
      this.active = undefined;
      response.off("close", disconnected);
    }
  }

  private capture(signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject("capture-failed");
        return;
      }
      const [executable, ...prefix] = this.command;
      const child = spawn(executable, [...prefix, "desktop-screenshot"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = "";
      let failure: DesktopScreenshotErrorCode | undefined;
      const stop = (error: DesktopScreenshotErrorCode) => {
        failure ??= error;
        chunks.length = 0;
        child.kill("SIGKILL");
      };
      const abort = () => stop("capture-failed");
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => stop("timeout"), this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure !== undefined) return;
        bytes += chunk.length;
        if (bytes > WEB_IMAGE_LIMITS.maxImageBytes) stop("image-too-large");
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 2048) stderr += chunk.toString("utf8").slice(0, 2048 - stderr.length);
      });
      child.once("error", () => {
        failure ??= "unavailable";
      });
      // Keep the concurrency lease until the native process and its pipes have actually closed.
      child.once("close", (code) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        if (code !== 0) {
          const native = /desktop-screenshot\/([a-z-]+)/u.exec(stderr)?.[1];
          reject(isDesktopScreenshotError(native) ? native : "capture-failed");
          return;
        }
        try {
          const image = Buffer.concat(chunks, bytes);
          const inspected = inspectImage(image);
          if (inspected.ref.mediaType !== "image/png") throw new Error("Unexpected image type");
          resolve(image);
        } catch {
          reject("capture-failed");
        }
      });
    });
  }
}
