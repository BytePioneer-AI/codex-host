import { consolePost } from "../api.js";
import { button, h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type { ConsoleState } from "../state.js";
import { createRendererSettingsIcon } from "../../settings/icons.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";
import { mountReportActions } from "./report-actions.js";
import { renderStartupDiagnostics } from "./diagnostics.js";

export function createOverviewPage(
  messages: ConsoleMessages,
  state: ConsoleState,
  navigate: (pageId: string) => void,
  locale: string,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "overview",
    label: messages.overview,
    icon: "dashboard" as const,
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      let daemonAction: "start" | "stop" | "restart" | null = null;
      const runDaemonAction = (action: "start" | "stop" | "restart"): void => {
        daemonAction = action;
        render();
        void consolePost(`/api/daemon/${action}`)
          .catch(() => undefined)
          .finally(() => {
            daemonAction = null;
            void state.refresh();
          });
      };
      const render = (): void => {
        const overview = state.overview;
        if (!overview) return;
        const actions = h(document, "div", { className: "console-actions" });
        if (state.update?.updateAvailable) {
          actions.append(
            button(document, `${messages.viewUpdate} · ${state.update.latestVersion ?? ""}`, () =>
              navigate("updates"),
            ),
          );
        }

        const distribution = overview.console.distribution;
        const installation = distribution
          ? distribution.distribution === "npm"
            ? messages.npm
            : messages.installer
          : messages.source;
        const desktop = overview.inspect?.desktop;
        const version = distribution?.version ?? overview.console.version;
        const versionFacts = [
          [messages.hostVersion, version === "source" ? messages.development : version],
          [messages.desktopVersion, desktop?.version ?? messages.missing],
          [messages.installationType, installation],
        ];
        const versions = h(
          document,
          "dl",
          { className: "console-versions" },
          ...versionFacts.map(([label, value]) =>
            h(
              document,
              "div",
              { className: "console-version-card" },
              h(document, "dt", {}, label),
              h(document, "dd", {}, value),
            ),
          ),
        );

        const daemon = overview.daemon;
        const daemonActions = h(document, "div", { className: "console-actions" });
        if (daemon.running) {
          const restart = button(
            document,
            daemonAction === "restart" ? "Restarting…" : "Restart daemon",
            () => runDaemonAction("restart"),
          );
          const stop = button(document, daemonAction === "stop" ? "Stopping…" : "Stop daemon", () =>
            runDaemonAction("stop"),
          );
          restart.disabled = daemonAction !== null;
          stop.disabled = daemonAction !== null;
          daemonActions.append(restart, stop);
        } else {
          const startDaemon = button(
            document,
            daemonAction === "start" ? "Starting…" : "Start daemon",
            () => runDaemonAction("start"),
            "primary",
          );
          startDaemon.disabled = daemonAction !== null;
          daemonActions.append(startDaemon);
        }
        const daemonCard = h(
          document,
          "section",
          { className: "console-hero", "data-tone": daemon.running ? "ok" : "info" },
          h(
            document,
            "div",
            { className: "console-hero__icon" },
            createRendererSettingsIcon(daemon.running ? "check" : "play", 20),
          ),
          h(
            document,
            "div",
            { className: "console-hero__copy" },
            h(
              document,
              "div",
              { className: "console-hero__title" },
              daemon.running ? "Daemon running" : "Daemon stopped",
            ),
            h(
              document,
              "div",
              { className: "console-hero__detail" },
              daemon.running
                ? [daemon.pid && `PID ${daemon.pid}`, daemon.port && `port ${daemon.port}`]
                    .filter(Boolean)
                    .join(" · ")
                : (daemon.error ?? "External UI and Harness sessions are not running."),
            ),
          ),
          daemonActions,
        );

        context.content.replaceChildren(
          h(document, "h1", { className: "settings-section-label" }, messages.overview),
          versions,
          ...(actions.childElementCount > 0 ? [actions] : []),
          h(document, "h2", { className: "console-section-title" }, "Daemon"),
          daemonCard,
          ...renderStartupDiagnostics(document, messages, overview, locale),
          h(document, "h2", { className: "console-section-title" }, messages.quickActions),
          mountReportActions(document, messages, overview),
        );
      };
      render();
      return state.subscribe(render);
    },
  });
}
