import type { CodexAccountSummary } from "@codexhost/shared-contracts";

import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import {
  renderAccountResetCredits,
  renderAccountUsage,
  type AccountUsageDisplay,
  type AccountUsageViewState,
} from "./accounts-usage.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

let resetDetailsSequence = 0;

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
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  for (const label of [
    messages.accountColumnAccount,
    messages.accountColumnUsage,
    messages.accountResetCredits,
    messages.accountColumnActions,
  ]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    row.append(cell);
  }
  head.append(row);
  const body = document.createElement("tbody");
  table.append(head, body);
  return { table, body };
}

export function renderAccountRows(
  document: Document,
  account: CodexAccountSummary,
  messages: RendererSettingsMessages,
  input: {
    usage: AccountUsageViewState | undefined;
    display: AccountUsageDisplay;
    actionsDisabled: boolean;
    usingReset: boolean;
    resetDisabled: boolean;
    resetExpanded: boolean;
    onActivate: () => void;
    onSignIn: () => void;
    onDelete: () => void;
    onRetry: () => void;
    onUseReset?: () => void;
    onResetExpanded: (open: boolean) => void;
  },
): HTMLTableRowElement[] {
  const row = document.createElement("tr");
  row.className = "settings-account-row";
  row.dataset.accountId = account.accountId;
  row.dataset.accountFocus = `${account.accountId}:row`;
  row.tabIndex = -1;
  const name = codexAccountDisplayName(account);
  row.setAttribute("aria-label", name.full);
  const personCell = document.createElement("td");
  const person = document.createElement("div");
  person.className = "settings-account-row__person";
  const mark = document.createElement("div");
  mark.className = "settings-account-row__mark";
  mark.setAttribute("aria-hidden", "true");
  mark.append(createRendererSettingsIcon("terminal", 17));
  const identity = document.createElement("div");
  identity.className = "settings-account-row__identity";
  const title = document.createElement("div");
  title.className = "settings-account-title";
  const local = document.createElement("strong");
  local.className = "settings-account-email";
  local.textContent = name.local;
  local.title = name.full;
  title.append(local);
  if (account.active) {
    const badge = document.createElement("span");
    badge.className = "settings-account-active";
    badge.textContent = messages.accountDefaultBadge;
    title.append(badge);
  }
  identity.append(title);
  if (name.domain) {
    const domain = document.createElement("span");
    domain.className = "settings-account-domain";
    domain.textContent = `@${name.domain}`;
    identity.append(domain);
  }
  person.append(mark, identity);
  personCell.append(person);

  const usageCell = document.createElement("td");
  const usage = renderAccountUsage(document, input.usage, messages, input.display, input.onRetry);
  if (usage) usageCell.append(usage);
  const resetCell = document.createElement("td");
  const resetLabel = document.createElement("span");
  resetLabel.className = "settings-account-mobile-label";
  resetLabel.textContent = messages.accountResetCredits;
  resetCell.append(resetLabel);
  const actionsCell = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "settings-account-actions";
  if (!account.active) {
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "settings-account-action";
    activate.textContent = messages.accountUse;
    activate.dataset.accountFocus = `${account.accountId}:activate`;
    activate.disabled = input.actionsDisabled;
    activate.addEventListener("click", input.onActivate);
    actions.append(activate);
  }
  if (!account.email) {
    const signIn = document.createElement("button");
    signIn.type = "button";
    signIn.className = "settings-account-action";
    signIn.textContent = messages.accountSignIn;
    signIn.dataset.accountFocus = `${account.accountId}:login`;
    signIn.disabled = input.actionsDisabled;
    signIn.addEventListener("click", input.onSignIn);
    actions.append(signIn);
  }
  // isDefault protects the native Account home; active selects the Account for
  // new tasks. Preserve these distinct Host semantics when exposing deletion.
  if (!account.isDefault) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "settings-icon-button settings-account-delete";
    remove.title = messages.accountDelete;
    remove.dataset.accountFocus = `${account.accountId}:delete`;
    remove.setAttribute("aria-label", `${messages.accountDelete}: ${name.full}`);
    remove.disabled = input.actionsDisabled;
    remove.append(createRendererSettingsIcon("trash", 16));
    remove.addEventListener("click", input.onDelete);
    actions.append(remove);
  }
  actionsCell.append(actions);
  row.append(personCell, usageCell, resetCell, actionsCell);
  const reset =
    input.usage?.status === "ready"
      ? renderAccountResetCredits(document, input.usage.credits, messages, input)
      : null;
  if (!reset) {
    const unknown = document.createElement("span");
    unknown.className = "settings-account-unknown";
    unknown.textContent = "—";
    unknown.title = messages.accountResetCreditsUnknown;
    unknown.setAttribute("aria-label", messages.accountResetCreditsUnknown);
    resetCell.append(unknown);
    return [row];
  }
  const detailsRow = document.createElement("tr");
  detailsRow.className = "settings-account-details-row";
  detailsRow.id = `settings-account-reset-${++resetDetailsSequence}`;
  detailsRow.hidden = !input.resetExpanded;
  const detailsCell = document.createElement("td");
  detailsCell.colSpan = 4;
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
  resetCell.append(reset.summary);
  return [row, detailsRow];
}
