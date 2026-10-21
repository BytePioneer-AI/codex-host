import {
  HARNESS_SKILLS_METHOD,
  harnessSkillsListParamsSchema,
  type HarnessSkillGroup,
  type HarnessSkillsListResult,
} from "@codexhost/shared-contracts";

import { h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";

/** Console Host transport: the same JSON-RPC bridge the usage statistics page uses. */
export type RendererSkillsRequest = (method: string, params: unknown) => Promise<unknown>;

interface SkillRow {
  name: string;
  description: string;
  category?: string | undefined;
  path: string;
}

const INVISIBLE = 0;

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

      const status = h(document, "p", { className: "settings-section-label" }, messages.loading);
      const search = h(document, "input", {
        type: "search",
        placeholder: messages.search,
        "aria-label": messages.search,
        className: "console-skills-search",
      }) as HTMLInputElement;
      const groupsHost = h(document, "div", { className: "console-skills-groups" });

      const shell = h(
        document,
        "div",
        { className: "console-skills-page" },
        h(document, "h1", { className: "settings-section-label" }, messages.label),
        h(document, "p", { className: "settings-hint" }, messages.description),
        search,
        status,
        groupsHost,
      );
      content.append(shell);

      let all: HarnessSkillGroup[] = [];

      const format = (template: string, values: Record<string, string | number>): string =>
        template.replaceAll(/\{(\w+)\}/gu, (match, key: string) =>
          key in values ? String(values[key]) : match,
        );

      const groupTitle = (group: HarnessSkillGroup): string =>
        group.origin === "shared" ? messages.originShared : (group.sourceLabel ?? group.harness);

      const skillCard = (skill: SkillRow): HTMLElement =>
        h(
          document,
          "li",
          { className: "console-skills-item" },
          h(document, "span", { className: "console-skills-item-name" }, skill.name),
          h(document, "span", { className: "console-skills-item-description" }, skill.description),
          h(document, "code", { className: "console-skills-item-path" }, skill.path),
        );

      const failureLine = (path: string, messageText: string): HTMLElement =>
        h(
          document,
          "p",
          { className: "console-skills-failure", role: "alert" },
          format(messages.failed, { path, message: messageText }),
        );

      const matches = (skill: SkillRow, query: string): boolean =>
        `${skill.name} ${skill.description} ${skill.category ?? ""} ${skill.path}`
          .toLowerCase()
          .includes(query);

      const render = (): void => {
        const query = search.value.trim().toLowerCase();
        const total = all.reduce((sum, group) => sum + group.skills.length, INVISIBLE);
        const visible = query
          ? all
              .map((group) => ({
                ...group,
                skills: group.skills.filter((skill) => matches(skill, query)),
              }))
              .filter(
                (group) => group.skills.length > INVISIBLE || group.failures.length > INVISIBLE,
              )
          : all;
        const shown = visible.reduce((sum, group) => sum + group.skills.length, INVISIBLE);
        status.textContent =
          total === INVISIBLE
            ? messages.empty
            : query && shown === INVISIBLE
              ? messages.noMatches
              : format(messages.count, { count: shown });
        groupsHost.replaceChildren(
          ...visible.map((group) =>
            h(
              document,
              "section",
              { className: "console-skills-group" },
              h(
                document,
                "h2",
                { className: "settings-section-label" },
                groupTitle(group),
                ` · ${format(messages.count, { count: group.skills.length })}`,
              ),
              ...group.failures.map((failure) => failureLine(failure.path, failure.message)),
              ...categoryBuckets(group.skills).map(([category, skills]) =>
                h(
                  document,
                  "div",
                  { className: "console-skills-category" },
                  h(
                    document,
                    "h3",
                    { className: "console-skills-category-title" },
                    category ?? messages.categoryUntitled,
                  ),
                  h(document, "ul", { className: "console-skills-list" }, ...skills.map(skillCard)),
                ),
              ),
            ),
          ),
        );
      };

      const categoryBuckets = (skills: readonly SkillRow[]): [string | undefined, SkillRow[]][] => {
        const buckets = new Map<string, { category?: string; skills: SkillRow[] }>();
        for (const skill of skills) {
          const key = skill.category ?? "";
          const bucket = buckets.get(key) ?? { ...(key ? { category: key } : {}), skills: [] };
          bucket.skills.push(skill);
          buckets.set(key, bucket);
        }
        return [...buckets.values()]
          .sort((a, b) =>
            a.category === undefined
              ? INVISIBLE
              : b.category === undefined
                ? -1
                : a.category.localeCompare(b.category),
          )
          .map(({ category, skills: bucketSkills }) => [category, bucketSkills] as const)
          .map(([category, bucketSkills]) => [
            category,
            [...bucketSkills].sort((a, b) => a.name.localeCompare(b.name)),
          ]);
      };

      search.addEventListener("input", render);
      const abort = context.signal;
      abort.addEventListener(
        "abort",
        () => {
          search.removeEventListener("input", render);
        },
        { once: true },
      );

      void (async () => {
        try {
          const parsed = harnessSkillsListParamsSchema.parse({});
          const result = (await request(HARNESS_SKILLS_METHOD, parsed)) as HarnessSkillsListResult;
          if (abort.aborted) return;
          all = result.groups;
          render();
        } catch (error) {
          if (abort.aborted) return;
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      })();

      return () => {
        search.removeEventListener("input", render);
      };
    },
  });
}
