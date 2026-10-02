import type { CodexSshConnection, CodexSshDraft } from "../codex-ssh-adapter.js";
import { preferenceId } from "./preference-ui.js";
import { remoteElement, remoteErrorMessage, type RemoteText } from "./remote-connections-card.js";
import { localizeRemoteFailure } from "./remote-failure-messages.js";

interface RemoteDialogOptions {
  /** Element inside the settings shell that hosts the modal. */
  container: HTMLElement;
  signal: AbortSignal;
  t: RemoteText;
}

interface RemoteDialog {
  form: HTMLFormElement;
  body: HTMLElement;
  /** Runs the confirmed operation, keeping the dialog open with the error if it fails. */
  submit(operation: () => Promise<void>): void;
  show(confirmLabel: string, busyLabel: string, danger?: boolean): void;
}

function createRemoteDialog(
  { container, signal, t }: RemoteDialogOptions,
  title: string,
): RemoteDialog | null {
  if (signal.aborted || container.querySelector("dialog")) return null;
  const document = container.ownerDocument;
  const modal = remoteElement(
    document,
    "dialog",
    "settings-account-dialog settings-credential-dialog settings-remote-dialog",
  );
  const form = remoteElement(document, "form");
  const heading = remoteElement(document, "h2", "", title);
  heading.id = preferenceId("remote-dialog-title");
  modal.setAttribute("aria-labelledby", heading.id);
  const body = remoteElement(document, "div", "settings-credential-dialog__body");
  const error = remoteElement(document, "p", "settings-credential-dialog__error");
  error.setAttribute("role", "alert");
  const actions = remoteElement(document, "div", "settings-credential-dialog__actions");
  const cancel = remoteElement(
    document,
    "button",
    "settings-command-button settings-command-button--secondary",
    t("取消", "Cancel"),
  );
  cancel.type = "button";
  const confirm = remoteElement(document, "button", "settings-command-button");
  confirm.type = "submit";
  actions.append(cancel, confirm);
  form.append(heading, body, error, actions);
  modal.append(form);

  let busy = false;
  let labels = { idle: "", busy: "" };
  const setBusy = (next: boolean): void => {
    busy = next;
    cancel.disabled = confirm.disabled = next;
    confirm.textContent = next ? labels.busy : labels.idle;
    modal.setAttribute("aria-busy", String(next));
  };
  const dispose = (): void => modal.remove();
  cancel.addEventListener("click", () => modal.close());
  modal.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  modal.addEventListener("close", () => {
    signal.removeEventListener("abort", dispose);
    dispose();
  });
  signal.addEventListener("abort", dispose, { once: true });

  return {
    form,
    body,
    submit(operation) {
      if (busy) return;
      error.textContent = "";
      setBusy(true);
      operation().then(
        () => modal.close(),
        (failure: unknown) => {
          if (signal.aborted) return;
          setBusy(false);
          error.textContent = localizeRemoteFailure(remoteErrorMessage(failure), t);
        },
      );
    },
    show(confirmLabel, busyLabel, danger = false) {
      labels = { idle: confirmLabel, busy: busyLabel };
      confirm.textContent = confirmLabel;
      if (danger)
        confirm.className =
          "settings-command-button settings-command-button--secondary settings-command-button--danger";
      container.append(modal);
      modal.showModal();
    },
  };
}

export function openRemoteConnectionEditor(
  options: RemoteDialogOptions & {
    previous: CodexSshConnection | null;
    save(draft: CodexSshDraft): Promise<void>;
  },
): void {
  const { t, previous } = options;
  const dialog = createRemoteDialog(
    options,
    previous ? t("编辑连接", "Edit connection") : t("添加 SSH 连接", "Add SSH connection"),
  );
  if (!dialog) return;
  const document = options.container.ownerDocument;
  const field = (label: string, value: string, placeholder = "", hint = ""): HTMLInputElement => {
    const wrapper = remoteElement(document, "div", "settings-credential-dialog__field");
    const input = remoteElement(document, "input");
    input.id = preferenceId("remote-field");
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    const caption = remoteElement(document, "label", "", label);
    caption.htmlFor = input.id;
    wrapper.append(caption, input);
    if (hint) {
      const description = remoteElement(document, "small", "", hint);
      description.id = `${input.id}-hint`;
      input.setAttribute("aria-describedby", description.id);
      wrapper.append(description);
    }
    dialog.body.append(wrapper);
    return input;
  };
  const name = field(t("名称", "Name"), previous?.displayName ?? "");
  name.required = true;
  const addressHint = t(
    "user@hostname，或 ~/.ssh/config 中的主机别名",
    "user@hostname, or a host alias from ~/.ssh/config",
  );
  const hostname = field(
    t("SSH 地址", "SSH address"),
    previous?.sshHost ?? "",
    "user@hostname",
    addressHint,
  );
  hostname.required = true;
  hostname.pattern = "[^\\s\\-]\\S*";
  hostname.title = addressHint;
  const port = field(
    t("端口（可选）", "Port (optional)"),
    previous?.sshPort?.toString() ?? "",
    "22",
  );
  port.type = "number";
  port.min = "1";
  port.max = "65535";
  port.step = "1";
  const identity = field(
    t("私钥路径（可选）", "Identity file (optional)"),
    previous?.identity ?? "",
    "~/.ssh/id_ed25519",
  );
  if (previous?.source === "discovered") {
    hostname.disabled = port.disabled = identity.disabled = true;
    dialog.body.append(
      remoteElement(
        document,
        "p",
        "",
        t(
          "此连接来自 SSH 配置，这里只能修改名称；其余配置请在原生设置中编辑。",
          "This connection comes from SSH config, so only its name can change here. Edit other details in native settings.",
        ),
      ),
    );
  }
  dialog.form.addEventListener("submit", (event) => {
    event.preventDefault();
    dialog.submit(() =>
      options.save({
        displayName: name.value,
        hostname: hostname.value,
        sshPort: port.value ? Number(port.value) : null,
        identity: identity.value.trim() || null,
      }),
    );
  });
  dialog.show(t("保存", "Save"), t("保存中…", "Saving…"));
  name.focus();
  name.select();
}

export function openRemoteConnectionRemoval(
  options: RemoteDialogOptions & { connection: CodexSshConnection; remove(): Promise<void> },
): void {
  const { t, connection } = options;
  const dialog = createRemoteDialog(
    options,
    t(`移除“${connection.displayName}”？`, `Remove "${connection.displayName}"?`),
  );
  if (!dialog) return;
  dialog.body.append(
    remoteElement(
      options.container.ownerDocument,
      "p",
      "",
      t(
        "移除连接不会删除远程文件或会话。",
        "Removing a connection does not delete remote files or chats.",
      ),
    ),
  );
  dialog.form.addEventListener("submit", (event) => {
    event.preventDefault();
    dialog.submit(options.remove);
  });
  dialog.show(t("移除", "Remove"), t("移除中…", "Removing…"), true);
}
