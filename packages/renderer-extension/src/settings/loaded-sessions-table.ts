import type { LoadedSession } from "@codexhost/shared-contracts";
import { RendererMethodUnavailableError } from "../renderer-request-sender.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface LoadedSessionsClient {
  listLoadedSessions?(): Promise<LoadedSession[]>;
}

export function mountLoadedSessionsTable(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  getClient: () => LoadedSessionsClient | null,
): () => void {
  const document = context.content.ownerDocument;
  const owner = document.defaultView;
  if (!owner) return () => undefined;
  const text = messages.loadedSessions;
  const container = document.createElement("div");
  container.className = "border-t border-settings-border";
  const header = document.createElement("div");
  header.className = "px-4 pt-4";
  const title = document.createElement("p");
  title.className = "m-0 text-sm font-medium";
  title.textContent = text.title;
  const description = document.createElement("p");
  description.className = "text-xs text-settings-muted";
  description.textContent = text.description;
  const status = document.createElement("p");
  status.className = "p-4 text-sm text-settings-muted";
  status.setAttribute("role", "status");
  status.textContent = text.loading;
  const scroll = document.createElement("div");
  scroll.className = "overflow-x-auto";
  const table = document.createElement("table");
  table.className = "w-full text-left text-sm";
  table.setAttribute("aria-label", text.title);
  const head = table.createTHead().insertRow();
  for (const label of text.columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.className = "px-4 py-3 font-medium text-settings-muted";
    cell.textContent = label;
    head.append(cell);
  }
  const body = table.createTBody();
  scroll.append(table);
  scroll.hidden = true;
  header.append(title, description);
  container.append(header, status, scroll);
  context.content.append(container);
  let disposed = false;
  let timer: number | undefined;
  let requestTimer: number | undefined;
  const refresh = async (): Promise<void> => {
    try {
      const client = getClient();
      if (!client?.listLoadedSessions) {
        status.textContent = text.unavailable;
        status.hidden = false;
        scroll.hidden = true;
        return;
      }
      const rows = await Promise.race([
        client.listLoadedSessions(),
        new Promise<never>((_, reject) => {
          requestTimer = owner.setTimeout(
            () => reject(new Error("Session status timed out")),
            10_000,
          );
        }),
      ]);
      if (disposed || context.signal.aborted) return;
      body.replaceChildren();
      for (const row of rows.toSorted(
        (a, b) =>
          b.inactiveMs - a.inactiveMs ||
          a.harnessId.localeCompare(b.harnessId) ||
          a.threadId.localeCompare(b.threadId),
      )) {
        const tr = body.insertRow();
        const values = [
          row.title,
          row.harnessId,
          text.states[row.state],
          text.minutes.replace("{minutes}", String(Math.floor(row.inactiveMs / 60_000))),
          text.reasons[row.reason],
        ];
        for (const value of values) {
          const cell = tr.insertCell();
          cell.className = "max-w-64 break-words px-4 py-3 align-top";
          cell.textContent = value;
        }
        tr.title = row.threadId;
      }
      status.textContent = rows.length ? "" : text.empty;
      status.hidden = rows.length > 0;
      scroll.hidden = rows.length === 0;
    } catch (error) {
      if (disposed || context.signal.aborted) return;
      status.textContent =
        error instanceof RendererMethodUnavailableError ? text.unavailable : text.failed;
      status.hidden = false;
      scroll.hidden = true;
    } finally {
      owner.clearTimeout(requestTimer);
      if (!disposed && !context.signal.aborted)
        timer = owner.setTimeout(() => void refresh(), 10_000);
    }
  };
  void refresh();
  return () => {
    disposed = true;
    owner.clearTimeout(timer);
    owner.clearTimeout(requestTimer);
  };
}
