/** Browser-owned PWA installation, captured before asynchronous plugin loading. */
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Optional browser-shell service, absent in native Desktop carriers. */
    pwaInstall: PwaInstall;
  }
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type PwaInstallState =
  "manual" | "available" | "prompting" | "accepted" | "dismissed" | "failed" | "installed";

export type PwaInstallGuide = "insecure" | "ios" | "android" | "safari" | "browser";

/** UA detection selects help text only; installability comes from browser events. */
export function pwaInstallGuide(browser: Window): PwaInstallGuide {
  if (!browser.isSecureContext) return "insecure";
  const { userAgent, maxTouchPoints } = browser.navigator;
  if (/iPad|iPhone|iPod/u.test(userAgent) || (/Macintosh/u.test(userAgent) && maxTouchPoints > 1))
    return "ios";
  if (/Android/u.test(userAgent)) return "android";
  if (
    /Macintosh/u.test(userAgent) &&
    /Safari/u.test(userAgent) &&
    !/Chrome|Chromium|Edg|OPR/u.test(userAgent)
  )
    return "safari";
  return "browser";
}

export class PwaInstall {
  readonly store = createSnapshotStore<PwaInstallState>("manual");
  readonly guide: PwaInstallGuide;
  private pending: InstallPromptEvent | undefined;
  private live = true;
  private installationConfirmed = false;
  private readonly standalone: MediaQueryList;

  constructor(private readonly browser: Window) {
    this.guide = pwaInstallGuide(browser);
    this.standalone = browser.matchMedia("(display-mode: standalone)");
    this.onDisplayMode();
    browser.addEventListener("beforeinstallprompt", this.onPrompt);
    browser.addEventListener("appinstalled", this.onInstalled);
    this.standalone.addEventListener("change", this.onDisplayMode);
  }

  private readonly onPrompt = (event: Event): void => {
    if (!this.browser.isSecureContext || this.store.getSnapshot() === "installed") return;
    const prompt = event as InstallPromptEvent;
    if (typeof prompt.prompt !== "function" || prompt.userChoice === undefined) return;
    event.preventDefault();
    this.pending = prompt;
    if (this.store.getSnapshot() !== "prompting") this.store.set("available");
  };

  private readonly onInstalled = (): void => {
    this.installationConfirmed = true;
    this.pending = undefined;
    this.store.set("installed");
  };

  private readonly onDisplayMode = (): void => {
    const iosStandalone = (this.browser.navigator as Navigator & { standalone?: boolean })
      .standalone;
    if (this.installationConfirmed || this.standalone.matches || iosStandalone === true) {
      this.pending = undefined;
      this.store.set("installed");
    } else if (this.store.getSnapshot() === "installed") {
      this.store.set("manual");
    }
  };

  /** Must be called directly from a user gesture, before any asynchronous work. */
  async install(): Promise<void> {
    if (!this.live || this.pending === undefined || this.store.getSnapshot() === "prompting")
      return;
    const event = this.pending;
    // Each browser prompt event is single-use, including cancellation or failure.
    this.pending = undefined;
    this.store.set("prompting");
    let result: PwaInstallState;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      result = choice.outcome;
    } catch {
      result = "failed";
    }
    if (!this.live || this.store.getSnapshot() === "installed") return;
    this.store.set(this.pending === undefined ? result : "available");
  }

  dispose(): void {
    this.live = false;
    this.pending = undefined;
    this.browser.removeEventListener("beforeinstallprompt", this.onPrompt);
    this.browser.removeEventListener("appinstalled", this.onInstalled);
    this.standalone.removeEventListener("change", this.onDisplayMode);
  }
}
