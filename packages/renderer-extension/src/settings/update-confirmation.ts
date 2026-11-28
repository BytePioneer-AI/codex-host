import type { RendererSettingsMessages } from "./localization.js";
import { preferenceId } from "./preference-ui.js";

export function confirmUpdateWithRunningTasks(
  container: HTMLElement,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  runningTaskCount: number,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const document = container.ownerDocument;
  const dialog = document.createElement("dialog");
  dialog.className =
    "settings-account-dialog settings-credential-dialog settings-update-confirm-dialog";
  const heading = document.createElement("h2");
  heading.id = preferenceId("update-running-tasks-title");
  heading.textContent = messages.updateConfirmRunningTitle;
  dialog.setAttribute("aria-labelledby", heading.id);
  const detail = document.createElement("p");
  detail.id = preferenceId("update-running-tasks-detail");
  detail.textContent = messages.updateConfirmRunningDetail.replace(
    "{count}",
    String(runningTaskCount),
  );
  dialog.setAttribute("aria-describedby", detail.id);
  const actions = document.createElement("div");
  actions.className = "settings-credential-dialog__actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "settings-command-button settings-command-button--secondary";
  cancel.textContent = messages.updateConfirmCancel;
  cancel.setAttribute("autofocus", "");
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "settings-command-button";
  confirm.textContent = messages.updateConfirmProceed;
  actions.append(cancel, confirm);
  dialog.append(heading, detail, actions);

  return new Promise((resolve) => {
    let confirmed = false;
    const abort = (): void => dialog.close();
    cancel.addEventListener("click", () => dialog.close());
    confirm.addEventListener("click", () => {
      confirmed = true;
      dialog.close();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation?.();
      dialog.close();
    });
    dialog.addEventListener(
      "close",
      () => {
        signal.removeEventListener("abort", abort);
        dialog.remove();
        resolve(confirmed && !signal.aborted);
      },
      { once: true },
    );
    signal.addEventListener("abort", abort, { once: true });
    container.append(dialog);
    dialog.showModal();
  });
}
