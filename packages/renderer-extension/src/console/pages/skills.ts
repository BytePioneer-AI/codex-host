import {
  HARNESS_SKILLS_METHOD,
  HARNESS_SKILL_SET_ENABLED_METHOD,
  HARNESS_SKILL_CONTENT_METHOD,
  HARNESS_SKILL_UNINSTALL_METHOD,
  harnessSkillSetEnabledParamsSchema,
  harnessSkillContentParamsSchema,
  harnessSkillUninstallParamsSchema,
  harnessSkillsListParamsSchema,
  harnessSkillsSetEnabledResultSchema,
  harnessSkillContentResultSchema,
  harnessSkillUninstallResultSchema,
  type HarnessSkillEntry,
  type HarnessSkillGroup,
  type HarnessSkillsListResult,
} from "@codexhost/shared-contracts";

import { h } from "../dom.js";
import { renderSkillMarkdown } from "../skill-markdown.js";
import { createRendererSettingsIcon } from "../../settings/icons.js";
import type { ConsoleMessages } from "../messages.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";
import { segmented } from "../usage/controls.js";

/** Console Host transport: the same JSON-RPC bridge the usage statistics page uses. */
export type RendererSkillsRequest = (method: string, params: unknown) => Promise<unknown>;

/** Filter values that are not a real Harness id or category name. */
const ALL = "";
const ARCHIVED = "\u0000archived";
const NONE = 0;
/** Category the adapters stamp on skills mounted from the cross-Harness shared root. */
const SHARED_CATEGORY = "shared";
/** Matches the shared root with either separator, so Windows paths classify too. */
const SHARED_ROOT_PATTERN = /[/\\]\.agents[/\\]skills[/\\]/u;

interface SkillRow {
  group: HarnessSkillGroup;
  skill: HarnessSkillEntry;
}

export function createSkillsPage(
  consoleMessages: ConsoleMessages,
  request: RendererSkillsRequest,
): RendererSettingsPageDefinition {
  const messages = consoleMessages.skills;
  return Object.freeze({
    id: "skills",
    label: messages.label,
    icon: "boxes" as const,
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const content = context.content;

      const detail = h(document, "p", { className: "settings-hint console-skills-detail" });
      const search = h(document, "input", {
        type: "search",
        placeholder: messages.search,
        "aria-label": messages.search,
        className: "console-skills-search",
      }) as HTMLInputElement;
      const harnessSlot = h(document, "div", { className: "console-skills-filters" });
      const categorySlot = h(document, "div", { className: "console-skills-filters" });
      const groupsHost = h(document, "div", { className: "console-skills-groups" });
      const refresh = h(
        document,
        "button",
        {
          type: "button",
          className: "console-skills-refresh",
          "aria-label": messages.refresh,
          title: messages.refresh,
        },
        createRendererSettingsIcon("refresh", 16),
      ) as HTMLButtonElement;

      const shell = h(
        document,
        "div",
        { className: "console-skills-page" },
        h(
          document,
          "div",
          { className: "console-skills-head" },
          h(document, "h1", { className: "settings-section-label" }, messages.label),
          refresh,
        ),
        harnessSlot,
        categorySlot,
        search,
        detail,
        groupsHost,
      );
      content.append(shell);

      const dialog = h(document, "dialog", {
        className: "console-skill-dialog",
      }) as HTMLDialogElement;
      const dialogName = h(document, "h2", { className: "console-skill-dialog-name" });
      const dialogDescription = h(document, "p", {
        className: "console-skill-dialog-description",
      });
      const dialogBody = h(document, "div", { className: "console-skill-dialog-body" });
      const dialogRemove = h(
        document,
        "button",
        {
          type: "button",
          className: "console-skill-dialog-action is-danger",
          "aria-label": messages.uninstall,
          title: messages.uninstall,
        },
        createRendererSettingsIcon("trash", 16),
      ) as HTMLButtonElement;
      const dialogClose = h(
        document,
        "button",
        {
          type: "button",
          className: "console-skill-dialog-close",
          "aria-label": messages.close,
          title: messages.close,
        },
        "✕",
      );
      dialog.append(
        h(
          document,
          "header",
          { className: "console-skill-dialog-head" },
          h(
            document,
            "div",
            { className: "console-skill-dialog-title" },
            dialogName,
            dialogDescription,
          ),
          h(
            document,
            "div",
            { className: "console-skill-dialog-actions" },
            dialogRemove,
            dialogClose,
          ),
        ),
        dialogBody,
      );
      content.append(dialog);
      dialogClose.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });

      let all: HarnessSkillGroup[] = [];
      /** Selected Harness id, `ALL`, or `shared`. */
      let harness = ALL;
      /** Selected category name, `ALL`, or `ARCHIVED`. */
      let category = ALL;

      const format = (template: string, values: Record<string, string | number>): string =>
        template.replaceAll(/\{(\w+)\}/gu, (match, key: string) =>
          key in values ? String(values[key]) : match,
        );

      const groupTitle = (group: HarnessSkillGroup): string =>
        group.origin === "shared" ? messages.originShared : (group.sourceLabel ?? group.harness);

      const selectedGroups = (): HarnessSkillGroup[] =>
        harness === ALL ? all : all.filter((group) => group.harness === harness);

      const rows = (): SkillRow[] =>
        selectedGroups().flatMap((group) => group.skills.map((skill) => ({ group, skill })));

      /** Categories of the selected Harness; archived skills and shared copies keep their own places. */
      const categoriesOf = (): string[] => {
        const names = new Set<string>();
        for (const { skill } of rows()) {
          if (skill.archived || !skill.category || skill.category === SHARED_CATEGORY) continue;
          names.add(skill.category);
        }
        return [...names].sort((a, b) => a.localeCompare(b));
      };

      const matchesQuery = (skill: HarnessSkillEntry, query: string): boolean =>
        `${skill.name} ${skill.description} ${skill.category ?? ""} ${skill.path}`
          .toLowerCase()
          .includes(query);

      /** A copy of a skill that lives in the shared root; the Shared tab already lists it once. */
      const isSharedCopy = (skill: HarnessSkillEntry): boolean =>
        skill.category === SHARED_CATEGORY && SHARED_ROOT_PATTERN.test(skill.path);

      const inCategory = (skill: HarnessSkillEntry): boolean => {
        if (category === ARCHIVED) return skill.archived === true;
        // Everything is on by default: archived skills stay behind their own filter.
        if (category === ALL) return !skill.archived;
        return !skill.archived && skill.category === category;
      };

      /** The row the dialog currently shows; the remove button acts on it. */
      let detailRow: SkillRow | undefined;

      /** Opens the detail dialog and fills it with the skill's own SKILL.md. */
      const openDetail = async (row: SkillRow): Promise<void> => {
        detailRow = row;
        dialogName.textContent = row.skill.name;
        dialogDescription.textContent = row.skill.description;
        // A shared copy would come back on the next read: the shared root is not ours to edit.
        dialogRemove.hidden = isSharedCopy(row.skill);
        dialogBody.replaceChildren(
          h(document, "p", { className: "settings-hint" }, messages.loading),
        );
        dialog.showModal();
        // showModal focuses the first button; drop that ring so the close X stays quiet.
        dialogClose.blur();
        try {
          const params = harnessSkillContentParamsSchema.parse({
            harness: row.group.harness,
            name: row.skill.name,
          });
          const result = harnessSkillContentResultSchema.parse(
            await request(HARNESS_SKILL_CONTENT_METHOD, params),
          );
          if (!result.ok) {
            dialogBody.replaceChildren(
              h(
                document,
                "p",
                { className: "settings-hint" },
                result.reason ?? messages.contentFailed,
              ),
            );
            return;
          }
          dialogBody.replaceChildren(renderSkillMarkdown(document, result.content));
          if (result.truncated) {
            dialogBody.append(
              h(document, "p", { className: "settings-hint" }, messages.contentTruncated),
            );
          }
        } catch (error) {
          dialogBody.replaceChildren(
            h(
              document,
              "p",
              { className: "settings-hint" },
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      };

      /** Second step for a destructive action: a confirm view inside the same dialog. */
      const showConfirm = (row: SkillRow): void => {
        const cancel = h(
          document,
          "button",
          {
            type: "button",
            className: "settings-command-button settings-command-button--secondary",
          },
          messages.cancel,
        ) as HTMLButtonElement;
        cancel.addEventListener("click", () => void openDetail(row));
        const confirm = h(
          document,
          "button",
          { type: "button", className: "settings-command-button console-skill-danger" },
          messages.uninstallConfirm,
        ) as HTMLButtonElement;
        confirm.addEventListener("click", () => void runUninstall(row, confirm));
        dialogBody.replaceChildren(
          h(
            document,
            "div",
            { className: "console-skill-confirm" },
            h(document, "p", {}, format(messages.uninstallQuestion, { name: row.skill.name })),
            h(document, "code", { className: "console-skill-confirm-path" }, row.skill.path),
            h(document, "p", { className: "settings-hint" }, messages.uninstallWarning),
            h(document, "div", { className: "console-skill-confirm-actions" }, cancel, confirm),
          ),
        );
      };

      const runUninstall = async (row: SkillRow, button: HTMLButtonElement): Promise<void> => {
        button.disabled = true;
        try {
          const params = harnessSkillUninstallParamsSchema.parse({
            harness: row.group.harness,
            name: row.skill.name,
          });
          const result = harnessSkillUninstallResultSchema.parse(
            await request(HARNESS_SKILL_UNINSTALL_METHOD, params),
          );
          if (!result.ok) {
            dialogBody.append(
              h(
                document,
                "p",
                { className: "settings-hint console-skills-failure" },
                result.reason ?? messages.uninstallFailed,
              ),
            );
            return;
          }
          dialog.close();
          detailRow = undefined;
          await load();
          detail.textContent = format(messages.uninstalled, { name: row.skill.name });
        } catch (error) {
          dialogBody.append(
            h(
              document,
              "p",
              { className: "settings-hint console-skills-failure" },
              error instanceof Error ? error.message : String(error),
            ),
          );
        } finally {
          button.disabled = false;
        }
      };

      dialogRemove.addEventListener("click", () => {
        if (detailRow) showConfirm(detailRow);
      });

      const toggleSwitch = async (row: SkillRow, button: HTMLButtonElement): Promise<void> => {
        const next = row.skill.enabled === false;
        button.disabled = true;
        detail.textContent = messages.switching;
        try {
          const params = harnessSkillSetEnabledParamsSchema.parse({
            harness: row.group.harness,
            name: row.skill.name,
            enabled: next,
          });
          const result = harnessSkillsSetEnabledResultSchema.parse(
            await request(HARNESS_SKILL_SET_ENABLED_METHOD, params),
          );
          if (!result.ok) {
            detail.textContent = result.reason ?? messages.toggleFailed;
            return;
          }
          detail.textContent = ALL;
          await load();
        } catch (error) {
          detail.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          button.disabled = false;
        }
      };

      const switchFor = (row: SkillRow): HTMLElement | undefined => {
        if (!row.skill.toggle) return undefined;
        const on = row.skill.enabled !== false;
        const button = h(
          document,
          "button",
          {
            type: "button",
            role: "switch",
            "aria-checked": on ? "true" : "false",
            "aria-label": row.skill.name,
            className: `console-skills-switch${on ? " is-on" : ""}`,
            title: on ? messages.turnOff : messages.turnOn,
          },
          h(document, "span", { className: "console-skills-switch-knob" }),
        ) as HTMLButtonElement;
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          void toggleSwitch(row, button);
        });
        return button;
      };

      const rowItem = (row: SkillRow): HTMLElement => {
        const switchControl = switchFor(row);
        const item = h(
          document,
          "li",
          {
            className: `console-skills-item${row.skill.enabled === false ? " is-off" : ""}`,
            tabindex: "0",
            title: messages.openDetail,
          },
          h(
            document,
            "div",
            { className: "console-skills-item-main" },
            h(
              document,
              "div",
              { className: "console-skills-item-head" },
              h(document, "span", { className: "console-skills-item-name" }, row.skill.name),
              ...(row.skill.category && !row.skill.archived
                ? [h(document, "span", { className: "console-skills-tag" }, row.skill.category)]
                : []),
              ...(row.skill.archived
                ? [
                    h(
                      document,
                      "span",
                      { className: "console-skills-tag is-archived" },
                      messages.archived,
                    ),
                  ]
                : []),
            ),
            h(
              document,
              "p",
              { className: "console-skills-item-description" },
              row.skill.description,
            ),
            h(document, "code", { className: "console-skills-item-path" }, row.skill.path),
          ),
          ...(switchControl ? [switchControl] : []),
        );
        item.addEventListener("click", () => void openDetail(row));
        item.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          void openDetail(row);
        });
        return item;
      };

      const renderFilters = (): void => {
        const harnessOptions = [
          { value: ALL, label: messages.allHarnesses },
          ...all.map((group) => ({ value: group.harness, label: groupTitle(group) })),
        ];
        harnessSlot.replaceChildren(
          segmented(
            document,
            messages.harnessFilter,
            harnessOptions,
            harness,
            (value) => {
              harness = value;
              if (!categoriesOf().includes(category) && category !== ALL && category !== ARCHIVED) {
                category = ALL;
              }
              renderFilters();
              renderList();
            },
            "skills-harness",
          ),
        );
        const archivedCount = rows().filter((row) => row.skill.archived).length;
        const categoryOptions = [
          { value: ALL, label: messages.allCategories },
          ...categoriesOf().map((name) => ({ value: name, label: name })),
          ...(archivedCount > NONE
            ? [{ value: ARCHIVED, label: `${messages.archived} (${archivedCount})` }]
            : []),
        ];
        categorySlot.replaceChildren(
          segmented(
            document,
            messages.categoryFilter,
            categoryOptions,
            category,
            (value) => {
              category = value;
              renderFilters();
              renderList();
            },
            "skills-category",
          ),
        );
      };

      const renderList = (): void => {
        const query = search.value.trim().toLowerCase();
        const visibleGroups = selectedGroups()
          .map((group) => ({
            group,
            visible: group.skills.filter(
              (skill) =>
                inCategory(skill) &&
                !(harness === ALL && isSharedCopy(skill)) &&
                (!query || matchesQuery(skill, query)),
            ),
          }))
          .filter((entry) => entry.visible.length > NONE || entry.group.failures.length > NONE);
        const shown = visibleGroups.reduce((sum, entry) => sum + entry.visible.length, NONE);
        detail.textContent = shown === NONE ? (query ? messages.noMatches : messages.empty) : ALL;
        groupsHost.replaceChildren(
          ...visibleGroups.map(({ group, visible }) =>
            h(
              document,
              "section",
              { className: "console-skills-group" },
              h(
                document,
                "h2",
                { className: "settings-section-label" },
                groupTitle(group),
                ` · ${format(messages.count, { count: visible.length })}`,
              ),
              ...group.failures.map((failure) =>
                h(
                  document,
                  "p",
                  { className: "console-skills-failure", role: "alert" },
                  format(messages.failed, { path: failure.path, message: failure.message }),
                ),
              ),
              h(
                document,
                "ul",
                { className: "console-skills-list" },
                ...visible
                  .slice()
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map((skill) => rowItem({ group, skill })),
              ),
            ),
          ),
        );
      };

      async function load(): Promise<void> {
        const parsed = harnessSkillsListParamsSchema.parse({});
        const result = (await request(HARNESS_SKILLS_METHOD, parsed)) as HarnessSkillsListResult;
        if (context.signal.aborted) return;
        all = result.groups;
        renderFilters();
        renderList();
      }

      /** Re-reads every Harness: skills get installed and removed outside this page all the time. */
      const reload = async (): Promise<void> => {
        refresh.disabled = true;
        refresh.classList.add("is-spinning");
        detail.textContent = messages.loading;
        try {
          await load();
        } catch (error) {
          detail.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          refresh.disabled = false;
          refresh.classList.remove("is-spinning");
        }
      };
      refresh.addEventListener("click", () => void reload());

      search.addEventListener("input", renderList);
      context.signal.addEventListener(
        "abort",
        () => {
          search.removeEventListener("input", renderList);
        },
        { once: true },
      );

      void load().catch((error: unknown) => {
        if (context.signal.aborted) return;
        detail.textContent = error instanceof Error ? error.message : String(error);
      });

      return () => {
        search.removeEventListener("input", renderList);
      };
    },
  });
}
