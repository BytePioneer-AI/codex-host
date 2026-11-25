import { TextNode, type LexicalEditor } from "lexical";
import { skillReferences, SKILL_REFERENCE_SOURCE } from "@codexhost/shared-contracts";
import { ReferenceChipNode } from "./chip-node.tsx";

/** Derive chips from text on typing, paste and draft restoration alike. */
export function registerSkillReferences(editor: LexicalEditor): () => void {
  return editor.registerNodeTransform(TextNode, (node) => {
    const reference = skillReferences(node.getTextContent())[0];
    if (!reference) return;
    const pieces = node.splitText(reference.start, reference.end);
    const matched = pieces[reference.start === 0 ? 0 : 1];
    matched?.replace(
      new ReferenceChipNode({
        source: SKILL_REFERENCE_SOURCE,
        ref: reference.text,
        label: reference.name,
        appearance: "skill",
        clipboardText: reference.text,
      }),
    );
  });
}
