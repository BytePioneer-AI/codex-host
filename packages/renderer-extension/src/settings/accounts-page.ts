import type {
  CodexAccountChanged,
  CodexAccountSwitchParams,
  CodexAccountSwitchResult,
  CodexAccountDeleteParams,
  CodexAccountDeleteResult,
  CodexAccountListResult,
  CodexAccountLoginCancelParams,
  CodexAccountLoginCancelResult,
  CodexAccountLoginCompleted,
  CodexAccountLoginStartParams,
  CodexAccountLoginStartResult,
  CodexAccountSummary,
  CodexAccountUsageParams,
  CodexAccountUsageResult,
  CodexAccountResetCreditConsumeParams,
  CodexAccountResetCreditConsumeResult,
} from "@codexhost/shared-contracts";

import {
  accountListFocusRestorer,
  createAccountsTable,
  renderAccountRows,
} from "./accounts-list.js";
import { mountHarnessAccounts, type RendererHarnessAccountClient } from "./harness-accounts.js";
import type { AccountUsageDisplay, AccountUsageViewState } from "./accounts-usage.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererCodexAccountClient extends RendererHarnessAccountClient {
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts?(): Promise<CodexAccountListResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  consumeCodexAccountResetCredit?(
    input: CodexAccountResetCreditConsumeParams,
  ): Promise<CodexAccountResetCreditConsumeResult>;
  deleteCodexAccount(input: CodexAccountDeleteParams): Promise<CodexAccountDeleteResult>;
  switchCodexAccount(input: CodexAccountSwitchParams): Promise<CodexAccountSwitchResult>;
  startCodexAccountLogin(
    input: CodexAccountLoginStartParams,
  ): Promise<CodexAccountLoginStartResult>;
  cancelCodexAccountLogin(
    input: CodexAccountLoginCancelParams,
  ): Promise<CodexAccountLoginCancelResult>;
  subscribeCodexAccountLogin?(listener: (result: CodexAccountLoginCompleted) => void): () => void;
  subscribeCodexAccounts?(listener: (result: CodexAccountChanged) => void): () => void;
}

interface CodexDesktopLinkWindow extends Window {
  electronBridge?: {
    sendMessageFromView(message: unknown): unknown;
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function createAccountsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererCodexAccountClient | null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "accounts",
    label: messages.pageLabels.accounts,
    icon: "accounts",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const header = document.createElement("div");
      header.className = "settings-account-header";
      const copy = document.createElement("div");
      const eyebrow = document.createElement("p");
      eyebrow.className = "settings-account-eyebrow";
      eyebrow.textContent = "ACCOUNT MANAGEMENT";
      const heading = document.createElement("h1");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.accounts;
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.accountsDescription;
      copy.append(eyebrow, heading, description);
      const add = document.createElement("button");
      add.type = "button";
      add.className = "settings-command-button";
      add.append(createRendererSettingsIcon("add", 16), messages.accountAdd);
      header.append(copy, add);

      const status = document.createElement("p");
      status.className = "settings-account-status";
      status.setAttribute("aria-live", "polite");
      const helpRow = document.createElement("div");
      helpRow.className = "settings-account-help-row";
      const taskHint = document.createElement("p");
      taskHint.className = "settings-account-task-hint";
      const taskHintText = document.createElement("span");
      taskHintText.textContent = messages.accountTaskHint;
      taskHint.append(createRendererSettingsIcon("info", 16), taskHintText);
      const help = document.createElement("button");
      help.type = "button";
      help.className = "settings-account-help-button";
      help.append(createRendererSettingsIcon("help", 16), messages.accountLoginHelp);
      help.setAttribute("aria-expanded", "false");
      help.setAttribute("aria-controls", "settings-account-login-help");
      const deviceCodeNote = document.createElement("p");
      deviceCodeNote.id = "settings-account-login-help";
      deviceCodeNote.className = "settings-account-device-code-note";
      deviceCodeNote.textContent = messages.accountDeviceCodePrerequisite;
      deviceCodeNote.hidden = true;
      help.addEventListener("click", () => {
        deviceCodeNote.hidden = !deviceCodeNote.hidden;
        help.setAttribute("aria-expanded", String(!deviceCodeNote.hidden));
      });
      helpRow.append(taskHint, help);
      const toolbar = document.createElement("div");
      toolbar.className = "settings-account-toolbar";
      const connected = document.createElement("div");
      connected.className = "settings-account-count";
      const connectedLabel = document.createElement("span");
      connectedLabel.textContent = messages.accountConnected;
      const connectedCount = document.createElement("span");
      connected.append(connectedLabel, connectedCount);
      const searchWrapper = document.createElement("label");
      searchWrapper.className = "settings-account-search";
      const search = document.createElement("input");
      search.type = "search";
      search.name = "account-search";
      search.autocomplete = "off";
      search.spellcheck = false;
      search.placeholder = messages.accountSearch;
      search.setAttribute("aria-label", messages.accountSearch);
      searchWrapper.append(createRendererSettingsIcon("search", 16), search);
      const displayControls = document.createElement("div");
      displayControls.className = "settings-account-display-controls";
      const displayButtons = new Map<AccountUsageDisplay, HTMLButtonElement>();
      for (const display of ["used", "remaining"] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent =
          display === "used" ? messages.accountCreditsUsed : messages.accountCreditsRemaining;
        button.addEventListener("click", () => {
          usageDisplay = display;
          render();
        });
        displayButtons.set(display, button);
        displayControls.append(button);
      }
      const refreshUsage = document.createElement("button");
      refreshUsage.type = "button";
      refreshUsage.className = "settings-icon-button";
      refreshUsage.title = messages.accountCreditsRefresh;
      refreshUsage.setAttribute("aria-label", messages.accountCreditsRefresh);
      refreshUsage.append(createRendererSettingsIcon("refresh", 16));
      refreshUsage.addEventListener("click", () => {
        loadUsage(accounts, true);
        void harnessAccounts?.refresh();
      });
      search.addEventListener("input", () => render());
      toolbar.append(connected, searchWrapper, displayControls, refreshUsage);
      const list = document.createElement("div");
      list.className = "settings-account-list";
      const { table, body } = createAccountsTable(document, messages);
      list.append(table);
      context.content.append(header, helpRow, deviceCodeNote, status, toolbar, list);

      let accounts: readonly CodexAccountSummary[] = [];
      let currentAccountId: string | null = null;
      let accountPhase: CodexAccountListResult["phase"] = "unavailable";
      let accountRevision = 0;
      let capabilities: CodexAccountListResult["capabilities"] = {
        manage: false,
        switch: false,
        login: false,
        delete: false,
      };
      let accountCreating = false;
      let accountActivating = false;
      let deletingAccountId: string | null = null;
      let login: CodexAccountLoginStartResult | null = null;
      let loginStartingAccountId: string | null = null;
      let loginMessage: string | null = null;
      let loginRefreshTimer: number | undefined;
      const usageByAccountId = new Map<string, AccountUsageViewState>();
      const usageRequestByAccountId = new Map<string, symbol>();
      const usagePromiseByAccountId = new Map<string, Promise<void>>();
      let usageRefresh: Promise<void> | null = null;
      let usingResetAccountId: string | null = null;
      let usageDisplay: AccountUsageDisplay = "remaining";
      const expandedResetAccounts = new Set<string>();
      // Mutations share runLatest; do not let a second action discard the
      // completion handler of an in-flight login, deletion, or reset.
      const accountBusy = (): boolean =>
        accountCreating ||
        accountActivating ||
        deletingAccountId !== null ||
        login !== null ||
        loginStartingAccountId !== null ||
        usingResetAccountId !== null;

      const clearLoginRefresh = (): void => {
        if (loginRefreshTimer === undefined) return;
        document.defaultView?.clearTimeout(loginRefreshTimer);
        loginRefreshTimer = undefined;
      };

      const scheduleLoginRefresh = (): void => {
        clearLoginRefresh();
        if (!login || context.signal.aborted) return;
        loginRefreshTimer = document.defaultView?.setTimeout(() => {
          loginRefreshTimer = undefined;
          if (!login || context.signal.aborted) return;
          void context.runLatest(
            () => client().refreshCodexAccounts?.() ?? client().listCodexAccounts(),
            {
              success(result) {
                const signedIn = result.accounts.some(
                  (account) => account.accountId === login?.accountId && account.email,
                );
                if (signedIn) {
                  login = null;
                  loginMessage = messages.accountLoginSucceeded;
                }
                setAccounts(result);
                scheduleLoginRefresh();
              },
              failure() {
                scheduleLoginRefresh();
              },
            },
          );
        }, 750);
      };

      const createVerificationRow = (
        pendingLogin: CodexAccountLoginStartResult,
      ): HTMLTableRowElement => {
        const verification = document.createElement("div");
        verification.className = "settings-account-verification";
        const prompt = document.createElement("span");
        prompt.textContent = messages.accountVerificationDescription;
        const link = document.createElement("a");
        link.href = pendingLogin.verificationUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = pendingLogin.verificationUrl;
        link.addEventListener("click", (event) => {
          const bridge = (document.defaultView as CodexDesktopLinkWindow | null)?.electronBridge;
          if (typeof bridge?.sendMessageFromView !== "function") return;
          event.preventDefault();
          void Promise.resolve(
            bridge.sendMessageFromView({
              type: "open-in-browser",
              url: pendingLogin.verificationUrl,
              initiator: "open_in_browser_bridge",
              openTarget: "external-browser",
              source: "manual",
            }),
          ).catch(() => undefined);
        });
        const code = document.createElement("code");
        code.textContent = pendingLogin.userCode;
        const copyCode = document.createElement("button");
        copyCode.type = "button";
        copyCode.className = "settings-command-button settings-command-button--secondary";
        copyCode.textContent = messages.accountCopyCode;
        copyCode.addEventListener("click", () => {
          void document.defaultView?.navigator.clipboard
            ?.writeText(pendingLogin.userCode)
            .then(() => {
              copyCode.textContent = messages.accountCopied;
            });
        });
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-command-button settings-command-button--secondary";
        cancel.textContent = messages.accountLoginCancel;
        cancel.addEventListener("click", () =>
          cancelLogin(pendingLogin.accountId, pendingLogin.loginId),
        );
        verification.append(prompt, link, code, copyCode, cancel);
        const verificationRow = document.createElement("tr");
        const verificationCell = document.createElement("td");
        verificationCell.colSpan = 4;
        verificationCell.append(verification);
        verificationRow.append(verificationCell);
        return verificationRow;
      };

      const render = (): void => {
        const restoreFocus = accountListFocusRestorer(list, search);
        body.replaceChildren();
        status.textContent = loginMessage ?? "";
        connectedCount.textContent = String(accounts.filter((account) => account.email).length);
        search.disabled = login !== null || loginStartingAccountId !== null;
        for (const [display, button] of displayButtons) {
          button.setAttribute("aria-pressed", String(display === usageDisplay));
        }
        refreshUsage.disabled =
          ((!getClient()?.inspectCodexAccountUsage || accounts.length === 0) &&
            !getClient()?.listHarnessAccounts) ||
          harnessAccounts?.refreshing === true ||
          usageRefresh !== null ||
          [...usageByAccountId.values()].some((usage) => usage.status === "loading") ||
          accountBusy();
        const query = search.value.trim().toLocaleLowerCase();
        harnessAccounts?.update(query, usageDisplay);
        const visibleAccounts = accounts.filter((account) =>
          `${account.email ?? ""} ${account.label}`.toLocaleLowerCase().includes(query),
        );
        if (visibleAccounts.length === 0) {
          const emptyRow = document.createElement("tr");
          const emptyCell = document.createElement("td");
          emptyCell.colSpan = 4;
          emptyCell.className = "settings-account-empty";
          emptyCell.textContent = query ? messages.accountNoMatches : messages.accountEmpty;
          emptyRow.append(emptyCell);
          body.append(emptyRow);
        }
        add.disabled = accountBusy();
        for (const account of visibleAccounts) {
          body.append(
            ...renderAccountRows(document, account, messages, {
              current: accountPhase === "ready" && account.accountId === currentAccountId,
              usage: usageByAccountId.get(account.accountId),
              display: usageDisplay,
              actionsDisabled: accountBusy(),
              usingReset: usingResetAccountId === account.accountId,
              resetDisabled: accountBusy(),
              resetExpanded: expandedResetAccounts.has(account.accountId),
              onActivate: () =>
                mutate(
                  () => client().switchCodexAccount({ accountId: account.accountId }),
                  account.accountId,
                ),
              onSignIn: () => startLogin(account.accountId),
              onDelete: () => deleteAccount(account.accountId),
              onRetry: () => {
                usageByAccountId.delete(account.accountId);
                loadUsage(accounts);
              },
              onResetExpanded: (open) => {
                if (open) expandedResetAccounts.add(account.accountId);
                else expandedResetAccounts.delete(account.accountId);
              },
              ...(account.accountId === currentAccountId &&
              accountPhase === "ready" &&
              getClient()?.consumeCodexAccountResetCredit
                ? { onUseReset: () => useReset(account.accountId) }
                : {}),
            }),
          );

          if (login?.accountId === account.accountId) body.append(createVerificationRow(login));
        }
        if (login && !accounts.some((account) => account.accountId === login?.accountId)) {
          body.append(createVerificationRow(login));
        }
        restoreFocus();
      };

      const client = (): RendererCodexAccountClient => {
        const value = getClient();
        if (!value) throw new Error(messages.runtimeCapabilityNotInstalled);
        return value;
      };
      const loadUsage = (
        nextAccounts: readonly CodexAccountSummary[],
        forceRefresh = false,
      ): void => {
        const inspect = getClient()?.inspectCodexAccountUsage;
        const saved = [...nextAccounts];
        const keep = new Set(saved.map((account) => account.accountId));
        for (const accountId of [...usageByAccountId.keys()]) {
          if (!keep.has(accountId)) {
            usageByAccountId.delete(accountId);
            usageRequestByAccountId.delete(accountId);
            usagePromiseByAccountId.delete(accountId);
          }
        }
        const pending = saved.filter(
          (account) => forceRefresh || !usageByAccountId.has(account.accountId),
        );
        if (!inspect || pending.length === 0) {
          render();
          return;
        }
        const requests = pending.map((account) => {
          const previous = usageByAccountId.get(account.accountId);
          const request = Symbol(account.accountId);
          usageRequestByAccountId.set(account.accountId, request);
          if (!previous || previous.status !== "ready") {
            usageByAccountId.set(account.accountId, { status: "loading" });
          }
          return { account, previous, request };
        });
        render();
        const refresh = Promise.all(
          requests.map(({ account, previous, request }) => {
            const pending = (async () => {
              try {
                const result = await inspect({
                  accountId: account.accountId,
                  ...(forceRefresh ? { refresh: true } : {}),
                });
                if (
                  context.signal.aborted ||
                  usageRequestByAccountId.get(account.accountId) !== request
                )
                  return;
                usageByAccountId.set(
                  account.accountId,
                  result.accountCredits
                    ? {
                        status: "ready",
                        credits: result.accountCredits,
                        freshness: result.freshness,
                        observedAt: result.observedAt,
                      }
                    : { status: "empty" },
                );
              } catch {
                if (
                  context.signal.aborted ||
                  usageRequestByAccountId.get(account.accountId) !== request
                )
                  return;
                // OpenCodex-style last-good semantics: a failed refresh never erases a
                // successful snapshot already visible in this window.
                if (previous?.status === "ready") usageByAccountId.set(account.accountId, previous);
                else usageByAccountId.set(account.accountId, { status: "error" });
              } finally {
                if (usageRequestByAccountId.get(account.accountId) === request) {
                  usageRequestByAccountId.delete(account.accountId);
                }
              }
              render();
            })().finally(() => {
              if (usagePromiseByAccountId.get(account.accountId) === pending) {
                usagePromiseByAccountId.delete(account.accountId);
              }
            });
            usagePromiseByAccountId.set(account.accountId, pending);
            return pending;
          }),
        ).then(() => undefined);
        usageRefresh = refresh;
        void refresh.finally(() => {
          if (usageRefresh === refresh) {
            usageRefresh = null;
            render();
          }
        });
      };
      const setAccounts = (result: CodexAccountListResult): void => {
        if (result.revision < accountRevision) return;
        accounts = result.accounts;
        currentAccountId = result.currentAccountId;
        accountPhase = result.phase;
        accountRevision = result.revision;
        capabilities = result.capabilities;
        for (const accountId of expandedResetAccounts) {
          if (!accounts.some((account) => account.accountId === accountId))
            expandedResetAccounts.delete(accountId);
        }
        loadUsage(accounts);
      };
      const refreshInBackground = (): void => {
        if (!client().refreshCodexAccounts) return;
        void context.runLatest(
          () => client().refreshCodexAccounts?.() ?? client().listCodexAccounts(),
          {
            success(result) {
              setAccounts(result);
            },
            failure() {
              // Keep showing the cached Account list when live metadata refresh fails.
            },
          },
        );
      };
      const load = (): void => {
        void context.runLatest(() => client().listCodexAccounts(), {
          success(result) {
            loginMessage = null;
            setAccounts(result);
            refreshInBackground();
          },
          failure(error) {
            loginMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };
      const mutate = (
        operation: () => Promise<CodexAccountSwitchResult>,
        targetAccountId?: string,
      ): void => {
        if (accountBusy()) return;
        accountActivating = true;
        render();
        const pendingUsage = [currentAccountId, targetAccountId]
          .filter((accountId): accountId is string => accountId !== null && accountId !== undefined)
          .map((accountId) => usagePromiseByAccountId.get(accountId))
          .filter((pending): pending is Promise<void> => pending !== undefined);
        void context.runLatest(
          async () => {
            // Wait only for the source and target reads. Unrelated Account quota
            // probes are read-only and must not make a global switch wait for the
            // entire saved Account library.
            await Promise.all(pendingUsage);
            return operation();
          },
          {
            success() {
              accountActivating = false;
              loginMessage = null;
              if (targetAccountId) usageByAccountId.delete(targetAccountId);
              load();
            },
            failure(error) {
              accountActivating = false;
              loginMessage = errorMessage(error, messages.accountLoadFailed);
              render();
            },
          },
        );
      };
      const startLogin = (accountId?: string): void => {
        if (accountBusy()) return;
        loginStartingAccountId = accountId ?? "new";
        loginMessage = messages.accountSigningIn;
        render();
        void client()
          .startCodexAccountLogin(accountId ? { accountId } : {})
          .then(
            (result) => {
              if (context.signal.aborted) return;
              loginStartingAccountId = null;
              login = result;
              loginMessage = null;
              render();
              scheduleLoginRefresh();
            },
            (error: unknown) => {
              if (context.signal.aborted) return;
              loginStartingAccountId = null;
              loginMessage = errorMessage(error, messages.accountLoginFailed);
              render();
            },
          );
      };
      const createAndLogin = (): void => {
        if (accountBusy()) return;
        accountCreating = true;
        loginMessage = messages.accountSigningIn;
        render();
        void client()
          .startCodexAccountLogin({})
          .then(
            (result) => {
              if (context.signal.aborted) return;
              accountCreating = false;
              login = result;
              loginMessage = null;
              search.value = "";
              render();
              scheduleLoginRefresh();
            },
            (error: unknown) => {
              if (context.signal.aborted) return;
              accountCreating = false;
              loginMessage = errorMessage(error, messages.accountLoginFailed);
              render();
            },
          );
      };
      const resetOutcomeMessage = (
        outcome: CodexAccountResetCreditConsumeResult["outcome"],
      ): string => {
        if (outcome === "reset") return messages.accountResetCreditsSucceeded;
        if (outcome === "nothingToReset") return messages.accountResetCreditsNothingToReset;
        if (outcome === "noCredit") return messages.accountResetCreditsNoCredit;
        return messages.accountResetCreditsAlreadyRedeemed;
      };
      const useReset = (accountId: string): void => {
        const consume = getClient()?.consumeCodexAccountResetCredit;
        if (!consume || accountBusy()) return;
        if (document.defaultView?.confirm?.(messages.accountResetCreditsConfirm) === false) return;
        usingResetAccountId = accountId;
        loginMessage = messages.accountResetCreditsUsing;
        render();
        void context.runLatest(() => consume({ accountId, idempotencyKey: crypto.randomUUID() }), {
          success(result) {
            usingResetAccountId = null;
            loginMessage = resetOutcomeMessage(result.outcome);
            if (result.accountCredits) {
              usageByAccountId.set(accountId, {
                status: "ready",
                credits: result.accountCredits,
                freshness: "live",
                observedAt: new Date().toISOString(),
              });
            } else if (result.outcome === "reset") {
              usageByAccountId.delete(accountId);
              loadUsage(accounts);
            }
            render();
          },
          failure(error) {
            usingResetAccountId = null;
            loginMessage = errorMessage(error, messages.accountResetCreditsFailed);
            render();
          },
        });
      };
      const deleteAccount = (accountId: string): void => {
        const account = accounts.find((candidate) => candidate.accountId === accountId);
        if (
          !account ||
          account.accountId === currentAccountId ||
          !capabilities.delete ||
          accountBusy()
        )
          return;
        if (document.defaultView?.confirm?.(messages.accountDeleteConfirm) === false) return;
        deletingAccountId = accountId;
        loginMessage = messages.accountDeleting;
        render();
        void context.runLatest(() => client().deleteCodexAccount({ accountId }), {
          success() {
            deletingAccountId = null;
            loginMessage = null;
            load();
          },
          failure(error) {
            deletingAccountId = null;
            loginMessage = errorMessage(error, messages.accountDeleteFailed);
            render();
          },
        });
      };
      const cancelLogin = (accountId: string, loginId: string): void => {
        void context.runLatest(() => client().cancelCodexAccountLogin({ accountId, loginId }), {
          success() {
            clearLoginRefresh();
            login = null;
            loginMessage = null;
            render();
          },
          failure(error) {
            loginMessage = errorMessage(error, messages.accountLoginFailed);
            render();
          },
        });
      };

      add.addEventListener("click", createAndLogin);
      let unsubscribe: (() => void) | undefined;
      let unsubscribeAccounts: (() => void) | undefined;
      try {
        unsubscribeAccounts = getClient()?.subscribeCodexAccounts?.((result) => {
          setAccounts(result);
          render();
        });
        unsubscribe = getClient()?.subscribeCodexAccountLogin?.((result) => {
          if (result.loginId !== login?.loginId) return;
          clearLoginRefresh();
          login = null;
          loginMessage = result.success
            ? messages.accountLoginSucceeded
            : (result.error ?? messages.accountLoginFailed);
          render();
          if (result.success) load();
        });
      } catch {
        // Login remains usable even when the renderer bridge cannot subscribe.
      }
      const harnessAccounts = mountHarnessAccounts(context, messages, getClient, render);
      void harnessAccounts.refresh();
      load();
      return () => {
        clearLoginRefresh();
        unsubscribe?.();
        unsubscribeAccounts?.();
      };
    },
  });
}
