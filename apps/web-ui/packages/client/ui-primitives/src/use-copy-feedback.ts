import { useCallback, useState } from "react";
import { writeClipboard } from "./clipboard.ts";

/** How long the `copied` flag stays true after a successful write, in ms. */
const COPIED_FEEDBACK_MS = 1000;

/** The copy-feedback hook's return: the transient flag and the copy handler. */
export interface CopyFeedback {
  /** True for {@link COPIED_FEEDBACK_MS} after a successful write; render the success label off it. */
  copied: boolean;
  /** Copy the hook's text; no-op while `copied` is still true, silent on a refused write. */
  onCopy: () => void;
}

/**
 * Copy `text` to the clipboard with one-second success feedback.
 * @param text - the text to write on copy.
 * @returns the `copied` flag and the `onCopy` handler.
 */
export function useCopyFeedback(text: string | (() => Promise<string>)): CopyFeedback {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    if (copied) return;
    void (async () => {
      try {
        const value = typeof text === "function" ? await text() : text;
        if (!(await writeClipboard(value))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      } catch {
        // Async text owners present loading and read failures at the source card.
        return;
      }
    })();
  }, [copied, text]);
  return { copied, onCopy };
}
