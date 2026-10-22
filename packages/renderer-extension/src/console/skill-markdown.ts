import { h } from "./dom.js";

type Child = Node | string | null | undefined | false;

/**
 * Renders the Markdown subset SKILL.md files actually use — ATX headings, bullet and ordered
 * lists, fenced code, rules, inline code, bold and http(s) links — as DOM nodes. Nothing here goes
 * through innerHTML, so a manifest's content can never inject markup or script.
 */
export function renderSkillMarkdown(document: Document, source: string): HTMLElement {
  const root = h(document, "div", { className: "console-skill-md" });
  const lines = source.split(/\r?\n/u);

  const paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    root.append(h(document, "p", {}, ...inline(document, paragraph.join(" "))));
    paragraph.length = 0;
  };

  let index = skipFrontmatter(lines);
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      flush();
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      root.append(
        h(
          document,
          "pre",
          { className: "console-skill-md-code" },
          h(document, "code", {}, body.join("\n")),
        ),
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(trimmed);
    if (heading) {
      flush();
      const level = Math.min((heading[1]?.length ?? 1) + 1, 6);
      const tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
      root.append(h(document, tag, {}, ...inline(document, heading[2] ?? "")));
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/u.test(trimmed)) {
      flush();
      root.append(h(document, "hr"));
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/u.test(line)) {
      flush();
      const items: Child[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/u.test(lines[index] ?? "")) {
        const text = (lines[index] ?? "").replace(/^\s*[-*+]\s+/u, "");
        items.push(h(document, "li", {}, ...inline(document, text)));
        index += 1;
      }
      root.append(h(document, "ul", {}, ...items));
      continue;
    }

    if (/^\s*\d+[.)]\s+/u.test(line)) {
      flush();
      const items: Child[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index] ?? "")) {
        const text = (lines[index] ?? "").replace(/^\s*\d+[.)]\s+/u, "");
        items.push(h(document, "li", {}, ...inline(document, text)));
        index += 1;
      }
      root.append(h(document, "ol", {}, ...items));
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }
  flush();
  return root;
}

/** The frontmatter fence carries no display value inside the detail dialog. */
function skipFrontmatter(lines: readonly string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === "---") return index + 1;
  }
  return 0;
}

/** Inline spans: `code`, **bold**, and [text](https://…) links; everything else stays text. */
function inline(document: Document, text: string): Child[] {
  const out: Child[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (match[1]) out.push(h(document, "code", {}, match[1].slice(1, -1)));
    else if (match[2]) out.push(h(document, "strong", {}, match[2].slice(2, -2)));
    else if (match[3] && match[4]) {
      out.push(
        h(
          document,
          "a",
          { href: match[4], target: "_blank", rel: "noopener noreferrer" },
          match[3],
        ),
      );
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
