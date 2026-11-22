import type { RendererSettingsMessages } from "./localization.js";
import { preferenceId } from "./preference-ui.js";

export function confirmHarnessUpdate(
  container: HTMLElement,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  name: string,
  target: string,
  verified?: string,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const document = container.ownerDocument;
  const dialog = document.createElement("dialog");
  dialog.className = "settings-account-dialog settings-credential-dialog";
  const heading = document.createElement("h2");
  heading.id = preferenceId("unverified-harness-update");
  heading.textContent = verified
    ? messages.harnessUpdateUnverifiedTitle
    : messages.harnessUpdateTargetChangedTitle;
  dialog.setAttribute("aria-labelledby", heading.id);
  const detail = document.createElement("p");
  detail.id = preferenceId("unverified-harness-version");
  const template = verified
    ? messages.harnessUpdateUnverifiedDetail
    : messages.harnessUpdateTargetChangedDetail;
  detail.textContent = template.replace(
    /\{(name|target|verified)\}/gu,
    (_, field: "name" | "target" | "verified") =>
      ({ name, target, verified: verified ?? "" })[field],
  );
  dialog.setAttribute("aria-describedby", detail.id);
  const actions = document.createElement("div");
  actions.className = "settings-credential-dialog__actions";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "settings-command-button settings-command-button--secondary";
  skip.textContent = messages.harnessUpdateSkip;
  skip.setAttribute("autofocus", "");
  const update = document.createElement("button");
  update.type = "button";
  update.className = "settings-command-button";
  update.textContent = verified ? messages.harnessUpdateAnyway : messages.harnessVersionUpdate;
  actions.append(skip, update);
  dialog.append(heading, detail, actions);

  return new Promise((resolve) => {
    let confirmed = false;
    const abort = (): void => dialog.close();
    skip.addEventListener("click", () => dialog.close());
    update.addEventListener("click", () => {
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
