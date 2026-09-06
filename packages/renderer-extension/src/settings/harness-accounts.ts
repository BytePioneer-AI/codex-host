import type { HarnessAccountListResult } from "@codexhost/shared-contracts";
import { KNOWN_RENDERER_AGENTS } from "../agent-selection-state.js";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import { renderAccountUsage, type AccountUsageDisplay } from "./accounts-usage.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererHarnessAccountClient {
  listHarnessAccounts?(): Promise<HarnessAccountListResult>;
}

/** Read-only telemetry, deliberately separate from Codex Account IDs and mutations. */
export function mountHarnessAccounts(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  getClient: () => RendererHarnessAccountClient | null,
  onChange: () => void,
) {
  const document = context.content.ownerDocument;
  const section = document.createElement("section");
  section.className = "settings-harness-accounts";
  section.hidden = true;
  const heading = document.createElement("h2");
  heading.className = "settings-harness-accounts__title";
  heading.textContent = messages.harnessAccountsTitle;
  const list = document.createElement("div");
  list.className = "settings-account-list";
  section.append(heading, list);
  context.content.append(section);
  let accounts: HarnessAccountListResult["accounts"] = [];
  let refreshing = false;
  let query = "";
  let display: AccountUsageDisplay = "remaining";

  const render = (): void => {
    section.hidden = accounts.length === 0;
    list.replaceChildren();
    const visible = accounts.filter((account) =>
      `${account.harnessName} ${account.email ?? ""} ${account.label ?? ""} ${account.plan ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
    );
    for (const account of visible) {
      const row = document.createElement("article");
      row.className = "settings-harness-account";
      row.dataset.harnessId = account.harnessId;
      const identity = document.createElement("div");
      identity.className = "settings-harness-account__identity";
      const name = document.createElement("strong");
      name.className = "settings-account-email";
      const accountName = account.email ?? account.label;
      name.textContent = accountName ?? account.harnessName;
      name.title = name.textContent;
      identity.append(name);
      const metadata = document.createElement("div");
      metadata.className = "settings-account-metadata";
      if (accountName) {
        const harness = document.createElement("span");
        harness.textContent = account.harnessName;
        metadata.append(harness);
      }
      if (account.plan) {
        if (accountName) {
          const separator = document.createElement("span");
          separator.textContent = "·";
          separator.setAttribute("aria-hidden", "true");
          metadata.append(separator);
        }
        const plan = document.createElement("span");
        plan.className = "settings-account-plan";
        plan.textContent = account.plan;
        metadata.append(plan);
      }
      if (metadata.childElementCount) identity.append(metadata);
      const usage = renderAccountUsage(
        document,
        { status: "ready", credits: account.credits },
        messages,
        display,
        () => undefined,
      );
      const person = document.createElement("div");
      person.className = "settings-account-row__person";
      const agent = KNOWN_RENDERER_AGENTS.find((agent) => agent === account.harnessId);
      if (agent) {
        const logo = document.createElement("div");
        logo.className = "settings-harness-account__logo";
        logo.setAttribute("aria-hidden", "true");
        logo.append(createRendererAgentIcon(agent, 28, document));
        person.append(logo);
      }
      person.append(identity);
      row.append(person);
      if (usage) row.append(usage);
      list.append(row);
    }
    if (accounts.length && !visible.length) {
      const empty = document.createElement("p");
      empty.className = "settings-account-empty";
      empty.textContent = messages.accountNoMatches;
      list.append(empty);
    }
  };
  return {
    get refreshing() {
      return refreshing;
    },
    update(nextQuery: string, nextDisplay: AccountUsageDisplay) {
      query = nextQuery;
      display = nextDisplay;
      render();
    },
    async refresh(): Promise<void> {
      if (refreshing || context.signal.aborted) return;
      const client = getClient();
      if (!client?.listHarnessAccounts) return;
      refreshing = true;
      onChange();
      try {
        const result = await client.listHarnessAccounts();
        if (!context.signal.aborted) accounts = result.accounts;
      } catch {
        // Older Hosts and unavailable authentication have no read-only rows.
        if (!context.signal.aborted) accounts = [];
      } finally {
        refreshing = false;
        if (!context.signal.aborted) {
          render();
          onChange();
        }
      }
    },
  };
}
