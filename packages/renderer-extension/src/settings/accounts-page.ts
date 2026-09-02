import type {
  CodexAccountActivateParams,
  CodexAccountCreateParams,
  CodexAccountListResult,
  CodexAccountLoginCancelParams,
  CodexAccountLoginCancelResult,
  CodexAccountLoginCompleted,
  CodexAccountLoginStartParams,
  CodexAccountLoginStartResult,
  CodexAccountMutationResult,
  CodexAccountSummary,
} from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererCodexAccountClient {
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts?(): Promise<CodexAccountListResult>;
  createCodexAccount(input: CodexAccountCreateParams): Promise<CodexAccountMutationResult>;
  activateCodexAccount(input: CodexAccountActivateParams): Promise<CodexAccountMutationResult>;
  startCodexAccountLogin(
    input: CodexAccountLoginStartParams,
  ): Promise<CodexAccountLoginStartResult>;
  cancelCodexAccountLogin(
    input: CodexAccountLoginCancelParams,
  ): Promise<CodexAccountLoginCancelResult>;
  subscribeCodexAccountLogin?(listener: (result: CodexAccountLoginCompleted) => void): () => void;
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
      let login: CodexAccountLoginStartResult | null = null;
      let loginStartingAccountId: string | null = null;
      let loginMessage: string | null = null;

      const render = (): void => {
        list.replaceChildren();
        status.textContent = loginMessage ?? "";
        add.disabled = accountCreating || login !== null || loginStartingAccountId !== null;
        for (const account of accounts) {
          const row = document.createElement("section");
          row.className = "settings-account-row";
          row.dataset.accountId = account.accountId;
          const identity = document.createElement("div");
          identity.className = "settings-account-row__identity";
          const titleLine = document.createElement("div");
          const title = document.createElement("strong");
          title.textContent = account.email ?? account.label;
          titleLine.append(title);
          if (account.active) {
            const badge = document.createElement("span");
            badge.className = "settings-status-badge settings-account-active";
            badge.textContent = messages.accountActive;
            titleLine.append(badge);
          }
          const home = document.createElement("code");
          home.textContent = account.codexHome;
          home.title = account.codexHome;
          identity.append(titleLine, home);
          const actions = document.createElement("div");
          actions.className = "settings-account-actions";
          if (!account.active) {
            const activate = document.createElement("button");
            activate.type = "button";
            activate.className = "settings-command-button settings-command-button--secondary";
            activate.textContent = messages.accountUse;
            activate.addEventListener("click", () =>
              mutate(() => client().activateCodexAccount({ accountId: account.accountId })),
            );
            actions.append(activate);
          }
          const signIn = document.createElement("button");
          signIn.type = "button";
          signIn.className = "settings-command-button settings-command-button--secondary";
          signIn.textContent = messages.accountSignIn;
          signIn.disabled = accountCreating || login !== null || loginStartingAccountId !== null;
          signIn.addEventListener("click", () => startLogin(account.accountId));
          actions.append(signIn);
          row.append(identity, actions);

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
      const load = (): void => {
        void context.runLatest(
          () => client().refreshCodexAccounts?.() ?? client().listCodexAccounts(),
          {
            success(result) {
              accounts = result.accounts;
              loginMessage = null;
              render();
            },
            failure(error) {
              loginMessage = errorMessage(error, messages.accountLoadFailed);
              render();
            },
          },
        );
      };
      const mutate = (operation: () => Promise<CodexAccountMutationResult>): void => {
        void context.runLatest(() => operation(), {
          success(result) {
            accounts = accounts.map((account) => ({
              ...(account.accountId === result.account.accountId ? result.account : account),
              active: account.accountId === result.account.accountId,
            }));
            loginMessage = null;
            render();
          },
          failure(error) {
            loginMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };
      const startLogin = (accountId: string): void => {
        if (accountCreating || login !== null || loginStartingAccountId !== null) return;
        loginStartingAccountId = accountId;
        loginMessage = messages.accountSigningIn;
        render();
        void context.runLatest(() => client().startCodexAccountLogin({ accountId }), {
          success(result) {
            loginStartingAccountId = null;
            login = result;
            loginMessage = null;
            render();
          },
          failure(error) {
            loginStartingAccountId = null;
            loginMessage = errorMessage(error, messages.accountLoginFailed);
            render();
          },
        });
      };
      const createAndLogin = (): void => {
        if (accountCreating || login !== null || loginStartingAccountId !== null) return;
        accountCreating = true;
        loginMessage = messages.accountSigningIn;
        render();
        void context.runLatest(() => client().createCodexAccount({}), {
          success(result) {
            accountCreating = false;
            accounts = [
              ...accounts.filter(({ accountId }) => accountId !== result.account.accountId),
              result.account,
            ];
            loginMessage = null;
            render();
            startLogin(result.account.accountId);
          },
          failure(error) {
            accountCreating = false;
            loginMessage = errorMessage(error, messages.accountCreateFailed);
            render();
          },
        });
      };
      const cancelLogin = (accountId: string, loginId: string): void => {
        void context.runLatest(() => client().cancelCodexAccountLogin({ accountId, loginId }), {
          success() {
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
      return () => unsubscribe?.();
    },
  });
}
