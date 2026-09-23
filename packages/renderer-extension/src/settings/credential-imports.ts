import {
  credentialImportNameSchema,
  type CredentialImportRecord,
  type CredentialImportsRequest,
  type CredentialImportsResult,
  type CredentialOtherLogin,
  type CredentialSource,
} from "@codexhost/shared-contracts";
import { KNOWN_RENDERER_AGENTS, type RendererAgent } from "../agent-selection-state.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "../renderer-agent-icon.js";
import type { CredentialImportMessages } from "./credential-import-messages.js";
import { createRendererSettingsIcon } from "./icons.js";

export interface RendererCredentialImportClient {
  credentialImports?(
    request: CredentialImportsRequest,
    targetHarnessId?: string,
  ): Promise<CredentialImportsResult>;
}

type DialogMode = "add" | "reimport" | "remove" | "done";

interface DialogState {
  readonly source?: CredentialSource | undefined;
  readonly record?: CredentialImportRecord | undefined;
}

const TARGET_HARNESS_ID = "pi";

/** Vendors codexhost recognizes in a Pi OAuth credential, mapped to the mark shown for them. */
const VENDOR_AGENTS = {
  "openai-codex": "codex",
  xai: "grok",
} as const satisfies Record<NonNullable<CredentialOtherLogin["vendor"]>, RendererAgent>;

function formatImportedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Default entry name for a new import. The first login of a provider gets the plain name
 * (`codex`, `grok`); further accounts get `<name>-<email prefix>` so the model entry in Pi
 * (`codex-alice/…`) tells which account it belongs to, then `<name>2`, `<name>3`… as a last resort.
 * Only known imports are checked here; the backend still rejects names Pi already uses.
 */
export function defaultImportName(
  source: CredentialSource,
  existing: readonly CredentialImportRecord[],
): string {
  const base = source.provider === "openai-codex" ? "codex" : "grok";
  const used = new Set(existing.map((record) => record.name));
  const valid = (name: string) => credentialImportNameSchema.safeParse(name).success;
  if (!used.has(base)) return base;
  const local = source.label.includes("@") ? (source.label.split("@")[0] ?? "") : "";
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const named = `${base}-${slug}`.slice(0, 48).replace(/-+$/, "");
  if (slug && valid(named) && !used.has(named)) return named;
  for (let index = 2; ; index += 1) {
    const numbered = `${base}${index}`;
    if (!used.has(numbered)) return numbered;
  }
}

/**
 * Controls for copying a native login into another Harness. Two surfaces: a small target icon on
 * each compatible account row (starts the copy), and a dedicated "imported into Pi" section below
 * the account table that lists, re-imports and removes the copies. `section` is the second one.
 */
export function mountCredentialImports(
  root: HTMLElement,
  signal: AbortSignal,
  getClient: () => RendererCredentialImportClient | null,
  messages: CredentialImportMessages,
  changed: () => void,
) {
  const document = root.ownerDocument;
  let snapshot: CredentialImportsResult = { sources: [], targets: [] };
  let busy = false;
  let dialog: HTMLDialogElement | undefined;
  // Pi's own logins are context, not something to act on, so they start collapsed.
  let othersExpanded = false;
  const targetButtons = new Map<string, HTMLElement>();

  const importedRecords = (): readonly CredentialImportRecord[] =>
    snapshot.targets.find((target) => target.harnessId === TARGET_HARNESS_ID)?.imports ?? [];
  const sourceOf = (record: CredentialImportRecord): CredentialSource | undefined =>
    snapshot.sources.find((source) => source.id === record.source.id);
  const section = document.createElement("section");
  section.className = "settings-pi-accounts";
  section.hidden = true;
  section.tabIndex = -1;
  section.setAttribute("aria-label", messages.sectionTitle);
  const sectionHeader = document.createElement("div");
  sectionHeader.className = "settings-pi-accounts__header";
  const sectionTitle = document.createElement("strong");
  sectionTitle.textContent = messages.sectionTitle;
  const sectionCount = document.createElement("span");
  sectionHeader.append(createRendererAgentIcon("pi", 16, document), sectionTitle, sectionCount);
  const card = document.createElement("div");
  card.className = "settings-pi-accounts__card";
  const othersToggle = document.createElement("button");
  othersToggle.type = "button";
  othersToggle.className = "settings-pi-accounts__toggle";
  othersToggle.setAttribute("aria-expanded", "false");
  const othersLabel = document.createElement("span");
  othersLabel.textContent = messages.othersTitle;
  const othersCount = document.createElement("span");
  othersCount.className = "settings-pi-accounts__toggle-count";
  othersToggle.append(createRendererSettingsIcon("chevron-right", 14), othersLabel, othersCount);
  const othersList = document.createElement("div");
  othersList.className = "settings-pi-accounts__others";
  othersList.hidden = true;
  othersList.id = "settings-pi-accounts-others";
  othersToggle.setAttribute("aria-controls", othersList.id);
  othersToggle.addEventListener("click", () => {
    othersExpanded = !othersExpanded;
    othersList.hidden = !othersExpanded;
    othersToggle.setAttribute("aria-expanded", String(othersExpanded));
  });
  section.append(sectionHeader, card);
  const rows = new Map<string, HTMLElement>();

  const metaPart = (text: string, className?: string, code = false): HTMLElement => {
    const part = document.createElement(code ? "code" : "span");
    part.textContent = text;
    if (className) part.className = className;
    return part;
  };
  /** Vendor mark, matching the account table above so the same credential always looks the same. */
  const createMark = (agent: RendererAgent | undefined): HTMLElement => {
    const mark = document.createElement("div");
    mark.setAttribute("aria-hidden", "true");
    mark.className = agent
      ? "settings-harness-account__logo"
      : "settings-harness-account__logo settings-pi-accounts__other-mark";
    if (agent) mark.dataset.agent = agent;
    mark.append(createRendererAgentIcon(agent ?? "pi", 26, document));
    return mark;
  };
  const renderRow = (record: CredentialImportRecord): HTMLElement => {
    const row = document.createElement("div");
    row.className = "settings-pi-accounts__row";
    row.tabIndex = -1;
    row.dataset.importName = record.name;
    row.setAttribute("aria-label", record.source.label);
    const agent = KNOWN_RENDERER_AGENTS.find((candidate) => candidate === record.source.harnessId);
    const mark = createMark(agent);
    const identity = document.createElement("div");
    identity.className = "settings-pi-accounts__identity";
    const label = document.createElement("strong");
    label.className = "settings-account-email";
    label.textContent = record.source.label;
    label.title = record.source.label;
    label.translate = false;
    const meta = document.createElement("div");
    meta.className = "settings-account-metadata";
    const source = sourceOf(record);
    const parts: HTMLElement[] = [
      metaPart(
        (agent && RENDERER_AGENT_LABELS[agent]) || record.source.harnessId,
        "settings-pi-accounts__agent",
      ),
      metaPart(`${record.name}/…`, undefined, true),
      metaPart(messages.copied),
    ];
    const time = formatImportedAt(record.importedAt);
    if (time) parts.push(metaPart(time));
    parts.forEach((part, index) => {
      if (index > 0) {
        const separator = metaPart("·");
        separator.setAttribute("aria-hidden", "true");
        meta.append(separator);
      }
      meta.append(part);
    });
    identity.append(label, meta);
    const actions = document.createElement("div");
    actions.className = "settings-pi-accounts__actions";
    const reimport = document.createElement("button");
    reimport.type = "button";
    reimport.className = "settings-account-action";
    reimport.textContent = messages.rowReimport;
    reimport.setAttribute("aria-label", `${messages.reimport}: ${record.source.label}`);
    reimport.disabled = busy || !source;
    reimport.title = messages.reimport;
    reimport.addEventListener("click", () => {
      if (source) openDialog("reimport", { source, record }, `row:${record.name}`);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "settings-account-action settings-pi-accounts__remove";
    remove.textContent = messages.rowRemove;
    remove.setAttribute("aria-label", `${messages.remove}: ${record.source.label}`);
    remove.disabled = busy;
    remove.addEventListener("click", () => openDialog("remove", { record }, `row:${record.name}`));
    // A copy whose source login is not the current one simply cannot be copied again: no button.
    if (source) actions.append(reimport);
    actions.append(remove);
    row.append(mark, identity, actions);
    rows.set(record.name, row);
    return row;
  };
  const loginTypeLabel = (type: "oauth" | "api_key" | "unknown"): string =>
    type === "oauth"
      ? messages.typeOauth
      : type === "api_key"
        ? messages.typeApiKey
        : messages.typeOther;
  /** A login Pi already had: listed for completeness, read-only, no actions. */
  const renderOtherRow = (login: CredentialOtherLogin): HTMLElement => {
    const row = document.createElement("div");
    row.className = "settings-pi-accounts__row settings-pi-accounts__row--other";
    // A recognized OAuth vendor gets its own mark; anything else keeps the neutral Pi mark.
    const agent = login.vendor ? VENDOR_AGENTS[login.vendor] : undefined;
    row.setAttribute(
      "aria-label",
      [login.label ?? login.provider, agent && RENDERER_AGENT_LABELS[agent]]
        .filter(Boolean)
        .join(" · "),
    );
    const mark = createMark(agent);
    const identity = document.createElement("div");
    identity.className = "settings-pi-accounts__identity";
    const title = document.createElement("strong");
    title.className = "settings-account-email";
    title.textContent = login.label ?? login.provider;
    title.title = title.textContent;
    title.translate = false;
    const meta = document.createElement("div");
    meta.className = "settings-account-metadata";
    const parts: HTMLElement[] = [];
    if (login.label) parts.push(metaPart(login.provider, undefined, true));
    parts.push(metaPart(loginTypeLabel(login.type)));
    parts.forEach((part, index) => {
      if (index > 0) {
        const separator = metaPart("·");
        separator.setAttribute("aria-hidden", "true");
        meta.append(separator);
      }
      meta.append(part);
    });
    identity.append(title, meta);
    row.append(mark, identity);
    return row;
  };
  const renderSection = (): void => {
    // Stay hidden until Pi is known as a target, so a failed or unsupported host shows nothing.
    const target = snapshot.targets.find((candidate) => candidate.harnessId === TARGET_HARNESS_ID);
    section.hidden = !target;
    const records = importedRecords();
    const others = target?.others ?? [];
    sectionCount.textContent = String(records.length + others.length);
    rows.clear();
    if (records.length + others.length === 0) {
      const empty = document.createElement("p");
      empty.className = "settings-pi-accounts__empty";
      empty.textContent = messages.sectionEmpty;
      card.replaceChildren(empty);
      return;
    }
    const content: HTMLElement[] = records.map(renderRow);
    if (others.length > 0) {
      othersCount.textContent = String(others.length);
      othersList.hidden = !othersExpanded;
      othersToggle.setAttribute("aria-expanded", String(othersExpanded));
      othersList.replaceChildren(...others.map(renderOtherRow));
      content.push(othersToggle, othersList);
    }
    card.replaceChildren(...content);
  };

  const run = async (request: CredentialImportsRequest): Promise<boolean> => {
    if (busy || signal.aborted) return false;
    busy = true;
    renderSection();
    changed();
    let ok = false;
    try {
      const client = getClient();
      if (!client?.credentialImports) throw new Error("Unavailable");
      const result = await client.credentialImports(
        request,
        request.action === "list" ? undefined : TARGET_HARNESS_ID,
      );
      if (signal.aborted) return false;
      snapshot = result;
      ok = true;
    } catch {
      ok = false;
    } finally {
      busy = false;
      if (!signal.aborted) {
        renderSection();
        changed();
      }
    }
    return ok;
  };

  const openDialog = (initialMode: DialogMode, initial: DialogState, returnKey?: string): void => {
    if (busy || dialog || signal.aborted) return;
    const modal = document.createElement("dialog");
    dialog = modal;
    modal.className = "settings-account-dialog settings-credential-dialog";
    const title = document.createElement("h2");
    const body = document.createElement("div");
    body.className = "settings-credential-dialog__body";
    const error = document.createElement("p");
    error.className = "settings-credential-dialog__error";
    error.setAttribute("role", "alert");
    const controls = document.createElement("div");
    controls.className = "settings-credential-dialog__actions";
    modal.append(title, body, error, controls);

    let state = initial;
    let mode: DialogMode = initialMode;
    let nameInput: HTMLInputElement | undefined;

    const command = (
      text: string,
      onClick: () => void | Promise<void>,
      variant: "primary" | "secondary" | "danger" = "secondary",
    ): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.className =
        variant === "primary"
          ? "settings-command-button"
          : variant === "danger"
            ? "settings-command-button settings-command-button--secondary settings-command-button--danger"
            : "settings-command-button settings-command-button--secondary";
      button.addEventListener("click", () => void onClick());
      return button;
    };
    const line = (label: string, value: string, code = false): HTMLElement => {
      const row = document.createElement("div");
      row.className = "settings-credential-dialog__line";
      const key = document.createElement("span");
      key.textContent = label;
      const content = document.createElement(code ? "code" : "span");
      content.textContent = value;
      row.append(key, content);
      return row;
    };
    const note = (text: string): HTMLElement => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      return paragraph;
    };
    const setBusy = (value: boolean): void => {
      for (const child of controls.children) (child as HTMLButtonElement).disabled = value;
      if (nameInput) nameInput.disabled = value;
    };
    const submit = async (request: CredentialImportsRequest, next: DialogMode | null) => {
      error.textContent = "";
      setBusy(true);
      const ok = await run(request);
      if (signal.aborted) return;
      if (!ok) {
        error.textContent = messages.failed;
        setBusy(false);
        nameInput?.focus();
        return;
      }
      if (next) {
        // Re-resolve the record from the fresh snapshot so the done view stays truthful.
        const name = request.action === "list" ? undefined : request.name;
        state = {
          source: state.source,
          record: importedRecords().find((record) => record.name === name) ?? state.record,
        };
        show(next);
      } else {
        modal.close();
      }
    };

    const show = (next: DialogMode): void => {
      mode = next;
      error.textContent = "";
      nameInput = undefined;
      body.replaceChildren();
      controls.replaceChildren();
      const { source, record } = state;
      const close = () => modal.close();
      if (mode === "add" || mode === "reimport") {
        title.textContent = mode === "add" ? messages.add : messages.reimport;
        modal.setAttribute("aria-label", title.textContent);
        const active = source ?? record?.source;
        if (active) body.append(line(messages.source, active.label));
        const input = document.createElement("input");
        input.type = "text";
        input.maxLength = 48;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.value =
          record?.name ?? (source ? defaultImportName(source, importedRecords()) : "codex");
        input.readOnly = Boolean(record);
        nameInput = input;
        const label = document.createElement("label");
        label.className = "settings-credential-dialog__field";
        const caption = document.createElement("span");
        caption.textContent = messages.name;
        label.append(caption, input);
        const preview = note("");
        const update = () => {
          preview.textContent = (
            mode === "reimport" ? messages.reimportPreview : messages.preview
          ).replace("{name}", input.value);
        };
        input.addEventListener("input", update);
        update();
        body.append(label, preview, note(messages.warning));
        controls.append(
          command(messages.cancel, close),
          command(
            messages.confirm,
            async () => {
              if (!source) return;
              if (!credentialImportNameSchema.safeParse(input.value).success) {
                error.textContent = messages.invalidName;
                input.focus();
                return;
              }
              await submit(
                {
                  action: mode === "reimport" ? "reimport" : "import",
                  sourceId: source.id,
                  name: record?.name ?? input.value,
                  confirmed: true,
                },
                "done",
              );
            },
            "primary",
          ),
        );
        (mode === "add" ? input : (controls.children[0] as HTMLElement)).focus();
      } else if (mode === "remove" && record) {
        title.textContent = messages.remove;
        modal.setAttribute("aria-label", title.textContent);
        body.append(note(messages.removeWarning.replace("{name}", record.name)));
        const cancel = command(messages.cancel, close);
        controls.append(
          cancel,
          command(
            messages.remove,
            () => submit({ action: "remove", name: record.name, confirmed: true }, null),
            "danger",
          ),
        );
        cancel.focus();
      } else {
        title.textContent = messages.doneTitle;
        modal.setAttribute("aria-label", title.textContent);
        const name = record?.name;
        if (name) body.append(line(messages.entry, `${name}/…`, true));
        body.append(note(messages.done));
        const done = command(messages.close, close, "primary");
        controls.append(done);
        done.focus();
      }
    };

    modal.addEventListener("cancel", (event) => {
      if (busy) event.preventDefault();
    });
    modal.addEventListener("close", () => {
      modal.remove();
      dialog = undefined;
      const target = returnKey
        ? (targetButtons.get(returnKey) ?? rows.get(returnKey.replace(/^row:/, "")))
        : undefined;
      (target?.isConnected ? target : section).focus();
    });
    show(initialMode);
    root.append(modal);
    modal.showModal();
  };

  signal.addEventListener("abort", () => dialog?.remove(), { once: true });
  renderSection();

  return {
    /** Dedicated "imported into Pi" section, rendered below the account table. */
    section: section as HTMLElement,
    refresh: async (): Promise<void> => {
      await run({ action: "list" });
    },
    /**
     * Small target icon for a source account, or null when this login has no verified-compatible
     * target. Incompatible rows intentionally render nothing.
     */
    button(harnessId: string, accountLabel: string): HTMLElement | null {
      const source = snapshot.sources.find(
        (candidate) => candidate.harnessId === harnessId && candidate.label === accountLabel,
      );
      const target = snapshot.targets.find(
        (candidate) =>
          candidate.harnessId === TARGET_HARNESS_ID &&
          source &&
          candidate.providers.includes(source.provider),
      );
      if (!source || !target) return null;
      const record = target.imports.find((candidate) => candidate.source.id === source.id);
      const key = `${harnessId}:${accountLabel}:import`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "settings-icon-button settings-account-harness-target";
      button.dataset.accountFocus = key;
      button.disabled = busy;
      if (record) button.dataset.state = "imported";
      const hint = record ? messages.importedHint.replace("{name}", record.name) : messages.add;
      button.title = hint;
      button.setAttribute("aria-label", hint);
      button.setAttribute("aria-haspopup", "dialog");
      button.append(createRendererAgentIcon("pi", 16, document));
      button.addEventListener("click", () => {
        if (!record) {
          openDialog("add", { source }, key);
          return;
        }
        const row = rows.get(record.name);
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        row?.focus();
      });
      targetButtons.set(key, button);
      return button;
    },
  };
}
