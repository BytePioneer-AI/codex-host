/** Localized copy adapters for Cordis-free Markdown primitives. */

import type {
  MarkdownLabels,
  ResponseAnnotationLabels,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps } from "./contract/slots.ts";

/**
 * Build the complete Markdown chrome copy for one locale revision.
 * @param t - Chat locale seat.
 * @returns Labels for code fences and footnotes.
 */
export function markdownLabels(t: ChatViewSlotProps["t"]): MarkdownLabels {
  return {
    code: {
      copyLabel: t("copy"),
      copiedLabel: t("copied"),
      toolbarLabels: {
        codeLabel: t("codeBlock.title"),
        wrapLabel: t("codeBlock.wrap"),
        unwrapLabel: t("codeBlock.unwrap"),
      },
    },
    footnotes: t("markdown.footnotes"),
  };
}

/**
 * Build the response-annotation copy for one locale revision.
 * @param t - Chat locale seat.
 * @returns Labels for the annotation chip, its card, and a reply's citation.
 */
export function annotationLabels(t: ChatViewSlotProps["t"]): ResponseAnnotationLabels {
  return {
    label: (index) => t("annotation.label", { index }),
    railLabel: (index) => t("annotation.chipLabel", { index }),
    railTitle: (index, excerpt) => t("annotation.title", { index, excerpt }),
    remove: (index) => t("annotation.remove", { index }),
    selectedText: t("annotation.selectedText"),
    userComment: t("annotation.userComment"),
  };
}
