import type { CodexAccountSummary, HarnessAccountListResult } from "@codexhost/shared-contracts";

import { KNOWN_RENDERER_AGENTS } from "../agent-selection-state.js";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import { createAccountDetails } from "./accounts-details.js";
import {
  accountUsageColumnLabel,
  renderAccountResetCredits,
  renderAccountUsage,
  type AccountUsageDisplay,
  type AccountUsageViewState,
} from "./accounts-usage.js";
import { createRendererSettingsIcon } from "./icons.js";
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
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  const headers = Array.from({ length: 4 }, () => {
    const cell = document.createElement("th");
    cell.scope = "col";
    row.append(cell);
    return cell;
  });
  const updateDisplay = (display: AccountUsageDisplay): void => {
    const labels = [
      messages.accountColumnAccount,
      accountUsageColumnLabel("five_hour", display, messages),
      accountUsageColumnLabel("seven_day", display, messages),
      messages.accountColumnActions,
    ];
    headers.forEach((cell, index) => {
      cell.textContent = labels[index] ?? "";
    });
  };
  updateDisplay("remaining");
  head.append(row);
  const body = document.createElement("tbody");
  table.append(head, body);
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

export function renderAccountRows(
  document: Document,
  account: CodexAccountSummary,
  messages: RendererSettingsMessages,
  input: {
    current: boolean;
    usage: AccountUsageViewState | undefined;
    display: AccountUsageDisplay;
    actionsDisabled: boolean;
    switchDisabled: boolean;
    loginDisabled: boolean;
    deleteDisabled: boolean;
    logoutDisabled: boolean;
    usingReset: boolean;
    resetDisabled: boolean;
    resetExpanded: boolean;
    onActivate: () => void;
    onSignIn: () => void;
    onDelete: () => void;
    onLogout: () => void;
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
  personCell.className = "settings-account-person-cell";
  const mark = document.createElement("div");
  mark.className = "settings-account-row__mark";
  mark.setAttribute("aria-hidden", "true");
  mark.append(createRendererSettingsIcon("terminal", 17));
  personCell.append(
    createAccountPerson(document, messages, {
      name: name.full,
      agent: "Codex",
      plan: accountPlanLabel(account.planType),
      highlighted: account.planType === "pro" || account.planType === "prolite",
      active: input.current,
      mark,
    }),
  );
  const usage = renderAccountUsage(document, input.usage, messages, input.display, input.onRetry);
  if (usage.additional) personCell.append(usage.additional);
  const actionsCell = document.createElement("td");
  actionsCell.className = "settings-account-management-cell";
  const management = document.createElement("div");
  management.className = "settings-account-management";
  const actions = document.createElement("div");
  actions.className = "settings-account-actions";
  const more: HTMLButtonElement[] = [];
  if (!input.current) {
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "settings-account-action";
    activate.textContent = messages.accountUse;
    activate.title = messages.accountDefaultHint;
    activate.dataset.accountFocus = `${account.accountId}:activate`;
    activate.disabled = input.actionsDisabled || input.switchDisabled;
    activate.addEventListener("click", input.onActivate);
    actions.append(activate);
  }
  const signIn = document.createElement("button");
  signIn.type = "button";
  signIn.className = "settings-account-action";
  signIn.textContent = messages.accountSignIn;
  signIn.dataset.accountFocus = `${account.accountId}:login`;
  signIn.disabled = input.actionsDisabled || input.loginDisabled;
  signIn.addEventListener("click", input.onSignIn);
  if (account.email) more.push(signIn);
  else actions.append(signIn);
  if (input.usage) {
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "settings-account-action";
    refresh.textContent = messages.accountCreditsRefresh;
    refresh.dataset.accountFocus = `${account.accountId}:refresh`;
    refresh.disabled = input.actionsDisabled || input.usage.status === "loading";
    refresh.addEventListener("click", input.onRetry);
    more.push(refresh);
  }
  if (input.current) {
    const logout = document.createElement("button");
    logout.type = "button";
    logout.className = "settings-account-action";
    logout.textContent = messages.accountLogout;
    logout.dataset.accountFocus = `${account.accountId}:logout`;
    logout.disabled = input.actionsDisabled || input.logoutDisabled;
    logout.addEventListener("click", input.onLogout);
    more.push(logout);
  } else {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "settings-account-action settings-account-delete";
    remove.textContent = messages.accountDelete;
    remove.dataset.accountFocus = `${account.accountId}:delete`;
    remove.setAttribute("aria-label", `${messages.accountDelete}: ${name.full}`);
    remove.disabled = input.actionsDisabled || input.deleteDisabled;
    remove.addEventListener("click", input.onDelete);
    more.push(remove);
  }
  if (more.length)
    actions.append(
      createAccountDetails(document, messages, {
        label: messages.accountMore,
        triggerLabel: `${name.full} · ${messages.accountMore}`,
        description: name.full,
        focusKey: `${account.accountId}:more`,
        icon: "ellipsis",
        disabled: input.actionsDisabled,
        actions: more,
      }),
    );
  management.append(actions);
  actionsCell.append(management);
  row.append(personCell, ...usage.cells, actionsCell);
  const reset =
    input.usage?.status === "ready"
      ? renderAccountResetCredits(document, input.usage.credits, messages, input)
      : null;
  if (!reset) return [row];
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
  management.append(reset.summary);
  return [row, detailsRow];
}

export function renderHarnessAccountRow(
  document: Document,
  account: HarnessAccountListResult["accounts"][number],
  messages: RendererSettingsMessages,
  display: AccountUsageDisplay,
): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "settings-account-row";
  row.dataset.harnessId = account.harnessId;
  row.tabIndex = -1;
  const name = account.email ?? account.label ?? account.harnessName;
  row.setAttribute("aria-label", name);
  const personCell = document.createElement("td");
  personCell.className = "settings-account-person-cell";
  const logo = document.createElement("div");
  logo.className = "settings-harness-account__logo";
  logo.setAttribute("aria-hidden", "true");
  const agent = KNOWN_RENDERER_AGENTS.find((agent) => agent === account.harnessId);
  if (agent) logo.append(createRendererAgentIcon(agent, 26, document));
  personCell.append(
    createAccountPerson(document, messages, {
      name,
      agent: account.harnessName,
      plan: account.plan ?? null,
      mark: logo,
    }),
  );
  const usage = renderAccountUsage(
    document,
    { status: "ready", credits: account.credits, freshness: "live", observedAt: null },
    messages,
    display,
    () => undefined,
  );
  if (usage.additional) personCell.append(usage.additional);
  const managementCell = document.createElement("td");
  managementCell.className = "settings-account-management-cell";
  const management = document.createElement("div");
  management.className = "settings-account-native";
  const label = document.createElement("span");
  label.textContent = messages.accountNativeManaged;
  const info = createAccountDetails(document, messages, {
    label: `${account.harnessName} · ${messages.accountNativeManaged}`,
    description: messages.accountNativeManagementHint.replace("{harness}", account.harnessName),
    focusKey: `harness:${account.harnessId}:info`,
    icon: "info",
    actions: [],
  });
  management.append(label, info);
  managementCell.append(management);
  row.append(personCell, ...usage.cells, managementCell);
  return row;
}
