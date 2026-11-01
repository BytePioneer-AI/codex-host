/** A single ephemeral preview; requesting it never modifies a draft or calls a Harness. */
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import {
  isDesktopScreenshotError,
  type DesktopScreenshotErrorCode,
} from "@codexhost/shared-contracts/desktop-screenshot";

/** Transfer progress; present only after the Host finished capturing. */
export interface DesktopScreenshotProgress {
  readonly loaded: number;
  /** Absent when the response carries no usable length. */
  readonly total: number | undefined;
}

export interface DesktopScreenshotState {
  readonly sessionId: string | undefined;
  readonly pending: boolean;
  /** `Date.now()` when the current attempt began; undefined while idle. */
  readonly startedAt: number | undefined;
  /** Undefined while the Host is still capturing; defined while the image downloads. */
  readonly progress: DesktopScreenshotProgress | undefined;
  readonly image: { readonly url: string; readonly capturedAt: string } | undefined;
  readonly error: DesktopScreenshotErrorCode | undefined;
}

const EMPTY: DesktopScreenshotState = {
  sessionId: undefined,
  pending: false,
  startedAt: undefined,
  progress: undefined,
  image: undefined,
  error: undefined,
};

/** Earliest a press restarts a running attempt. */
const RESTART_AFTER_MS = 3000;

export class DesktopScreenshot {
  private readonly store = createSnapshotStore<DesktopScreenshotState>(EMPTY);
  private request: AbortController | undefined;

  constructor(
    private readonly capture: (
      signal: AbortSignal,
      onProgress: (progress: DesktopScreenshotProgress) => void,
    ) => Promise<{ image: Blob; capturedAt: string }>,
  ) {}

  getSnapshot = (): DesktopScreenshotState => this.store.getSnapshot();
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  refresh = async (sessionId: string): Promise<void> => {
    // A press during a running attempt restarts it, so repeated taps on a
    // stalled link start fresh requests instead of being swallowed. Presses
    // within the first moments are double-taps and keep the attempt.
    const running = this.request;
    if (running !== undefined) {
      const startedAt = this.getSnapshot().startedAt ?? 0;
      if (Date.now() - startedAt < RESTART_AFTER_MS) return;
      this.request = undefined;
      running.abort();
    }
    if (this.getSnapshot().sessionId !== sessionId) this.close();
    const request = new AbortController();
    this.request = request;
    this.store.set({
      ...this.getSnapshot(),
      sessionId,
      pending: true,
      startedAt: Date.now(),
      progress: undefined,
      error: undefined,
    });
    try {
      const result = await this.capture(request.signal, (progress) => {
        if (this.request === request) this.store.set({ ...this.getSnapshot(), progress });
      });
      if (this.request !== request || request.signal.aborted) return;
      const old = this.getSnapshot().image;
      const image = { url: URL.createObjectURL(result.image), capturedAt: result.capturedAt };
      this.store.set({
        sessionId,
        pending: false,
        startedAt: undefined,
        progress: undefined,
        image,
        error: undefined,
      });
      if (old !== undefined) URL.revokeObjectURL(old.url);
    } catch (error) {
      if (this.request !== request || request.signal.aborted) return;
      const code = error instanceof Error ? error.message : error;
      this.store.set({
        ...this.getSnapshot(),
        pending: false,
        startedAt: undefined,
        progress: undefined,
        error: isDesktopScreenshotError(code) ? code : "unavailable",
      });
    } finally {
      if (this.request === request) this.request = undefined;
    }
  };

  /** Abandon the in-flight request, keeping any earlier image. */
  cancel = (): void => {
    const request = this.request;
    if (request === undefined) return;
    this.request = undefined;
    request.abort();
    this.store.set({
      ...this.getSnapshot(),
      pending: false,
      startedAt: undefined,
      progress: undefined,
    });
  };

  close = (sessionId?: string): void => {
    if (sessionId !== undefined && this.getSnapshot().sessionId !== sessionId) return;
    const request = this.request;
    this.request = undefined;
    request?.abort();
    const old = this.getSnapshot().image;
    this.store.set(EMPTY);
    if (old !== undefined) URL.revokeObjectURL(old.url);
  };
}
