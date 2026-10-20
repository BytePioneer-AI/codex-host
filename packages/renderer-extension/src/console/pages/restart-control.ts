import { button, h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type { ConsoleState } from "../state.js";

export function renderRestartControl(
  document: Document,
  messages: ConsoleMessages,
  state: ConsoleState,
): HTMLElement {
  const root = h(document, "div", { className: "console-actions" });
  const status = state.overview?.restart;
  const busy = state.restartSubmitting || status?.phase === "restarting";
  if (state.restartConfirm && !busy) {
    root.append(
      h(document, "p", { role: "status" }, messages.restartWarning),
      button(document, messages.restartConfirm, () => void state.restart(), "primary"),
      button(document, messages.restartCancel, () => state.confirmRestart(false)),
    );
  } else {
    const restart = button(document, messages.restart, () => state.confirmRestart(true));
    restart.disabled =
      busy ||
      state.offline ||
      !state.overview?.launchAvailable ||
      !["running", "integration-unavailable"].includes(state.overview.summary.state);
    root.append(restart);
  }
  if (busy || status?.phase === "succeeded") {
    root.append(
      h(document, "p", { role: "status" }, busy ? messages.restarting : messages.restarted),
    );
  }
  const error = state.restartError ?? status?.error;
  if (error) root.append(h(document, "p", { role: "alert" }, error));
  return root;
}
