import type {
  CodexAccountChanged,
  CodexAccountListResult,
  CodexAccountSummary,
  CodexAccountUsageParams,
  CodexAccountUsageResult,
} from "@codexhost/shared-contracts";

import {
  mountCredentialImports,
  type RendererCredentialImportClient,
} from "./credential-imports.js";
import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import {
  accountListFocusRestorer,
  accountPlanLabel,
  createAccountsTable,
  renderAccountRows,
  renderHarnessAccountRows,
} from "./accounts-list.js";
import { createHarnessAccounts, type RendererHarnessAccountClient } from "./harness-accounts.js";
import { mountAccountResetCountdowns } from "./accounts-reset-time.js";
import type { AccountUsageDisplay, AccountUsageViewState } from "./accounts-usage.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { shouldApplyCodexAccountSnapshot } from "../renderer-codex-account-state.js";

export interface RendererCodexAccountClient
  extends RendererHarnessAccountClient, RendererCredentialImportClient {
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts?(): Promise<CodexAccountListResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  subscribeCodexAccounts?(listener: (result: CodexAccountChanged) => void): () => void;
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
      copy.append(heading);
      header.append(copy);

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
        void harnessAccounts?.refresh(true);
        void credentialImports.refresh();
      });
      search.addEventListener("input", () => render());
      toolbar.append(connected, searchWrapper, displayControls, refreshUsage);
      const list = document.createElement("div");
      list.className = "settings-account-list";
      const { table, body, updateDisplay } = createAccountsTable(document, messages);
      list.append(table);
      const credentialImports = mountCredentialImports(
        context.content,
        context.signal,
        getClient,
        messages.credentialImports,
        () => render(),
      );
      context.content.append(header, status, toolbar, list, credentialImports.section);
      const stopCountdowns = mountAccountResetCountdowns(list, messages, context.signal);

      let accounts: readonly CodexAccountSummary[] = [];
      let currentAccountId: string | null = null;
      let accountPhase: CodexAccountListResult["phase"] = "unavailable";
      let accountRevision = 0;
      let accountInstanceId: string | undefined;
      let hasAccountSnapshot = false;
      let loadMessage: string | null = null;
      const usageByAccountId = new Map<string, AccountUsageViewState>();
      let usageDisplay: AccountUsageDisplay = "remaining";
      const expandedResetAccounts = new Set<string>();

      const render = (): void => {
        const restoreFocus = accountListFocusRestorer(list, search);
        body.replaceChildren();
        status.replaceChildren();
        if (loadMessage) status.append(loadMessage);
        connectedCount.textContent = String(accounts.length + harnessAccounts.accounts.length);
        updateDisplay(usageDisplay);
        for (const [display, button] of displayButtons) {
          button.setAttribute("aria-pressed", String(display === usageDisplay));
        }
        refreshUsage.disabled =
          ((!getClient()?.inspectCodexAccountUsage || accounts.length === 0) &&
            !getClient()?.listHarnessAccounts) ||
          harnessAccounts?.refreshing === true ||
          [...usageByAccountId.values()].some((usage) => usage.status === "loading");
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
        for (const account of visibleAccounts) {
          body.append(
            ...renderAccountRows(document, account, messages, {
              current: accountPhase === "ready" && account.accountId === currentAccountId,
              importAction: credentialImports.button(
                "codex",
                codexAccountDisplayName(account).full,
              ),
              usage: usageByAccountId.get(account.accountId),
              display: usageDisplay,
              resetExpanded: expandedResetAccounts.has(account.accountId),
              onRetry: () => {
                usageByAccountId.delete(account.accountId);
                loadUsage(accounts);
              },
              onResetExpanded: (open) => {
                if (open) expandedResetAccounts.add(account.accountId);
                else expandedResetAccounts.delete(account.accountId);
              },
            }),
          );
        }
        for (const account of visibleHarnessAccounts) {
          body.append(
            ...renderHarnessAccountRows(
              document,
              account,
              messages,
              usageDisplay,
              credentialImports.button(
                account.harnessId,
                account.email ?? account.label ?? account.harnessName,
              ),
            ),
          );
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
            loadMessage = null;
            setAccounts(result);
            refreshInBackground();
          },
          failure(error) {
            loadMessage = errorMessage(error, messages.accountLoadFailed);
            render();
          },
        });
      };

      let unsubscribeAccounts: (() => void) | undefined;
      try {
        unsubscribeAccounts = getClient()?.subscribeCodexAccounts?.((result) => {
          setAccounts(result);
          render();
        });
      } catch {
        // The page remains usable through list and refresh.
      }
      const harnessAccounts = createHarnessAccounts(context.signal, getClient, render);
      void credentialImports.refresh();
      void harnessAccounts.refresh();
      load();
      return () => {
        stopCountdowns();
        unsubscribeAccounts?.();
      };
    },
  });
}
