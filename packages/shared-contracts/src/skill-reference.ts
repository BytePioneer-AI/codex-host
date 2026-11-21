/** Text-only Skill references; no catalog lookup or Skill body is needed for recognition. */
export const SKILL_REFERENCE_SOURCE = "codexhost-skill";
export const DESKTOP_SKILL_MENTION_PATH_PREFIX = "subagent://codexhost-skill.";
const DESKTOP_MENTION = /\[@[^\]\r\n]+\]\(<?subagent:\/\/codexhost-skill\.([^\s)>]+)>?\)/gu;
const LINK =
  /\[\$([^\]\r\n]+)\]\((?:<([^<>\r\n]+)>|([^\s()]+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\)/gu;

export interface SkillReference {
  start: number;
  end: number;
  name: string;
  path: string;
  text: string;
}

export function skillReferences(text: string): SkillReference[] {
  return [...text.matchAll(LINK)].flatMap((match) => {
    const path = match[2] ?? match[3] ?? "";
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path) || !/[\\/]SKILL\.md$/u.test(path)) return [];
    return [
      {
        start: match.index,
        end: match.index + match[0].length,
        name: match[1] ?? "",
        path,
        text: match[0],
      },
    ];
  });
}

export function formatSkillReference(skill: { name: string; path: string }): string {
  const target = /[\s()]/u.test(skill.path) ? `<${skill.path}>` : skill.path;
  return `[$${skill.name}](${target} "Read this skill")`;
}

/** Native agent mentions avoid Desktop's plain-text Markdown escaping and Skill injection. */
export function desktopSkillMentionPath(skill: { name: string; path: string }): string {
  return (
    DESKTOP_SKILL_MENTION_PATH_PREFIX +
    encodeURIComponent(JSON.stringify({ name: skill.name, path: skill.path })).replace(
      /[!'()*]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
  );
}

/** Restore every Desktop carrier in place, without catalog access or command routing. */
export function restoreDesktopSkillMentions(text: string): string {
  return text.replace(DESKTOP_MENTION, (match, encoded: string) => {
    try {
      const skill: unknown = JSON.parse(decodeURIComponent(encoded));
      if (
        !skill ||
        typeof skill !== "object" ||
        !("name" in skill) ||
        typeof skill.name !== "string" ||
        !("path" in skill) ||
        typeof skill.path !== "string"
      )
        return match;
      const canonical = formatSkillReference({ name: skill.name, path: skill.path });
      return skillReferences(canonical)[0]?.text === canonical ? canonical : match;
    } catch {
      return match;
    }
  });
}
