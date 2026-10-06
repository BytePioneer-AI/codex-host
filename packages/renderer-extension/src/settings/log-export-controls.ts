import type { DiagnosticLogExportResult, DiagnosticLogScope } from "@codexhost/shared-contracts";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createRendererSettingsIcon } from "./icons.js";
import { createPreferenceGroup, createPreferenceItem, preferenceId } from "./preference-ui.js";

export interface DiagnosticLogClient {
  listDiagnosticLogs?(): Promise<DiagnosticLogScope[]>;
  exportDiagnosticLogs?(scope: DiagnosticLogScope): Promise<DiagnosticLogExportResult>;
}

interface DiagnosticLogFileHandle {
  readonly name: string;
  createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: readonly { description: string; accept: Readonly<Record<string, readonly string[]>> }[];
  }) => Promise<DiagnosticLogFileHandle>;
}

async function pickDiagnosticLogFile(
  ownerWindow: Window,
  suggestedName: string,
): Promise<DiagnosticLogFileHandle> {
  const picker = (ownerWindow as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) throw new Error("Save dialog is unavailable");
  return picker({
    suggestedName,
    types: [{ description: "Gzip JSONL diagnostics", accept: { "application/gzip": [".gz"] } }],
  });
}

async function saveDiagnosticLog(
  handle: DiagnosticLogFileHandle,
  result: DiagnosticLogExportResult,
): Promise<string> {
  const binary = atob(result.data);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return handle.name || result.fileName;
}

export function mountLogExportControls(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  getClient: () => DiagnosticLogClient | null,
): void {
  const document = context.content.ownerDocument;
  const text = messages.diagnosticLogs;
  const { group, card } = createPreferenceGroup(document, text.title);
  const id = preferenceId("export-diagnostic-logs");
  const row = createPreferenceItem(document, {
    title: text.export,
    description: text.description,
    controlId: id,
  });
  const button = document.createElement("button");
  button.id = id;
  button.type = "button";
  button.className = "settings-command-button settings-command-button--secondary";
  button.setAttribute("aria-describedby", row.description.id);
  button.append(createRendererSettingsIcon("download", 16), text.export);
  button.disabled = true;
  const select = document.createElement("select");
  select.className =
    "max-w-48 rounded-md border border-settings-border bg-settings-panel px-2 py-1 text-sm";
  select.setAttribute("aria-label", text.source);
  select.disabled = true;
  let scopes: DiagnosticLogScope[] = [];
  const status = document.createElement("p");
  status.className = "m-0 px-4 py-3 text-xs text-settings-muted";
  status.setAttribute("role", "status");
  status.hidden = true;
  const filePath = document.createElement("code");
  filePath.className = "block break-all px-4 pb-3 text-xs";
  filePath.hidden = true;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "settings-command-button settings-command-button--secondary";
  save.append(createRendererSettingsIcon("download", 16), text.save);
  save.hidden = true;
  // The Host prepares the archive first; a separate click saves it, because the save dialog
  // must open while that click's user activation is still valid.
  let prepared: DiagnosticLogExportResult | null = null;
  const readyText = (result: DiagnosticLogExportResult): string =>
    text.ready.replace("{count}", String(result.fileCount));
  const failureText = (error: unknown): string =>
    `${text.failed} ${error instanceof Error ? error.message : ""}`.trim();
  const setBusy = (busy: boolean): void => {
    button.disabled = busy;
    select.disabled = busy;
    save.disabled = busy;
  };
  const discardPrepared = (): void => {
    prepared = null;
    save.hidden = true;
  };
  select.addEventListener("change", () => {
    discardPrepared();
    status.hidden = true;
    filePath.hidden = true;
  });
  button.addEventListener("click", () => {
    if (button.disabled) return;
    const client = getClient();
    const exportLogs = client?.exportDiagnosticLogs?.bind(client);
    discardPrepared();
    status.hidden = false;
    filePath.hidden = true;
    const scope = scopes[Number(select.value)];
    if (!exportLogs || !scope) {
      status.textContent = text.unavailable;
      return;
    }
    setBusy(true);
    status.textContent = text.exporting;
    void context.runLatest(() => exportLogs(scope), {
      success(result) {
        setBusy(false);
        prepared = result;
        save.hidden = false;
        status.textContent = readyText(result);
      },
      failure(error) {
        setBusy(false);
        status.textContent = failureText(error);
      },
    });
  });
  save.addEventListener("click", () => {
    const result = prepared;
    if (save.disabled || !result) return;
    // Open the dialog before any await so it still runs within this click's activation.
    const picking = pickDiagnosticLogFile(document.defaultView ?? window, result.fileName);
    setBusy(true);
    void context.runLatest(async () => saveDiagnosticLog(await picking, result), {
      success(name) {
        setBusy(false);
        discardPrepared();
        status.textContent = text.saved.replace("{count}", String(result.fileCount));
        filePath.textContent = name;
        filePath.hidden = false;
      },
      failure(error) {
        setBusy(false);
        // A cancelled dialog keeps the prepared archive for another attempt.
        status.textContent =
          error instanceof Error && error.name === "AbortError"
            ? readyText(result)
            : failureText(error);
      },
    });
  });
  row.item.append(select, button, save);
  card.append(row.item, status, filePath);
  context.content.append(group);
  const client = getClient();
  const listLogs = client?.listDiagnosticLogs?.bind(client);
  status.hidden = false;
  if (!listLogs || !client?.exportDiagnosticLogs) {
    status.textContent = text.unavailable;
    return;
  }
  status.textContent = text.loading;
  void context.runLatest(() => listLogs(), {
    success(result) {
      scopes = result;
      for (const [index, scope] of scopes.entries()) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = scope.kind === "runtime" ? text.runtime : scope.harnessId;
        select.append(option);
      }
      select.value = "0";
      button.disabled = scopes.length === 0;
      select.disabled = scopes.length === 0;
      status.hidden = scopes.length > 0;
      status.textContent = scopes.length === 0 ? text.empty : "";
    },
    failure() {
      status.textContent = text.unavailable;
    },
  });
}
