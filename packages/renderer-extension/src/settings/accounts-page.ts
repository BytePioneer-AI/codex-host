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
  CodexAccountLogoutParams,
  CodexAccountLogoutResult,
  CodexAccountRecoverParams,
  CodexAccountRecoverResult,
  CodexAccountSummary,
  CodexAccountUsageParams,
  CodexAccountUsageResult,
  CodexAccountResetCreditConsumeParams,
  CodexAccountResetCreditConsumeResult,
} from "@codexhost/shared-contracts";

import {
  accountListFocusRestorer,
  accountPlanLabel,
  createAccountsTable,
  renderAccountRows,
  renderHarnessAccountRow,
} from "./accounts-list.js";
import { createHarnessAccounts, type RendererHarnessAccountClient } from "./harness-accounts.js";
import { mountAccountResetCountdowns } from "./accounts-reset-time.js";
import type { AccountUsageDisplay, AccountUsageViewState } from "./accounts-usage.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { shouldApplyCodexAccountSnapshot } from "../renderer-codex-account-state.js";

export interface RendererCodexAccountClient extends RendererHarnessAccountClient {
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts?(): Promise<CodexAccountListResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  consumeCodexAccountResetCredit?(
    input: CodexAccountResetCreditConsumeParams,
  ): Promise<CodexAccountResetCreditConsumeResult>;
  deleteCodexAccount(input: CodexAccountDeleteParams): Promise<CodexAccountDeleteResult>;
  switchCodexAccount(input: CodexAccountSwitchParams): Promise<CodexAccountSwitchResult>;
  logoutCodexAccount(input?: CodexAccountLogoutParams): Promise<CodexAccountLogoutResult>;
  recoverCodexAccounts(input?: CodexAccountRecoverParams): Promise<CodexAccountRecoverResult>;
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
      const heading = document.createElement("h1");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.accounts;
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.accountsDescription;
      copy.append(heading, description);
      const add = document.createElement("button");
      add.type = "button";
      add.className = "settings-command-button";
      add.append(createRendererSettingsIcon("add", 16), messages.accountAdd);
      header.append(copy, add);

      const status = document.createElement("p");
      status.className = "settings-account-status";
      status.setAttribute("aria-live", "polite");
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
        usageByAccountId.clear();
        loadUsage(accounts);
        void harnessAccounts?.refresh();
      });
      search.addEventListener("input", () => render());
      toolbar.append(connected, searchWrapper, displayControls, refreshUsage);
      const list = document.createElement("div");
      list.className = "settings-account-list";
      const { table, body, updateDisplay } = createAccountsTable(document, messages);
      list.append(table);
      context.content.append(header, status, toolbar, list);
      const stopCountdowns = mountAccountResetCountdowns(list, messages, context.signal);

      let accounts: readonly CodexAccountSummary[] = [];
      let currentAccountId: string | null = null;
      let accountPhase: CodexAccountListResult["phase"] = "unavailable";
      let accountRevision = 0;
      let accountInstanceId: string | undefined;
      let hasAccountSnapshot = false;
      let cleanupRequired = false;
      let legacyHistoryPreserved = false;
      let capabilities: CodexAccountListResult["capabilities"] = {
        manage: false,
        switch: false,
        login: false,
        delete: false,
      };
      let accountCreating = false;
      let accountActivating = false;
      let accountRecovering = false;
      let accountLoggingOut = false;
      let deletingAccountId: string | null = null;
      let login: CodexAccountLoginStartResult | null = null;
      let loginStartingAccountId: string | null = null;
      let loginMessage: string | null = null;
      let loginRefreshTimer: number | undefined;
      let loginStartSnapshot: { instanceId: string | undefined; revision: number } | undefined;
      const earlyLoginCompletions = new Map<string, CodexAccountLoginCompleted>();
      const usageByAccountId = new Map<string, AccountUsageViewState>();
      let usingResetAccountId: string | null = null;
      let usageDisplay: AccountUsageDisplay = "remaining";
      const expandedResetAccounts = new Set<string>();
      // Mutations share runLatest; do not let a second action discard the
      // completion handler of an in-flight login, deletion, or reset.
      const accountBusy = (): boolean =>
        accountCreating ||
        accountActivating ||
        accountRecovering ||
        accountLoggingOut ||
        accountPhase === "changing" ||
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
                const refreshedLogin = login;
                // A ready Account event may already have advanced the displayed
                // revision. Compare with this login's admission, not that event.
                const snapshotAdvanced =
                  loginStartSnapshot &&
                  ((result.instanceId !== undefined &&
                    result.instanceId !== loginStartSnapshot.instanceId) ||
                    (result.instanceId === loginStartSnapshot.instanceId &&
                      result.revision > loginStartSnapshot.revision));
                setAccounts(result);
                if (
                  refreshedLogin &&
                  snapshotAdvanced &&
                  result.phase !== "changing" &&
                  !(
                    result.pendingOperation?.kind === "login" &&
                    result.pendingOperation.operationId === refreshedLogin.loginId
                  )
                ) {
                  login = null;
                  loginStartSnapshot = undefined;
                  loginMessage = messages.accountLoginResultUnconfirmed;
                  render();
                  return;
                }
                scheduleLoginRefresh();
              },
              failure() {
                scheduleLoginRefresh();
              },
            },
          );
        }, 750);
      };

      const render = (): void => {
        const restoreFocus = accountListFocusRestorer(list, search);
        body.replaceChildren();
        status.replaceChildren();
        const accountStatus = cleanupRequired
          ? messages.accountCleanupRequired
          : accountPhase === "unavailable" && capabilities.reason === "recovery-required"
            ? messages.accountRecoveryRequired
            : capabilities.reason === "competing-writer"
              ? messages.accountCompetingWriter
              : capabilities.reason === "migration-required"
                ? accountPhase === "ready" && currentAccountId !== null
                  ? messages.accountLegacyCompatibility
                  : messages.accountMigrationRequired
                : (loginMessage ??
                  (legacyHistoryPreserved ? messages.accountLegacyCredentialsAdopted : null));
        if (accountStatus) status.append(accountStatus);
        if (
          (cleanupRequired || capabilities.reason === "recovery-required") &&
          capabilities.recover
        ) {
          const recover = document.createElement("button");
          recover.type = "button";
          recover.className = "settings-command-button settings-command-button--secondary";
          recover.textContent = accountRecovering
            ? messages.accountRecovering
            : messages.accountRecover;
          recover.disabled = accountBusy();
          recover.addEventListener("click", recoverAccounts);
          status.append(" ", recover);
        }
        connectedCount.textContent = String(accounts.length + harnessAccounts.accounts.length);
        updateDisplay(usageDisplay);
        search.disabled = login !== null || loginStartingAccountId !== null;
        for (const [display, button] of displayButtons) {
          button.setAttribute("aria-pressed", String(display === usageDisplay));
        }
        refreshUsage.disabled =
          ((!getClient()?.inspectCodexAccountUsage || accounts.length === 0) &&
            !getClient()?.listHarnessAccounts) ||
          harnessAccounts?.refreshing === true ||
          [...usageByAccountId.values()].some((usage) => usage.status === "loading") ||
          accountBusy();
        const query = search.value.trim().toLocaleLowerCase();
        const visibleAccounts = accounts.filter((account) =>
          `Codex ${account.email ?? ""} ${account.label} ${accountPlanLabel(account.planType) ?? ""}`
            .toLocaleLowerCase()
            .includes(query),
        );
        const visibleHarnessAccounts = harnessAccounts.accounts.filter((account) =>
          `${account.harnessName} ${account.email ?? ""} ${account.label ?? ""} ${account.plan ?? ""}`
            .toLocaleLowerCase()
            .includes(query),
        );
        if (visibleAccounts.length + visibleHarnessAccounts.length === 0) {
          const emptyRow = document.createElement("tr");
          const emptyCell = document.createElement("td");
          emptyCell.colSpan = 4;
          emptyCell.className = "settings-account-empty";
          emptyCell.textContent = query ? messages.accountNoMatches : messages.accountEmpty;
          emptyRow.append(emptyCell);
          body.append(emptyRow);
        }
        add.disabled = accountBusy() || !capabilities.login;
        for (const account of visibleAccounts) {
          body.append(
            ...renderAccountRows(document, account, messages, {
              current: accountPhase === "ready" && account.accountId === currentAccountId,
              usage: usageByAccountId.get(account.accountId),
              display: usageDisplay,
              actionsDisabled: accountBusy(),
              switchDisabled: !capabilities.switch,
              loginDisabled: !capabilities.login,
              deleteDisabled: !capabilities.delete,
              logoutDisabled: !capabilities.logout,
              usingReset: usingResetAccountId === account.accountId,
              resetDisabled: accountBusy(),
              resetExpanded: expandedResetAccounts.has(account.accountId),
              onActivate: () => switchAccount(account.accountId),
              onSignIn: () => startLogin(account.accountId),
              onDelete: () => deleteAccount(account.accountId),
              onLogout: logoutAccount,
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

          if (login?.accountId === account.accountId) {
            const verification = document.createElement("div");
            verification.className = "settings-account-verification";
            const prompt = document.createElement("span");
            prompt.textContent = messages.accountVerificationDescription;
            const link = document.createElement("a");
            link.href = login.verificationUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = login.verificationUrl;
            link.addEventListener("click", (event) => {
              const bridge = (document.defaultView as CodexDesktopLinkWindow | null)
                ?.electronBridge;
              if (typeof bridge?.sendMessageFromView !== "function") return;
              event.preventDefault();
              void Promise.resolve(
                bridge.sendMessageFromView({
                  type: "open-in-browser",
                  url: login?.verificationUrl ?? link.href,
                  initiator: "open_in_browser_bridge",
                  openTarget: "external-browser",
                  source: "manual",
                }),
              ).catch(() => undefined);
            });
            const code = document.createElement("code");
            code.textContent = login.userCode;
            const copyCode = document.createElement("button");
            copyCode.type = "button";
            copyCode.className = "settings-command-button settings-command-button--secondary";
            copyCode.textContent = messages.accountCopyCode;
            copyCode.addEventListener("click", () => {
              void document.defaultView?.navigator.clipboard
                ?.writeText(login?.userCode ?? "")
                .then(() => {
                  copyCode.textContent = messages.accountCopied;
                });
            });
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.className = "settings-command-button settings-command-button--secondary";
            cancel.textContent = messages.accountLoginCancel;
            cancel.addEventListener("click", () =>
              cancelLogin(login?.accountId ?? "", login?.loginId ?? ""),
            );
            verification.append(prompt, link, code, copyCode, cancel);
            const verificationRow = document.createElement("tr");
            const verificationCell = document.createElement("td");
            verificationCell.colSpan = 4;
            verificationCell.append(verification);
            verificationRow.append(verificationCell);
            body.append(verificationRow);
          }
        }
        if (login && !accounts.some((account) => account.accountId === login?.accountId)) {
          const verification = document.createElement("div");
          verification.className = "settings-account-verification";
          const prompt = document.createElement("span");
          prompt.textContent = messages.accountVerificationDescription;
          const link = document.createElement("a");
          link.href = login.verificationUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = login.verificationUrl;
          const code = document.createElement("code");
          code.textContent = login.userCode;
          const copyCode = document.createElement("button");
          copyCode.type = "button";
          copyCode.className = "settings-command-button settings-command-button--secondary";
          copyCode.textContent = messages.accountCopyCode;
          copyCode.addEventListener("click", () => {
            void document.defaultView?.navigator.clipboard?.writeText(login?.userCode ?? "");
          });
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "settings-command-button settings-command-button--secondary";
          cancel.textContent = messages.accountLoginCancel;
          cancel.addEventListener("click", () =>
            cancelLogin(login?.accountId ?? "", login?.loginId ?? ""),
          );
          verification.append(prompt, link, code, copyCode, cancel);
          const verificationRow = document.createElement("tr");
          const verificationCell = document.createElement("td");
          verificationCell.colSpan = 4;
          verificationCell.append(verification);
          verificationRow.append(verificationCell);
          body.append(verificationRow);
        }
        for (const account of visibleHarnessAccounts) {
          body.append(renderHarnessAccountRow(document, account, messages, usageDisplay));
        }
        restoreFocus();
      };

      const client = (): RendererCodexAccountClient => {
        const value = getClient();
        if (!value) throw new Error(messages.runtimeCapabilityNotInstalled);
        return value;
      };
      const loadUsage = (nextAccounts: readonly CodexAccountSummary[]): void => {
        const inspect = getClient()?.inspectCodexAccountUsage;
        const saved = [...nextAccounts];
        const keep = new Set(saved.map((account) => account.accountId));
        for (const accountId of [...usageByAccountId.keys()]) {
          if (!keep.has(accountId)) usageByAccountId.delete(accountId);
        }
        const pending = saved.filter((account) => !usageByAccountId.has(account.accountId));
        if (!inspect || pending.length === 0) {
          render();
          return;
        }
        const requests = pending.map((account) => {
          const loading: AccountUsageViewState = { status: "loading" };
          usageByAccountId.set(account.accountId, loading);
          return { account, loading };
        });
        render();
        void Promise.all(
          requests.map(async ({ account, loading }) => {
            try {
              const result = await inspect({ accountId: account.accountId });
              if (context.signal.aborted || usageByAccountId.get(account.accountId) !== loading)
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
              if (context.signal.aborted || usageByAccountId.get(account.accountId) !== loading)
                return;
              usageByAccountId.set(account.accountId, { status: "error" });
            }
            render();
          }),
        );
      };
      const setAccounts = (result: CodexAccountListResult): void => {
        if (
          !shouldApplyCodexAccountSnapshot(
            hasAccountSnapshot
              ? { instanceId: accountInstanceId, revision: accountRevision }
              : null,
            result,
          )
        ) {
          return;
        }
        hasAccountSnapshot = true;
        accounts = result.accounts;
        currentAccountId = result.currentAccountId;
        accountPhase = result.phase;
        accountRevision = result.revision;
        accountInstanceId = result.instanceId;
        cleanupRequired = result.cleanupRequired ?? false;
        legacyHistoryPreserved = result.legacyHistoryPreserved ?? false;
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
      const load = (keepMessage = false): void => {
        void context.runLatest(() => client().listCodexAccounts(), {
          success(result) {
            if (!keepMessage) loginMessage = null;
            setAccounts(result);
            refreshInBackground();
          },
          failure(error) {
            loginMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };
      const completeLogin = (result: CodexAccountLoginCompleted): void => {
        if (context.signal.aborted || result.loginId !== login?.loginId) return;
        clearLoginRefresh();
        login = null;
        loginStartSnapshot = undefined;
        cleanupRequired = result.cleanupRequired ?? cleanupRequired;
        loginMessage =
          result.saved || result.success
            ? result.cleanupRequired
              ? messages.accountCleanupRequired
              : messages.accountLoginSucceeded
            : (result.error ?? messages.accountLoginFailed);
        render();
        if (result.saved || result.success) load(true);
      };
      const reconcileLoginStart = (result: CodexAccountLoginStartResult): void => {
        login = result;
        const completed = earlyLoginCompletions.get(result.loginId);
        earlyLoginCompletions.clear();
        if (completed) {
          completeLogin(completed);
          return;
        }
        render();
        scheduleLoginRefresh();
      };
      const switchAccount = (accountId: string): void => {
        if (accountBusy() || !capabilities.switch || accountId === currentAccountId) return;
        accountActivating = true;
        loginMessage = null;
        render();
        void context.runLatest(() => client().switchCodexAccount({ accountId }), {
          success() {
            accountActivating = false;
            loginMessage = null;
            usageByAccountId.delete(accountId);
            load();
          },
          failure(error) {
            accountActivating = false;
            loginMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };
      const startLogin = (accountId?: string): void => {
        if (accountBusy() || !capabilities.login) return;
        loginStartingAccountId = accountId ?? "new";
        loginStartSnapshot = { instanceId: accountInstanceId, revision: accountRevision };
        loginMessage = messages.accountSigningIn;
        render();
        void context.runLatest(
          () => client().startCodexAccountLogin(accountId ? { accountId } : {}),
          {
            success(result) {
              loginStartingAccountId = null;
              loginMessage = null;
              reconcileLoginStart(result);
            },
            failure(error) {
              loginStartingAccountId = null;
              loginStartSnapshot = undefined;
              earlyLoginCompletions.clear();
              loginMessage = errorMessage(error, messages.accountLoginFailed);
              render();
            },
          },
        );
      };
      const createAndLogin = (): void => {
        if (accountBusy() || !capabilities.login) return;
        accountCreating = true;
        loginStartSnapshot = { instanceId: accountInstanceId, revision: accountRevision };
        loginMessage = messages.accountSigningIn;
        render();
        void context.runLatest(() => client().startCodexAccountLogin({}), {
          success(result) {
            accountCreating = false;
            loginMessage = null;
            search.value = "";
            reconcileLoginStart(result);
          },
          failure(error) {
            accountCreating = false;
            loginStartSnapshot = undefined;
            earlyLoginCompletions.clear();
            loginMessage = errorMessage(error, messages.accountLoginFailed);
            render();
          },
        });
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
      const logoutAccount = (): void => {
        if (accountBusy() || !capabilities.logout || currentAccountId === null) return;
        if (document.defaultView?.confirm?.(messages.accountLogoutConfirm) === false) return;
        accountLoggingOut = true;
        loginMessage = messages.accountLoggingOut;
        render();
        void context.runLatest(() => client().logoutCodexAccount({}), {
          success() {
            accountLoggingOut = false;
            loginMessage = messages.accountLoggedOut;
            load();
          },
          failure(error) {
            accountLoggingOut = false;
            loginMessage = errorMessage(error, messages.accountLogoutFailed);
            render();
          },
        });
      };
      const recoverAccounts = (): void => {
        if (accountBusy() || !capabilities.recover) return;
        accountRecovering = true;
        loginMessage = messages.accountRecovering;
        render();
        void context.runLatest(() => client().recoverCodexAccounts({}), {
          success(result) {
            accountRecovering = false;
            loginMessage = null;
            setAccounts(result);
            render();
          },
          failure(error) {
            accountRecovering = false;
            loginMessage = errorMessage(error, messages.accountRecoveryRequired);
            render();
          },
        });
      };
      const cancelLogin = (_accountId: string, loginId: string): void => {
        void context.runLatest(() => client().cancelCodexAccountLogin({ loginId }), {
          success() {
            clearLoginRefresh();
            earlyLoginCompletions.clear();
            login = null;
            loginStartSnapshot = undefined;
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
          if (context.signal.aborted) return;
          if (result.loginId === login?.loginId) {
            completeLogin(result);
            return;
          }
          if (login || (loginStartingAccountId === null && !accountCreating)) return;
          earlyLoginCompletions.set(result.loginId, result);
          if (earlyLoginCompletions.size > 4) {
            const oldestLoginId = earlyLoginCompletions.keys().next().value;
            if (oldestLoginId) earlyLoginCompletions.delete(oldestLoginId);
          }
        });
      } catch {
        // Login remains usable even when the renderer bridge cannot subscribe.
      }
      const harnessAccounts = createHarnessAccounts(context.signal, getClient, render);
      void harnessAccounts.refresh();
      load();
      return () => {
        stopCountdowns();
        clearLoginRefresh();
        earlyLoginCompletions.clear();
        unsubscribe?.();
        unsubscribeAccounts?.();
      };
    },
  });
}
