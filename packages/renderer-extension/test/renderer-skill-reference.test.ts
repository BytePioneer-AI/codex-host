// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { desktopSkillMentionPath, formatSkillReference } from "@codexhost/shared-contracts";
import { installRendererSkillReferences } from "../src/renderer-skill-reference.js";

const skill = { name: "eli5", path: "/skills/copy (1)/SKILL.md" };
const carrier = `[@eli5](${desktopSkillMentionPath(skill)})`;
const canonical = formatSkillReference(skill);
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function fixture(eligible = true) {
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.textContent = "selected";
  document.body.append(editor);
  const selection = document.getSelection();
  const node = editor.firstChild;
  if (!selection || !node) throw new Error("Missing selection");
  selection.setBaseAndExtent(node, 0, node, 8);
  const cut = vi.fn(() => "selected-native-content");
  const replace = vi.fn(() => "native-transaction");
  const dispatch = vi.fn();
  const serialize = vi.fn(() => `before ${carrier} after`);
  Object.assign(editor, {
    __reactFiber$skill: {
      memoizedProps: {
        composerController: {
          view: {
            dom: editor,
            posAtDOM: vi.fn(),
            dispatch,
            state: {
              doc: { cut },
              selection: { from: 1, to: 9 },
              tr: { replaceWith: replace },
              schema: {
                nodes: { agentMention: { create: (attrs: unknown) => ({ mention: attrs }) } },
                marks: { literalPaste: { create: () => "literal" } },
                text: (text: string, marks: unknown) => ({ text, marks }),
              },
            },
          },
          insertMentionNodeInRange: vi.fn(),
          getMarkdownSerializer: () => serialize,
        },
      },
    },
  });
  dispose = installRendererSkillReferences(document, () => eligible);
  const event = (type: string, plain: string) => {
    const data = new Map([["text/plain", plain]]);
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (key: string) => data.get(key) ?? "",
        setData: (key: string, value: string) => data.set(key, value),
      },
    });
    editor.dispatchEvent(event);
    return { event, data };
  };
  return { cut, replace, dispatch, serialize, event };
}

it("copies the selected native content as canonical links rather than visible @labels", () => {
  const f = fixture();
  const copied = f.event("copy", "before @eli5 after");
  expect(copied.data.get("text/plain")).toBe(`before ${canonical} after`);
  expect(copied.event.defaultPrevented).toBe(true);
  expect(f.cut).toHaveBeenCalledWith(1, 9);
  expect(f.serialize).toHaveBeenCalledWith("selected-native-content");
});

it("pastes multiple canonical links as native mention nodes without moving the surrounding text", () => {
  const f = fixture();
  expect(
    f.event("paste", `before ${canonical} middle ${canonical} after`).event.defaultPrevented,
  ).toBe(true);
  const mention = {
    mention: {
      conversationId: null,
      name: "eli5",
      displayName: "eli5",
      path: desktopSkillMentionPath(skill),
    },
  };
  expect(f.replace).toHaveBeenCalledWith(1, 9, [
    { text: "before ", marks: ["literal"] },
    mention,
    { text: " middle ", marks: ["literal"] },
    mention,
    { text: " after", marks: ["literal"] },
  ]);
  expect(f.dispatch).toHaveBeenCalledWith("native-transaction");
});

it("leaves clipboard events untouched outside eligible external Composers", () => {
  const f = fixture(false);
  expect(f.event("copy", "native text").data.get("text/plain")).toBe("native text");
  expect(f.event("paste", canonical).event.defaultPrevented).toBe(false);
  expect(f.dispatch).not.toHaveBeenCalled();
});
