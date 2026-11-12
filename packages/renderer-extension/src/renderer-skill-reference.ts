import {
  DESKTOP_SKILL_MENTION_PATH_PREFIX,
  desktopSkillMentionPath,
  restoreDesktopSkillMentions,
  skillReferences,
} from "@codexhost/shared-contracts";
import {
  insertNativeMentionContent,
  nativeSelectionMarkdown,
  type NativeAgentMention,
} from "./renderer-native-composer-controller.js";

const STYLE_ATTRIBUTE = "data-codexhost-skill-reference-style";
const SVG_NS = "http://www.w3.org/2000/svg";
const CUBE = "M12 3 20 7.5v9L12 21l-8-4.5v-9ZM4 7.5 12 12l8-4.5M12 12v9";

export function createSkillIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = ownerDocument.createElementNS(SVG_NS, "path");
  path.setAttribute("d", CUBE);
  svg.append(path);
  return svg;
}

export function skillMention(skill: { name: string; path: string }): NativeAgentMention {
  return { name: skill.name, displayName: skill.name, path: desktopSkillMentionPath(skill) };
}

/** Native nodes retain editing/serialization; only our carrier's presentation is styled. */
export function installRendererSkillReferences(
  ownerDocument: Document,
  isExternalEditor: (editor: HTMLElement) => boolean,
): () => void {
  const style = ownerDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  const selector = `[agent-mention-path^="${DESKTOP_SKILL_MENTION_PATH_PREFIX}"][agent-mention-display-name]`;
  const icon = encodeURIComponent(
    `<svg xmlns="${SVG_NS}" viewBox="0 0 24 24" fill="none" stroke="#808080" stroke-width="1.7" stroke-linejoin="round"><path d="${CUBE}"/></svg>`,
  );
  style.textContent = `${selector}>span{display:none;}
${selector}::before{content:"";display:inline-block;width:16px;height:16px;margin-inline-end:3px;vertical-align:-3px;background:url("data:image/svg+xml,${icon}") center/contain no-repeat;}
${selector}::after{content:attr(agent-mention-display-name);}`;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);

  const selectedEditor = (): HTMLElement | null => {
    const node = ownerDocument.getSelection()?.anchorNode;
    const element = node?.nodeType === node?.ELEMENT_NODE ? (node as Element) : node?.parentElement;
    const editor = element?.closest<HTMLElement>('[contenteditable="true"]');
    return editor && isExternalEditor(editor) ? editor : null;
  };
  const copy = (event: ClipboardEvent): void => {
    const editor = selectedEditor();
    if (!editor || !event.clipboardData) return;
    const text = nativeSelectionMarkdown(editor) ?? event.clipboardData.getData("text/plain");
    const canonical = restoreDesktopSkillMentions(text);
    if (canonical === text) return;
    event.clipboardData.setData("text/plain", canonical);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const paste = (event: ClipboardEvent): void => {
    const editor = selectedEditor();
    if (!editor || !event.clipboardData || event.clipboardData.files.length) return;
    const text = event.clipboardData.getData("text/plain");
    const references = skillReferences(text);
    if (!references.length) return;
    const parts: (string | NativeAgentMention)[] = [];
    let cursor = 0;
    for (const reference of references) {
      parts.push(text.slice(cursor, reference.start), skillMention(reference));
      cursor = reference.end;
    }
    parts.push(text.slice(cursor));
    if (!insertNativeMentionContent(editor, parts)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  ownerDocument.addEventListener("copy", copy, true);
  ownerDocument.addEventListener("paste", paste, true);
  return () => {
    ownerDocument.removeEventListener("copy", copy, true);
    ownerDocument.removeEventListener("paste", paste, true);
    style.remove();
  };
}
