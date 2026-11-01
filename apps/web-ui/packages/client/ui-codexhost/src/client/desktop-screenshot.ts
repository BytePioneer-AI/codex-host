/** A single ephemeral preview; requesting it never modifies a draft or calls a Harness. */
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import {
  isDesktopScreenshotError,
  type DesktopScreenshotErrorCode,
} from "@codexhost/shared-contracts/desktop-screenshot";

export interface DesktopScreenshotState {
  readonly sessionId: string | undefined;
  readonly pending: boolean;
  readonly image: { readonly url: string; readonly capturedAt: string } | undefined;
  readonly error: DesktopScreenshotErrorCode | undefined;
}

const EMPTY: DesktopScreenshotState = {
  sessionId: undefined,
  pending: false,
  image: undefined,
  error: undefined,
};

export class DesktopScreenshot {
  private readonly store = createSnapshotStore<DesktopScreenshotState>(EMPTY);
  private request: AbortController | undefined;

  constructor(
    private readonly capture: (signal: AbortSignal) => Promise<{ image: Blob; capturedAt: string }>,
  ) {}

  getSnapshot = (): DesktopScreenshotState => this.store.getSnapshot();
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  refresh = async (sessionId: string): Promise<void> => {
    if (this.request !== undefined) return;
    if (this.getSnapshot().sessionId !== sessionId) this.close();
    const request = new AbortController();
    this.request = request;
    this.store.set({ ...this.getSnapshot(), sessionId, pending: true, error: undefined });
    try {
      const result = await this.capture(request.signal);
      if (this.request !== request || request.signal.aborted) return;
      const old = this.getSnapshot().image;
      const image = { url: URL.createObjectURL(result.image), capturedAt: result.capturedAt };
      this.store.set({ sessionId, pending: false, image, error: undefined });
      if (old !== undefined) URL.revokeObjectURL(old.url);
    } catch (error) {
      if (this.request !== request || request.signal.aborted) return;
      const code = error instanceof Error ? error.message : error;
      this.store.set({
        ...this.getSnapshot(),
        pending: false,
        error: isDesktopScreenshotError(code) ? code : "unavailable",
      });
    } finally {
      if (this.request === request) this.request = undefined;
    }
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
