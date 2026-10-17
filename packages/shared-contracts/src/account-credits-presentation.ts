import { localizeHarnessPresentation } from "./harness-presentation.js";
import type { AccountCreditsSnapshot } from "./thread-usage.js";

type CreditsWindow = {
  [K in "label" | "periodType" | "scope" | "localizations"]?: AccountCreditsSnapshot[K] | undefined;
} & { product?: string | undefined };

/** Shared by clients; never parses product names or recognizes a Harness ID. */
export function accountCreditsWindowLabel(
  window: CreditsWindow,
  locale: string,
  periodLabel: (period: AccountCreditsSnapshot["periodType"]) => string,
): string {
  if (window.periodType && window.periodType !== "unknown" && (window.scope || !window.label)) {
    const period = periodLabel(window.periodType);
    return window.scope
      ? `${localizeHarnessPresentation(window.scope, locale).label} · ${period}`
      : period;
  }
  return localizeHarnessPresentation(
    {
      label: window.label ?? window.product ?? periodLabel("unknown"),
      ...(window.localizations ? { localizations: window.localizations } : {}),
    },
    locale,
  ).label;
}
