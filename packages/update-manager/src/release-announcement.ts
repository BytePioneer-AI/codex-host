import {
  RELEASE_ANNOUNCEMENT_MAX_THEMES,
  type ReleaseAnnouncement,
  type ReleaseAnnouncementContent,
  type ReleaseAnnouncementTheme,
} from "@codexhost/shared-contracts";

const graphemes = new Intl.Segmenter();
const CONTRIBUTOR_PREFIX = "— ";

function bounded(text: string, length: number): string {
  return text.trim().slice(0, length).toWellFormed().trimEnd();
}

function parseTheme(block: string): ReleaseAnnouncementTheme | null {
  const [heading = "", ...lines] = block.split("\n");
  const headingText = heading.trim();
  const first = graphemes.segment(headingText)[Symbol.iterator]().next().value?.segment;
  // Accept bare pictographs (such as 🖥) as well as flags, keycaps and joined emoji.
  const emoji =
    first && (/^\p{RGI_Emoji}$/v.test(first) || /^\p{Extended_Pictographic}/u.test(first))
      ? first
      : undefined;
  const title = bounded(headingText.slice(emoji?.length ?? 0), 120);
  const body = bounded(
    lines.filter((line) => !line.startsWith(CONTRIBUTOR_PREFIX)).join("\n"),
    1_200,
  );
  if (!title || !body) return null;
  const contributors = lines
    .filter((line) => line.startsWith(CONTRIBUTOR_PREFIX))
    .flatMap((line) => line.slice(CONTRIBUTOR_PREFIX.length).split(" · "))
    .flatMap((mention) => /^@([a-z\d-]{1,39})$/iu.exec(mention.trim())?.[1] ?? [])
    .slice(0, 30);
  return { ...(emoji && emoji.length <= 16 ? { icon: emoji } : {}), title, body, contributors };
}

function parseLanguage(markdown: string): ReleaseAnnouncementContent | null {
  const preamble = markdown.split(/^##[ \t]+/mu, 1)[0] ?? "";
  const [intro = "", ...blocks] = preamble.split(/^###[ \t]+/mu);
  const themes: ReleaseAnnouncementTheme[] = [];
  for (const block of blocks) {
    const theme = parseTheme(block);
    if (theme) themes.push(theme);
    if (themes.length === RELEASE_ANNOUNCEMENT_MAX_THEMES) break;
  }
  if (!themes.length) return null;
  const summary = bounded(intro.trim().split(/\n[ \t]*\n/u, 1)[0] ?? "", 600);
  return { ...(summary ? { summary } : {}), themes };
}

/** Parse the two announcement preambles, without the detailed release notes below them. */
export function parseReleaseAnnouncementMarkdown(
  markdown: string,
): Pick<ReleaseAnnouncement, "zh" | "en"> {
  const text = markdown.replaceAll("\r\n", "\n");
  const separator = /^---[ \t]*$/mu.exec(text);
  return separator
    ? {
        zh: parseLanguage(text.slice(0, separator.index)),
        en: parseLanguage(text.slice(separator.index + separator[0].length)),
      }
    : { zh: parseLanguage(text), en: null };
}
