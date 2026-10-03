import type { HarnessLocalPage } from "@codexhost/harness-adapter/plugin";
import { ZcodeError } from "../errors.js";
import { createCaptchaConfigSource, type CaptchaConfig } from "./config.js";
import { writeVerification, type VerificationRecord } from "./diagnostics.js";
import {
  DEFAULT_TIMING,
  openVerificationPage,
  type VerificationPage,
  type VerificationTiming,
} from "./page.js";

export interface ZcodeVerifier {
  /** One fresh proof per Start Plan model request; proofs are single-use and never cached. */
  verify(signal: AbortSignal): Promise<Record<string, string>>;
  /**
   * Opens the resident page and initializes the SDK when verification is enabled, without
   * verifying. Failure only leaves the page unavailable; the next `verify` reopens it.
   */
  prewarm(): void;
  close(): Promise<void>;
}

export interface ZcodeVerifierOptions {
  openLocalPage?: (url: string) => Promise<HarnessLocalPage>;
  /** The installed ZCode.app version, reported to the client configuration service. */
  appVersion: string;
  /** Test and experiment seam; defaults follow ZCode Desktop. */
  timing?: Partial<VerificationTiming>;
}

const sameInstance = (a: CaptchaConfig, b: CaptchaConfig): boolean =>
  a.region === b.region && a.prefix === b.prefix && a.sceneId === b.sceneId;

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    else signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
}

/**
 * The Host's verifier, shared by every ZCode Session like Desktop's single SDK instance: one
 * resident background page, and one queue that runs requests from all Sessions in order. Each
 * request is cancelled only by its own signal; the page belongs to the verifier's lifetime.
 */
export function createZcodeVerifier(options: ZcodeVerifierOptions): ZcodeVerifier {
  const captchaConfig = createCaptchaConfigSource(options.appVersion);
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  let pages = 0;
  const lifetime = new AbortController();
  let page: VerificationPage | undefined;
  let opening: Promise<VerificationPage> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;

  // Opening is not tied to the request that asked first, so a cancelled Session cannot discard
  // the page another Session is about to use.
  const ensurePage = (
    config: CaptchaConfig,
    openLocalPage: NonNullable<ZcodeVerifierOptions["openLocalPage"]>,
  ): Promise<VerificationPage> => {
    // A prewarm can finish reading configuration after close(); it must not open a page then.
    if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason as Error);
    if (page && !page.closed && sameInstance(page.config, config)) return Promise.resolve(page);
    opening ??= (async () => {
      const stale = page;
      page = undefined;
      await stale?.close();
      page = await openVerificationPage(config, openLocalPage, lifetime.signal, ++pages, timing);
      return page;
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  };

  const verifyNow = async (
    signal: AbortSignal,
    record: VerificationRecord,
  ): Promise<Record<string, string>> => {
    const config = await captchaConfig(signal);
    if (!config) {
      record.result = "not_required";
      return {};
    }
    if (!options.openLocalPage)
      throw new ZcodeError(
        "unavailable",
        "ZCode Start Plan verification requires the local Codex in-app browser",
      );
    const openStarted = Date.now();
    const current = await Promise.race([
      ensurePage(config, options.openLocalPage),
      whenAborted(signal),
    ]);
    record.openMs = Date.now() - openStarted;
    const proof = await current.verify(signal, record);
    return {
      "X-Aliyun-Captcha-Verify-Param": proof,
      "X-Aliyun-Captcha-Verify-Region": config.region,
    };
  };

  return {
    verify(signal) {
      const combined = AbortSignal.any([signal, lifetime.signal]);
      const previous = queue;
      const aborted = whenAborted(combined);
      void aborted.catch(() => undefined);
      const requestedAt = Date.now();
      const record: VerificationRecord = { sdk: [], shown: false };
      const run = Promise.race([previous, aborted])
        .then(() => {
          record.queueMs = Date.now() - requestedAt;
          return verifyNow(combined, record);
        })
        .finally(() => {
          // Requests that never reached a page still get a line.
          record.result ??= combined.aborted ? "cancelled" : "error";
          record.totalMs = Date.now() - requestedAt;
          writeVerification(record);
        });
      // The next task waits for this one and for everything queued before it.
      queue = run.then(
        () => previous,
        () => previous,
      );
      return run;
    },
    prewarm() {
      const openLocalPage = options.openLocalPage;
      if (!openLocalPage || lifetime.signal.aborted) return;
      void captchaConfig(lifetime.signal)
        .then((config) => config && ensurePage(config, openLocalPage))
        .catch(() => undefined);
    },
    close() {
      closing ??= (async () => {
        lifetime.abort(new ZcodeError("unavailable", "ZCode verification closed"));
        await queue;
        await opening?.catch(() => undefined);
        await page?.close();
      })();
      return closing;
    },
  };
}
