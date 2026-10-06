import { h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type { ConsoleOverview } from "../state.js";
import { createRendererSettingsIcon } from "../../settings/icons.js";

/** Export and report actions at the end of the overview. */
export function mountReportActions(
  document: Document,
  messages: ConsoleMessages,
  overview: ConsoleOverview,
): HTMLElement {
  const exportLink = h(
    document,
    "a",
    {
      className: "settings-command-button settings-command-button--secondary",
      href: "/api/diagnostics/export",
      download: "codexhost-diagnostics.json",
    },
    createRendererSettingsIcon("download", 14),
    messages.exportDiagnostics,
  );
  const issueLink = h(
    document,
    "a",
    {
      className: "settings-command-button settings-command-button--secondary",
      href: overview.issueUrl,
      target: "_blank",
      rel: "noopener noreferrer",
    },
    createRendererSettingsIcon("github", 14),
    messages.reportIssue,
  );
  return h(
    document,
    "section",
    { className: "console-panel" },
    h(document, "div", { className: "console-actions" }, exportLink, issueLink),
  );
}
