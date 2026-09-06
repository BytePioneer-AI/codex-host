import type {
  CodexAccountActivateParams,
  CodexAccountCreateParams,
  CodexAccountDeleteParams,
  CodexAccountDeleteResult,
  CodexAccountListResult,
  CodexAccountLoginCancelParams,
  CodexAccountLoginCancelResult,
  CodexAccountLoginCompleted,
  CodexAccountLoginStartParams,
  CodexAccountLoginStartResult,
  CodexAccountMutationResult,
  CodexAccountSummary,
  CodexAccountUsageParams,
  CodexAccountUsageResult,
  CodexAccountResetCreditConsumeParams,
  CodexAccountResetCreditConsumeResult,
} from "@codexhost/shared-contracts";

import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import { renderAccountUsageCard, type AccountUsageViewState } from "./accounts-usage.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererCodexAccountClient {
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts?(): Promise<CodexAccountListResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  consumeCodexAccountResetCredit?(
    input: CodexAccountResetCreditConsumeParams,
  ): Promise<CodexAccountResetCreditConsumeResult>;
  createCodexAccount(input: CodexAccountCreateParams): Promise<CodexAccountMutationResult>;
  deleteCodexAccount(input: CodexAccountDeleteParams): Promise<CodexAccountDeleteResult>;
  activateCodexAccount(input: CodexAccountActivateParams): Promise<CodexAccountMutationResult>;
  startCodexAccountLogin(
    input: CodexAccountLoginStartParams,
  ): Promise<CodexAccountLoginStartResult>;
  cancelCodexAccountLogin(
    input: CodexAccountLoginCancelParams,
  ): Promise<CodexAccountLoginCancelResult>;
  subscribeCodexAccountLogin?(listener: (result: CodexAccountLoginCompleted) => void): () => void;
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
      const heading = document.createElement("div");
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
      const deviceCodeNote = document.createElement("p");
      deviceCodeNote.className = "settings-account-device-code-note";
      deviceCodeNote.textContent = messages.accountDeviceCodePrerequisite;
      const list = document.createElement("div");
      list.className = "settings-account-list";
      context.content.append(header, deviceCodeNote, status, list);

      let accounts: readonly CodexAccountSummary[] = [];
      let accountCreating = false;
      let deletingAccountId: string | null = null;
      let login: CodexAccountLoginStartResult | null = null;
      let loginStartingAccountId: string | null = null;
      let loginMessage: string | null = null;
      let loginRefreshTimer: number | undefined;
      const usageByAccountId = new Map<string, AccountUsageViewState>();
      let usageGeneration = 0;
      let usingResetAccountId: string | null = null;

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
                setAccounts(result.accounts);
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
        list.replaceChildren();
        status.textContent = loginMessage ?? "";
        add.disabled =
          accountCreating ||
          deletingAccountId !== null ||
          login !== null ||
          loginStartingAccountId !== null;
        for (const account of accounts) {
          const row = document.createElement("section");
          row.className = "settings-account-row";
          row.dataset.accountId = account.accountId;
          const head = document.createElement("div");
          head.className = "settings-account-row__head";
          const person = document.createElement("div");
          person.className = "settings-account-row__person";
          const mark = document.createElement("div");
          mark.className = "settings-account-row__mark";
          mark.setAttribute("aria-hidden", "true");
          mark.append(createRendererAgentIcon("codex", 36, document));
          const identity = document.createElement("div");
          identity.className = "settings-account-row__identity";
          const titleLine = document.createElement("div");
          const displayName = codexAccountDisplayName(account);
          const email = document.createElement("span");
          email.className = "settings-account-email";
          email.title = displayName.full;
          const local = document.createElement("strong");
          local.textContent = displayName.local;
          email.append(local);
          if (displayName.domain) {
            const domain = document.createElement("span");
            domain.textContent = displayName.domain;
            email.append(domain);
          }
          titleLine.append(email);
          if (account.active) {
            const badge = document.createElement("span");
            badge.className = "settings-status-badge settings-account-active";
            badge.textContent = messages.accountActive;
            titleLine.append(badge);
          }
          identity.append(titleLine);
          person.append(mark, identity);
          const actions = document.createElement("div");
          actions.className = "settings-account-actions";
          if (!account.active) {
            const activate = document.createElement("button");
            activate.type = "button";
            activate.className = "settings-command-button settings-command-button--secondary";
            activate.textContent = messages.accountUse;
            activate.disabled = deletingAccountId !== null;
            activate.addEventListener("click", () =>
              mutate(() => client().activateCodexAccount({ accountId: account.accountId })),
            );
            actions.append(activate);
          }
          if (!account.email) {
            const signIn = document.createElement("button");
            signIn.type = "button";
            signIn.className = "settings-command-button settings-command-button--secondary";
            signIn.textContent = messages.accountSignIn;
            signIn.disabled =
              accountCreating ||
              deletingAccountId !== null ||
              login !== null ||
              loginStartingAccountId !== null;
            signIn.addEventListener("click", () => startLogin(account.accountId));
            actions.append(signIn);
          }
          if (!account.isDefault) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className =
              "settings-command-button settings-command-button--secondary settings-command-button--danger";
            remove.textContent = messages.accountDelete;
            remove.disabled = deletingAccountId !== null;
            remove.addEventListener("click", () => deleteAccount(account.accountId));
            actions.append(remove);
          }
          head.append(person, actions);
          row.append(head);
          const usage = renderAccountUsageCard(
            document,
            usageByAccountId.get(account.accountId),
            messages,
            {
              usingReset: usingResetAccountId === account.accountId,
              ...(getClient()?.consumeCodexAccountResetCredit
                ? { onUseReset: () => useReset(account.accountId) }
                : {}),
            },
          );
          if (usage) row.append(usage);

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
            row.append(verification);
          }
          list.append(row);
        }
      };

      const client = (): RendererCodexAccountClient => {
        const value = getClient();
        if (!value) throw new Error(messages.runtimeCapabilityNotInstalled);
        return value;
      };
      const loadUsage = (nextAccounts: readonly CodexAccountSummary[]): void => {
        const inspect = getClient()?.inspectCodexAccountUsage;
        const signedIn = nextAccounts.filter((account) => account.email);
        const keep = new Set(signedIn.map((account) => account.accountId));
        for (const accountId of [...usageByAccountId.keys()]) {
          if (!keep.has(accountId)) usageByAccountId.delete(accountId);
        }
        if (!inspect) return;
        const pending = signedIn.filter((account) => !usageByAccountId.has(account.accountId));
        if (pending.length === 0) return;
        const generation = ++usageGeneration;
        for (const account of pending) {
          usageByAccountId.set(account.accountId, { status: "loading" });
        }
        render();
        void Promise.all(
          pending.map(async (account) => {
            try {
              const result = await inspect({ accountId: account.accountId });
              if (context.signal.aborted || generation !== usageGeneration) return;
              usageByAccountId.set(
                account.accountId,
                result.accountCredits
                  ? { status: "ready", credits: result.accountCredits }
                  : { status: "empty" },
              );
            } catch {
              if (context.signal.aborted || generation !== usageGeneration) return;
              usageByAccountId.set(account.accountId, { status: "empty" });
            }
          }),
        ).then(() => {
          if (context.signal.aborted || generation !== usageGeneration) return;
          render();
        });
      };
      const setAccounts = (nextAccounts: readonly CodexAccountSummary[]): void => {
        accounts = nextAccounts;
        render();
        loadUsage(nextAccounts);
      };
      const refreshInBackground = (): void => {
        if (!client().refreshCodexAccounts) return;
        void context.runLatest(
          () => client().refreshCodexAccounts?.() ?? client().listCodexAccounts(),
          {
            success(result) {
              setAccounts(result.accounts);
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
            setAccounts(result.accounts);
            refreshInBackground();
          },
          failure(error) {
            loginMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };
      const mutate = (operation: () => Promise<CodexAccountMutationResult>): void => {
        void context.runLatest(() => operation(), {
          success(result) {
            loginMessage = null;
            setAccounts(
              accounts.map((account) => ({
                ...(account.accountId === result.account.accountId ? result.account : account),
                active: account.accountId === result.account.accountId,
              })),
            );
          },
          failure(error) {
            loginMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };
      const startLogin = (accountId: string): void => {
        if (
          accountCreating ||
          deletingAccountId !== null ||
          login !== null ||
          loginStartingAccountId !== null
        )
          return;
        loginStartingAccountId = accountId;
        loginMessage = messages.accountSigningIn;
        render();
        void context.runLatest(() => client().startCodexAccountLogin({ accountId }), {
          success(result) {
            loginStartingAccountId = null;
            login = result;
            loginMessage = null;
            render();
            scheduleLoginRefresh();
          },
          failure(error) {
            loginStartingAccountId = null;
            loginMessage = errorMessage(error, messages.accountLoginFailed);
            render();
          },
        });
      };
      const createAndLogin = (): void => {
        if (
          accountCreating ||
          deletingAccountId !== null ||
          login !== null ||
          loginStartingAccountId !== null
        )
          return;
        accountCreating = true;
        loginMessage = messages.accountSigningIn;
        render();
        void context.runLatest(() => client().createCodexAccount({}), {
          success(result) {
            accountCreating = false;
            loginMessage = null;
            setAccounts([
              ...accounts.filter(({ accountId }) => accountId !== result.account.accountId),
              result.account,
            ]);
            startLogin(result.account.accountId);
          },
          failure(error) {
            accountCreating = false;
            loginMessage = errorMessage(error, messages.accountCreateFailed);
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
        if (!consume || usingResetAccountId !== null) return;
        if (document.defaultView?.confirm?.(messages.accountResetCreditsConfirm) === false) return;
        usingResetAccountId = accountId;
        loginMessage = messages.accountResetCreditsUsing;
        render();
        void context.runLatest(
          () => consume({ accountId, idempotencyKey: crypto.randomUUID() }),
          {
            success(result) {
              usingResetAccountId = null;
              loginMessage = resetOutcomeMessage(result.outcome);
              if (result.accountCredits) {
                usageByAccountId.set(accountId, {
                  status: "ready",
                  credits: result.accountCredits,
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
          },
        );
      };
      const deleteAccount = (accountId: string): void => {
        const account = accounts.find((candidate) => candidate.accountId === accountId);
        if (!account || account.isDefault || deletingAccountId !== null) return;
        if (document.defaultView?.confirm?.(messages.accountDeleteConfirm) === false) return;
        deletingAccountId = accountId;
        loginMessage = messages.accountDeleting;
        render();
        void context.runLatest(() => client().deleteCodexAccount({ accountId }), {
          success() {
            deletingAccountId = null;
            loginMessage = null;
            setAccounts(
              accounts
                .filter((candidate) => candidate.accountId !== accountId)
                .map((candidate) => ({
                  ...candidate,
                  active: account.active ? candidate.isDefault : candidate.active,
                })),
            );
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
      try {
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
      load();
      return () => {
        clearLoginRefresh();
        unsubscribe?.();
      };
    },
  });
}
