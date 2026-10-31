// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
} from "lexical";
import { registerClaimDecoration } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/input/editor/claim-decor.ts";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

it("keeps native boundary insertions in editor state and only colors the claimed token", () => {
  const onError = vi.fn();
  const editor = createEditor({ onError });
  const root = document.createElement("div");
  document.body.append(root);
  editor.setRootElement(root);
  const unregister = registerClaimDecoration(editor, () => "/goal ");
  cleanup.push(() => {
    unregister();
    editor.setRootElement(null);
    root.remove();
  });
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode("/goal 发布")));
    },
    { discrete: true },
  );

  // Lexical syncs native insertion at the styled token's end via setTextContent.
  for (const insertion of ["立即", "再次"]) {
    editor.update(
      () => {
        const token = $getRoot().getFirstDescendant();
        if (!$isTextNode(token)) throw new Error("missing token");
        token.setTextContent(`/goal ${insertion}`);
        token.select(8, 8);
      },
      { discrete: true },
    );
    expect(onError).not.toHaveBeenCalled();
  }
  expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
    "/goal 再次立即发布",
  );
  expect(root.textContent).toBe("/goal 再次立即发布");
  expect(root.querySelector('[style*="business-primary"]')?.textContent).toBe("/goal ");
  expect(
    editor.getEditorState().read(() =>
      $getRoot()
        .getAllTextNodes()
        .map((node) => [node.getTextContent(), node.getStyle()]),
    ),
  ).toEqual([
    ["/goal ", "color: var(--dsw-alias-state-business-primary)"],
    ["再次立即发布", ""],
  ]);
});
