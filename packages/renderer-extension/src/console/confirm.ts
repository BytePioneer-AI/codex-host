import { button, h } from "./dom.js";

/** Confirmation shared by Console lifecycle and connection switches. */
export function confirmAction(
  container: HTMLElement,
  signal: AbortSignal,
  title: string,
  description: string,
  operation: () => Promise<void>,
  chinese: boolean,
  extraContent?: Node,
): void {
  if (signal.aborted || container.querySelector("dialog")) return;
  const document = container.ownerDocument;
  const dialog = h(document, "dialog", {
    className: "console-model-prices",
    "aria-label": title,
  });
  const error = h(document, "p", { role: "alert" });
  let busy = false;
  const close = (): void => {
    dialog.close();
    dialog.remove();
  };
  const cancel = button(document, chinese ? "取消" : "Cancel", close);
  const confirm = button(
    document,
    title,
    () => {
      busy = true;
      cancel.disabled = confirm.disabled = true;
      dialog.setAttribute("aria-busy", "true");
      void operation().then(close, (cause: unknown) => {
        if (signal.aborted) return;
        busy = false;
        cancel.disabled = confirm.disabled = false;
        dialog.setAttribute("aria-busy", "false");
        error.textContent = cause instanceof Error ? cause.message : String(cause);
      });
    },
    "primary",
  );
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    signal.removeEventListener("abort", close);
    dialog.remove();
  });
  signal.addEventListener("abort", close, { once: true });
  dialog.append(
    h(document, "h2", {}, title),
    h(document, "p", {}, description),
    ...(extraContent ? [extraContent] : []),
    error,
    h(document, "div", { className: "console-actions" }, cancel, confirm),
  );
  container.append(dialog);
  dialog.showModal();
}
