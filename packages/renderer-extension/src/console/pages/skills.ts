import {
  HARNESS_SKILLS_METHOD,
  HARNESS_SKILL_SET_ENABLED_METHOD,
  harnessSkillSetEnabledParamsSchema,
  harnessSkillsListParamsSchema,
  harnessSkillsSetEnabledResultSchema,
  type HarnessSkillEntry,
  type HarnessSkillGroup,
  type HarnessSkillsListResult,
} from "@codexhost/shared-contracts";

import { h } from "../dom.js";
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

      const status = h(
        document,
        "p",
        { className: "settings-section-label" },
        messages.loading,
      ) as HTMLParagraphElement;
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

      const shell = h(
        document,
        "div",
        { className: "console-skills-page" },
        h(document, "h1", { className: "settings-section-label" }, messages.label),
        h(document, "p", { className: "settings-hint" }, messages.description),
        harnessSlot,
        categorySlot,
        search,
        status,
        detail,
        groupsHost,
      );
      content.append(shell);

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

      /** Categories of the selected Harness; archived skills keep their own bucket. */
      const categoriesOf = (): string[] => {
        const names = new Set<string>();
        for (const { skill } of rows()) {
          if (!skill.archived && skill.category) names.add(skill.category);
        }
        return [...names].sort((a, b) => a.localeCompare(b));
      };

      const matchesQuery = (skill: HarnessSkillEntry, query: string): boolean =>
        `${skill.name} ${skill.description} ${skill.category ?? ""} ${skill.path}`
          .toLowerCase()
          .includes(query);

      const inCategory = (skill: HarnessSkillEntry): boolean => {
        if (category === ALL) return true;
        if (category === ARCHIVED) return skill.archived === true;
        return !skill.archived && skill.category === category;
      };

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
        button.addEventListener("click", () => void toggleSwitch(row, button));
        return button;
      };

      const rowItem = (row: SkillRow): HTMLElement => {
        const switchControl = switchFor(row);
        return h(
          document,
          "li",
          { className: `console-skills-item${row.skill.enabled === false ? " is-off" : ""}` },
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
              (skill) => inCategory(skill) && (!query || matchesQuery(skill, query)),
            ),
          }))
          .filter((entry) => entry.visible.length > NONE || entry.group.failures.length > NONE);
        const shown = visibleGroups.reduce((sum, entry) => sum + entry.visible.length, NONE);
        const total = rows().filter((row) => inCategory(row.skill)).length;
        status.textContent =
          total === NONE
            ? messages.empty
            : query && shown === NONE
              ? messages.noMatches
              : format(messages.count, { count: shown });
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
                ...(visibleGroups.length > 1
                  ? [` · ${format(messages.count, { count: visible.length })}`]
                  : []),
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
        status.textContent = error instanceof Error ? error.message : String(error);
      });

      return () => {
        search.removeEventListener("input", renderList);
      };
    },
  });
}
