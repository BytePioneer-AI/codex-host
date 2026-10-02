import { consolePost } from "../api.js";
import { button, h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type { ConsoleOverview, ConsoleState } from "../state.js";
import { createRendererSettingsIcon, type RendererSettingsIconName } from "../../settings/icons.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";
import { mountReportActions } from "./report-actions.js";
import { renderStartupDiagnostics } from "./diagnostics.js";

type Tone = "ok" | "warn" | "bad" | "info";

function summaryView(
  overview: ConsoleOverview,
  messages: ConsoleMessages,
): { tone: Tone; icon: RendererSettingsIconName; title: string; detail: string } {
  const { state, detail } = overview.summary;
  if (state === "starting") {
    return {
      tone: "info",
      icon: "refresh",
      title: messages.startingTitle,
      detail: messages.startingDetail,
    };
  }
  if (state === "running") {
    return { tone: "ok", icon: "check", title: messages.running, detail: messages.runningDetail };
  }
  if (state === "integration-unavailable") {
    return {
      tone: "warn",
      icon: "alert",
      title: messages.integration,
      detail: [messages.integrationDetail, detail].filter(Boolean).join("\n"),
    };
  }
  if (state === "startup-failed") {
    return { tone: "bad", icon: "alert", title: messages.failed, detail: detail ?? "" };
  }
  if (state === "desktop-missing") {
    return { tone: "bad", icon: "unavailable", title: messages.missing, detail: detail ?? "" };
  }
  return { tone: "info", icon: "play", title: messages.stopped, detail: messages.stoppedDetail };
}

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
      let launching = false;
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
        const summary = summaryView(overview, messages);
        const actions = h(document, "div", { className: "console-actions" });
        const summaryState = overview.summary.state;
        if (
          summaryState !== "starting" &&
          summaryState !== "running" &&
          summaryState !== "integration-unavailable"
        ) {
          const start = button(
            document,
            [
              createRendererSettingsIcon("play", 14),
              launching ? messages.starting : messages.start,
            ],
            () => {
              launching = true;
              render();
              void consolePost("/api/launch")
                .catch(() => undefined)
                .finally(() => {
                  window.setTimeout(() => {
                    launching = false;
                    void state.refresh();
                  }, 4_000);
                });
            },
            summaryState === "stopped" ? "primary" : "secondary",
          );
          start.disabled = launching || !overview.launchAvailable;
          actions.append(start);
        }
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
          const stop = button(
            document,
            daemonAction === "stop" ? "Stopping…" : "Stop daemon",
            () => runDaemonAction("stop"),
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
                : daemon.error ?? "External UI and Harness sessions are not running.",
            ),
          ),
          daemonActions,
        );

        context.content.replaceChildren(
          h(document, "h1", { className: "settings-section-label" }, messages.overview),
          h(
            document,
            "section",
            { className: "console-hero", "data-tone": summary.tone },
            h(
              document,
              "div",
              { className: "console-hero__icon" },
              createRendererSettingsIcon(summary.icon, 20),
            ),
            h(
              document,
              "div",
              { className: "console-hero__copy" },
              h(document, "div", { className: "console-hero__title" }, summary.title),
              summary.detail
                ? h(document, "div", { className: "console-hero__detail" }, summary.detail)
                : null,
            ),
            actions,
          ),
          versions,
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
