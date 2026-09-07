import type { CodexAccountSummary } from "@codexhost/shared-contracts";

import { createRendererAgentIcon } from "./renderer-agent-icon.js";

export interface RendererCodexAccountOptionControl {
  readonly row: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly check: HTMLElement;
  readonly action: null;
}

export interface RendererCodexAccountGroupControl {
  readonly root: HTMLElement;
  readonly badge: HTMLElement;
  readonly options: Map<string, RendererCodexAccountOptionControl>;
  accounts: readonly CodexAccountSummary[];
  render(input: {
    readonly accounts: readonly CodexAccountSummary[];
    readonly selectedAccountId: string | null;
    readonly disabled: boolean;
    readonly showBadge: boolean;
  }): void;
}

export interface CodexAccountDisplayName {
  readonly local: string;
  readonly domain: string | null;
  readonly full: string;
}

const ACCOUNT_COLORS = ["#5b38c9", "#239b88", "#ce6724", "#2878c7", "#b34778", "#65752a"] as const;

export function codexAccountDisplayName(account: CodexAccountSummary): CodexAccountDisplayName {
  const full = account.email ?? account.label;
  const separator = account.email?.lastIndexOf("@") ?? -1;
  if (!account.email || separator <= 0 || separator === account.email.length - 1) {
    return { local: full, domain: null, full };
  }
  return {
    local: account.email.slice(0, separator),
    domain: account.email.slice(separator + 1),
    full,
  };
}

export function codexAccountPresentationSignature(
  accounts: readonly CodexAccountSummary[],
): string {
  return accounts
    .map(({ accountId, label, email }) => `${accountId}\u0000${label}\u0000${email ?? ""}`)
    .join("\u0001");
}

function accountColor(accountId: string): string {
  let hash = 0;
  for (const character of accountId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return ACCOUNT_COLORS[hash % ACCOUNT_COLORS.length] ?? ACCOUNT_COLORS[0];
}

function accountInitial(account: CodexAccountSummary): string {
  const display = codexAccountDisplayName(account).local.trim();
  return display.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
}

function setInteractiveHighlight(button: HTMLButtonElement): void {
  const update = (hovered: boolean): void => {
    const selected = button.getAttribute("aria-checked") === "true";
    button.style.background =
      selected || (hovered && !button.disabled)
        ? `rgba(127, 127, 127, ${selected ? "0.16" : "0.1"})`
        : "transparent";
  };
  button.addEventListener("pointerenter", () => update(true));
  button.addEventListener("pointerleave", () => update(false));
  button.addEventListener("focus", () => update(true));
  button.addEventListener("blur", () => update(false));
}

export function createRendererCodexAccountGroup(input: {
  readonly ownerDocument: Document;
  readonly accountsLabel: string;
  readonly manageAccountsLabel: string;
  readonly onSelect: (accountId: string) => void;
  readonly onManage: () => void;
}): RendererCodexAccountGroupControl {
  const { ownerDocument: document } = input;
  const root = document.createElement("div");
  root.dataset.codexAccountOptions = "true";
  root.hidden = true;

  const accountSection = document.createElement("div");
  accountSection.setAttribute("role", "group");
  accountSection.setAttribute("aria-label", input.accountsLabel);
  accountSection.style.position = "relative";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "7px";
  header.style.height = "30px";
  header.style.padding = "0 34px 0 8px";
  header.style.color = "inherit";
  header.style.font = "600 12px/1 system-ui, sans-serif";
  header.style.opacity = "0.72";
  header.append(createRendererAgentIcon("codex", 16, document), input.accountsLabel);

  const list = document.createElement("div");
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "2px";
  list.style.maxHeight = "132px";
  list.style.marginBottom = "4px";
  list.style.paddingLeft = "14px";
  list.style.overflowY = "auto";
  list.style.scrollbarWidth = "thin";

  const manage = document.createElement("button");
  manage.type = "button";
  manage.setAttribute("role", "menuitem");
  manage.setAttribute("aria-label", input.manageAccountsLabel);
  manage.title = input.manageAccountsLabel;
  manage.textContent = "…";
  manage.style.position = "absolute";
  manage.style.top = "3px";
  manage.style.right = "4px";
  manage.style.display = "inline-flex";
  manage.style.alignItems = "center";
  manage.style.justifyContent = "center";
  manage.style.width = "24px";
  manage.style.height = "24px";
  manage.style.padding = "0";
  manage.style.color = "inherit";
  manage.style.background = "transparent";
  manage.style.border = "0";
  manage.style.borderRadius = "5px";
  manage.style.font = "600 16px/1 system-ui, sans-serif";
  manage.style.opacity = "0.56";
  manage.style.cursor = "pointer";
  manage.addEventListener("pointerenter", () => {
    manage.style.background = "rgba(127, 127, 127, 0.1)";
    manage.style.opacity = "1";
  });
  manage.addEventListener("pointerleave", () => {
    manage.style.background = "transparent";
    manage.style.opacity = "0.56";
  });
  manage.addEventListener("click", input.onManage);

  accountSection.append(header, list, manage);
  root.append(accountSection);

  const badge = document.createElement("span");
  badge.setAttribute("aria-hidden", "true");
  badge.style.display = "none";
  badge.style.position = "absolute";
  badge.style.right = "1px";
  badge.style.bottom = "0";
  badge.style.width = "9px";
  badge.style.height = "9px";
  badge.style.border = "1.5px solid Canvas";
  badge.style.borderRadius = "50%";
  badge.style.pointerEvents = "none";

  const options = new Map<string, RendererCodexAccountOptionControl>();
  let accounts: readonly CodexAccountSummary[] = [];
  let presentationSignature = "";

  const rebuild = (nextAccounts: readonly CodexAccountSummary[]): void => {
    list.replaceChildren();
    options.clear();
    for (const account of nextAccounts) {
      const row = document.createElement("div");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.codexAccountId = account.accountId;
      button.setAttribute("role", "menuitemradio");
      button.style.display = "grid";
      button.style.gridTemplateColumns = "20px minmax(0, 1fr) 16px";
      button.style.alignItems = "center";
      button.style.gap = "7px";
      button.style.width = "100%";
      button.style.height = "32px";
      button.style.padding = "0 7px";
      button.style.color = "inherit";
      button.style.background = "transparent";
      button.style.border = "0";
      button.style.borderRadius = "5px";
      button.style.textAlign = "left";
      button.style.cursor = "pointer";
      setInteractiveHighlight(button);

      const avatar = document.createElement("span");
      avatar.textContent = accountInitial(account);
      avatar.style.display = "inline-flex";
      avatar.style.alignItems = "center";
      avatar.style.justifyContent = "center";
      avatar.style.width = "20px";
      avatar.style.height = "20px";
      avatar.style.color = "#fff";
      avatar.style.background = accountColor(account.accountId);
      avatar.style.borderRadius = "50%";
      avatar.style.font = "700 10px/1 system-ui, sans-serif";

      const displayName = codexAccountDisplayName(account);
      const name = document.createElement("span");
      name.style.display = "flex";
      name.style.alignItems = "baseline";
      name.style.minWidth = "0";
      name.style.gap = "4px";
      const local = document.createElement("strong");
      local.textContent = displayName.local;
      local.style.minWidth = "0";
      local.style.overflow = "hidden";
      local.style.font = "600 13px/1 system-ui, sans-serif";
      local.style.textOverflow = "ellipsis";
      local.style.whiteSpace = "nowrap";
      name.append(local);
      if (displayName.domain) {
        const domain = document.createElement("span");
        domain.textContent = displayName.domain;
        domain.style.maxWidth = "48%";
        domain.style.overflow = "hidden";
        domain.style.flex = "none";
        domain.style.font = "400 11px/1 system-ui, sans-serif";
        domain.style.opacity = "0.58";
        domain.style.textOverflow = "ellipsis";
        domain.style.whiteSpace = "nowrap";
        name.append(domain);
      }

      const check = document.createElement("span");
      check.textContent = "✓";
      check.setAttribute("aria-hidden", "true");
      check.style.width = "16px";
      check.style.textAlign = "center";
      check.style.font = "600 14px/1 system-ui, sans-serif";
      check.style.visibility = "hidden";

      button.title = displayName.full;
      button.setAttribute("aria-label", `${input.accountsLabel}: ${displayName.full}`);
      button.append(avatar, name, check);
      button.addEventListener("click", () => input.onSelect(account.accountId));
      row.append(button);
      list.append(row);
      options.set(account.accountId, { row, button, check, action: null });
    }
    presentationSignature = codexAccountPresentationSignature(nextAccounts);
  };

  const control: RendererCodexAccountGroupControl = {
    root,
    badge,
    options,
    accounts,
    render({ accounts: nextAccounts, selectedAccountId, disabled, showBadge }) {
      const nextSignature = codexAccountPresentationSignature(nextAccounts);
      if (nextSignature !== presentationSignature) rebuild(nextAccounts);
      accounts = [...nextAccounts];
      control.accounts = accounts;
      root.hidden = accounts.length === 0;

      const selectedAccount = accounts.find(({ accountId }) => accountId === selectedAccountId);
      badge.style.display = showBadge && selectedAccount ? "block" : "none";
      if (selectedAccount) badge.style.background = accountColor(selectedAccount.accountId);

      for (const account of accounts) {
        const option = options.get(account.accountId);
        if (!option) continue;
        const selected = account.accountId === selectedAccountId;
        option.button.disabled = disabled;
        option.button.setAttribute("aria-checked", String(selected));
        option.button.setAttribute("aria-pressed", String(selected));
        option.button.style.background = selected ? "rgba(127, 127, 127, 0.16)" : "transparent";
        option.button.style.cursor = disabled ? "not-allowed" : "pointer";
        option.button.style.opacity = disabled && !selected ? "0.5" : "1";
        option.check.style.visibility = selected ? "visible" : "hidden";
      }
    },
  };
  return control;
}
