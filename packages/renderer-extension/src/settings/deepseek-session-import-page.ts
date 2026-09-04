import type {
  DeepSeekModernSessionCandidate,
  DeepSeekModernSessionImportParams,
  DeepSeekModernSessionImportResult,
  DeepSeekModernSessionListParams,
  DeepSeekModernSessionListResult,
  HostThreadId,
} from "@codexhost/shared-contracts";

import { KNOWN_RENDERER_AGENTS, type ExternalRendererAgent } from "../agent-selection-state.js";
import { RENDERER_AGENT_LABELS } from "../renderer-agent-icon.js";
import { RendererDeepSeekSessionUnavailableError } from "../renderer-model-client.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

const SESSION_IMPORT_HARNESSES = KNOWN_RENDERER_AGENTS.filter(
  (agent): agent is ExternalRendererAgent => agent !== "codex",
);

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

function createAccessibleText(document: Document, message: string): HTMLElement {
  const text = document.createElement("span");
  text.className = "settings-visually-hidden";
  text.textContent = message;
  return text;
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
      const heading = document.createElement("h2");
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

      const harness = document.createElement("div");
      harness.className = "settings-session-import-harness";
      const harnessLabel = document.createElement("span");
      harnessLabel.textContent = messages.sessionImportHarness;
      const harnessOptions = document.createElement("div");
      harnessOptions.className = "settings-session-import-harness__options";
      harnessOptions.dataset.sessionImportHarness = "selector";
      harnessOptions.setAttribute("role", "group");
      harnessOptions.setAttribute("aria-label", messages.sessionImportHarness);
      for (const agent of SESSION_IMPORT_HARNESSES) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "settings-session-import-harness__option";
        option.dataset.sessionImportHarnessOption = agent;
        option.textContent = RENDERER_AGENT_LABELS[agent];
        option.disabled = agent !== "deepseek-harness";
        option.setAttribute("aria-pressed", agent === "deepseek-harness" ? "true" : "false");
        harnessOptions.append(option);
      }
      harness.append(harnessLabel, harnessOptions);

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.sessionImportDescription;
      const content = document.createElement("section");
      content.className = "settings-session-import-content";
      context.content.append(header, harness, description, content);

      let candidates: readonly DeepSeekModernSessionCandidate[] = [];
      let importingId: string | null = null;
      let actions: Array<{
        readonly button: HTMLButtonElement;
        readonly candidate: DeepSeekModernSessionCandidate;
      }> = [];

      const updateImportActions = (): void => {
        for (const { button, candidate } of actions) {
          const importing = importingId === candidate.nativeSessionId;
          button.disabled = candidate.running;
          button.setAttribute(
            "aria-disabled",
            candidate.running || importingId !== null ? "true" : "false",
          );
          button.setAttribute("aria-busy", importing ? "true" : "false");
          button.replaceChildren(
            createRendererSettingsIcon("download", 15),
            importing ? messages.sessionImportImporting : messages.sessionImportAction,
          );
        }
      };

      const renderUnavailable = (focus = false): void => {
        candidates = [];
        actions = [];
        const status = createStatus(document, messages.sessionImportUnavailable);
        content.replaceChildren(status);
        if (focus) {
          status.tabIndex = -1;
          status.focus();
        }
      };

      const renderFailure = (error: unknown, operation: "list" | "import" = "list"): void => {
        if (error instanceof RendererDeepSeekSessionUnavailableError) {
          renderUnavailable(operation === "import");
          return;
        }
        actions = [];
        const status = createStatus(
          document,
          operation === "import" ? messages.sessionImportFailed : messages.sessionImportLoadFailed,
          true,
        );
        content.replaceChildren(status);
        if (operation === "import") {
          status.tabIndex = -1;
          status.focus();
        }
      };

      const renderOpenRecovery = (
        candidate: DeepSeekModernSessionCandidate,
        threadId: HostThreadId,
      ): void => {
        actions = [];
        refresh.disabled = false;
        const recovery = document.createElement("section");
        recovery.className = "settings-session-import-recovery";
        recovery.setAttribute("role", "region");
        recovery.setAttribute("aria-label", messages.sessionImportImported);
        recovery.tabIndex = -1;

        const recoveryCopy = document.createElement("div");
        recoveryCopy.className = "settings-session-import-recovery__copy";
        const title = document.createElement("strong");
        title.textContent = messages.sessionImportImported;
        const explanation = document.createElement("p");
        explanation.textContent = messages.sessionImportOpenFailed;
        recoveryCopy.append(title, explanation);

        const path = document.createElement("div");
        path.className = "settings-session-import-recovery__path";
        const cwd = document.createElement("code");
        cwd.textContent = candidate.cwd;
        cwd.title = candidate.cwd;
        const copyPath = document.createElement("button");
        copyPath.type = "button";
        copyPath.className = "settings-command-button settings-command-button--secondary";
        copyPath.dataset.sessionImportAction = "copy-project-path";
        const setCopyLabel = (label: string): void => {
          copyPath.replaceChildren(createRendererSettingsIcon("copy", 15), label);
        };
        const showCopyFeedback = (label: string): void => {
          setCopyLabel(label);
          document.defaultView?.setTimeout(
            () => setCopyLabel(messages.sessionImportCopyProjectPath),
            2_000,
          );
        };
        setCopyLabel(messages.sessionImportCopyProjectPath);
        copyPath.addEventListener("click", () => {
          const clipboard = document.defaultView?.navigator.clipboard;
          if (!clipboard) {
            showCopyFeedback(messages.sessionImportPathCopyFailed);
            return;
          }
          void clipboard.writeText(candidate.cwd).then(
            () => showCopyFeedback(messages.sessionImportPathCopied),
            () => showCopyFeedback(messages.sessionImportPathCopyFailed),
          );
        });
        path.append(cwd, copyPath);

        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "settings-command-button";
        retry.dataset.sessionImportAction = "retry-open";
        const setRetrying = (pending: boolean): void => {
          retry.disabled = pending;
          refresh.disabled = pending;
          retry.setAttribute("aria-busy", pending ? "true" : "false");
          retry.replaceChildren(
            createRendererSettingsIcon("refresh", 15),
            pending ? messages.sessionImportRetrying : messages.sessionImportRetryOpen,
          );
        };
        setRetrying(false);
        retry.addEventListener("click", () => {
          if (retry.disabled) return;
          setRetrying(true);
          void context.runLatest((signal) => openImportedThread(threadId, signal), {
            success() {
              setRetrying(false);
            },
            failure() {
              renderOpenRecovery(candidate, threadId);
            },
          });
        });

        recovery.append(recoveryCopy, path, retry);
        content.replaceChildren(recovery);
        recovery.focus();
      };

      const renderCandidates = (): void => {
        actions = [];
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
          identity.setAttribute("aria-hidden", "true");
          copy.append(
            title,
            metadata,
            cwd,
            identity,
            createAccessibleText(
              document,
              `${messages.sessionImportSessionId}: ${candidate.nativeSessionId}`,
            ),
          );

          const actionArea = document.createElement("div");
          actionArea.className = "settings-session-import-row__action";
          if (candidate.running) {
            const running = document.createElement("span");
            running.className = "settings-session-import-running";
            running.textContent = messages.sessionImportRunning;
            running.title = messages.sessionImportRunningHint;
            running.setAttribute("aria-hidden", "true");
            actionArea.append(
              running,
              createAccessibleText(
                document,
                `${messages.sessionImportRunning}: ${messages.sessionImportRunningHint}`,
              ),
            );
          }
          const action = document.createElement("button");
          action.type = "button";
          action.className = "settings-command-button";
          action.dataset.sessionImportAction = "import";
          action.addEventListener("click", () => {
            if (candidate.running || importingId !== null) return;
            const client = getClient();
            if (!client) {
              renderUnavailable(true);
              return;
            }
            importingId = candidate.nativeSessionId;
            refresh.disabled = true;
            updateImportActions();
            let committedThreadId: HostThreadId | null = null;
            void context.runLatest(
              async (signal) => {
                const result = await client.importDeepSeekModernSession({
                  nativeSessionId: candidate.nativeSessionId,
                });
                committedThreadId = result.threadId;
                await openImportedThread(result.threadId, signal);
              },
              {
                success() {
                  importingId = null;
                  refresh.disabled = false;
                  updateImportActions();
                },
                failure(error) {
                  importingId = null;
                  refresh.disabled = false;
                  if (committedThreadId) {
                    renderOpenRecovery(candidate, committedThreadId);
                  } else {
                    renderFailure(error, "import");
                  }
                },
              },
            );
          });
          actions.push({ button: action, candidate });
          actionArea.append(action);
          row.append(copy, actionArea);
          list.append(row);
        }
        content.append(list);
        updateImportActions();
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
