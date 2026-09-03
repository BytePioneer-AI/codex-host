import type {
  DeepSeekModernSessionCandidate,
  DeepSeekModernSessionImportParams,
  DeepSeekModernSessionImportResult,
  DeepSeekModernSessionListParams,
  DeepSeekModernSessionListResult,
  HostThreadId,
} from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererDeepSeekSessionImportClient {
  listDeepSeekModernSessions(
    input: DeepSeekModernSessionListParams,
  ): Promise<DeepSeekModernSessionListResult>;
  importDeepSeekModernSession(
    input: DeepSeekModernSessionImportParams,
  ): Promise<DeepSeekModernSessionImportResult>;
}

export type RendererImportedThreadOpener = (
  threadId: HostThreadId,
  signal: AbortSignal,
) => Promise<void>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function shortSessionId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function createStatus(document: Document, message: string, error = false): HTMLElement {
  const status = document.createElement("div");
  status.className = error
    ? "settings-session-import-status is-error"
    : "settings-session-import-status";
  status.setAttribute("role", error ? "alert" : "status");
  status.append(createRendererSettingsIcon(error ? "alert" : "download", 18));
  const copy = document.createElement("span");
  copy.textContent = message;
  status.append(copy);
  return status;
}

export function createDeepSeekSessionImportSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererDeepSeekSessionImportClient | null,
  openImportedThread: RendererImportedThreadOpener,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "session-import",
    label: messages.pageLabels["session-import"],
    icon: "download",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const header = document.createElement("div");
      header.className = "settings-session-import-header";
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels["session-import"];
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "settings-command-button settings-command-button--secondary";
      refresh.dataset.sessionImportAction = "refresh";
      const setRefreshLabel = (loading: boolean): void => {
        refresh.replaceChildren(
          createRendererSettingsIcon("refresh", 15),
          loading ? messages.sessionImportRefreshing : messages.sessionImportRefresh,
        );
      };
      setRefreshLabel(false);
      header.append(heading, refresh);

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.sessionImportDescription;
      const content = document.createElement("section");
      content.className = "settings-session-import-content";
      content.setAttribute("aria-live", "polite");
      context.content.append(header, description, content);

      let candidates: readonly DeepSeekModernSessionCandidate[] = [];
      let importingId: string | null = null;

      const renderUnavailable = (): void => {
        candidates = [];
        content.replaceChildren(createStatus(document, messages.sessionImportUnavailable));
      };

      const renderFailure = (
        error: unknown,
        imported = false,
        operation: "list" | "import" = "list",
      ): void => {
        content.replaceChildren(
          createStatus(
            document,
            imported
              ? messages.sessionImportOpenFailed
              : errorMessage(
                  error,
                  operation === "import"
                    ? messages.sessionImportFailed
                    : messages.sessionImportLoadFailed,
                ),
            true,
          ),
        );
      };

      const renderCandidates = (): void => {
        content.replaceChildren();
        if (candidates.length === 0) {
          content.append(createStatus(document, messages.sessionImportEmpty));
          return;
        }
        const list = document.createElement("div");
        list.className = "settings-session-import-list";
        for (const candidate of candidates) {
          const row = document.createElement("article");
          row.className = "settings-session-import-row";
          row.dataset.sessionImportId = candidate.nativeSessionId;

          const copy = document.createElement("div");
          copy.className = "settings-session-import-row__copy";
          const title = document.createElement("strong");
          title.textContent = candidate.title ?? messages.sessionImportUntitled;
          const metadata = document.createElement("span");
          metadata.textContent = `${messages.sessionImportUpdatedAt}: ${new Intl.DateTimeFormat(
            messages.locale === "zh-CN" ? "zh-CN" : "en",
            { dateStyle: "medium", timeStyle: "short" },
          ).format(new Date(candidate.updatedAt))}`;
          const cwd = document.createElement("code");
          cwd.className = "settings-session-import-row__cwd";
          cwd.textContent = candidate.cwd;
          cwd.title = candidate.cwd;
          const identity = document.createElement("span");
          identity.textContent = `${messages.sessionImportSessionId}: ${shortSessionId(candidate.nativeSessionId)}`;
          identity.title = candidate.nativeSessionId;
          copy.append(title, metadata, cwd, identity);

          const actionArea = document.createElement("div");
          actionArea.className = "settings-session-import-row__action";
          if (candidate.running) {
            const running = document.createElement("span");
            running.className = "settings-session-import-running";
            running.textContent = messages.sessionImportRunning;
            running.title = messages.sessionImportRunningHint;
            actionArea.append(running);
          }
          const action = document.createElement("button");
          action.type = "button";
          action.className = "settings-command-button";
          action.dataset.sessionImportAction = "import";
          action.disabled = candidate.running || importingId !== null;
          action.replaceChildren(
            createRendererSettingsIcon("download", 15),
            importingId === candidate.nativeSessionId
              ? messages.sessionImportImporting
              : messages.sessionImportAction,
          );
          action.addEventListener("click", () => {
            if (candidate.running || importingId !== null) return;
            const client = getClient();
            if (!client) {
              renderUnavailable();
              return;
            }
            importingId = candidate.nativeSessionId;
            refresh.disabled = true;
            renderCandidates();
            let committed = false;
            void context.runLatest(
              async (signal) => {
                const result = await client.importDeepSeekModernSession({
                  nativeSessionId: candidate.nativeSessionId,
                });
                committed = true;
                await openImportedThread(result.threadId, signal);
              },
              {
                success() {
                  importingId = null;
                  refresh.disabled = false;
                },
                failure(error) {
                  importingId = null;
                  refresh.disabled = false;
                  renderFailure(error, committed, "import");
                },
              },
            );
          });
          actionArea.append(action);
          row.append(copy, actionArea);
          list.append(row);
        }
        content.append(list);
      };

      const load = (): void => {
        if (importingId !== null) return;
        const client = getClient();
        if (!client) {
          refresh.disabled = false;
          setRefreshLabel(false);
          renderUnavailable();
          return;
        }
        refresh.disabled = true;
        setRefreshLabel(true);
        content.replaceChildren(createStatus(document, messages.sessionImportRefreshing));
        void context.runLatest(() => client.listDeepSeekModernSessions({}), {
          success(result) {
            candidates = result.candidates;
            refresh.disabled = false;
            setRefreshLabel(false);
            renderCandidates();
          },
          failure(error) {
            candidates = [];
            refresh.disabled = false;
            setRefreshLabel(false);
            renderFailure(error);
          },
        });
      };

      refresh.addEventListener("click", load);
      load();
      return undefined;
    },
  });
}
