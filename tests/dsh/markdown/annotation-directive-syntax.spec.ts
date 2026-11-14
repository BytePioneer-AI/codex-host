/**
 * The annotation directive is a Markdown construct: these cases compare the
 * nodes our grammar produces against token shapes recorded from the installed
 * Desktop lexer, so code, escapes and links keep their own meaning.
 */
import { expect, it } from "vitest";
import type { Root, RootContent } from "mdast";
import {
  parseGfm,
  parseGfmWithMath,
} from "../../../apps/web-ui/packages/client/ui-primitives/src/markdown/parse.ts";
import { DESKTOP_DIRECTIVE_TOKENS } from "../../../packages/shared-contracts/test/fixtures/desktop-directive-tokens.ts";
import type { DirectiveNode } from "../../../packages/shared-contracts/test/fixtures/desktop-directive-tokens.ts";
import { responseAnnotationIndex } from "../../../packages/shared-contracts/src/response-annotation.ts";

function project(node: RootContent | Root): DirectiveNode | undefined {
  switch (node.type) {
    case "paragraph":
      return { type: "link", children: node.children.map(project).filter(isNode) };
    case "text":
      return { type: "text", value: node.value.replace(/\r\n?/g, "\n") };
    case "inlineCode":
      return { type: "inlineCode", value: node.value };
    case "code":
      return { type: "code", value: node.value };
    case "link":
      return { type: "link", children: node.children.map(project).filter(isNode) };
    case "codexAnnotation":
      return { type: "directive", index: node.index };
    default:
      return undefined;
  }
}

function isNode(node: DirectiveNode | undefined): node is DirectiveNode {
  return node !== undefined;
}

/** The paragraph's children, without the wrapper this projection adds for it. */
function children(text: string, parse: typeof parseGfm): readonly DirectiveNode[] {
  const [first] = parse(text).children;
  if (first === undefined) throw new Error("no block");
  const projected = project(first);
  return projected?.type === "link" && first.type === "paragraph"
    ? (projected.children ?? [])
    : [projected as DirectiveNode];
}

it.each(DESKTOP_DIRECTIVE_TOKENS)("matches the Desktop lexer for $text", ({ text, nodes }) => {
  for (const parse of [parseGfm, parseGfmWithMath]) expect(children(text, parse)).toEqual(nodes);
});

it("reads only canonical positive integers as a position", () => {
  expect(responseAnnotationIndex("1")).toBe(1);
  expect(responseAnnotationIndex("2")).toBe(2);
  for (const raw of ["01", "0", "-1", "1.0", " 1", "x", "", undefined])
    expect(responseAnnotationIndex(raw)).toBeUndefined();
});
