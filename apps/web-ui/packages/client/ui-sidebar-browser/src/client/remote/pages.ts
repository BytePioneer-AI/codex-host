/** Assemble a streamed tab behind the shared BrowserPage interface. */
import type { BrowserPage, BrowserPageOptions } from "../browser/BrowserPage.ts";
import { RemoteFrame } from "./RemoteFrame.ts";
import { RemotePresentation } from "./RemotePresentation.ts";

/**
 * @param options - checkpoint, persistence and window-opening callbacks.
 * @param key - server-side tab identity, stable for this sidebar tab across reloads.
 * @param inputLabel - accessible name of the keyboard focus target.
 * @returns the streamed page's navigation and canvas presentation.
 */
export function createRemotePage(
  options: BrowserPageOptions,
  key: string,
  inputLabel: string,
): BrowserPage {
  const presentation = new RemotePresentation((message) => {
    frame.send(message);
  }, inputLabel);
  const frame = new RemoteFrame(options, key, presentation);
  return { frame, presentation };
}
