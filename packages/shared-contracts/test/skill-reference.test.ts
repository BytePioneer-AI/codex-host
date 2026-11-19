import { describe, expect, it } from "vitest";
import {
  desktopSkillMentionPath,
  restoreDesktopSkillMentions,
  formatSkillReference,
  skillReferences,
  skillsListParamsSchema,
} from "../src/index.js";

describe("Desktop Skill carriers", () => {
  it.each([
    "/Users/me/with spaces (copy)/SKILL.md",
    "C:\\Users\\me\\技能\\SKILL.md",
    "\\\\server\\share\\skills\\SKILL.md",
  ])("restores every inline occurrence without moving surrounding text: %s", (path) => {
    const skill = { name: "eli5", path };
    const carrier = `[@eli5](${desktopSkillMentionPath(skill)})`;
    const canonical = formatSkillReference(skill);
    expect(restoreDesktopSkillMentions(`before ${carrier}\n middle ${carrier} after`)).toBe(
      `before ${canonical}\n middle ${canonical} after`,
    );
    expect(restoreDesktopSkillMentions(canonical)).toBe(canonical);
  });
  it.each([
    "[@broken](subagent://codexhost-skill.%ZZ)",
    "[@broken](subagent://codexhost-skill.null)",
    `[@broken](${desktopSkillMentionPath({ name: "bad", path: "relative/SKILL.md" })})`,
    "[@Pi](subagent://codexhost.pi)",
    "[@compact](subagent://codexhost-command.compact)",
    "[$native](/native/SKILL.md)",
  ])("preserves malformed carriers and other native inputs: %s", (text) => {
    expect(restoreDesktopSkillMentions(text)).toBe(text);
  });
});

describe("text-only Skill references", () => {
  it.each([
    "/Users/me/.agents/skills/eli5/SKILL.md",
    "/Users/me/with spaces (copy)/SKILL.md",
    "C:\\Users\\me\\skills\\SKILL.md",
    "\\\\server\\share\\skills\\SKILL.md",
  ])("formats and recognizes %s", (path) => {
    const text = formatSkillReference({ name: "eli5", path });
    expect(text).toContain('"Read this skill"');
    expect(skillReferences(`before ${text} after`)).toEqual([
      { start: 7, end: 7 + text.length, text, name: "eli5", path },
    ]);
    if (/[\s()]/u.test(path)) expect(text).toContain(`<${path}>`);
  });
  it("recognizes multiple inline references by text alone, with or without a title", () => {
    const text = 'Use [$one](/a/SKILL.md) and [$two](</b (copy)/SKILL.md> "Read this skill") here';
    expect(skillReferences(text).map((ref) => ref.name)).toEqual(["one", "two"]);
  });
  it.each([
    "[$x](relative/SKILL.md)",
    "[x](/absolute/SKILL.md)",
    "[$x](https://example.com/SKILL.md)",
    "[$x](/a/README.md)",
    "[$x](/SKILL.md/child)",
  ])("leaves non-Skill links plain: %s", (text) => {
    expect(skillReferences(text)).toEqual([]);
  });
  it("allows global/draft/Thread queries and rejects ambiguous workspace identity", () => {
    expect(skillsListParamsSchema.parse({})).toEqual({});
    expect(skillsListParamsSchema.safeParse({ cwd: "/a" }).success).toBe(true);
    expect(skillsListParamsSchema.safeParse({ cwd: "/a", refresh: true }).success).toBe(false);
    expect(skillsListParamsSchema.safeParse({ cwd: "/a", threadId: "thread" }).success).toBe(false);
  });
});
