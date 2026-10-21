import {
  WORKBENCH_ENTRY_LIMIT,
  workbenchConfigSchema,
  type WorkbenchConfig,
  type WorkbenchEntry,
} from "@codexhost/shared-contracts";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createRendererSettingsIcon } from "./icons.js";
import { workbenchMessages } from "./workbench-messages.js";

export interface WorkbenchClient {
  getWorkbench(): Promise<WorkbenchConfig>;
  setWorkbench(config: WorkbenchConfig): Promise<WorkbenchConfig>;
}
const categories = ["knowledge", "projects", "chats"] as const;
const defaultIcons = { knowledge: "📚", projects: "✅", chats: "💬" };

export function createWorkbenchPage(
  messages: RendererSettingsMessages,
  getClient: () => WorkbenchClient | null,
): RendererSettingsPageDefinition {
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "workbench",
    label: messages.pageLabels.workbench,
    icon: "dashboard",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const text = workbenchMessages(messages.locale);
      const root = document.createElement("div");
      root.className = "settings-workbench max-w-[900px]";
      const header = document.createElement("header");
      header.className = "flex items-start justify-between gap-5 max-[650px]:flex-col";
      const title = document.createElement("h1");
      title.textContent = messages.pageLabels.workbench;
      title.className = "m-0 mb-2 text-2xl font-semibold tracking-[-0.5px]";
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = text.description;
      const heading = document.createElement("div");
      heading.append(title, description);
      const actions = document.createElement("div");
      actions.className = "flex shrink-0 flex-wrap gap-2";
      header.append(heading, actions);
      const local = document.createElement("p");
      local.className = "mt-2 mb-6 text-xs text-settings-muted";
      local.textContent = text.local;
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.className =
        "text-[13px] text-settings-muted empty:hidden data-[error=true]:text-settings-danger";
      const body = document.createElement("div");
      root.append(header, local, status, body);
      context.content.append(root);
      let config: WorkbenchConfig = { version: 1, entries: [] };
      let saving = false;

      function button(label: string, action: () => void, primary = false): HTMLButtonElement {
        const element = document.createElement("button");
        element.type = "button";
        element.className =
          "cursor-pointer rounded-[7px] border px-3 py-[7px] font-[inherit] text-[13px] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-settings-focus disabled:cursor-default disabled:opacity-50 " +
          (primary
            ? "border-transparent bg-settings-primary text-settings-primary-text hover:opacity-90"
            : "border-settings-border bg-settings-panel text-settings-text hover:bg-settings-hover");
        element.textContent = label;
        element.addEventListener("click", action, { signal: context.signal });
        return element;
      }
      function showError(message: string): void {
        status.textContent = message;
        status.dataset.error = "true";
      }
      function showLinks(): void {
        actions.replaceChildren(button(text.manage, edit));
        body.replaceChildren();
        status.textContent = "";
        delete status.dataset.error;
        if (!config.entries.length) {
          const empty = document.createElement("div");
          empty.className =
            "rounded-xl border border-dashed border-settings-border px-6 py-12 text-center [&_h2]:text-lg [&_h2]:font-medium [&_p]:mt-3 [&_p]:mb-6 [&_p]:text-[13px] [&_p]:text-settings-muted";
          const icons = document.createElement("div");
          icons.className = "mb-5 text-3xl";
          icons.textContent = "📚   ✅   💬";
          icons.setAttribute("aria-hidden", "true");
          const label = document.createElement("h2");
          label.textContent = text.empty;
          const detail = document.createElement("p");
          detail.textContent = text.emptyDetail;
          empty.append(icons, label, detail, button(text.add, edit, true));
          body.append(empty);
        }
        for (const category of categories) {
          const entries = config.entries.filter((entry) => entry.category === category);
          if (!entries.length) continue;
          const section = document.createElement("section");
          section.className =
            "my-[30px] [&_h2]:m-0 [&_h2]:mb-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2_span]:font-normal [&_h2_span]:text-settings-muted";
          const label = document.createElement("h2");
          label.textContent = text.categories[category];
          const count = document.createElement("span");
          count.textContent = String(entries.length);
          label.append(count);
          const grid = document.createElement("div");
          grid.className = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-2.5";
          for (const entry of entries) {
            const link = document.createElement("a");
            link.className =
              "workbench-link flex min-w-0 items-center gap-3 rounded-[10px] border border-settings-border bg-settings-panel px-4 py-[18px] text-settings-text no-underline hover:bg-settings-hover focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-settings-focus [&>svg]:shrink-0 [&>svg]:text-settings-subtle";
            link.href = entry.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.referrerPolicy = "no-referrer";
            link.title = entry.url;
            const icon = document.createElement("span");
            icon.className =
              "workbench-link-icon flex h-10 min-w-10 max-w-16 items-center justify-center overflow-hidden rounded-[9px] bg-settings-surface text-2xl";
            icon.textContent = entry.icon;
            icon.setAttribute("aria-hidden", "true");
            const copy = document.createElement("span");
            copy.className =
              "flex min-w-0 flex-1 flex-col gap-[5px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-medium [&_small]:truncate [&_small]:text-xs [&_small]:text-settings-muted";
            const name = document.createElement("strong");
            name.textContent = entry.name;
            const host = document.createElement("small");
            host.textContent = new URL(entry.url).host;
            copy.append(name, host);
            link.append(icon, copy, createRendererSettingsIcon("external-link", 14));
            grid.append(link);
          }
          section.append(label, grid);
          body.append(section);
        }
      }
      function edit(): void {
        status.textContent = "";
        delete status.dataset.error;
        const form = document.createElement("form");
        const fields = document.createElement("fieldset");
        fields.className = "m-0 min-w-0 border-0 p-0";
        const rows: { read(): WorkbenchEntry }[] = [];
        const add = button(text.add, () => {
          if (rows.length >= WORKBENCH_ENTRY_LIMIT) return;
          addRow();
        });
        function updateLimit(): void {
          add.disabled = rows.length >= WORKBENCH_ENTRY_LIMIT;
        }
        function addRow(entry?: WorkbenchEntry): void {
          const row = document.createElement("div");
          row.className =
            "workbench-edit-row my-3 grid grid-cols-[minmax(120px,1fr)_72px_120px] gap-3 rounded-[10px] border border-settings-border bg-settings-panel p-5 max-[650px]:grid-cols-[minmax(80px,1fr)_64px] max-[650px]:p-3.5 [&>label:nth-child(4)]:col-span-full max-[650px]:[&>label:nth-child(3)]:col-span-full";
          const id = entry?.id ?? crypto.randomUUID();
          const category = document.createElement("select");
          for (const key of categories) {
            const option = document.createElement("option");
            option.value = key;
            option.textContent = text.categories[key];
            category.append(option);
          }
          category.value = entry?.category ?? "knowledge";
          function field(label: string, input: HTMLInputElement | HTMLSelectElement): void {
            input.setAttribute("aria-label", label);
            const wrapper = document.createElement("label");
            wrapper.className = "flex min-w-0 flex-col gap-1.5 text-xs text-settings-muted";
            input.className =
              "box-border w-full min-w-0 rounded-md border border-settings-border bg-settings-bg px-2.5 py-2 font-[inherit] text-[13px] text-settings-text focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-settings-focus";
            const caption = document.createElement("span");
            caption.textContent = label;
            wrapper.append(caption, input);
            row.append(wrapper);
          }
          function input(value: string, maxLength: number): HTMLInputElement {
            const control = document.createElement("input");
            control.value = value;
            control.required = true;
            control.maxLength = maxLength;
            return control;
          }
          const name = input(entry?.name ?? "", 80);
          const icon = input(entry?.icon ?? defaultIcons.knowledge, 16);
          const url = input(entry?.url ?? "", 2048);
          url.type = "url";
          url.placeholder = "https://example.com";
          category.addEventListener(
            "change",
            () => {
              const previousDefault = Object.values(defaultIcons).includes(icon.value);
              if (previousDefault)
                icon.value = defaultIcons[category.value as WorkbenchEntry["category"]];
            },
            { signal: context.signal },
          );
          field(text.name, name);
          field(text.icon, icon);
          field(text.category, category);
          field(text.url, url);
          const remove = button(text.remove, () => {
            rows.splice(rows.indexOf(record), 1);
            row.remove();
            updateLimit();
          });
          remove.classList.add("col-span-full", "justify-self-start", "text-settings-danger");
          row.append(remove);
          const record = {
            read: (): WorkbenchEntry => ({
              id,
              category: category.value as WorkbenchEntry["category"],
              name: name.value,
              icon: icon.value,
              url: url.value,
            }),
          };
          rows.push(record);
          fields.append(row);
          updateLimit();
          if (!entry) name.focus();
        }
        const save = button(text.save, () => form.requestSubmit(), true);
        actions.replaceChildren(button(text.cancel, showLinks), save);
        form.append(fields, add);
        body.replaceChildren(form);
        for (const entry of config.entries) addRow(entry);
        if (!rows.length) addRow();
        form.addEventListener(
          "submit",
          (event) => {
            event.preventDefault();
            if (saving) return;
            const parsed = workbenchConfigSchema.safeParse({
              version: 1,
              entries: rows.map((row) => row.read()),
            });
            if (!parsed.success) {
              showError(text.invalid);
              return;
            }
            const client = getClient();
            if (!client) {
              showError(text.saveFailed);
              return;
            }
            saving = true;
            fields.disabled = true;
            add.disabled = true;
            for (const action of actions.querySelectorAll("button")) action.disabled = true;
            status.textContent = text.saving;
            delete status.dataset.error;
            void context.runLatest(
              async () => workbenchConfigSchema.parse(await client.setWorkbench(parsed.data)),
              {
                success(value) {
                  saving = false;
                  config = value;
                  showLinks();
                },
                failure() {
                  saving = false;
                  fields.disabled = false;
                  updateLimit();
                  for (const action of actions.querySelectorAll("button")) action.disabled = false;
                  showError(text.saveFailed);
                },
              },
            );
          },
          { signal: context.signal },
        );
      }
      function load(): void {
        status.textContent = text.loading;
        delete status.dataset.error;
        actions.replaceChildren();
        body.replaceChildren();
        void context.runLatest(
          async () => {
            const client = getClient();
            if (!client) throw new Error("Local workbench is unavailable");
            return workbenchConfigSchema.parse(await client.getWorkbench());
          },
          {
            success(value) {
              config = value;
              showLinks();
            },
            failure() {
              showError(text.failed);
              actions.append(button(text.retry, load));
            },
          },
        );
      }
      load();
    },
  });
}
