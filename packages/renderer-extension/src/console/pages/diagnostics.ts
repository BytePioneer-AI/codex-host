import { formatTime, h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type { ConsoleOverview, StartupRecord } from "../state.js";

type StepKey =
  | "prepare"
  | "findDesktop"
  | "ownership"
  | "launchDesktop"
  | "connectDesktop"
  | "startHost"
  | "finish";

/** Launcher stage names are internal; users see the step they belong to. */
const STAGE_STEPS: Readonly<Record<string, StepKey>> = {
  "launch requested": "prepare",
  "resources resolved": "prepare",
  "Codex Desktop installation discovered": "findDesktop",
  "acquiring Launcher ownership": "ownership",
  "Launcher ownership acquired": "ownership",
  "attached to existing controlled Desktop": "ownership",
  "launching Codex Desktop": "launchDesktop",
  "Codex Desktop launched": "launchDesktop",
  "spawning Desktop Controller": "connectDesktop",
  "waiting for Desktop Controller readiness": "connectDesktop",
  "Desktop Controller ready": "connectDesktop",
  "waiting for Host chain": "startHost",
  "Host chain ready": "startHost",
  "runtime descriptor published": "finish",
  "publishing ready": "finish",
};

/**
 * The step a failed start stopped in. The last recorded stage finished, so a
 * stage that completes a step points at the next one.
 */
export function failedStep(stages: readonly { name: string }[]): StepKey {
  const last = stages.at(-1)?.name;
  if (!last) return "prepare";
  const next: Readonly<Record<string, StepKey>> = {
    "launch requested": "prepare",
    "resources resolved": "findDesktop",
    "Codex Desktop installation discovered": "ownership",
    "Launcher ownership acquired": "launchDesktop",
    "Codex Desktop launched": "connectDesktop",
    "Desktop Controller ready": "startHost",
    "Host chain ready": "finish",
  };
  return next[last] ?? STAGE_STEPS[last] ?? "prepare";
}

function durationText(record: StartupRecord, messages: ConsoleMessages): string {
  const last = record.stages.at(-1)?.elapsedMs ?? 0;
  return messages.startDuration.replace("{seconds}", (last / 1000).toFixed(1));
}

function timelineDetails(
  document: Document,
  record: StartupRecord,
  messages: ConsoleMessages,
): HTMLElement {
  const failed = record.outcome === "failed";
  const timeline = h(document, "ol", { className: "console-timeline" });
  record.stages.forEach((stage, index) => {
    const stopped = failed && index === record.stages.length - 1;
    timeline.append(
      h(
        document,
        "li",
        { className: stopped ? "is-stopped" : "" },
        h(document, "span", { className: "console-timeline__name" }, stage.name),
        h(document, "span", { className: "console-timeline__time" }, `+${stage.elapsedMs} ms`),
      ),
    );
  });
  return h(
    document,
    "details",
    { className: "console-details" },
    h(document, "summary", {}, messages.details),
    h(
      document,
      "dl",
      { className: "console-facts" },
      h(document, "dt", {}, messages.desktop),
      h(
        document,
        "dd",
        {},
        record.desktop ? `${record.desktop.version} (${record.desktop.build})` : "—",
      ),
      h(document, "dt", {}, messages.codexhost),
      h(document, "dd", {}, record.launcherVersion || "—"),
    ),
    timeline,
  );
}

export function renderStartupDiagnostics(
  document: Document,
  messages: ConsoleMessages,
  overview: ConsoleOverview,
  locale: string,
): HTMLElement[] {
  const latest = overview.startup[0];
  const sections: HTMLElement[] = [];
  if (!latest) {
    sections.push(
      h(document, "div", { className: "console-panel console-muted" }, messages.noStart),
    );
  } else if (latest.outcome === "failed") {
    const step = messages.steps[failedStep(latest.stages)];
    sections.push(
      h(
        document,
        "section",
        { className: "console-panel" },
        h(
          document,
          "div",
          { className: "console-panel__header" },
          h(document, "h2", { className: "console-panel__title" }, messages.latestStart),
          h(document, "span", { className: "console-badge is-bad" }, messages.outcomeFailed),
        ),
        h(
          document,
          "p",
          { className: "console-lead" },
          messages.failedAtStep.replace("{step}", step),
        ),
        h(document, "p", { className: "console-muted" }, formatTime(latest.startedAtMs, locale)),
        latest.error ? h(document, "pre", { className: "console-pre" }, latest.error) : null,
        timelineDetails(document, latest, messages),
      ),
    );
  } else {
    sections.push(
      h(
        document,
        "section",
        { className: "console-panel" },
        h(
          document,
          "div",
          { className: "console-panel__header" },
          h(document, "h2", { className: "console-panel__title" }, messages.latestStart),
          h(
            document,
            "span",
            { className: "console-badge is-ok" },
            latest.outcome === "attached" ? messages.outcomeAttached : messages.outcomeReady,
          ),
        ),
        h(
          document,
          "p",
          { className: "console-muted" },
          latest.outcome === "attached"
            ? formatTime(latest.startedAtMs, locale)
            : `${formatTime(latest.startedAtMs, locale)} · ${durationText(latest, messages)}`,
        ),
      ),
    );
  }
  // Only a persistent failure is shown: the first attempt at startup can
  // fail harmlessly while Codex is still loading.
  const renderer = overview.controller?.renderer;
  if (overview.summary.state === "integration-unavailable" && renderer) {
    const reason = renderer.error ?? renderer.lastError;
    sections.push(
      h(
        document,
        "section",
        { className: "console-panel" },
        h(
          document,
          "div",
          { className: "console-panel__header" },
          h(document, "h2", { className: "console-panel__title" }, messages.integrationTitle),
          h(document, "span", { className: "console-badge is-bad" }, messages.detached),
        ),
        h(document, "p", { className: "console-lead" }, messages.integrationDetail),
        reason ? h(document, "pre", { className: "console-pre" }, reason) : null,
      ),
    );
  }
  return sections;
}
