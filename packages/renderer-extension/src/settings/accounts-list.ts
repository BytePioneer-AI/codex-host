import type { CodexAccountSummary, HarnessAccountListResult } from "@codexhost/shared-contracts";

import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import {
  accountUsageColumnLabel,
  renderAccountResetCredits,
  renderAccountUsage,
  type AccountUsageDisplay,
  type AccountUsageViewState,
} from "./accounts-usage.js";
import { accountDisplayText } from "./account-privacy.js";
import type { RendererSettingsMessages } from "./localization.js";

let resetDetailsSequence = 0;

export function accountPlanLabel(planType: CodexAccountSummary["planType"]): string | null {
  if (!planType || planType === "unknown") return null;
  if (planType === "free") return "Free";
  if (planType === "go") return "Go";
  if (planType === "plus") return "Plus";
  if (planType === "pro") return "Pro 20x";
  if (planType === "prolite") return "Pro 5x";
  if (planType === "team") return "Team";
  if (planType === "self_serve_business_prolite") return "Business Pro Lite";
  if (planType === "self_serve_business_usage_based") return "Business";
  if (planType === "business") return "Business";
  if (planType === "edu") return "Edu";
  if (planType === "edu_plus") return "Edu Plus";
  if (planType === "edu_pro") return "Edu Pro";
  return "Enterprise";
}

/** Preserve keyboard position when an async update replaces the table body. */
export function accountListFocusRestorer(list: HTMLElement, fallback: HTMLElement): () => void {
  const active = (list.getRootNode() as Document | ShadowRoot).activeElement;
  if (!active || !list.contains(active)) return () => undefined;
  const key = active.getAttribute("data-account-focus");
  const accountId = active.closest<HTMLElement>(".settings-account-row")?.dataset.accountId;
  return () => {
    const target = key
      ? list.querySelector<HTMLElement>(`[data-account-focus="${CSS.escape(key)}"]`)
      : null;
    if (target && !target.matches(":disabled")) {
      const dialog = target.closest("dialog");
      if (dialog && !dialog.open) dialog.showModal();
      target.focus({ preventScroll: true });
      return;
    }
    // An action may be disabled while pending or disappear after success.
    // Keep focus with its Account; use the page fallback only if that row is gone.
    const row = accountId
      ? list.querySelector<HTMLElement>(
          `.settings-account-row[data-account-id="${CSS.escape(accountId)}"]`,
        )
      : null;
    (row ?? fallback).focus({ preventScroll: true });
  };
}

export function createAccountsTable(document: Document, messages: RendererSettingsMessages) {
  const table = document.createElement("table");
  table.className = "settings-account-table";
  table.setAttribute("aria-label", messages.pageLabels.accounts);
  const columns = document.createElement("colgroup");
  for (const width of [36, 32, 32]) {
    const column = document.createElement("col");
    column.style.width = `${width}%`;
    columns.append(column);
  }
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  const headers = Array.from({ length: 2 }, (_, index) => {
    const cell = document.createElement("th");
    cell.scope = index === 1 ? "colgroup" : "col";
    if (index === 1) cell.colSpan = 2;
    row.append(cell);
    return cell;
  });
  const updateDisplay = (display: AccountUsageDisplay): void => {
    const labels = [messages.accountColumnAccount, accountUsageColumnLabel(display, messages)];
    headers.forEach((cell, index) => {
      cell.textContent = labels[index] ?? "";
    });
  };
  updateDisplay("remaining");
  head.append(row);
  const body = document.createElement("tbody");
  table.append(columns, head, body);
  return { table, body, updateDisplay };
}

function createAccountPerson(
  document: Document,
  messages: RendererSettingsMessages,
  input: {
    name: string;
    agent: string;
    plan: string | null;
    highlighted?: boolean;
    active?: boolean;
    mark: HTMLElement;
  },
): HTMLElement {
  const person = document.createElement("div");
  person.className = "settings-account-row__person";
  const identity = document.createElement("div");
  identity.className = "settings-account-row__identity";
  const title = document.createElement("strong");
  title.className = "settings-account-email";
  title.textContent = input.name;
  title.title = input.name;
  title.translate = false;
  const metadata = document.createElement("div");
  metadata.className = "settings-account-metadata";
  const agent = document.createElement("span");
  agent.textContent = input.agent;
  agent.translate = false;
  if (input.name !== input.agent) metadata.append(agent);
  if (input.plan) {
    if (metadata.childElementCount) {
      const separator = document.createElement("span");
      separator.textContent = "·";
      separator.setAttribute("aria-hidden", "true");
      metadata.append(separator);
    }
    const plan = document.createElement("span");
    plan.className = input.highlighted
      ? "settings-account-plan settings-account-plan--highlighted"
      : "settings-account-plan";
    plan.textContent = input.plan;
    plan.translate = false;
    metadata.append(plan);
  }
  if (input.active) {
    const badge = document.createElement("span");
    badge.className = "settings-account-active";
    badge.textContent = messages.accountDefaultBadge;
    badge.title = messages.accountDefaultHint;
    metadata.append(badge);
  }
  identity.append(title);
  if (metadata.childElementCount) identity.append(metadata);
  person.append(input.mark, identity);
  return person;
}

/**
 * Secondary line under an account's identity: reset cards and the Pi import chip share it, so the
 * import entry costs no table column and rows without either keep their compact height.
 */
function appendAccountExtras(
  cell: HTMLTableCellElement,
  items: readonly (HTMLElement | null | undefined)[],
): void {
  const present = items.filter((item): item is HTMLElement => Boolean(item));
  if (present.length === 0) return;
  const extras = cell.ownerDocument.createElement("div");
  extras.className = "settings-account-row__extras";
  extras.append(...present);
  cell.append(extras);
}

function renderAccountBalance(
  document: Document,
  messages: RendererSettingsMessages,
  balance: HarnessAccountListResult["accounts"][number]["balance"],
): ReturnType<typeof renderAccountUsage> {
  const cell = document.createElement("td");
  cell.colSpan = 2;
  cell.className = "settings-account-usage-cell settings-account-balance-cell";
  const root = document.createElement("div");
  root.className = "settings-account-balance";
  if (balance) {
    const amount = document.createElement("strong");
    amount.textContent = `${balance.currency} ${balance.amount.toFixed(2)}`;
    const caption = document.createElement("span");
    caption.className = "settings-account-balance__caption";
    caption.textContent = balance.label
      ? `${balance.label} · ${messages.accountBalanceRemaining}`
      : messages.accountBalanceRemaining;
    root.append(amount, caption);
  }
  cell.append(root);
  return { cells: [cell], continuationCells: [] };
}

export function renderAccountRows(
  document: Document,
  account: CodexAccountSummary,
  messages: RendererSettingsMessages,
  input: {
    current: boolean;
    usage: AccountUsageViewState | undefined;
    display: AccountUsageDisplay;
    resetExpanded: boolean;
    onRetry: () => void;
    onResetExpanded: (open: boolean) => void;
    importAction?: HTMLElement | null;
    hideEmails?: boolean;
  },
): HTMLTableRowElement[] {
  const row = document.createElement("tr");
  row.className = "settings-account-row";
  row.dataset.accountId = account.accountId;
  row.dataset.accountFocus = `${account.accountId}:row`;
  row.tabIndex = -1;
  const name = accountDisplayText(codexAccountDisplayName(account).full, input.hideEmails === true);
  row.setAttribute("aria-label", name);
  const personCell = document.createElement("td");
  personCell.className = "settings-account-person-cell";
  const mark = document.createElement("div");
  mark.className = "settings-harness-account__logo";
  mark.dataset.agent = "codex";
  mark.setAttribute("aria-hidden", "true");
  mark.append(createRendererAgentIcon("codex", 26, document));
  personCell.append(
    createAccountPerson(document, messages, {
      name,
      agent: "Codex",
      plan: accountPlanLabel(account.planType),
      highlighted: account.planType === "pro" || account.planType === "prolite",
      active: input.current,
      mark,
    }),
  );
  // Codex Pro 20x exposes extra model-scoped limits; this page intentionally shows only its
  // generic weekly allowance so the Account row has one comparable quota.
  const usage = renderAccountUsage(
    document,
    input.usage,
    messages,
    input.display,
    input.onRetry,
    account.planType === "pro" ? "weekly-only" : "all",
  );
  const continuationRows = usage.continuationCells.map((cells) => {
    const continuation = document.createElement("tr");
    continuation.className = "settings-account-row settings-account-quota-continuation-row";
    continuation.dataset.accountId = account.accountId;
    continuation.append(...cells);
    return continuation;
  });
  if (continuationRows.length > 0) {
    personCell.rowSpan = continuationRows.length + 1;
    personCell.className += " settings-account-spanning-cell";
  }
  row.append(personCell, ...usage.cells);
  const reset =
    input.usage?.status === "ready"
      ? renderAccountResetCredits(document, input.usage.credits, messages)
      : null;
  if (!reset) {
    appendAccountExtras(personCell, [input.importAction]);
    return [row, ...continuationRows];
  }
  const detailsRow = document.createElement("tr");
  detailsRow.className = "settings-account-details-row";
  detailsRow.id = `settings-account-reset-${++resetDetailsSequence}`;
  detailsRow.hidden = !input.resetExpanded;
  const detailsCell = document.createElement("td");
  detailsCell.colSpan = 3;
  detailsCell.append(reset.details);
  detailsRow.append(detailsCell);
  reset.summary.dataset.accountFocus = `${account.accountId}:reset`;
  reset.summary.setAttribute("aria-controls", detailsRow.id);
  reset.summary.setAttribute("aria-expanded", String(input.resetExpanded));
  reset.summary.addEventListener("click", () => {
    detailsRow.hidden = !detailsRow.hidden;
    reset.summary.setAttribute("aria-expanded", String(!detailsRow.hidden));
    input.onResetExpanded(!detailsRow.hidden);
  });
  appendAccountExtras(personCell, [reset.summary, input.importAction]);
  return [row, ...continuationRows, detailsRow];
}

export function renderHarnessAccountRows(
  document: Document,
  account: HarnessAccountListResult["accounts"][number],
  messages: RendererSettingsMessages,
  display: AccountUsageDisplay,
  importAction?: HTMLElement | null,
  hideEmails = false,
  plugin?: HarnessPluginDescriptor,
): HTMLTableRowElement[] {
  const row = document.createElement("tr");
  row.className = "settings-account-row";
  row.dataset.harnessId = account.harnessId;
  row.tabIndex = -1;
  const name = accountDisplayText(
    account.email ?? account.label ?? account.harnessName,
    hideEmails,
  );
  row.setAttribute("aria-label", name);
  const personCell = document.createElement("td");
  personCell.className = "settings-account-person-cell";
  const logo = document.createElement("div");
  logo.className = "settings-harness-account__logo";
  logo.setAttribute("aria-hidden", "true");
  logo.append(createRendererAgentIcon(account.harnessId, 26, document, plugin));
  personCell.append(
    createAccountPerson(document, messages, {
      name,
      agent: account.harnessName,
      plan: account.plan ?? null,
      mark: logo,
    }),
  );
  const usage = account.credits
    ? renderAccountUsage(
        document,
        { status: "ready", credits: account.credits, freshness: "live", observedAt: null },
        messages,
        display,
        () => undefined,
        account.harnessId === "grok" ? "weekly-only" : "all",
      )
    : renderAccountBalance(document, messages, account.balance);
  personCell.title = messages.accountNativeManagementHint.replace("{harness}", account.harnessName);
  appendAccountExtras(personCell, [importAction]);
  const continuationRows = usage.continuationCells.map((cells) => {
    const continuation = document.createElement("tr");
    continuation.className = "settings-account-row settings-account-quota-continuation-row";
    continuation.dataset.harnessId = account.harnessId;
    continuation.append(...cells);
    return continuation;
  });
  if (continuationRows.length > 0) {
    personCell.rowSpan = continuationRows.length + 1;
    personCell.className += " settings-account-spanning-cell";
  }
  row.append(personCell, ...usage.cells);
  return [row, ...continuationRows];
}
